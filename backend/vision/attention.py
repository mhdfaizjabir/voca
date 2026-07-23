import math
import time
from pathlib import Path

import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

MODEL_PATH = Path(__file__).resolve().parent.parent / "agent" / "models" / "face_landmarker.task"

# Lenient / "real life" defaults: a quick glance away or down to think isn't
# penalized, only sustained turning away from the screen is.
YAW_LIMIT_DEG = 30.0
PITCH_LIMIT_DEG = 25.0
LOOK_AWAY_THRESHOLD_S = 3.0

# Stricter thresholds for real mock job interviews - tighter angle tolerance
# and a shorter grace period before a look-away counts.
JOB_YAW_LIMIT_DEG = 18.0
JOB_PITCH_LIMIT_DEG = 15.0
JOB_LOOK_AWAY_THRESHOLD_S = 2.0

_landmarker: mp_vision.FaceLandmarker | None = None


def _get_landmarker() -> mp_vision.FaceLandmarker:
    global _landmarker
    if _landmarker is None:
        if not MODEL_PATH.exists():
            raise FileNotFoundError(
                f"FaceLandmarker model not found at {MODEL_PATH}. "
                "Download it from https://storage.googleapis.com/mediapipe-models/"
                "face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
            )
        options = mp_vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(MODEL_PATH)),
            running_mode=mp_vision.RunningMode.VIDEO,
            num_faces=1,
            output_facial_transformation_matrixes=True,
            min_face_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        _landmarker = mp_vision.FaceLandmarker.create_from_options(options)
    return _landmarker


def _yaw_pitch_from_matrix(matrix: np.ndarray) -> tuple[float, float]:
    """
    Extract yaw/pitch (degrees) from MediaPipe's 4x4 facial transformation matrix
    via standard rotation-matrix -> Euler angle decomposition.

    NOTE: this has only been verified to run without error on synthetic input.
    The sign/axis convention has NOT been confirmed against a real face turning
    left/right/up/down (no camera in the dev environment this was built in) -
    run agent/test_attention.py with a webcam and eyeball it before trusting
    this in scoring.
    """
    r = matrix[:3, :3]
    sy = math.sqrt(r[0, 0] ** 2 + r[1, 0] ** 2)
    if sy > 1e-6:
        pitch = math.degrees(math.atan2(r[2, 1], r[2, 2]))
        yaw = math.degrees(math.atan2(-r[2, 0], sy))
    else:
        pitch = math.degrees(math.atan2(-r[1, 2], r[1, 1]))
        yaw = math.degrees(math.atan2(-r[2, 0], sy))
    return yaw, pitch


class AttentionTracker:
    """
    Tracks whether a candidate appears to be looking at the screen, sampled from
    periodic video frames. Only sustained (LOOK_AWAY_THRESHOLD_S) turning away or
    a missing face counts as an "away" event - brief glances don't.
    """

    def __init__(
        self,
        yaw_limit_deg: float = YAW_LIMIT_DEG,
        pitch_limit_deg: float = PITCH_LIMIT_DEG,
        look_away_threshold_s: float = LOOK_AWAY_THRESHOLD_S,
    ) -> None:
        self._yaw_limit_deg = yaw_limit_deg
        self._pitch_limit_deg = pitch_limit_deg
        self._look_away_threshold_s = look_away_threshold_s

        self._total_samples = 0
        self._attentive_samples = 0
        self._away_events = 0
        self._away_since: float | None = None
        self._away_event_counted = False
        self._total_away_seconds = 0.0
        self._no_face_samples = 0

    def process_frame(self, rgb_frame: np.ndarray, timestamp_ms: int) -> None:
        """Call with an RGB uint8 (H, W, 3) frame. CPU-bound - run off the event loop."""
        now = time.monotonic()
        self._total_samples += 1

        landmarker = _get_landmarker()
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        result = landmarker.detect_for_video(mp_image, timestamp_ms)

        attentive = False
        if result.face_landmarks and result.facial_transformation_matrixes:
            matrix = np.array(result.facial_transformation_matrixes[0]).reshape(4, 4)
            yaw, pitch = _yaw_pitch_from_matrix(matrix)
            attentive = abs(yaw) <= self._yaw_limit_deg and abs(pitch) <= self._pitch_limit_deg
        else:
            self._no_face_samples += 1

        if attentive:
            self._attentive_samples += 1
            if self._away_since is not None:
                self._total_away_seconds += now - self._away_since
            self._away_since = None
            self._away_event_counted = False
        else:
            if self._away_since is None:
                self._away_since = now
            elif not self._away_event_counted and now - self._away_since >= self._look_away_threshold_s:
                self._away_events += 1
                self._away_event_counted = True

    def get_summary(self) -> dict:
        # Flush an in-progress away streak into the total.
        total_away = self._total_away_seconds
        if self._away_since is not None:
            total_away += time.monotonic() - self._away_since

        attentive_fraction = (
            self._attentive_samples / self._total_samples if self._total_samples else 1.0
        )
        return {
            "total_samples": self._total_samples,
            "attentive_samples": self._attentive_samples,
            "attentive_fraction": round(attentive_fraction, 3),
            "away_events": self._away_events,
            "total_away_seconds": round(total_away, 1),
            "no_face_samples": self._no_face_samples,
        }
