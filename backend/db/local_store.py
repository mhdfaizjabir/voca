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
        # Tier-0 cache for company research (see research/company_research.py).
        # Keyed on a normalized company name so repeat sessions for the same
        # company skip straight past tier 1 (parametric LLM) and tier 2 (web search).
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS companies (
                name TEXT PRIMARY KEY,
                research_json TEXT NOT NULL,
                source TEXT NOT NULL,
                confidence INTEGER,
                fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        # Text-only follow-up chat about a past interview (not a new interview -
        # see chat/review_chat.py). Separate table so it can grow independently
        # of session_scores without needing a migration.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS session_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                text TEXT NOT NULL,
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


def list_session_scores() -> list[dict]:
    """Summaries only (no transcript/rubric bodies) - enough for a history list."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT session_id, document_id, score_json, created_at FROM session_scores "
            "ORDER BY created_at DESC"
        ).fetchall()
    results = []
    for row in rows:
        item = dict(row)
        score = json.loads(item.pop("score_json"))
        item["overall_score"] = score.get("overall_score")
        item["summary"] = score.get("summary")
        results.append(item)
    return results


def append_chat_message(session_id: str, role: str, text: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO session_chat_messages (session_id, role, text) VALUES (?, ?, ?)",
            (session_id, role, text),
        )


def get_chat_messages(session_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, text, created_at FROM session_chat_messages "
            "WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def _normalize_company_name(name: str) -> str:
    return " ".join(name.strip().lower().split())


def get_company_research(name: str) -> dict | None:
    key = _normalize_company_name(name)
    with _connect() as conn:
        row = conn.execute("SELECT * FROM companies WHERE name = ?", (key,)).fetchone()
    if not row:
        return None
    result = dict(row)
    result["research"] = json.loads(result.pop("research_json"))
    return result


def save_company_research(name: str, research: dict, source: str, confidence: int | None = None) -> None:
    key = _normalize_company_name(name)
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO companies (name, research_json, source, confidence, fetched_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(name) DO UPDATE SET
                research_json = excluded.research_json,
                source = excluded.source,
                confidence = excluded.confidence,
                fetched_at = excluded.fetched_at
            """,
            (key, json.dumps(research), source, confidence),
        )