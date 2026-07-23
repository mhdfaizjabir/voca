import json
import os
import uuid

from fastapi import APIRouter, HTTPException
from livekit.api import AccessToken, VideoGrants
from livekit.protocol.room import RoomConfiguration
from pydantic import BaseModel

from chat.review_chat import chat_about_session
from db.local_store import (
    append_chat_message,
    get_chat_messages,
    get_document,
    get_session_score,
    list_session_scores,
)
from scoring.answer_feedback import AnswerFeedback, generate_answer_feedback
from scoring.rubric import Rubric
from scoring.schemas import ScoreReport, TranscriptTurn

VALID_PERSONAS = ("friendly", "balanced", "tough")
VALID_DIFFICULTIES = ("easy", "normal", "hard")
VALID_VOICES = ("thalia", "apollo", "helena", "arcas")

router = APIRouter(prefix="/sessions", tags=["sessions"])


class StartSessionIn(BaseModel):
    document_id: str
    rubric: Rubric | None = None
    company_name: str | None = None
    position: str | None = None
    duration_minutes: int | None = None
    persona: str | None = None  # "friendly" | "balanced" | "tough"
    difficulty: str | None = None  # "easy" | "normal" | "hard"
    voice: str | None = None  # "thalia" | "apollo" | "helena" | "arcas"
    focus_areas: list[str] | None = None  # targeted re-drill topics


class StartSessionOut(BaseModel):
    livekit_url: str
    token: str
    room_name: str


class SessionScoreOut(BaseModel):
    session_id: str
    document_id: str | None
    rubric: Rubric
    score: ScoreReport
    transcript: list[TranscriptTurn]


class SessionSummaryOut(BaseModel):
    session_id: str
    document_id: str | None
    overall_score: float | None
    summary: str | None
    created_at: str


class ChatIn(BaseModel):
    message: str


class ChatMessageOut(BaseModel):
    role: str
    text: str
    created_at: str


class ChatOut(BaseModel):
    reply: str


@router.post("/start", response_model=StartSessionOut)
def start_session(body: StartSessionIn) -> StartSessionOut:
    document = get_document(body.document_id)
    if not document:
        raise HTTPException(404, "Document not found")

    room_name = f"interview-{uuid.uuid4()}"
    identity = f"user-{uuid.uuid4()}"

    metadata = {"document_id": body.document_id, "resource_type": document["resource_type"]}
    if body.rubric:
        metadata["rubric"] = body.rubric.model_dump()
    if body.company_name:
        metadata["company_name"] = body.company_name
    if body.position:
        metadata["position"] = body.position
    if body.duration_minutes and body.duration_minutes > 0:
        metadata["duration_minutes"] = body.duration_minutes
    if body.persona in VALID_PERSONAS:
        metadata["persona"] = body.persona
    if body.difficulty in VALID_DIFFICULTIES:
        metadata["difficulty"] = body.difficulty
    if body.voice in VALID_VOICES:
        metadata["voice"] = body.voice
    if body.focus_areas:
        cleaned = [a.strip() for a in body.focus_areas if a and a.strip()][:6]
        if cleaned:
            metadata["focus_areas"] = cleaned

    token = (
        AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
        .with_identity(identity)
        .with_grants(VideoGrants(room_join=True, room=room_name))
        .with_room_config(RoomConfiguration(metadata=json.dumps(metadata)))
        .to_jwt()
    )

    return StartSessionOut(
        livekit_url=os.environ["LIVEKIT_URL"],
        token=token,
        room_name=room_name,
    )


@router.get("/{session_id}/score", response_model=SessionScoreOut)
def get_score(session_id: str) -> SessionScoreOut:
    result = get_session_score(session_id)
    if not result:
        raise HTTPException(404, "Score not available yet")
    return SessionScoreOut(
        session_id=result["session_id"],
        document_id=result["document_id"],
        rubric=Rubric(**result["rubric"]),
        score=ScoreReport(**result["score"]),
        transcript=[TranscriptTurn(**t) for t in result["transcript"]],
    )


@router.get("", response_model=list[SessionSummaryOut])
def list_sessions() -> list[SessionSummaryOut]:
    return [SessionSummaryOut(**row) for row in list_session_scores()]


@router.get("/{session_id}/feedback", response_model=list[AnswerFeedback])
def get_feedback(session_id: str) -> list[AnswerFeedback]:
    result = get_session_score(session_id)
    if not result:
        raise HTTPException(404, "Session not found")
    try:
        return generate_answer_feedback(result["transcript"])
    except Exception as exc:
        raise HTTPException(502, "Could not generate answer feedback") from exc


@router.get("/{session_id}/chat", response_model=list[ChatMessageOut])
def get_chat(session_id: str) -> list[ChatMessageOut]:
    if not get_session_score(session_id):
        raise HTTPException(404, "Session not found")
    return [ChatMessageOut(**msg) for msg in get_chat_messages(session_id)]


@router.post("/{session_id}/chat", response_model=ChatOut)
def post_chat(session_id: str, body: ChatIn) -> ChatOut:
    result = get_session_score(session_id)
    if not result:
        raise HTTPException(404, "Session not found")
    if not body.message.strip():
        raise HTTPException(400, "message must not be empty")

    history = get_chat_messages(session_id)
    reply = chat_about_session(result["transcript"], result["score"], history, body.message)

    append_chat_message(session_id, "user", body.message)
    append_chat_message(session_id, "assistant", reply)

    return ChatOut(reply=reply)
