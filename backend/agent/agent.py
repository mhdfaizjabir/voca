import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from livekit.agents import Agent, AgentSession, JobContext, JobProcess, WorkerOptions, cli
from livekit.plugins import deepgram, groq, silero

from db.local_store import save_session_score
from prompts import build_instructions
from rag.retriever import retrieve
from scoring.rubric import DEFAULT_RUBRIC, Rubric
from scoring.schemas import TranscriptTurn
from scoring.scorer import score_transcript
from shared.env import load_environment

load_environment()

logger = logging.getLogger("voca-agent")


def prewarm(proc: JobProcess) -> None:
    # Loaded once per worker process, reused across every room/job it handles.
    proc.userdata["vad"] = silero.VAD.load()


class InterviewerAgent(Agent):
    def __init__(self, instructions: str) -> None:
        super().__init__(instructions=instructions)


def _parse_room_metadata(room_metadata: str) -> tuple[str | None, Rubric]:
    if not room_metadata:
        return None, DEFAULT_RUBRIC
    try:
        data = json.loads(room_metadata)
    except json.JSONDecodeError:
        return None, DEFAULT_RUBRIC

    document_id = data.get("document_id")
    rubric = DEFAULT_RUBRIC
    if data.get("rubric"):
        try:
            rubric = Rubric(**data["rubric"])
        except Exception:
            logger.exception("Invalid rubric in room metadata; falling back to default")

    return document_id, rubric


def _extract_transcript(session: AgentSession) -> list[TranscriptTurn]:
    return [
        TranscriptTurn(role=item.role, text=item.text_content)
        for item in session.history.items
        if item.type == "message" and item.text_content
    ]


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    document_id, rubric = _parse_room_metadata(ctx.room.metadata)

    context_chunks = None
    if document_id:
        try:
            context_chunks = retrieve(document_id)
        except Exception:
            logger.exception("RAG retrieval failed for document_id=%s; falling back to base prompt", document_id)

    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=deepgram.STT(model="nova-3", language="en"),
        llm=groq.LLM(model="llama-3.3-70b-versatile", temperature=0.7),
        tts=deepgram.TTS(model="aura-2-thalia-en"),
    )

    async def score_and_save() -> None:
        transcript = _extract_transcript(session)
        if not transcript:
            return
        try:
            report = score_transcript(transcript, rubric)
            save_session_score(
                session_id=ctx.room.name,
                document_id=document_id,
                transcript=[t.model_dump() for t in transcript],
                rubric=rubric.model_dump(),
                score=report.model_dump(),
            )
        except Exception:
            logger.exception("Scoring failed for session_id=%s", ctx.room.name)

    ctx.add_shutdown_callback(score_and_save)

    await session.start(room=ctx.room, agent=InterviewerAgent(build_instructions(context_chunks)))
    await session.generate_reply(
        instructions="Greet the candidate and ask if they're ready to begin a short practice interview."
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
