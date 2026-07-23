# Voca AI

**Talk it through before it counts.** Voca AI is a voice-based interview practice platform. You upload your own material — course notes for a **viva**, or a job description for a **mock interview** — and a live AI voice agent conducts a real spoken interview grounded in that material. When you're done, it scores you, breaks down your answers, and lets you keep chatting about how you did.

---

## What it does

Two practice modes, one flow:

- **📚 Viva practice (students)** — Upload course notes, slides, or a syllabus. The AI quizzes you on it like an oral exam. Voice-only, no camera.
- **💼 Mock interview (job seekers)** — Paste a job description. The AI runs a realistic interview tailored to the role, with live camera + posture guidance and optional company-specific questions.

The loop: **upload material → talk to the AI out loud → get scored instantly → review and keep chatting about it.**

---

## Features

### Live interview
- **Real-time voice conversation** — natural spoken back-and-forth (Deepgram STT → Groq LLM → Deepgram TTS via LiveKit Agents).
- **Immersive voice-mode UI** — a reactive voice orb that pulses as the AI speaks and as you talk, with a live call timer.
- **Live captions + transcript** — see the conversation build in real time as you both speak.
- **Interviewer personas** — dial the intensity: 🙂 Friendly (warm, gives hints), 😐 Balanced (realistic), or 😤 Tough (rigorous, hard follow-ups).
- **RAG grounding** — questions are grounded in your uploaded material (chunked, embedded, and retrieved from Pinecone).
- **Company research** — for mock interviews, an optional tiered lookup (LLM → Tavily web search, cached in MongoDB) weaves company-specific interview culture into the questions.
- **Camera attention tracking** — for job interviews, on-device face/pose tracking flags when you look away, and it factors into your score. Runs in the browser (MediaPipe) with a matching server-side check.

### Feedback & scoring
- **Rubric-based scoring** — the transcript is scored 0–100 per criterion against a mode-specific rubric, with a weighted overall score and summary.
- **Letter grade + insights** — overall score ring, letter grade, and auto-computed stats (answers given, words spoken, filler-word count).
- **Per-answer breakdown** — an LLM pass rates each key answer (Strong / OK / Needs work) and gives a specific, actionable tip.
- **Downloadable result card** — export a shareable PNG report card of your score and breakdown.

### Review
- **Follow-up chat** — after the interview, chat with the AI about your performance ("why did I score low here?", "what should I have said?") — it has your full transcript and score as context.
- **Session history + progress** — past sessions are saved locally, with a progress sparkline tracking your scores over time.

---

## Tech stack

| Layer | Tech |
| :--- | :--- |
| **Voice orchestration** | LiveKit Agents (Python) |
| **Speech** | Deepgram (Nova-3 STT, Aura-2 TTS) |
| **LLM** | Groq — `llama-3.3-70b-versatile` (interview, scoring, feedback, chat) |
| **RAG** | Pinecone (hosted `multilingual-e5-large` embeddings) |
| **Vision** | MediaPipe Face Landmarker (browser + server) |
| **Persistence** | SQLite (local doc/session store) + MongoDB Atlas (company-research cache, TTL) |
| **API** | FastAPI (Uvicorn) |
| **Frontend** | Next.js 16 (App Router, React 19) + Tailwind CSS v4 |

---

## How it works

```
        upload doc                 start session                    live call
Frontend ──────────► FastAPI ──────────────────► LiveKit room ◄──────────────► Voice Agent
   │  /documents/upload   │  /sessions/start          (audio + video)          │
   │                      │  (mints token +                                    │  Deepgram STT
   │                      │   room metadata)                                   │  Groq LLM (RAG + company ctx + persona)
   │                      │                                                    │  Deepgram TTS
   │                                                                           │  MediaPipe attention tracking
   │  poll /sessions/{id}/score                                               ▼
   │◄──────────────────────────────────────────────────  on call end: score transcript,
   │  score + per-answer feedback + review chat            save transcript + score
   ▼
Results UI: score ring, grade, stats, answer breakdown, result card, review chat
```

1. **Upload** → the document is chunked, embedded, and stored in Pinecone; metadata goes in the local store.
2. **Start** → the API mints a LiveKit token and packs the room metadata (document id, resource type, persona, duration, optional company/position).
3. **Interview** → the agent joins the room, retrieves the document context (and company research if applicable), builds its system prompt, and runs the spoken interview. Transcriptions stream to the browser for live captions.
4. **Scoring** → on call end, a shutdown callback scores the transcript against the rubric (folding in camera-attention for job interviews) and persists it.
5. **Review** → the frontend fetches the score, per-answer feedback, and offers a follow-up chat over the same transcript.

