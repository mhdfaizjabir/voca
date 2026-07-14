"use client";

import { useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";
const SCORE_POLL_INTERVAL_MS = 3000;
const SCORE_POLL_MAX_ATTEMPTS = 20;

type Document = {
  id: string;
  filename: string;
  resource_type: string;
  chunk_count: number;
};

type CallStatus = "idle" | "connecting" | "connected" | "error";

type CriterionScore = {
  criterion: string;
  score_0_100: number;
  justification: string;
};

type SessionScore = {
  score: {
    scores: CriterionScore[];
    overall_score: number;
    summary: string;
  };
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [resourceType, setResourceType] = useState("course_material");
  const [uploading, setUploading] = useState(false);
  const [document, setDocument] = useState<Document | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [callError, setCallError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [scoreStatus, setScoreStatus] = useState<"idle" | "polling" | "ready" | "timeout">("idle");
  const [sessionScore, setSessionScore] = useState<SessionScore | null>(null);
  const pollingRoomRef = useRef<string | null>(null);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    setDocument(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("resource_type", resourceType);

      const res = await fetch(`${API_URL}/documents/upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `Upload failed (${res.status})`);
      }

      setDocument(await res.json());
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function pollForScore(roomName: string) {
    if (pollingRoomRef.current === roomName) return;
    pollingRoomRef.current = roomName;
    setScoreStatus("polling");
    setSessionScore(null);

    for (let attempt = 0; attempt < SCORE_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, SCORE_POLL_INTERVAL_MS));
      const res = await fetch(`${API_URL}/sessions/${roomName}/score`);
      if (res.ok) {
        setSessionScore(await res.json());
        setScoreStatus("ready");
        return;
      }
    }
    setScoreStatus("timeout");
  }

  async function handleStartInterview() {
    if (!document) return;
    setCallStatus("connecting");
    setCallError(null);
    setScoreStatus("idle");
    setSessionScore(null);
    pollingRoomRef.current = null;

    try {
      const res = await fetch(`${API_URL}/sessions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: document.id }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `Could not start session (${res.status})`);
      }

      const { livekit_url, token, room_name } = await res.json();

      const room = new Room();
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && audioRef.current) {
          track.attach(audioRef.current);
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        setCallStatus("idle");
        pollForScore(room_name);
      });

      await room.connect(livekit_url, token);
      await room.localParticipant.setMicrophoneEnabled(true);

      setCallStatus("connected");
    } catch (err) {
      setCallError(err instanceof Error ? err.message : "Could not start session");
      setCallStatus("error");
    }
  }

  function handleEndInterview() {
    roomRef.current?.disconnect();
    roomRef.current = null;
  }

  return (
    <main style={{ maxWidth: 560, margin: "40px auto", padding: 16, fontFamily: "sans-serif" }}>
      <h1>Voca AI — test console</h1>

      <section style={{ marginBottom: 32 }}>
        <h2>1. Upload a document</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 360 }}>
          <select value={resourceType} onChange={(e) => setResourceType(e.target.value)}>
            <option value="course_material">Course material (viva practice)</option>
            <option value="job_description">Job description (mock interview)</option>
          </select>
          <input
            type="file"
            accept=".pdf,.txt"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button onClick={handleUpload} disabled={!file || uploading}>
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
        {uploadError && <p style={{ color: "crimson" }}>{uploadError}</p>}
        {document && (
          <p>
            Uploaded <strong>{document.filename}</strong> ({document.chunk_count} chunk
            {document.chunk_count === 1 ? "" : "s"}) — id <code>{document.id}</code>
          </p>
        )}
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2>2. Start the interview</h2>
        {callStatus !== "connected" ? (
          <button onClick={handleStartInterview} disabled={!document || callStatus === "connecting"}>
            {callStatus === "connecting" ? "Connecting…" : "Start interview"}
          </button>
        ) : (
          <button onClick={handleEndInterview}>End interview</button>
        )}
        <p>Status: {callStatus}</p>
        {callError && <p style={{ color: "crimson" }}>{callError}</p>}
        <audio ref={audioRef} autoPlay />
      </section>

      <section>
        <h2>3. Score</h2>
        {scoreStatus === "idle" && <p>End the interview to get a score.</p>}
        {scoreStatus === "polling" && <p>Scoring your interview…</p>}
        {scoreStatus === "timeout" && <p style={{ color: "crimson" }}>Scoring took too long — try again.</p>}
        {scoreStatus === "ready" && sessionScore && (
          <div>
            <p>
              <strong>Overall: {sessionScore.score.overall_score}/100</strong>
            </p>
            <ul>
              {sessionScore.score.scores.map((s) => (
                <li key={s.criterion}>
                  <strong>{s.criterion}: {s.score_0_100}</strong> — {s.justification}
                </li>
              ))}
            </ul>
            <p>{sessionScore.score.summary}</p>
          </div>
        )}
      </section>
    </main>
  );
}
