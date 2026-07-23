import json
import os

from openai import OpenAI
from pydantic import BaseModel

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
FEEDBACK_MODEL = "llama-3.3-70b-versatile"
MAX_ATTEMPTS = 2
MAX_ITEMS = 6

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.environ["GROQ_API_KEY"], base_url=GROQ_BASE_URL)
    return _client


class AnswerFeedback(BaseModel):
    question: str  # the interviewer question this answer responded to (paraphrased if needed)
    answer_excerpt: str  # a short quote/summary of what the candidate said
    verdict: str  # "strong" | "ok" | "weak"
    tip: str  # one concrete, actionable suggestion


def _format_transcript(transcript: list[dict]) -> str:
    speaker = {"assistant": "INTERVIEWER", "user": "CANDIDATE"}
    lines = [
        f"{speaker.get(turn.get('role'), turn.get('role'))}: {turn.get('text')}"
        for turn in transcript
        if turn.get("text")
    ]
    return "\n".join(lines)


def _build_messages(transcript: list[dict]) -> list[dict]:
    system = (
        "You are an interview coach reviewing a completed practice interview. For the "
        f"candidate's {MAX_ITEMS} most important answers, give per-answer feedback. For "
        "each, identify the interviewer's question it addressed, quote or tightly "
        "summarize the answer, judge it as 'strong', 'ok', or 'weak', and give ONE "
        "concrete, actionable tip to improve it (specific to what they said - not "
        "generic advice). Focus on the answers that matter most; skip greetings and "
        "filler exchanges.\n\n"
        "Respond with strict JSON only, no prose outside the JSON, in exactly this "
        'shape:\n{"items": [{"question": string, "answer_excerpt": string, '
        '"verdict": "strong"|"ok"|"weak", "tip": string}, ...]}'
    )
    user = f"Transcript:\n{_format_transcript(transcript)}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def generate_answer_feedback(transcript: list[dict]) -> list[AnswerFeedback]:
    """Runs a single LLM pass over the transcript and returns per-answer feedback.
    Returns an empty list if there's nothing substantive to review."""
    candidate_turns = [t for t in transcript if t.get("role") == "user" and t.get("text")]
    if not candidate_turns:
        return []

    client = _get_client()
    messages = _build_messages(transcript)

    last_error: Exception | None = None
    for _ in range(MAX_ATTEMPTS):
        response = client.chat.completions.create(
            model=FEEDBACK_MODEL,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.3,
        )
        raw = response.choices[0].message.content
        try:
            data = json.loads(raw)
            items = [AnswerFeedback(**item) for item in data.get("items", [])]
            valid = [i for i in items if i.verdict in ("strong", "ok", "weak")]
            return valid[:MAX_ITEMS]
        except Exception as e:  # malformed JSON or shape mismatch -> retry once
            last_error = e
            messages.append(
                {"role": "user", "content": f"That response was invalid ({e}). Return only the corrected strict JSON."}
            )

    raise RuntimeError(f"Answer feedback failed after {MAX_ATTEMPTS} attempts: {last_error}")
