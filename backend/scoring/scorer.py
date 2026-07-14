import json
import os

from openai import OpenAI

from scoring.rubric import DEFAULT_RUBRIC, Rubric
from scoring.schemas import CriterionScore, ScoreReport, TranscriptTurn

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
SCORING_MODEL = "llama-3.3-70b-versatile"
MAX_ATTEMPTS = 2

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.environ["GROQ_API_KEY"], base_url=GROQ_BASE_URL)
    return _client


def _format_transcript(transcript: list[TranscriptTurn]) -> str:
    speaker = {"assistant": "INTERVIEWER", "user": "CANDIDATE"}
    lines = [
        f"{speaker[turn.role]}: {turn.text}" for turn in transcript if turn.role in speaker and turn.text
    ]
    return "\n".join(lines)


def _build_messages(transcript: list[TranscriptTurn], rubric: Rubric) -> list[dict]:
    criteria_lines = "\n".join(f"- {c.criterion} (weight {c.weight}%)" for c in rubric.criteria)
    criteria_names = [c.criterion for c in rubric.criteria]

    system = (
        "You are an interview evaluator. Score the candidate's performance in the "
        "transcript below against each rubric criterion, on a 0-100 scale, with a "
        "one to two sentence justification per criterion grounded in what the "
        "candidate actually said. Then write a 2-3 sentence overall summary.\n\n"
        f"Rubric criteria:\n{criteria_lines}\n\n"
        "Respond with strict JSON only, no prose outside the JSON, in exactly this "
        "shape:\n"
        '{"scores": [{"criterion": string, "score_0_100": integer, '
        '"justification": string}, ...], "summary": string}\n\n'
        f"You must return exactly these criteria, in this order: {criteria_names}."
    )
    user = f"Transcript:\n{_format_transcript(transcript)}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def score_transcript(transcript: list[TranscriptTurn], rubric: Rubric = DEFAULT_RUBRIC) -> ScoreReport:
    client = _get_client()
    messages = _build_messages(transcript, rubric)

    last_error: Exception | None = None
    for _ in range(MAX_ATTEMPTS):
        response = client.chat.completions.create(
            model=SCORING_MODEL,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.2,
        )
        raw = response.choices[0].message.content

        try:
            data = json.loads(raw)
            scores = [CriterionScore(**s) for s in data["scores"]]
            if len(scores) != len(rubric.criteria):
                raise ValueError(f"Expected {len(rubric.criteria)} criterion scores, got {len(scores)}")

            # Overall score is our own weighted average, never the model's arithmetic.
            overall = sum(s.score_0_100 * (c.weight / 100) for s, c in zip(scores, rubric.criteria))

            return ScoreReport(scores=scores, overall_score=round(overall, 1), summary=data["summary"])
        except Exception as e:  # malformed JSON or shape mismatch -> retry once
            last_error = e
            messages.append(
                {"role": "user", "content": f"That response was invalid ({e}). Return only the corrected strict JSON."}
            )

    raise RuntimeError(f"Scoring failed after {MAX_ATTEMPTS} attempts: {last_error}")
