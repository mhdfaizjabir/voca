import asyncio
import json
import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# ⬇️ Load environment FIRST – before any import that needs it
from shared.env import load_environment
load_environment()

# Now safe to import everything else
import numpy as np
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    ConversationItemAddedEvent,
    JobContext,
    JobProcess,
    WorkerOptions,
    cli,
)
from livekit.plugins import deepgram, groq, silero

from db.local_store import save_session_score
from db.session_cache import append_turn, clear_session
from prompts import build_instructions
from rag.retriever import retrieve
from scoring.rubric import Rubric, default_rubric_for
from scoring.schemas import TranscriptTurn
from scoring.scorer import score_transcript
from research.company_research import get_company_context
from vision.attention import (
    AttentionTracker,
    JOB_LOOK_AWAY_THRESHOLD_S,
    JOB_PITCH_LIMIT_DEG,
    JOB_YAW_LIMIT_DEG,
)

logger = logging.getLogger("voca-agent")

# LiveKit's dev-mode CLI silences its own known-noisy loggers (httpx, openai, etc.)
# but doesn't know about these. pymongo's heartbeats are just spam; the raw groq
# SDK's debug logs include full request bodies which can contain Unicode
# characters (e.g. non-breaking hyphens) that crash Windows' cp1252 console.
logging.getLogger("pymongo").setLevel(logging.WARNING)
logging.getLogger("groq").setLevel(logging.WARNING)

ATTENTION_SAMPLE_INTERVAL_S = 0.5
WRAP_UP_LEAD_S = 60  # give a heads-up this many seconds before a timed interview auto-ends

# Selectable Deepgram Aura-2 interviewer voices, keyed by the short name the
# frontend sends. Falls back to DEFAULT_VOICE for anything unrecognized.
AURA_VOICES = {
    "thalia": "aura-2-thalia-en",
    "apollo": "aura-2-apollo-en",
    "helena": "aura-2-helena-en",
    "arcas": "aura-2-arcas-en",
}
DEFAULT_VOICE = "thalia"


def prewarm(proc: JobProcess) -> None:
    """Loaded once per worker process, reused across every room/job it handles."""
    proc.userdata["vad"] = silero.VAD.load()


class InterviewerAgent(Agent):
    def __init__(self, instructions: str) -> None:
        super().__init__(instructions=instructions)


@dataclass
class RoomMetadata:
    document_id: str | None
    rubric: Rubric
    company_name: str | None
    position: str | None
    resource_type: str | None  # "job_description" or "course_material"
    duration_minutes: int | None  # None = no auto-end timer
    persona: str | None  # "friendly" | "balanced" | "tough" | None
    difficulty: str | None  # "easy" | "normal" | "hard" | None
    voice: str | None  # short Aura voice key, e.g. "thalia" | None
    focus_areas: list[str] | None  # targeted re-drill topics, or None


def _parse_room_metadata(room_metadata: str) -> RoomMetadata:
    """Parses room metadata JSON, falling back to safe defaults on missing/invalid input."""
    if not room_metadata:
        return RoomMetadata(None, default_rubric_for(None), None, None, None, None, None, None, None, None)

    try:
        data = json.loads(room_metadata)
    except json.JSONDecodeError:
        logger.warning("Invalid JSON in room metadata")
        return RoomMetadata(None, default_rubric_for(None), None, None, None, None, None, None, None, None)

    resource_type = data.get("resource_type")

    rubric = default_rubric_for(resource_type)
    if data.get("rubric"):
        try:
            rubric = Rubric(**data["rubric"])
        except Exception:
            logger.exception("Invalid rubric in room metadata; falling back to default")

    duration_minutes = data.get("duration_minutes")
    if duration_minutes is not None:
        try:
            duration_minutes = int(duration_minutes)
            if duration_minutes <= 0:
                duration_minutes = None
        except (TypeError, ValueError):
            logger.warning("Invalid duration_minutes in room metadata: %r", duration_minutes)
            duration_minutes = None

    persona = data.get("persona")
    if persona not in ("friendly", "balanced", "tough"):
        persona = None

    difficulty = data.get("difficulty")
    if difficulty not in ("easy", "normal", "hard"):
        difficulty = None

    voice = data.get("voice")
    if voice not in AURA_VOICES:
        voice = None

    focus_areas = data.get("focus_areas")
    if isinstance(focus_areas, list):
        focus_areas = [str(x).strip() for x in focus_areas if isinstance(x, str) and x.strip()][:6] or None
    else:
        focus_areas = None

    return RoomMetadata(
        document_id=data.get("document_id"),
        rubric=rubric,
        company_name=data.get("company_name"),
        position=data.get("position"),
        resource_type=resource_type,
        duration_minutes=duration_minutes,
        persona=persona,
        difficulty=difficulty,
        voice=voice,
        focus_areas=focus_areas,
    )


