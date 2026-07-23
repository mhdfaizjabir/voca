"use client";

import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import FaceGuideOverlay from "./FaceGuideOverlay";
import ReviewChat from "./ReviewChat";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";
const SCORE_POLL_INTERVAL_MS = 3000;
const SCORE_POLL_MAX_ATTEMPTS = 20;
const HISTORY_STORAGE_KEY = "voca_interview_history";
const TRANSCRIPTION_TOPIC = "lk.transcription";
const FILLER_RE = /\b(um+|uh+|er+|like|you know|basically|actually|literally|kind of|sort of|i mean)\b/gi;

type HistoryEntry = { sessionId: string; documentId: string; createdAt: string; score?: number };

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

type TranscriptTurn = { role: string; text: string };

type SessionScore = {
  score: {
    scores: CriterionScore[];
    overall_score: number;
    summary: string;
  };
  transcript?: TranscriptTurn[];
};

type LiveCaption = { id: string; speaker: "ai" | "you"; text: string; final: boolean };

type AnswerFeedback = {
  question: string;
  answer_excerpt: string;
  verdict: "strong" | "ok" | "weak";
  tip: string;
};

type Persona = "friendly" | "balanced" | "tough";
type Difficulty = "easy" | "normal" | "hard";
type Voice = "thalia" | "apollo" | "helena" | "arcas";

type SessionAnalytics = {
  createdAt: string;
  overall: number;
  criteria: { criterion: string; score: number }[];
  fillers: number;
};

type StepState = "pending" | "active" | "done";
type View = "landing" | "practice" | "chat" | "analytics";
type OrbState = "connecting" | "speaking" | "listening" | "idle";

const VERDICT_STYLE: Record<AnswerFeedback["verdict"], { label: string; fg: string; soft: string; border: string }> = {
  strong: { label: "Strong", fg: "var(--good)", soft: "var(--good-soft)", border: "var(--good-border)" },
  ok: { label: "OK", fg: "var(--warn)", soft: "var(--warn-soft)", border: "var(--warn-border)" },
  weak: { label: "Needs work", fg: "var(--bad)", soft: "var(--bad-soft)", border: "var(--bad-border)" },
};

function scoreColor(score: number): { fg: string; soft: string; border: string } {
  if (score >= 75) return { fg: "var(--good)", soft: "var(--good-soft)", border: "var(--good-border)" };
  if (score >= 50) return { fg: "var(--warn)", soft: "var(--warn-soft)", border: "var(--warn-border)" };
  return { fg: "var(--bad)", soft: "var(--bad-soft)", border: "var(--bad-border)" };
}

function scoreHex(score: number): string {
  if (score >= 75) return "#34d399";
  if (score >= 50) return "#fbbf24";
  return "#f87171";
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): number {
  const words = text.split(/\s+/);
  let line = "";
  let lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = words[i];
      y += lineHeight;
      lines++;
      if (lines >= maxLines - 1 && i < words.length - 1) {
        // last allowed line — truncate the remainder with an ellipsis
        let rest = words.slice(i).join(" ");
        while (ctx.measureText(`${rest}…`).width > maxWidth && rest.length > 0) rest = rest.slice(0, -1);
        ctx.fillText(`${rest}…`, x, y);
        return y + lineHeight;
      }
    } else {
      line = test;
    }
  }
  if (line) {
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
  return y;
}

function letterGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "A-";
  if (score >= 73) return "B";
  if (score >= 65) return "B-";
  if (score >= 55) return "C";
  if (score >= 45) return "D";
  return "E";
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function transcriptStats(transcript: TranscriptTurn[]) {
  const you = transcript.filter((t) => t.role === "user" && t.text);
  const text = you.map((t) => t.text).join(" ");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const fillers = (text.match(FILLER_RE) ?? []).length;
  const answers = you.length;
  const avgWords = answers ? Math.round(words / answers) : 0;
  return { words, fillers, answers, avgWords };
}

function BookIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5C4 4.67 4.67 4 5.5 4H11a1 1 0 0 1 1 1v15a1 1 0 0 0-1-1H5.5A1.5 1.5 0 0 1 4 17.5v-12Z" />
      <path d="M20 5.5c0-.83-.67-1.5-1.5-1.5H13a1 1 0 0 0-1 1v15a1 1 0 0 1 1-1h5.5a1.5 1.5 0 0 0 1.5-1.5v-12Z" />
    </svg>
  );
}

function BriefcaseIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7.5" width="18" height="12" rx="2" />
      <path d="M8 7.5V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.5" />
      <path d="M3 12.5h18" />
      <path d="M10.5 12.5v1.2a1.5 1.5 0 0 0 1.5 1.5c.83 0 1.5-.67 1.5-1.5v-1.2" />
    </svg>
  );
}

function MicIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function ScoreIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M12 20V4M20 20v-6" />
    </svg>
  );
}

function UploadIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4M7 8.5 12 4l5 4.5" />
      <path d="M4 17.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" />
    </svg>
  );
}

