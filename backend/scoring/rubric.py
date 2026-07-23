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


CAMERA_ATTENTION_CRITERION = "Camera Attention"

# No camera/proctoring purpose for course-material (viva) practice.
DEFAULT_RUBRIC_NO_CAMERA = Rubric(
    criteria=[
        RubricCriterion(criterion="Clarity", weight=30),
        RubricCriterion(criterion="Relevance", weight=40),
        RubricCriterion(criterion="Confidence", weight=30),
    ]
)

# Job interviews get the stricter, camera-aware rubric.
DEFAULT_RUBRIC = Rubric(
    criteria=[
        RubricCriterion(criterion="Clarity", weight=25),
        RubricCriterion(criterion="Relevance", weight=35),
        RubricCriterion(criterion="Confidence", weight=25),
        RubricCriterion(criterion=CAMERA_ATTENTION_CRITERION, weight=15),
    ]
)


def default_rubric_for(resource_type: str | None) -> Rubric:
    return DEFAULT_RUBRIC if resource_type == "job_description" else DEFAULT_RUBRIC_NO_CAMERA
