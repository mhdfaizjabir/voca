import json
import os

from openai import OpenAI

from scoring.rubric import CAMERA_ATTENTION_CRITERION, DEFAULT_RUBRIC, Rubric
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


def _camera_attention_score(attention_summary: dict | None) -> CriterionScore:
    """Computed directly from the tracker's numbers - the LLM never sees video, so
    this criterion is never asked of the model."""
    if not attention_summary or attention_summary.get("total_samples", 0) == 0:
        return CriterionScore(
            criterion=CAMERA_ATTENTION_CRITERION,
            score_0_100=100,
            justification="No camera data was available for this session, so attention wasn't scored.",
        )

    fraction = attention_summary.get("attentive_fraction", 1.0)
    away_events = attention_summary.get("away_events", 0)
    away_seconds = attention_summary.get("total_away_seconds", 0.0)
    score = round(fraction * 100)

    if away_events == 0:
        justification = f"Stayed focused on the screen throughout the interview ({score}% of sampled frames)."
    else:
        justification = (
            f"Looked at the screen for {score}% of sampled frames, with {away_events} sustained "
            f"look-away moment(s) totaling ~{away_seconds:.1f}s."
        )

    return CriterionScore(criterion=CAMERA_ATTENTION_CRITERION, score_0_100=score, justification=justification)


def _build_messages(criteria: list, transcript: list[TranscriptTurn]) -> list[dict]:
    criteria_lines = "\n".join(f"- {c.criterion} (weight {c.weight}%)" for c in criteria)
    criteria_names = [c.criterion for c in criteria]

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


def score_transcript(
    transcript: list[TranscriptTurn],
    rubric: Rubric = DEFAULT_RUBRIC,
    attention_summary: dict | None = None,
) -> ScoreReport:
    client = _get_client()

    # The LLM only ever sees text - Camera Attention is scored deterministically
    # below, not judged by the model.
    llm_criteria = [c for c in rubric.criteria if c.criterion != CAMERA_ATTENTION_CRITERION]
    messages = _build_messages(llm_criteria, transcript)

    last_error: Exception | None = None
    llm_scores: list[CriterionScore] | None = None
    summary_text = ""

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
            if len(scores) != len(llm_criteria):
                raise ValueError(f"Expected {len(llm_criteria)} criterion scores, got {len(scores)}")
            llm_scores = scores
            summary_text = data["summary"]
            break
        except Exception as e:  # malformed JSON or shape mismatch -> retry once
            last_error = e
            messages.append(
                {"role": "user", "content": f"That response was invalid ({e}). Return only the corrected strict JSON."}
            )

    if llm_scores is None:
        raise RuntimeError(f"Scoring failed after {MAX_ATTEMPTS} attempts: {last_error}")

    scores_by_criterion = {s.criterion: s for s in llm_scores}
    if any(c.criterion == CAMERA_ATTENTION_CRITERION for c in rubric.criteria):
        scores_by_criterion[CAMERA_ATTENTION_CRITERION] = _camera_attention_score(attention_summary)

    # Reassemble in the rubric's own order so the weighted average lines up.
    scores = [scores_by_criterion[c.criterion] for c in rubric.criteria]

    # Overall score is our own weighted average, never the model's arithmetic.
    overall = sum(s.score_0_100 * (c.weight / 100) for s, c in zip(scores, rubric.criteria))

    return ScoreReport(scores=scores, overall_score=round(overall, 1), summary=summary_text)
