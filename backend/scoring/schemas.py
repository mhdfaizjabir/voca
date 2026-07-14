from pydantic import BaseModel


class CriterionScore(BaseModel):
    criterion: str
    score_0_100: int
    justification: str


class ScoreReport(BaseModel):
    scores: list[CriterionScore]
    overall_score: float
    summary: str


class TranscriptTurn(BaseModel):
    role: str
    text: str
