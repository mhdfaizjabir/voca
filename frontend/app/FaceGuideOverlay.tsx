"use client";

import { useEffect, useRef, useState } from "react";
import type { FaceLandmarker as FaceLandmarkerType } from "@mediapipe/tasks-vision";

// MediaPipe's WASM runtime prints benign INFO lines (e.g. the "Created TensorFlow
// Lite XNNPACK delegate for CPU" notice) through console.error, which trips
// Next.js's dev error overlay. Swallow only those exact known-benign messages so
// real errors still surface. Installed once, guarded against double-patching.
if (typeof window !== "undefined" && !(window as unknown as { __mpLogPatched?: boolean }).__mpLogPatched) {
  (window as unknown as { __mpLogPatched?: boolean }).__mpLogPatched = true;
  const benign = /XNNPACK|TensorFlow Lite|Created TensorFlow/i;
  (["error", "info", "warn"] as const).forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (typeof args[0] === "string" && benign.test(args[0])) return;
      original(...(args as []));
    };
  });
}

// Mirrors backend/vision/attention.py's JOB_* thresholds so the live on-screen
// guide matches what the server-side scorer will actually judge.
const YAW_LIMIT_DEG = 18;
const PITCH_LIMIT_DEG = 15;

// Run detection at ~5fps, not every animation frame (~60fps) - the WASM
// runtime doesn't handle being hammered at full frame rate well, and this
// is plenty smooth for a live posture guide.
const DETECT_INTERVAL_MS = 200;

function yawPitchFromMatrix(data: number[]): [number, number] {
  // data is a flattened 4x4 row-major matrix; rotation is the top-left 3x3.
  const r = (row: number, col: number) => data[row * 4 + col];
  const sy = Math.sqrt(r(0, 0) ** 2 + r(1, 0) ** 2);
  let pitch: number;
  let yaw: number;
  if (sy > 1e-6) {
    pitch = Math.atan2(r(2, 1), r(2, 2)) * (180 / Math.PI);
    yaw = Math.atan2(-r(2, 0), sy) * (180 / Math.PI);
  } else {
    pitch = Math.atan2(-r(1, 2), r(1, 1)) * (180 / Math.PI);
    yaw = Math.atan2(-r(2, 0), sy) * (180 / Math.PI);
  }
  return [yaw, pitch];
}

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  active: boolean;
};

export default function FaceGuideOverlay({ videoRef, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const landmarkerRef = useRef<FaceLandmarkerType | null>(null);
  const rafRef = useRef<number | null>(null);
  const [status, setStatus] = useState<"loading" | "no-face" | "ok" | "away">("loading");

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function init() {
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
      );
      if (cancelled) return;
      landmarkerRef.current = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: "/models/face_landmarker.task" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFacialTransformationMatrixes: true,
      });
      if (!cancelled) setStatus("no-face");
    }

    init().catch((err) => {
      console.error("Face guide failed to load", err);
    });

    return () => {
      cancelled = true;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let lastDetectMs = 0;

    function tick() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const landmarker = landmarkerRef.current;
      const now = performance.now();

      if (video && canvas && landmarker && video.readyState >= 2 && now - lastDetectMs >= DETECT_INTERVAL_MS) {
        lastDetectMs = now;
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const result = landmarker.detectForVideo(video, now);

          if (result.faceLandmarks.length > 0) {
            const landmarks = result.faceLandmarks[0];
            let minX = 1, minY = 1, maxX = 0, maxY = 0;
            for (const p of landmarks) {
              minX = Math.min(minX, p.x);
              minY = Math.min(minY, p.y);
              maxX = Math.max(maxX, p.x);
              maxY = Math.max(maxY, p.y);
            }
            const boxX = minX * canvas.width;
            const boxY = minY * canvas.height;
            const boxW = (maxX - minX) * canvas.width;
            const boxH = (maxY - minY) * canvas.height;

            let attentive = true;
            if (result.facialTransformationMatrixes.length > 0) {
              const [yaw, pitch] = yawPitchFromMatrix(result.facialTransformationMatrixes[0].data);
              attentive = Math.abs(yaw) <= YAW_LIMIT_DEG && Math.abs(pitch) <= PITCH_LIMIT_DEG;
            }

            ctx.strokeStyle = attentive ? "#22c55e" : "#ef4444";
            ctx.lineWidth = 3;
            ctx.strokeRect(boxX, boxY, boxW, boxH);
            setStatus(attentive ? "ok" : "away");
          } else {
            setStatus("no-face");
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [active, videoRef]);

  if (!active) return null;

  const statusText: Record<typeof status, string> = {
    loading: "Loading camera guide...",
    "no-face": "No face detected - make sure you're centered in frame",
    ok: "Sitting properly - eyes on screen",
    away: "Please face the camera and sit up straight",
  };
  const statusColor: Record<typeof status, string> = {
    loading: "#9498a8",
    "no-face": "#fbbf24",
    ok: "#34d399",
    away: "#f87171",
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          transform: "scaleX(-1)",
          pointerEvents: "none",
          borderRadius: 14,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 8,
          right: 8,
          bottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          borderRadius: 999,
          background: "rgba(7,8,13,0.72)",
          backdropFilter: "blur(6px)",
          border: `1px solid ${statusColor[status]}55`,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: statusColor[status],
            flexShrink: 0,
          }}
        />
        <span style={{ color: statusColor[status], fontWeight: 600, fontSize: 11.5, lineHeight: 1.3 }}>
          {statusText[status]}
        </span>
      </div>
    </>
  );
}
