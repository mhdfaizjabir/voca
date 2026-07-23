"use client";

import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

type TranscriptTurn = { role: string; text: string };
type ChatMessage = { role: string; text: string; created_at: string };

// A unified line in the merged conversation view - either a turn from the
// original voice interview, or a later text follow-up message.
type ConversationLine = { speaker: "them" | "you"; text: string; kind: "interview" | "chat" };

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="spin-soft inline-block rounded-full border-2 border-white/25 border-t-white"
      style={{ width: size, height: size }}
    />
  );
}

function Bubble({ line }: { line: ConversationLine }) {
  const isYou = line.speaker === "you";
  return (
    <div className={`flex ${isYou ? "justify-end" : "justify-start"}`}>
      <div
        className="max-w-[85%] rounded-[14px] px-3.5 py-2.5 text-[13.5px] leading-relaxed"
        style={{
          background: isYou ? "var(--accent-soft)" : "var(--surface)",
          border: `1px solid ${isYou ? "var(--accent-border)" : "var(--border)"}`,
          borderTopRightRadius: isYou ? 4 : 14,
          borderTopLeftRadius: isYou ? 14 : 4,
        }}
      >
        <p className="text-[10.5px] uppercase tracking-wide mb-1 text-[var(--text-dim)]">
          {isYou ? "You" : "Voca"}
        </p>
        {line.text}
      </div>
    </div>
  );
}

export default function ReviewChat({ sessionId, fullHeight = false }: { sessionId: string; fullHeight?: boolean }) {
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch(`${API_URL}/sessions/${sessionId}/score`).then((res) => res.json()),
      fetch(`${API_URL}/sessions/${sessionId}/chat`).then((res) => res.json()),
    ])
      .then(([scoreData, chatData]) => {
        if (cancelled) return;
        setTranscript(scoreData.transcript ?? []);
        setChatMessages(chatData ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this conversation");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages, loading]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setChatMessages((prev) => [...prev, { role: "user", text, created_at: new Date().toISOString() }]);
    setInput("");

    try {
      const res = await fetch(`${API_URL}/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `Chat failed (${res.status})`);
      }
      const data = await res.json();
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.reply, created_at: new Date().toISOString() },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed");
    } finally {
      setSending(false);
    }
  }

  const conversation: ConversationLine[] = [
    ...transcript
      .filter((t) => t.text)
      .map((t): ConversationLine => ({
        speaker: t.role === "user" ? "you" : "them",
        text: t.text,
        kind: "interview",
      })),
    ...chatMessages.map((m): ConversationLine => ({
      speaker: m.role === "user" ? "you" : "them",
      text: m.text,
      kind: "chat",
    })),
  ];

  return (
    <div
      className={fullHeight ? "flex flex-col h-full min-h-0" : "rounded-[14px] overflow-hidden"}
      style={fullHeight ? undefined : { border: "1px solid var(--border)", background: "rgba(255,255,255,0.015)" }}
    >
      {loading ? (
        <div className="flex items-center gap-2.5 px-4 py-6 text-[13px] text-[var(--text-muted)]">
          <Spinner />
          Loading conversation…
        </div>
      ) : (
        <div
          ref={scrollRef}
          className={
            fullHeight
              ? "flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 px-1 py-4"
              : "flex flex-col gap-2.5 max-h-[420px] overflow-y-auto px-3.5 py-3.5"
          }
        >
          {conversation.length === 0 && (
            <p className="text-[13px] text-[var(--text-dim)] px-1">No conversation recorded for this session.</p>
          )}
          {conversation.map((line, i) => {
            const isFirstChatLine = line.kind === "chat" && conversation[i - 1]?.kind === "interview";
            return (
              <div key={i}>
                {isFirstChatLine && (
                  <div className="flex items-center gap-2.5 my-1.5">
                    <div className="h-px flex-1" style={{ background: "var(--border)" }} />
                    <span className="text-[10.5px] uppercase tracking-wide text-[var(--text-dim)]">
                      Follow-up chat
                    </span>
                    <div className="h-px flex-1" style={{ background: "var(--border)" }} />
                  </div>
                )}
                <Bubble line={line} />
              </div>
            );
          })}
        </div>
      )}

      {error && <p className={`${fullHeight ? "px-1" : "px-3.5"} text-[12.5px] text-[var(--bad)] mb-2`}>{error}</p>}

      <div className={fullHeight ? "flex gap-2 pt-3 border-t border-[var(--border)] shrink-0" : "flex gap-2 px-3.5 pb-3.5 pt-1"}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
          }}
          placeholder="Ask about your interview…"
          className="flex-1 min-w-0"
          disabled={sending}
        />
        <button
          onClick={handleSend}
          disabled={sending || !input.trim()}
          className="px-4 py-2 rounded-[10px] text-[13px] font-medium text-white transition-all duration-150 disabled:opacity-40 flex items-center gap-2"
          style={{ background: sending || !input.trim() ? "var(--surface-hover)" : "var(--accent)" }}
        >
          {sending && <Spinner size={12} />}
          {sending ? "" : "Send"}
        </button>
      </div>
    </div>
  );
}
