import { ImageResponse } from "next/og";

export const alt = "Voca AI — Talk it through before it counts";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "linear-gradient(135deg, #07080d 0%, #0d0f18 60%, #14122b 100%)",
          color: "#f4f5f9",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "linear-gradient(135deg, #7c6cff, #34d399)",
              fontSize: 34,
              fontWeight: 800,
              color: "#fff",
            }}
          >
            V
          </div>
          <div style={{ fontSize: 30, fontWeight: 700 }}>Voca AI</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.05, maxWidth: 900 }}>
            Talk it through before it counts.
          </div>
          <div style={{ fontSize: 30, color: "#9498a8", maxWidth: 820, lineHeight: 1.35 }}>
            Practice vivas and mock interviews out loud with a live AI voice partner — then get
            scored on exactly how you did.
          </div>
        </div>

        <div style={{ display: "flex", gap: 14 }}>
          {["Live voice interview", "Instant scoring", "Per-answer feedback"].map((t) => (
            <div
              key={t}
              style={{
                fontSize: 24,
                color: "#c9c4ff",
                padding: "10px 20px",
                borderRadius: 999,
                border: "1px solid rgba(124,108,255,0.45)",
                background: "rgba(124,108,255,0.12)",
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