function StepRow({
  n,
  title,
  state,
  last,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  last?: boolean;
  children: React.ReactNode;
}) {
  const badgeClasses =
    state === "done"
      ? "bg-[var(--good-soft)] border-[var(--good-border)] text-[var(--good)]"
      : state === "active"
      ? "bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent-bright)]"
      : "bg-white/[0.03] border-[var(--border)] text-[var(--text-dim)]";

  return (
    <div className="flex gap-4 animate-in" style={{ animationDelay: `${n * 70}ms` }}>
      <div className="flex flex-col items-center pt-1">
        <div className={`w-8 h-8 shrink-0 rounded-full grid place-items-center text-xs font-semibold border transition-colors duration-300 ${badgeClasses}`}>
          {state === "done" ? "✓" : n}
        </div>
        {!last && <div className="w-px flex-1 min-h-[20px] mt-1 bg-[var(--border)]" />}
      </div>
      <div className={`glass flex-1 p-5 md:p-6 mb-2 transition-opacity duration-300 ${state === "pending" ? "opacity-60" : "opacity-100"}`}>
        <h3 className="font-medium mb-4 text-[15px] tracking-tight">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex p-1 rounded-[12px] bg-white/[0.03] border border-[var(--border)] gap-1 flex-wrap">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3.5 py-1.5 rounded-[9px] text-[13px] font-medium transition-all duration-150 ${
            value === opt.value
              ? "bg-[var(--accent)] text-white shadow-[0_2px_10px_rgba(124,108,255,0.35)]"
              : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-white/[0.04]"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ScoreRing({ value, size = 96 }: { value: number; size?: number }) {
  const c = scoreColor(value);
  const inset = Math.round(size * 0.0625);
  return (
    <div
      className="relative rounded-full grid place-items-center shrink-0"
      style={{ width: size, height: size, background: `conic-gradient(${c.fg} ${value * 3.6}deg, rgba(255,255,255,0.06) 0deg)` }}
    >
      <div className="absolute rounded-full grid place-items-center" style={{ inset, background: "var(--bg-elevated)" }}>
        <span className="font-semibold tracking-tight" style={{ fontSize: size * 0.26 }}>
          {value}
        </span>
      </div>
    </div>
  );
}

function CriterionBar({ criterion, score_0_100, justification }: CriterionScore) {
  const c = scoreColor(score_0_100);
  return (
    <div className="py-3 border-b border-[var(--border)] last:border-0">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[13.5px] font-medium">{criterion}</span>
        <span className="text-[13px] font-semibold" style={{ color: c.fg }}>
          {score_0_100}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.05] overflow-hidden mb-1.5">
        <div className="h-full rounded-full transition-all duration-700 ease-out" style={{ width: `${score_0_100}%`, background: c.fg }} />
      </div>
      <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed">{justification}</p>
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="glass p-3.5 flex-1 min-w-[92px]">
      <p className="text-[11px] uppercase tracking-wide text-[var(--text-dim)] mb-1">{label}</p>
      <p className="text-[20px] font-semibold tracking-tight leading-none">{value}</p>
      {hint && <p className="text-[11px] text-[var(--text-dim)] mt-1">{hint}</p>}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 200;
  const h = 44;
  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y] as const;
  });
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-bright)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--accent-bright)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${last[0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`} fill="url(#spark)" />
      <path d={d} fill="none" stroke="var(--accent-bright)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={3} fill="var(--accent-bright)" />
    </svg>
  );
}

function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spin-soft inline-block rounded-full border-2 border-white/25 border-t-white" style={{ width: size, height: size }} />;
}

function LineChart({ points, yMax, unit = "" }: { points: { label: string; value: number }[]; yMax?: number; unit?: string }) {
  const w = 640;
  const h = 200;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const values = points.map((p) => p.value);
  const top = yMax ?? Math.max(1, ...values) * 1.15;
  const x = (i: number) => padL + (points.length === 1 ? 0 : (i / (points.length - 1)) * (w - padL - padR));
  const y = (v: number) => padT + (1 - v / top) * (h - padT - padB);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const gridVals = [0, top / 2, top];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxWidth: "100%" }}>
      <defs>
        <linearGradient id="lc" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-bright)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent-bright)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {gridVals.map((gv, i) => (
        <g key={i}>
          <line x1={padL} y1={y(gv)} x2={w - padR} y2={y(gv)} stroke="var(--border)" strokeWidth={1} />
          <text x={padL - 6} y={y(gv) + 4} textAnchor="end" fontSize={11} fill="var(--text-dim)">
            {Math.round(gv)}
            {unit}
          </text>
        </g>
      ))}
      {points.length > 1 && <path d={`${line} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill="url(#lc)" />}
      <path d={line} fill="none" stroke="var(--accent-bright)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.value)} r={3.5} fill="var(--accent-bright)" />
          {(points.length <= 8 || i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0) && (
            <text x={x(i)} y={h - 8} textAnchor="middle" fontSize={10.5} fill="var(--text-dim)">
              {p.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function VoiceOrb({ level, state }: { level: number; state: OrbState }) {
  const color =
    state === "speaking" ? "var(--accent-bright)" : state === "listening" ? "var(--good)" : "var(--text-dim)";
  const colorDeep =
    state === "speaking" ? "var(--accent)" : state === "listening" ? "#1d9c74" : "#3a3d4c";
  const active = state === "speaking" || state === "listening";
  const scale = 1 + (active ? level * 0.32 : 0);
  const glow = active ? 40 + level * 90 : 22;

  return (
    <div className="relative grid place-items-center" style={{ width: 240, height: 240 }}>
      {/* outer reactive halo */}
      <div
        className="absolute rounded-full"
        style={{
          width: 240,
          height: 240,
          background: `radial-gradient(circle, ${color}22 0%, transparent 65%)`,
          transform: `scale(${1 + level * 0.5})`,
          transition: "transform 120ms ease-out",
          opacity: active ? 0.9 : 0.5,
        }}
      />
      {/* rotating rings */}
      <div
        className="absolute rounded-full border"
        style={{ width: 200, height: 200, borderColor: `${color}33`, animation: "spin-soft 14s linear infinite" }}
      />
      <div
        className="absolute rounded-full border"
        style={{ width: 168, height: 168, borderColor: `${color}22`, animation: "spin-soft 9s linear infinite reverse" }}
      />
      {/* core */}
      <div
        className="rounded-full"
        style={{
          width: 132,
          height: 132,
          background: `radial-gradient(circle at 32% 28%, ${color}, ${colorDeep})`,
          transform: `scale(${scale})`,
          boxShadow: `0 0 ${glow}px ${color}, inset 0 0 30px rgba(255,255,255,0.14)`,
          transition: "transform 90ms ease-out, box-shadow 120ms ease-out",
        }}
      />
      {state === "connecting" && (
        <div className="absolute" style={{ color: "var(--text)" }}>
          <Spinner size={20} />
        </div>
      )}
    </div>
  );
}

function ModeCard({
  icon,
  eyebrow,
  title,
  description,
  bullets,
  accent,
  onSelect,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
  accent: string;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="group glass relative flex-1 text-left p-6 transition-all duration-200 hover:-translate-y-1 hover:border-[var(--border-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <div
        className="w-11 h-11 rounded-[12px] grid place-items-center mb-5 transition-transform duration-200 group-hover:scale-105"
        style={{ background: `${accent}1f`, color: accent }}
      >
        {icon}
      </div>
      <p className="text-[11px] uppercase tracking-wider font-semibold mb-1.5" style={{ color: accent }}>
        {eyebrow}
      </p>
      <h3 className="text-[17px] font-semibold tracking-tight mb-2">{title}</h3>
      <p className="text-[13.5px] text-[var(--text-muted)] leading-relaxed mb-4">{description}</p>
      <ul className="flex flex-col gap-1.5 mb-5">
        {bullets.map((b) => (
          <li key={b} className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
            <span className="w-1 h-1 rounded-full shrink-0" style={{ background: accent }} />
            {b}
          </li>
        ))}
      </ul>
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium transition-transform duration-200 group-hover:gap-2.5" style={{ color: accent }}>
        Start practicing
        <span aria-hidden>→</span>
      </span>
    </button>
  );
}

export default function Home() {
  const [view, setView] = useState<View>("landing");

  const [file, setFile] = useState<File | null>(null);
  const [jobDescriptionText, setJobDescriptionText] = useState("");
  const [resourceType, setResourceType] = useState("course_material");
  const [uploading, setUploading] = useState(false);
  const [document, setDocument] = useState<Document | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [companyName, setCompanyName] = useState("");
  const [position, setPosition] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<number | "">("");
  const [persona, setPersona] = useState<Persona>("balanced");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [voice, setVoice] = useState<Voice>("thalia");

  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [callError, setCallError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const selfVideoRef = useRef<HTMLVideoElement | null>(null);

  const [scoreStatus, setScoreStatus] = useState<"idle" | "polling" | "ready" | "timeout">("idle");
  const [sessionScore, setSessionScore] = useState<SessionScore | null>(null);
  const pollingRoomRef = useRef<string | null>(null);

  const [feedback, setFeedback] = useState<AnswerFeedback[] | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [showTranscript, setShowTranscript] = useState(true);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activeSession, setActiveSession] = useState<HistoryEntry | null>(null);

  const [analytics, setAnalytics] = useState<SessionAnalytics[] | null>(null);
  const [analyticsStatus, setAnalyticsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  // Live voice-mode state
  const [agentLevel, setAgentLevel] = useState(0);
  const [userLevel, setUserLevel] = useState(0);
  const [captions, setCaptions] = useState<LiveCaption[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const agentAnalyserRef = useRef<AnalyserNode | null>(null);
  const levelRafRef = useRef<number | null>(null);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
      // Client-only read of localStorage; must happen post-mount to avoid an
      // SSR/hydration mismatch, so this can't move to render or an initializer.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setHistory(JSON.parse(raw));
    } catch {
      // ignore malformed/missing localStorage data
    }
  }, []);

  function addToHistory(entry: HistoryEntry) {
    setHistory((prev) => {
      const next = [entry, ...prev.filter((h) => h.sessionId !== entry.sessionId)];
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  function enterPractice(mode: string) {
    setResourceType(mode);
    setView("practice");
  }

  async function openAnalytics() {
    setView("analytics");
    const scored = history.filter((h) => typeof h.score === "number");
    if (scored.length === 0) {
      setAnalytics([]);
      setAnalyticsStatus("ready");
      return;
    }
    setAnalyticsStatus("loading");
    try {
      const results = await Promise.all(
        scored.map(async (h): Promise<SessionAnalytics | null> => {
          try {
            const res = await fetch(`${API_URL}/sessions/${h.sessionId}/score`);
            if (!res.ok) return null;
            const data: SessionScore = await res.json();
            return {
              createdAt: h.createdAt,
              overall: Math.round(data.score.overall_score),
              criteria: data.score.scores.map((s) => ({ criterion: s.criterion, score: s.score_0_100 })),
              fillers: data.transcript ? transcriptStats(data.transcript).fillers : 0,
            };
          } catch {
            return null;
          }
        }),
      );
      // oldest → newest so the trend reads left-to-right
      const clean = results.filter((r): r is SessionAnalytics => r !== null).reverse();
      setAnalytics(clean);
      setAnalyticsStatus("ready");
    } catch {
      setAnalyticsStatus("error");
    }
  }

  async function handleUpload() {
    const isJobDescription = resourceType === "job_description";
    const pastedText = jobDescriptionText.trim();
    if (isJobDescription ? !pastedText : !file) return;

    setUploading(true);
    setUploadError(null);
    setDocument(null);

    try {
      const formData = new FormData();
      if (isJobDescription) {
        const blob = new Blob([pastedText], { type: "text/plain" });
        formData.append("file", blob, "job-description.txt");
      } else {
        formData.append("file", file as File);
      }
      formData.append("resource_type", resourceType);

      const res = await fetch(`${API_URL}/documents/upload`, { method: "POST", body: formData });

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

  async function pollForScore(roomName: string, documentId: string) {
    if (pollingRoomRef.current === roomName) return;
    pollingRoomRef.current = roomName;
    setScoreStatus("polling");
    setSessionScore(null);

    for (let attempt = 0; attempt < SCORE_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, SCORE_POLL_INTERVAL_MS));
      const res = await fetch(`${API_URL}/sessions/${roomName}/score`);
      if (res.ok) {
        const data: SessionScore = await res.json();
        setSessionScore(data);
        setScoreStatus("ready");
        addToHistory({
          sessionId: roomName,
          documentId,
          createdAt: new Date().toISOString(),
          score: data.score?.overall_score,
        });
        fetchFeedback(roomName);
        return;
      }
    }
    setScoreStatus("timeout");
  }

  async function fetchFeedback(roomName: string) {
    setFeedbackStatus("loading");
    setFeedback(null);
    try {
      const res = await fetch(`${API_URL}/sessions/${roomName}/feedback`);
      if (!res.ok) throw new Error(`Feedback failed (${res.status})`);
      setFeedback(await res.json());
      setFeedbackStatus("ready");
    } catch {
      setFeedbackStatus("error");
    }
  }

  function makeAnalyser(track: MediaStreamTrack): AnalyserNode | null {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      return analyser;
    } catch {
      return null;
    }
  }

  function scalarLevel(analyser: AnalyserNode | null, buf: Uint8Array<ArrayBuffer>): number {
    if (!analyser) return 0;
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    return Math.min(1, (sum / buf.length / 255) * 2.6);
  }

  function startAudioLoop() {
    const micBuf = new Uint8Array(new ArrayBuffer(128));
    const agentBuf = new Uint8Array(new ArrayBuffer(128));
    function tick() {
      setUserLevel(scalarLevel(micAnalyserRef.current, micBuf));
      setAgentLevel(scalarLevel(agentAnalyserRef.current, agentBuf));
      levelRafRef.current = requestAnimationFrame(tick);
    }
    levelRafRef.current = requestAnimationFrame(tick);
  }

  function stopAudioLoop() {
    if (levelRafRef.current !== null) cancelAnimationFrame(levelRafRef.current);
    levelRafRef.current = null;
    micAnalyserRef.current = null;
    agentAnalyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setAgentLevel(0);
    setUserLevel(0);
  }

  function upsertCaption(next: LiveCaption) {
    setCaptions((prev) => {
      const idx = prev.findIndex((c) => c.id === next.id);
      if (idx === -1) return [...prev, next];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }

  function registerCaptions(room: Room) {
    const anyRoom = room as unknown as {
      registerTextStreamHandler?: (topic: string, cb: (reader: unknown, info: { identity?: string }) => void) => void;
    };
    if (typeof anyRoom.registerTextStreamHandler !== "function") return;
    try {
      anyRoom.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader, info) => {
        try {
          const r = reader as {
            info?: { id?: string; attributes?: Record<string, string> };
            readAll?: () => Promise<string>;
            [Symbol.asyncIterator]?: () => AsyncIterator<string>;
          };
          const attrs = r.info?.attributes ?? {};
          const id = attrs["lk.segment_id"] || r.info?.id || `${Date.now()}-${Math.random()}`;
          let text = "";
          if (typeof r.readAll === "function") {
            text = await r.readAll();
          } else if (r[Symbol.asyncIterator]) {
            for await (const chunk of r as AsyncIterable<string>) text += chunk;
          }
          if (!text.trim()) return;
          const isAI = info?.identity !== room.localParticipant.identity;
          const final = attrs["lk.transcription_final"] !== "false";
          upsertCaption({ id, speaker: isAI ? "ai" : "you", text, final });
        } catch {
          // ignore malformed transcription segments
        }
      });
    } catch {
      // handler already registered or unsupported — captions simply won't show
    }
  }

  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }

  function startTimer() {
    setElapsedSeconds(0);
    stopTimer();
    timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
  }

  async function handleStartInterview(focusAreas?: string[]) {
    if (!document) return;
    setCallStatus("connecting");
    setCallError(null);
    setScoreStatus("idle");
    setSessionScore(null);
    setCaptions([]);
    setFeedback(null);
    setFeedbackStatus("idle");
    pollingRoomRef.current = null;

    try {
      const res = await fetch(`${API_URL}/sessions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_id: document.id,
          company_name: companyName.trim() || undefined,
          position: position.trim() || undefined,
          duration_minutes: durationMinutes === "" ? undefined : durationMinutes,
          persona,
          difficulty,
          voice,
          focus_areas: focusAreas && focusAreas.length > 0 ? focusAreas : undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `Could not start session (${res.status})`);
      }

      const { livekit_url, token, room_name } = await res.json();

      const room = new Room();
      roomRef.current = room;
      registerCaptions(room);

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          if (audioRef.current) track.attach(audioRef.current);
          if (track.mediaStreamTrack) agentAnalyserRef.current = makeAnalyser(track.mediaStreamTrack);
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        setCallStatus("idle");
        stopAudioLoop();
        stopTimer();
        pollForScore(room_name, document.id);
      });

      await room.connect(livekit_url, token);
      const micPub = await room.localParticipant.setMicrophoneEnabled(true);
      if (micPub?.track?.mediaStreamTrack) micAnalyserRef.current = makeAnalyser(micPub.track.mediaStreamTrack);
      startAudioLoop();

      if (isJobDescription) {
        try {
          const cameraPub = await room.localParticipant.setCameraEnabled(true);
          if (cameraPub?.videoTrack && selfVideoRef.current) cameraPub.videoTrack.attach(selfVideoRef.current);
        } catch {
          // Camera is optional — continue with audio-only if it's unavailable/denied.
        }
      }

      setCallStatus("connected");
      startTimer();
    } catch (err) {
      setCallError(err instanceof Error ? err.message : "Could not start session");
      setCallStatus("error");
    }
  }

  function handleEndInterview() {
    roomRef.current?.disconnect();
    roomRef.current = null;
    stopAudioLoop();
    stopTimer();
    if (selfVideoRef.current) selfVideoRef.current.srcObject = null;
  }

  function downloadResultCard() {
    if (!sessionScore) return;
    const W = 1200;
    const H = 630;
    const canvas = window.document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Background + ambient glow
    ctx.fillStyle = "#07080d";
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(210, 60, 0, 210, 60, 760);
    glow.addColorStop(0, "rgba(124,108,255,0.28)");
    glow.addColorStop(1, "rgba(124,108,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,0.09)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    // Brand
    ctx.fillStyle = "#f4f5f9";
    ctx.font = "700 30px system-ui, sans-serif";
    ctx.fillText("◆ Voca AI", 64, 78);
    ctx.fillStyle = "#9498a8";
    ctx.font = "400 20px system-ui, sans-serif";
    ctx.fillText("AI interview practice", 64, 108);

    const overall = Math.round(sessionScore.score.overall_score);
    const col = scoreHex(overall);

    // Score ring
    const cx = 210;
    const cy = 350;
    const r = 118;
    ctx.lineWidth = 20;
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (overall / 100) * Math.PI * 2);
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.fillStyle = "#f4f5f9";
    ctx.textAlign = "center";
    ctx.font = "700 84px system-ui, sans-serif";
    ctx.fillText(String(overall), cx, cy + 20);
    ctx.fillStyle = col;
    ctx.font = "600 30px system-ui, sans-serif";
    ctx.fillText(`Grade ${letterGrade(overall)}`, cx, cy + 66);
    ctx.textAlign = "left";

    // Right column — summary + criteria
    const rx = 400;
    const rw = W - rx - 64;
    ctx.fillStyle = "#64687a";
    ctx.font = "600 16px system-ui, sans-serif";
    ctx.fillText("OVERALL SUMMARY", rx, 168);
    ctx.fillStyle = "#c9ccd8";
    ctx.font = "400 22px system-ui, sans-serif";
    let y = wrapText(ctx, sessionScore.score.summary, rx, 202, rw, 32, 3) + 18;

    const criteria = sessionScore.score.scores.slice(0, 5);
    for (const c of criteria) {
      const cc = scoreHex(c.score_0_100);
      ctx.fillStyle = "#f4f5f9";
      ctx.font = "500 20px system-ui, sans-serif";
      ctx.fillText(c.criterion, rx, y);
      ctx.fillStyle = cc;
      ctx.textAlign = "right";
      ctx.font = "600 20px system-ui, sans-serif";
      ctx.fillText(String(c.score_0_100), rx + rw, y);
      ctx.textAlign = "left";
      // bar
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fillRect(rx, y + 12, rw, 8);
      ctx.fillStyle = cc;
      ctx.fillRect(rx, y + 12, (rw * c.score_0_100) / 100, 8);
      y += 52;
    }

    // Footer stats
    if (sessionScore.transcript && sessionScore.transcript.length) {
      const s = transcriptStats(sessionScore.transcript);
      ctx.fillStyle = "#64687a";
      ctx.font = "400 18px system-ui, sans-serif";
      ctx.fillText(`${s.answers} answers · ${s.words} words · ${s.fillers} filler words`, 64, H - 40);
    }

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement("a");
      a.href = url;
      a.download = `voca-score-${overall}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  useEffect(() => {
    return () => {
      stopAudioLoop();
      stopTimer();
    };
  }, []);

  useEffect(() => {
    if (showTranscript && transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
    }
  }, [captions, showTranscript]);

  const isJobDescription = resourceType === "job_description";
  const uploadDisabled = (isJobDescription ? !jobDescriptionText.trim() : !file) || uploading;

  const step1State: StepState = document ? "done" : "active";
  const step2State: StepState =
    callStatus === "connected" || scoreStatus === "polling" || scoreStatus === "ready" || scoreStatus === "timeout"
      ? "done"
      : document
      ? "active"
      : "pending";
  const step3State: StepState = scoreStatus === "ready" ? "done" : scoreStatus === "polling" ? "active" : "pending";

  const orbState: OrbState =
    callStatus === "connecting" ? "connecting" : agentLevel > 0.1 ? "speaking" : userLevel > 0.1 ? "listening" : "idle";
  const orbLevel = Math.max(agentLevel, userLevel * 0.85);
  const orbStatusText =
    orbState === "connecting" ? "Connecting…" : orbState === "speaking" ? "Voca is speaking" : orbState === "listening" ? "Listening to you" : "Waiting…";
  const latestAiCaption = [...captions].reverse().find((c) => c.speaker === "ai");
  const latestYouCaption = [...captions].reverse().find((c) => c.speaker === "you");

  const scoredHistory = history.filter((h) => typeof h.score === "number");
  const avgScore = scoredHistory.length
    ? Math.round(scoredHistory.reduce((n, h) => n + (h.score ?? 0), 0) / scoredHistory.length)
    : 0;

  return (
    <div className={view === "chat" ? "h-screen overflow-hidden flex flex-col" : "min-h-screen pb-24"}>
      <header className="sticky top-0 z-20 border-b border-[var(--border)] backdrop-blur-xl shrink-0" style={{ background: "rgba(7,8,13,0.72)" }}>
        <div className="mx-auto max-w-3xl px-5 py-4 flex items-center justify-between">
          <button
            onClick={() => (callStatus === "connected" ? undefined : setView("landing"))}
            className="flex items-center gap-2.5"
            aria-label="Back to home"
          >
            <div className="w-7 h-7 rounded-lg grid place-items-center text-[13px] font-bold text-white" style={{ background: "linear-gradient(135deg, var(--accent), var(--good))" }}>
              V
            </div>
            <span className="font-semibold tracking-tight text-[15px]">
              Voca <span className="text-[var(--text-muted)] font-normal">AI</span>
            </span>
          </button>
          {view !== "landing" && callStatus !== "connected" ? (
            <button
              onClick={() => setView("landing")}
              className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors duration-150 flex items-center gap-1.5"
            >
              <span aria-hidden>←</span> {view === "chat" ? "Past sessions" : view === "analytics" ? "Home" : "All sessions"}
            </button>
          ) : callStatus === "connected" ? (
            <span className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--bad)] pulse-ring" />
              Live · {formatClock(elapsedSeconds)}
              {durationMinutes !== "" ? ` / ${durationMinutes}:00` : ""}
            </span>
          ) : (
            <span className="text-xs text-[var(--text-dim)] hidden sm:block">Your AI practice partner</span>
          )}
        </div>
      </header>

      {view === "landing" ? (
        <main className="mx-auto max-w-3xl px-5 pt-14 md:pt-20">
          <div className="mb-12 animate-in">
            <h1 className="text-[32px] md:text-[44px] font-semibold tracking-tight gradient-text leading-[1.1]">
              Talk it through before it counts.
            </h1>
            <p className="mt-3.5 text-[var(--text-muted)] text-[15.5px] max-w-md leading-relaxed">
              Practice vivas and interviews out loud with a live AI voice partner, then get scored on exactly how you did.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 mb-14 animate-in" style={{ animationDelay: "70ms" }}>
            <ModeCard
              icon={<BookIcon />}
              eyebrow="For students"
              title="Viva practice"
              description="Upload your course notes or slides and get grilled on them like the real thing."
              bullets={["Upload notes, slides, or a syllabus", "Voice-only, no camera needed"]}
              accent="var(--good)"
              onSelect={() => enterPractice("course_material")}
            />
            <ModeCard
              icon={<BriefcaseIcon />}
              eyebrow="For job seekers"
              title="Mock interview"
              description="Paste a job description and rehearse with a live interviewer tailored to the role."
              bullets={["Paste any job description", "Live camera + posture guidance"]}
              accent="var(--accent-bright)"
              onSelect={() => enterPractice("job_description")}
            />
          </div>

          <div className="flex items-center gap-4 sm:gap-8 mb-14 px-1 animate-in text-[12.5px] text-[var(--text-dim)] flex-wrap" style={{ animationDelay: "110ms" }}>
            <div className="flex items-center gap-2">
              <UploadIcon size={14} /> Upload material
            </div>
            <div className="h-px w-6 hidden sm:block" style={{ background: "var(--border)" }} />
            <div className="flex items-center gap-2">
              <MicIcon size={14} /> Talk it out loud
            </div>
            <div className="h-px w-6 hidden sm:block" style={{ background: "var(--border)" }} />
            <div className="flex items-center gap-2">
              <ScoreIcon size={14} /> Get scored instantly
            </div>
          </div>

          {scoredHistory.length >= 2 && (
            <section className="mb-12 animate-in" style={{ animationDelay: "130ms" }}>
              <button
                onClick={openAnalytics}
                className="glass w-full p-5 flex items-center justify-between gap-4 flex-wrap text-left hover:border-[var(--border-strong)] hover:bg-white/[0.02] transition-colors duration-150"
              >
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-[var(--text-dim)] mb-1">Your progress</p>
                  <p className="text-[13.5px] text-[var(--text-muted)]">
                    Average score <strong className="text-[var(--text)] font-semibold">{avgScore}</strong> across{" "}
                    {scoredHistory.length} sessions ·{" "}
                    <span style={{ color: "var(--accent-bright)" }}>View analytics →</span>
                  </p>
                </div>
                <Sparkline values={scoredHistory.slice(0, 12).map((h) => h.score ?? 0).reverse()} />
              </button>
            </section>
          )}

          <section className="animate-in" style={{ animationDelay: "150ms" }}>
            <h2 className="text-lg font-semibold mb-1 tracking-tight">Past sessions</h2>
            <p className="text-[13.5px] text-[var(--text-muted)] mb-5">Click one to review the transcript and keep chatting about it.</p>

            {history.length === 0 ? (
              <div className="glass px-5 py-8 text-center text-[13.5px] text-[var(--text-dim)]">Sessions you complete will show up here.</div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {history.map((h) => (
                  <button
                    key={h.sessionId}
                    onClick={() => {
                      setActiveSession(h);
                      setView("chat");
                    }}
                    className="glass w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-white/[0.02] hover:border-[var(--border-strong)] transition-colors duration-150"
                  >
                    <span className="flex items-center gap-3">
                      {typeof h.score === "number" && (
                        <span
                          className="w-9 h-9 rounded-full grid place-items-center text-[12px] font-semibold shrink-0"
                          style={{ background: scoreColor(h.score).soft, color: scoreColor(h.score).fg, border: `1px solid ${scoreColor(h.score).border}` }}
                        >
                          {Math.round(h.score)}
                        </span>
                      )}
                      <span className="text-[13.5px] font-medium">Session from {new Date(h.createdAt).toLocaleString()}</span>
                    </span>
                    <span className="text-[var(--text-dim)] text-[13px]" aria-hidden>
                      →
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </main>
      ) : view === "practice" ? (
        <main className="mx-auto max-w-3xl px-5 pt-12 md:pt-16">
          {callStatus === "connected" ? (
            /* ---------- Immersive voice-mode call stage ---------- */
            <div className="animate-in">
              <div className="glass relative overflow-hidden p-6 md:p-8 flex flex-col items-center" style={{ minHeight: "68vh" }}>
                {/* ambient reactive glow */}
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    background: `radial-gradient(600px 300px at 50% 12%, ${
                      orbState === "speaking" ? "rgba(124,108,255,0.16)" : orbState === "listening" ? "rgba(52,211,153,0.14)" : "transparent"
                    }, transparent 70%)`,
                    transition: "background 300ms ease",
                  }}
                />

                {/* camera PiP for job interviews */}
                {isJobDescription && (
                  <div className="absolute top-4 right-4 z-10" style={{ width: "clamp(116px, 30vw, 168px)" }}>
                    <video
                      ref={selfVideoRef}
                      autoPlay
                      muted
                      playsInline
                      className="w-full rounded-[12px]"
                      style={{ aspectRatio: "4 / 3", background: "#0b0c12", border: "1px solid var(--border)", transform: "scaleX(-1)" }}
                    />
                    <FaceGuideOverlay videoRef={selfVideoRef} active />
                  </div>
                )}

                <p className="relative text-[11px] uppercase tracking-wider font-semibold mt-2 mb-8" style={{ color: isJobDescription ? "var(--accent-bright)" : "var(--good)" }}>
                  {isJobDescription ? "Mock interview" : "Viva practice"} · in progress
                </p>

                <div className="relative flex-1 flex flex-col items-center justify-center w-full">
                  <VoiceOrb level={orbLevel} state={orbState} />
                  <p className="mt-6 text-[15px] font-medium tracking-tight" style={{ color: orbState === "speaking" ? "var(--accent-bright)" : orbState === "listening" ? "var(--good)" : "var(--text-muted)" }}>
                    {orbStatusText}
                  </p>

                  {/* live caption */}
                  <div className="mt-6 w-full max-w-xl min-h-[76px] text-center px-4">
                    {latestAiCaption ? (
                      <p className="text-[15.5px] leading-relaxed text-[var(--text)]">{latestAiCaption.text}</p>
                    ) : (
                      <p className="text-[13.5px] text-[var(--text-dim)]">Captions will appear here as you talk.</p>
                    )}
                    {latestYouCaption && <p className="mt-3 text-[13px] text-[var(--text-muted)] italic">You: {latestYouCaption.text}</p>}
                  </div>
                </div>

                {/* live transcript panel */}
                <div className="relative w-full max-w-xl mt-4">
                  <div className="flex items-center justify-center mb-2">
                    <button
                      onClick={() => setShowTranscript((v) => !v)}
                      className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors duration-150 flex items-center gap-1.5"
                    >
                      {showTranscript ? "Hide" : "Show"} live transcript
                      <span className="text-[10px]" style={{ transform: showTranscript ? "rotate(180deg)" : "none", display: "inline-block" }} aria-hidden>
                        ▾
                      </span>
                    </button>
                  </div>
                  {showTranscript && (
                    <div
                      ref={transcriptScrollRef}
                      className="rounded-[12px] border border-[var(--border)] bg-white/[0.02] max-h-[168px] overflow-y-auto p-3 flex flex-col gap-2 text-left"
                    >
                      {captions.length === 0 ? (
                        <p className="text-[12px] text-[var(--text-dim)]">Transcript will build here as you both talk.</p>
                      ) : (
                        captions.map((c) => (
                          <div key={c.id} className="text-[12.5px] leading-relaxed">
                            <span className="font-semibold" style={{ color: c.speaker === "ai" ? "var(--accent-bright)" : "var(--good)" }}>
                              {c.speaker === "ai" ? "Voca" : "You"}:{" "}
                            </span>
                            <span className={c.speaker === "ai" ? "text-[var(--text)]" : "text-[var(--text-muted)]"}>{c.text}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>

                <button
                  onClick={handleEndInterview}
                  className="relative mt-6 px-6 py-2.5 rounded-full text-[13.5px] font-medium text-white transition-transform duration-150 hover:scale-[1.03] flex items-center gap-2"
                  style={{ background: "var(--bad)" }}
                >
                  <span className="w-2 h-2 rounded-sm bg-white" /> End interview
                </button>
              </div>

              <audio ref={audioRef} autoPlay />
            </div>
          ) : (
            /* ---------- Setup wizard ---------- */
            <>
              <div className="mb-12 animate-in">
                <p className="text-[11px] uppercase tracking-wider font-semibold mb-2" style={{ color: isJobDescription ? "var(--accent-bright)" : "var(--good)" }}>
                  {isJobDescription ? "Mock interview" : "Viva practice"}
                </p>
                <h1 className="text-[28px] md:text-4xl font-semibold tracking-tight gradient-text leading-tight">
                  {isJobDescription ? "Rehearse for the real thing" : "Get ready to defend your work"}
                </h1>
                <p className="mt-2.5 text-[var(--text-muted)] text-[15px] max-w-md">
                  Upload your material, talk to a live AI interviewer, and get scored instantly.
                </p>
              </div>

              <div className="flex flex-col">
                {/* Step 1 — Upload */}
                <StepRow n={1} title="Upload material" state={step1State}>
                  <div className="flex flex-col gap-3 max-w-sm">
                    <SegmentedControl
                      value={resourceType}
                      onChange={setResourceType}
                      options={[
                        { value: "course_material", label: "Viva practice" },
                        { value: "job_description", label: "Mock interview" },
                      ]}
                    />

                    {isJobDescription ? (
                      <textarea
                        placeholder="Paste the job description here…"
                        value={jobDescriptionText}
                        onChange={(e) => setJobDescriptionText(e.target.value)}
                        rows={7}
                        className="resize-vertical w-full"
                      />
                    ) : (
                      <label className="relative flex flex-col items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-[var(--border-strong)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors duration-150 cursor-pointer py-7 px-4 text-center">
                        <input type="file" accept=".pdf,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="absolute inset-0 opacity-0 cursor-pointer" />
                        <span className="text-[13.5px] font-medium">{file ? file.name : "Click to choose a PDF or TXT file"}</span>
                        <span className="text-[12px] text-[var(--text-dim)]">Course notes, slides, syllabus…</span>
                      </label>
                    )}

                    <button
                      onClick={handleUpload}
                      disabled={uploadDisabled}
                      className="self-start px-4 py-2 rounded-[10px] text-[13.5px] font-medium text-white transition-all duration-150 disabled:opacity-40 flex items-center gap-2"
                      style={{ background: uploadDisabled ? "var(--surface-hover)" : "var(--accent)" }}
                    >
                      {uploading && <Spinner size={13} />}
                      {uploading ? "Uploading…" : "Upload"}
                    </button>
                  </div>

                  {uploadError && <p className="mt-3 text-[13px] text-[var(--bad)]">{uploadError}</p>}
                  {document && (
                    <div className="mt-4 flex items-center gap-2.5 rounded-[10px] border border-[var(--good-border)] bg-[var(--good-soft)] px-3.5 py-2.5 text-[13px] animate-in">
                      <span className="text-[var(--good)]">✓</span>
                      <span>
                        <strong className="font-medium">{document.filename}</strong>{" "}
                        <span className="text-[var(--text-muted)]">· {document.chunk_count} chunk{document.chunk_count === 1 ? "" : "s"} indexed</span>
                      </span>
                    </div>
                  )}
                </StepRow>

                {/* Step 2 — Interview */}
                <StepRow n={2} title="Start the interview" state={step2State}>
                  <div className="flex flex-col gap-4 max-w-sm mb-4">
                    <div className="flex gap-2">
                      <input type="text" placeholder="Company (optional)" value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="flex-1 min-w-0" />
                      <input type="text" placeholder="Position (optional)" value={position} onChange={(e) => setPosition(e.target.value)} className="flex-1 min-w-0" />
                    </div>
                    <div>
                      <p className="text-[12px] text-[var(--text-dim)] mb-1.5">Length</p>
                      <SegmentedControl
                        value={durationMinutes === "" ? "none" : String(durationMinutes)}
                        onChange={(v) => setDurationMinutes(v === "none" ? "" : Number(v))}
                        options={[
                          { value: "none", label: "No limit" },
                          { value: "5", label: "5m" },
                          { value: "10", label: "10m" },
                          { value: "15", label: "15m" },
                          { value: "20", label: "20m" },
                        ]}
                      />
                    </div>
                    <div>
                      <p className="text-[12px] text-[var(--text-dim)] mb-1.5">Interviewer style</p>
                      <SegmentedControl
                        value={persona}
                        onChange={setPersona}
                        options={[
                          { value: "friendly", label: "🙂 Friendly" },
                          { value: "balanced", label: "😐 Balanced" },
                          { value: "tough", label: "😤 Tough" },
                        ]}
                      />
                      <p className="text-[12px] text-[var(--text-dim)] mt-1.5">
                        {persona === "friendly"
                          ? "Warm and encouraging, with hints if you get stuck."
                          : persona === "tough"
                          ? "Demanding and rigorous — expect hard follow-ups."
                          : "Realistic and fair, like a normal interview."}
                      </p>
                    </div>
                    <div>
                      <p className="text-[12px] text-[var(--text-dim)] mb-1.5">Question difficulty</p>
                      <SegmentedControl
                        value={difficulty}
                        onChange={setDifficulty}
                        options={[
                          { value: "easy", label: "Easy" },
                          { value: "normal", label: "Normal" },
                          { value: "hard", label: "Hard" },
                        ]}
                      />
                    </div>
                    <div>
                      <p className="text-[12px] text-[var(--text-dim)] mb-1.5">Interviewer voice</p>
                      <SegmentedControl
                        value={voice}
                        onChange={setVoice}
                        options={[
                          { value: "thalia", label: "Thalia" },
                          { value: "apollo", label: "Apollo" },
                          { value: "helena", label: "Helena" },
                          { value: "arcas", label: "Arcas" },
                        ]}
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => handleStartInterview()}
                    disabled={!document || callStatus === "connecting"}
                    className="relative px-5 py-2.5 rounded-[10px] text-[13.5px] font-medium text-white transition-all duration-150 disabled:opacity-40 flex items-center gap-2"
                    style={{ background: !document || callStatus === "connecting" ? "var(--surface-hover)" : "var(--accent)" }}
                  >
                    {callStatus === "connecting" && <Spinner size={13} />}
                    {callStatus === "connecting" ? "Connecting…" : "Start interview"}
                    {document && callStatus !== "connecting" && <span className="absolute inset-0 rounded-[10px] pulse-ring pointer-events-none" />}
                  </button>

                  {callError && <p className="mt-3 text-[13px] text-[var(--bad)]">{callError}</p>}
                </StepRow>

                {/* Step 3 — Score */}
                <StepRow n={3} title="Your results" state={step3State} last>
                  {scoreStatus === "idle" && <p className="text-[13.5px] text-[var(--text-muted)]">End the interview to get scored.</p>}

                  {scoreStatus === "polling" && (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-2.5 text-[13.5px] text-[var(--text-muted)]">
                        <Spinner size={15} /> Scoring your interview…
                      </div>
                      <div className="h-3 rounded-full shimmer w-full max-w-xs" />
                      <div className="h-3 rounded-full shimmer w-2/3 max-w-xs" />
                    </div>
                  )}

                  {scoreStatus === "timeout" && <p className="text-[13.5px] text-[var(--bad)]">Scoring took too long — try again.</p>}

                  {scoreStatus === "ready" && sessionScore && (
                    <div className="animate-in">
                      <div className="flex items-center gap-5 mb-5">
                        <div className="relative">
                          <ScoreRing value={Math.round(sessionScore.score.overall_score)} />
                          <span
                            className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full grid place-items-center text-[13px] font-bold border-2"
                            style={{ background: "var(--bg-elevated)", color: scoreColor(sessionScore.score.overall_score).fg, borderColor: scoreColor(sessionScore.score.overall_score).border }}
                          >
                            {letterGrade(sessionScore.score.overall_score)}
                          </span>
                        </div>
                        <div>
                          <p className="text-[12px] uppercase tracking-wide text-[var(--text-dim)] mb-1">Overall score</p>
                          <p className="text-[13.5px] text-[var(--text-muted)] leading-relaxed max-w-xs">{sessionScore.score.summary}</p>
                        </div>
                      </div>

                      {sessionScore.transcript && sessionScore.transcript.length > 0 && (
                        <div className="flex gap-2.5 mb-5 flex-wrap">
                          {(() => {
                            const s = transcriptStats(sessionScore.transcript!);
                            return (
                              <>
                                <StatTile label="Answers" value={s.answers} />
                                <StatTile label="Words spoken" value={s.words} />
                                <StatTile label="Avg / answer" value={s.avgWords} hint="words" />
                                <StatTile label="Filler words" value={s.fillers} hint={s.fillers <= 3 ? "great" : "watch these"} />
                              </>
                            );
                          })()}
                        </div>
                      )}

                      <div>
                        {sessionScore.score.scores.map((s) => (
                          <CriterionBar key={s.criterion} {...s} />
                        ))}
                      </div>

                      {/* Per-answer feedback */}
                      <div className="mt-6">
                        <p className="text-[13px] font-semibold tracking-tight mb-3">Answer breakdown</p>
                        {feedbackStatus === "loading" && (
                          <div className="flex items-center gap-2.5 text-[13px] text-[var(--text-muted)]">
                            <Spinner size={14} /> Analyzing your answers…
                          </div>
                        )}
                        {feedbackStatus === "error" && (
                          <p className="text-[12.5px] text-[var(--text-dim)]">Couldn&apos;t generate the per-answer breakdown this time.</p>
                        )}
                        {feedbackStatus === "ready" && feedback && feedback.length === 0 && (
                          <p className="text-[12.5px] text-[var(--text-dim)]">Not enough of a conversation to break down.</p>
                        )}
                        {feedbackStatus === "ready" && feedback && feedback.length > 0 && (
                          <div className="flex flex-col gap-2.5">
                            {feedback.map((f, i) => {
                              const v = VERDICT_STYLE[f.verdict];
                              return (
                                <div key={i} className="rounded-[12px] border p-3.5" style={{ borderColor: "var(--border)", background: "rgba(255,255,255,0.015)" }}>
                                  <div className="flex items-start justify-between gap-3 mb-1.5">
                                    <p className="text-[13px] font-medium leading-snug">{f.question}</p>
                                    <span className="shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full border" style={{ color: v.fg, background: v.soft, borderColor: v.border }}>
                                      {v.label}
                                    </span>
                                  </div>
                                  <p className="text-[12.5px] text-[var(--text-muted)] italic mb-2 leading-relaxed">“{f.answer_excerpt}”</p>
                                  <p className="text-[12.5px] leading-relaxed">
                                    <span style={{ color: "var(--accent-bright)" }}>Tip: </span>
                                    <span className="text-[var(--text-muted)]">{f.tip}</span>
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {(() => {
                        const weakCriteria = sessionScore.score.scores.filter((s) => s.score_0_100 < 65).map((s) => s.criterion);
                        const weakFromFeedback = (feedback ?? []).filter((f) => f.verdict === "weak").map((f) => f.question);
                        const weakAreas = [...new Set([...weakCriteria, ...weakFromFeedback])].slice(0, 6);
                        return (
                          <div className="mt-6 flex gap-2.5 flex-wrap">
                            {weakAreas.length > 0 && (
                              <button
                                onClick={() => handleStartInterview(weakAreas)}
                                className="px-4 py-2 rounded-[10px] text-[13px] font-medium text-white transition-transform duration-150 hover:scale-[1.02] flex items-center gap-2"
                                style={{ background: "linear-gradient(135deg, var(--accent), var(--good))" }}
                              >
                                🎯 Re-drill weak areas
                              </button>
                            )}
                            <button
                              onClick={() => {
                                const entry = history.find((h) => h.sessionId === pollingRoomRef.current);
                                if (entry) {
                                  setActiveSession(entry);
                                  setView("chat");
                                }
                              }}
                              className="px-4 py-2 rounded-[10px] text-[13px] font-medium transition-colors duration-150 border border-[var(--border-strong)] hover:bg-white/[0.04] flex items-center gap-2"
                            >
                              💬 Chat about this session
                            </button>
                            <button
                              onClick={downloadResultCard}
                              className="px-4 py-2 rounded-[10px] text-[13px] font-medium transition-colors duration-150 border border-[var(--border-strong)] hover:bg-white/[0.04] flex items-center gap-2"
                            >
                              ⬇ Download result card
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </StepRow>
              </div>
            </>
          )}
        </main>
      ) : view === "analytics" ? (
        <main className="mx-auto max-w-3xl px-5 pt-12 md:pt-16">
          <div className="mb-8 animate-in">
            <h1 className="text-[28px] md:text-4xl font-semibold tracking-tight gradient-text leading-tight">Your analytics</h1>
            <p className="mt-2.5 text-[var(--text-muted)] text-[15px]">How your practice has trended over time.</p>
          </div>

          {analyticsStatus === "loading" && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2.5 text-[13.5px] text-[var(--text-muted)]">
                <Spinner size={15} /> Crunching your sessions…
              </div>
              <div className="glass h-48 shimmer" />
            </div>
          )}

          {analyticsStatus === "error" && <p className="text-[13.5px] text-[var(--bad)]">Couldn&apos;t load your analytics — try again.</p>}

          {analyticsStatus === "ready" && analytics && analytics.length === 0 && (
            <div className="glass px-5 py-8 text-center text-[13.5px] text-[var(--text-dim)]">
              Complete a session or two and your trends will show up here.
            </div>
          )}

          {analyticsStatus === "ready" && analytics && analytics.length > 0 && (
            <div className="flex flex-col gap-6 animate-in">
              {(() => {
                const overalls = analytics.map((a) => a.overall);
                const avg = Math.round(overalls.reduce((n, v) => n + v, 0) / overalls.length);
                const best = Math.max(...overalls);
                const totalFillers = analytics.reduce((n, a) => n + a.fillers, 0);
                // per-criterion averages across sessions
                const critMap = new Map<string, number[]>();
                for (const a of analytics) for (const c of a.criteria) critMap.set(c.criterion, [...(critMap.get(c.criterion) ?? []), c.score]);
                const critAverages = [...critMap.entries()].map(([criterion, scores]) => ({
                  criterion,
                  score: Math.round(scores.reduce((n, v) => n + v, 0) / scores.length),
                }));
                const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
                return (
                  <>
                    <div className="flex gap-2.5 flex-wrap">
                      <StatTile label="Sessions" value={analytics.length} />
                      <StatTile label="Average" value={avg} hint="/ 100" />
                      <StatTile label="Best" value={best} hint="/ 100" />
                      <StatTile label="Total fillers" value={totalFillers} />
                    </div>

                    <div className="glass p-5">
                      <p className="text-[13px] font-semibold tracking-tight mb-4">Score over time</p>
                      <LineChart points={analytics.map((a) => ({ label: fmtDate(a.createdAt), value: a.overall }))} yMax={100} />
                    </div>

                    <div className="glass p-5">
                      <p className="text-[13px] font-semibold tracking-tight mb-4">Average by criterion</p>
                      <div>
                        {critAverages.map((c) => (
                          <CriterionBar key={c.criterion} criterion={c.criterion} score_0_100={c.score} justification={`Averaged across ${analytics.length} sessions.`} />
                        ))}
                      </div>
                    </div>

                    {analytics.length > 1 && (
                      <div className="glass p-5">
                        <p className="text-[13px] font-semibold tracking-tight mb-1">Filler words per session</p>
                        <p className="text-[12.5px] text-[var(--text-muted)] mb-4">Fewer is better — watch this trend down as you get more fluent.</p>
                        <LineChart points={analytics.map((a) => ({ label: fmtDate(a.createdAt), value: a.fillers }))} />
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </main>
      ) : (
        activeSession && (
          <main className="mx-auto max-w-3xl w-full px-5 pt-6 md:pt-8 flex flex-col flex-1 min-h-0">
            <div className="mb-1 pb-4 shrink-0 animate-in">
              <p className="text-[11px] uppercase tracking-wider font-semibold mb-1 text-[var(--text-dim)]">Session transcript</p>
              <h1 className="text-xl font-semibold tracking-tight">{new Date(activeSession.createdAt).toLocaleString()}</h1>
            </div>
            <div className="flex-1 min-h-0 animate-in">
              <ReviewChat sessionId={activeSession.sessionId} fullHeight />
            </div>
          </main>
        )
      )}
    </div>
  );
}
