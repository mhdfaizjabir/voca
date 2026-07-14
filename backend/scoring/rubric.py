from pydantic import BaseModel, model_validator


class RubricCriterion(BaseModel):
    criterion: str
    weight: float  # percentage points; all criteria must sum to 100


class Rubric(BaseModel):
    criteria: list[RubricCriterion]

    @model_validator(mode="after")
    def _weights_sum_to_100(self) -> "Rubric":
        total = sum(c.weight for c in self.criteria)
        if abs(total - 100) > 0.5:
            raise ValueError(f"Rubric weights must sum to 100, got {total}")
        return self


DEFAULT_RUBRIC = Rubric(
    criteria=[
        RubricCriterion(criterion="Clarity", weight=30),
        RubricCriterion(criterion="Relevance", weight=40),
        RubricCriterion(criterion="Confidence", weight=30),
    ]
)
