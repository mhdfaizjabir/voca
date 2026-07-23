#!/usr/bin/env python
"""
Manual calibration tool for the camera-attention tracker.

Opens your webcam, runs each frame through AttentionTracker, and overlays the
live yaw/pitch readings and attentive/away status so you can visually confirm
the numbers behave as expected:
  - Look straight at the screen -> should read "ATTENTIVE"
  - Turn your head left/right past a comfortable angle -> yaw should grow and
    it should flip to "AWAY" after ~3 sustained seconds
  - Tilt your head up/down -> pitch should grow similarly

Press 'q' in the video window to quit and print the session summary.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2

from vision.attention import (
    AttentionTracker,
    YAW_LIMIT_DEG,
    PITCH_LIMIT_DEG,
    _yaw_pitch_from_matrix,
    _get_landmarker,
)
import mediapipe as mp
import numpy as np


def main() -> None:
    tracker = AttentionTracker()
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Could not open webcam (index 0).")
        return

    print("Press 'q' in the video window to stop.\n")
    start = time.monotonic()

    try:
        while True:
            ok, frame_bgr = cap.read()
            if not ok:
                print("Failed to read frame from webcam.")
                break

            rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            timestamp_ms = int((time.monotonic() - start) * 1000)

            landmarker = _get_landmarker()
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = landmarker.detect_for_video(mp_image, timestamp_ms)

            if result.face_landmarks and result.facial_transformation_matrixes:
                matrix = np.array(result.facial_transformation_matrixes[0]).reshape(4, 4)
                yaw, pitch = _yaw_pitch_from_matrix(matrix)
                attentive = abs(yaw) <= YAW_LIMIT_DEG and abs(pitch) <= PITCH_LIMIT_DEG
                status = "ATTENTIVE" if attentive else "AWAY (angle)"
                label = f"yaw={yaw:6.1f}  pitch={pitch:6.1f}  {status}"
                color = (0, 255, 0) if attentive else (0, 0, 255)
            else:
                label = "no face detected - AWAY"
                color = (0, 0, 255)

            tracker.process_frame(rgb, timestamp_ms)
            summary = tracker.get_summary()

            cv2.putText(frame_bgr, label, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
            cv2.putText(
                frame_bgr,
                f"away_events={summary['away_events']}  away_s={summary['total_away_seconds']}",
                (10, 60),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                (0, 200, 255),
                2,
            )
            cv2.imshow("Attention calibration - press q to quit", frame_bgr)

            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()

    print("\nSession summary:")
    print(tracker.get_summary())


if __name__ == "__main__":
    main()
