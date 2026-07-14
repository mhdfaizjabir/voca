import json
import os
import uuid

from fastapi import APIRouter, HTTPException
from livekit.api import AccessToken, VideoGrants
from livekit.protocol.room import RoomConfiguration
from pydantic import BaseModel

from db.local_store import get_document, get_session_score
from scoring.rubric import Rubric
from scoring.schemas import ScoreReport

router = APIRouter(prefix="/sessions", tags=["sessions"])


class StartSessionIn(BaseModel):
    document_id: str
    rubric: Rubric | None = None


class StartSessionOut(BaseModel):
    livekit_url: str
    token: str
    room_name: str


class SessionScoreOut(BaseModel):
    session_id: str
    document_id: str | None
    rubric: Rubric
    score: ScoreReport


@router.post("/start", response_model=StartSessionOut)
def start_session(body: StartSessionIn) -> StartSessionOut:
    if not get_document(body.document_id):
        raise HTTPException(404, "Document not found")

    room_name = f"interview-{uuid.uuid4()}"
    identity = f"user-{uuid.uuid4()}"

    metadata = {"document_id": body.document_id}
    if body.rubric:
        metadata["rubric"] = body.rubric.model_dump()

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
    )
