import threading
from collections import deque

MAX_TURNS = 10

_lock = threading.Lock()
_sessions: dict[str, deque] = {}


def append_turn(session_id: str, role: str, text: str) -> None:
    """Appends a turn to the in-memory, per-session ring buffer. Oldest turns
    beyond MAX_TURNS are dropped automatically. This is short-term working
    memory only, scoped to this process - the durable transcript is saved
    separately (db/local_store.py) once the session ends."""
    with _lock:
        turns = _sessions.setdefault(session_id, deque(maxlen=MAX_TURNS))
        turns.append({"role": role, "text": text})


def get_recent_turns(session_id: str) -> list[dict]:
    with _lock:
        return list(_sessions.get(session_id, ()))


def clear_session(session_id: str) -> None:
    with _lock:
        _sessions.pop(session_id, None)
