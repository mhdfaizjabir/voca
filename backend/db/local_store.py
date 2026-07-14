import json
import sqlite3
import uuid
from pathlib import Path

# Temporary stand-in for document metadata until the Mongo layer
# (db/mongo_client.py, db/repository.py) lands. Same document_id-keyed
# lookup shape, so swapping the backing store later doesn't touch callers.
DB_PATH = Path(__file__).resolve().parent.parent / "local.sqlite3"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                resource_type TEXT NOT NULL,
                chunk_count INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS session_scores (
                session_id TEXT PRIMARY KEY,
                document_id TEXT,
                transcript_json TEXT NOT NULL,
                rubric_json TEXT NOT NULL,
                score_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )


_init()


def create_document(filename: str, resource_type: str, chunk_count: int) -> str:
    document_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO documents (id, filename, resource_type, chunk_count) VALUES (?, ?, ?, ?)",
            (document_id, filename, resource_type, chunk_count),
        )
    return document_id


def get_document(document_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
    return dict(row) if row else None


def list_documents() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM documents ORDER BY created_at DESC").fetchall()
    return [dict(row) for row in rows]


def save_session_score(
    session_id: str, document_id: str | None, transcript: list[dict], rubric: dict, score: dict
) -> None:
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO session_scores (session_id, document_id, transcript_json, rubric_json, score_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                document_id = excluded.document_id,
                transcript_json = excluded.transcript_json,
                rubric_json = excluded.rubric_json,
                score_json = excluded.score_json
            """,
            (session_id, document_id, json.dumps(transcript), json.dumps(rubric), json.dumps(score)),
        )


def get_session_score(session_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM session_scores WHERE session_id = ?", (session_id,)
        ).fetchone()
    if not row:
        return None
    result = dict(row)
    result["transcript"] = json.loads(result.pop("transcript_json"))
    result["rubric"] = json.loads(result.pop("rubric_json"))
    result["score"] = json.loads(result.pop("score_json"))
    return result