---

## Project structure

```
voca/
├─ run_dev.py                 # one command to run api + agent + frontend
├─ backend/
│  ├─ api/                    # FastAPI app
│  │  ├─ main.py
│  │  └─ routers/             # documents.py, sessions.py
│  ├─ agent/
│  │  ├─ agent.py             # LiveKit voice agent worker
│  │  └─ prompts.py           # system prompt + persona directives
│  ├─ rag/                    # chunk / embed / retrieve (Pinecone)
│  ├─ research/               # tiered company research + cache
│  ├─ scoring/                # rubric, scorer, answer_feedback, schemas
│  ├─ chat/                   # review_chat.py (post-interview chat)
│  ├─ vision/                 # attention.py (camera attention tracking)
│  └─ db/                     # local_store (SQLite), mongo_store, session_cache
└─ frontend/
   └─ app/
      ├─ page.tsx             # landing, setup wizard, voice-mode call, results, history
      ├─ ReviewChat.tsx       # post-interview review chat
      ├─ FaceGuideOverlay.tsx # live on-camera posture guide
      └─ globals.css          # dark/glassy design system (Tailwind v4)
```

---

## API reference

**Documents**
| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/documents/upload` | Upload a PDF/TXT (or pasted job description); chunks + embeds it |
| `GET` | `/documents` | List uploaded documents |
| `GET` | `/documents/{id}` | Get one document |

**Sessions**
| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/sessions/start` | Start an interview — returns LiveKit URL + token. Body: `document_id`, optional `company_name`, `position`, `duration_minutes`, `persona` |
| `GET` | `/sessions/{id}/score` | Get the score + transcript for a finished session |
| `GET` | `/sessions/{id}/feedback` | Per-answer breakdown (verdict + tip) via an LLM pass |
| `GET` | `/sessions` | List scored sessions |
| `GET` | `/sessions/{id}/chat` | Get the follow-up chat history |
| `POST` | `/sessions/{id}/chat` | Send a message to the review chat. Body: `message` |

---

## Getting started

### Prerequisites
- Python 3.11+
- Node.js 20+
- API keys (see [Environment variables](#environment-variables))

### 1. Environment variables

Copy `backend/.env.example` to `backend/.env` and fill it in. The frontend can optionally read `NEXT_PUBLIC_API_URL` from `frontend/.env.local` (defaults to `http://localhost:8001`).

### 2. First-time setup

```bash
# API
cd backend
python -m venv .venv-api
# Windows: .venv-api\Scripts\activate | macOS/Linux: source .venv-api/bin/activate
pip install -r api/requirements.txt

# Voice agent (separate venv)
cd agent
python -m venv .venv
# activate as above
pip install -r requirements.txt
cd ../..

# Frontend
cd frontend
npm install
cd ..
```

### 3. Run everything

One command runs the API, the voice agent, and the frontend together (Ctrl+C stops all three):

```bash
python run_dev.py
```

Then open **http://localhost:3000**.

The voice agent is supervised — if it crashes (the LiveKit native layer can panic while a call tears down), `run_dev.py` automatically respawns it, so you can run one interview after another without restarting.

> Prefer separate terminals? Run each service manually:
> - API: `cd backend && python -m uvicorn api.main:app --reload --port 8001`
> - Agent: `cd backend/agent && python agent.py dev`
> - Frontend: `cd frontend && npm run dev`
>
> To test the voice agent alone with no document grounding: `python agent.py console`.

---

## Environment variables

Create `backend/.env` (copy from `backend/.env.example`):

```
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
DEEPGRAM_API_KEY=
GROQ_API_KEY=
PINECONE_API_KEY=        # RAG embeddings + retrieval
MONGODB_URI=             # company-research cache (MongoDB Atlas)
TAVILY_API_KEY=          # company-research web-search fallback
```

**MongoDB** (research cache): create a free [Atlas](https://www.mongodb.com/atlas) cluster and set `MONGODB_URI`. The `company_research_db` database, `research` collection, and a 30-day TTL index are created automatically on first use.

---

## Security

**Never commit `.env` / `.env.local` or paste API keys into chat, issues, or commits.** All secrets are loaded from environment variables via `python-dotenv`; `.env*` files are gitignored.
