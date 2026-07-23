import os

from openai import OpenAI

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
CHAT_MODEL = "llama-3.3-70b-versatile"

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.environ["GROQ_API_KEY"], base_url=GROQ_BASE_URL)
    return _client


def _format_transcript(transcript: list[dict]) -> str:
    speaker = {"assistant": "INTERVIEWER", "user": "CANDIDATE"}
    lines = [
        f"{speaker.get(turn.get('role'), turn.get('role'))}: {turn.get('text')}"
        for turn in transcript
        if turn.get("text")
    ]
    return "\n".join(lines)


def _format_score(score: dict) -> str:
    lines = [f"Overall: {score.get('overall_score')}/100"]
    for s in score.get("scores", []):
        lines.append(f"- {s['criterion']}: {s['score_0_100']} - {s['justification']}")
    lines.append(f"Summary: {score.get('summary', '')}")
    return "\n".join(lines)


def _build_system_prompt(transcript: list[dict], score: dict) -> str:
    return (
        "You are Voca, helping a candidate review a mock interview they already "
        "completed. This is a text chat about that past interview - not a new "
        "interview. Do not ask interview questions or continue the interview. "
        "Answer their questions, explain the scoring, suggest how specific answers "
        "could have been better, and discuss anything else about the transcript "
        "below. Keep replies conversational and concise.\n\n"
        f"--- Interview transcript ---\n{_format_transcript(transcript)}\n\n"
        f"--- Score ---\n{_format_score(score)}"
    )


def chat_about_session(
    transcript: list[dict], score: dict, history: list[dict], user_message: str
) -> str:
    """
    history: prior turns as [{"role": "user"|"assistant", "text": str}, ...],
    oldest first. Returns the assistant's reply text.
    """
    client = _get_client()
    messages = [{"role": "system", "content": _build_system_prompt(transcript, score)}]
    for turn in history:
        role = "assistant" if turn["role"] == "assistant" else "user"
        messages.append({"role": role, "content": turn["text"]})
    messages.append({"role": "user", "content": user_message})

    response = client.chat.completions.create(
        model=CHAT_MODEL,
        messages=messages,
        temperature=0.5,
    )
    return response.choices[0].message.content or ""