async def _consume_video(track: rtc.Track, tracker: AttentionTracker) -> None:
    """Samples the candidate's camera track at ATTENTION_SAMPLE_INTERVAL_S and feeds
    frames into the attention tracker. CPU-bound inference runs in an executor thread
    so it doesn't block the agent's event loop (which also drives real-time voice)."""
    loop = asyncio.get_event_loop()
    stream = rtc.VideoStream(track, format=rtc.VideoBufferType.RGB24)
    start = time.monotonic()
    last_sample = 0.0
    try:
        async for event in stream:
            now = time.monotonic()
            if now - last_sample < ATTENTION_SAMPLE_INTERVAL_S:
                continue
            last_sample = now
            frame = event.frame
            rgb = np.frombuffer(frame.data, dtype=np.uint8).reshape((frame.height, frame.width, 3))
            timestamp_ms = int((now - start) * 1000)
            try:
                await loop.run_in_executor(None, tracker.process_frame, rgb, timestamp_ms)
            except Exception:
                logger.exception("Attention frame processing failed")
    except asyncio.CancelledError:
        pass
    finally:
        await stream.aclose()


def _extract_transcript(session: AgentSession) -> list[TranscriptTurn]:
    """Extract all message turns from the session history."""
    return [
        TranscriptTurn(role=item.role, text=item.text_content)
        for item in session.history.items
        if item.type == "message" and item.text_content
    ]


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    # --- Parse metadata from the room ---
    meta = _parse_room_metadata(ctx.room.metadata)
    is_job_interview = meta.resource_type == "job_description"

    # --- Retrieve document context (CV/JD) ---
    context_chunks = None
    if meta.document_id:
        try:
            context_chunks = retrieve(meta.document_id)
        except Exception:
            logger.exception("RAG retrieval failed for document_id=%s; falling back to base prompt", meta.document_id)

    # --- Fetch company research (tiered cache/LLM/search) ---
    company_context = None
    if meta.company_name:
        try:
            company_context = await get_company_context(meta.company_name, meta.position)
        except Exception:
            logger.exception("Company research failed for %s", meta.company_name)

    # --- Build the system prompt combining both ---
    instructions = build_instructions(
        context_chunks, company_context, meta.resource_type, meta.persona, meta.difficulty, meta.focus_areas
    )

    # --- Camera attention tracking - job interviews only. Course-material / viva
    # practice has no proctoring purpose, so we don't even subscribe to video there. ---
    attention_tracker: AttentionTracker | None = None
    video_task: asyncio.Task | None = None

    def _on_track_subscribed(
        track: rtc.Track, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant
    ) -> None:
        nonlocal attention_tracker, video_task
        if not is_job_interview or attention_tracker is not None:
            return  # not a job interview, or already tracking one camera track
        if track.kind != rtc.TrackKind.KIND_VIDEO or publication.source != rtc.TrackSource.SOURCE_CAMERA:
            return
        attention_tracker = AttentionTracker(
            yaw_limit_deg=JOB_YAW_LIMIT_DEG,
            pitch_limit_deg=JOB_PITCH_LIMIT_DEG,
            look_away_threshold_s=JOB_LOOK_AWAY_THRESHOLD_S,
        )
        video_task = asyncio.create_task(_consume_video(track, attention_tracker))

    ctx.room.on("track_subscribed", _on_track_subscribed)

    # --- Create session ---
    voice_model = AURA_VOICES.get(meta.voice or DEFAULT_VOICE, AURA_VOICES[DEFAULT_VOICE])
    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=deepgram.STT(model="nova-3", language="en"),
        llm=groq.LLM(model="llama-3.3-70b-versatile", temperature=0.7),
        tts=deepgram.TTS(model=voice_model),
    )

    # --- Short-term in-memory turn cache (last N turns, cleared at session end) ---
    def _on_conversation_item_added(ev: ConversationItemAddedEvent) -> None:
        item = ev.item
        if item.type == "message" and item.text_content:
            append_turn(ctx.room.name, item.role, item.text_content)

    session.on("conversation_item_added", _on_conversation_item_added)

    # --- Optional auto-end timer: warn ~1 minute before the assigned duration is
    # up, then end the job (which triggers the shutdown callback below, same as a
    # manual end). Cancelled on early/manual end so it never fires against a
    # closed session. ---
    timer_task: asyncio.Task | None = None

    async def _auto_end_after(duration_minutes: int) -> None:
        total_s = duration_minutes * 60
        warn_s = max(total_s - WRAP_UP_LEAD_S, 0)
        try:
            await asyncio.sleep(warn_s)
            try:
                await session.generate_reply(
                    instructions=(
                        "You're almost out of time for this practice interview. Wrap up "
                        "warmly - briefly acknowledge the candidate's last answer, thank "
                        "them, and let them know time is up."
                    )
                )
            except Exception:
                logger.exception("Failed to generate wrap-up reply")
            await asyncio.sleep(total_s - warn_s)
            ctx.shutdown(reason="time limit reached")
        except asyncio.CancelledError:
            pass

    if meta.duration_minutes:
        timer_task = asyncio.create_task(_auto_end_after(meta.duration_minutes))

    # --- Score & save transcript ---
    # Runs at most once (guarded), triggered either by the candidate leaving or by
    # job shutdown - whichever happens first. Scoring on participant-disconnect
    # matters because the room/transport teardown afterwards can be slow, and on
    # some platforms the native webrtc layer can crash during it, which would
    # otherwise lose the score entirely.
    scored = False
    scoring_lock = asyncio.Lock()

    async def score_and_save() -> None:
        nonlocal scored
        async with scoring_lock:
            if scored:
                return
            scored = True

        if video_task is not None:
            video_task.cancel()
        if timer_task is not None:
            timer_task.cancel()
        clear_session(ctx.room.name)

        transcript = _extract_transcript(session)
        if not transcript:
            return
        attention_summary = attention_tracker.get_summary() if attention_tracker else None
        loop = asyncio.get_event_loop()
        try:
            # score_transcript makes a blocking LLM call - run it off the event
            # loop so it can finish even while the session is tearing down.
            report = await loop.run_in_executor(None, score_transcript, transcript, meta.rubric, attention_summary)
            await loop.run_in_executor(
                None,
                lambda: save_session_score(
                    session_id=ctx.room.name,
                    document_id=meta.document_id,
                    transcript=[t.model_dump() for t in transcript],
                    rubric=meta.rubric.model_dump(),
                    score=report.model_dump(),
                ),
            )
            logger.info("Saved score for session_id=%s", ctx.room.name)
        except Exception:
            logger.exception("Scoring failed for session_id=%s", ctx.room.name)

    def _on_participant_disconnected(participant: rtc.RemoteParticipant) -> None:
        asyncio.create_task(score_and_save())

    ctx.room.on("participant_disconnected", _on_participant_disconnected)
    ctx.add_shutdown_callback(score_and_save)

    # --- Start the agent and greet the candidate ---
    await session.start(room=ctx.room, agent=InterviewerAgent(instructions))
    await session.generate_reply(
        instructions="Greet the candidate and ask if they're ready to begin a short practice interview."
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))