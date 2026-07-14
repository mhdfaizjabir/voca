# Voca AI

Voice-based interview practice platform. Users upload course material (viva
practice) or a job description (mock interview practice); an AI voice agent
conducts a spoken interview grounded in that material, then scores the
transcript against a user-defined rubric.

## Status

- **Milestone 1 (done)**: standalone LiveKit voice agent — Deepgram STT →
  Groq LLM → Deepgram TTS. See `backend/agent/`. Tested live.
- **Milestone 2 (done)**: RAG — document upload, chunking, Pinecone
  integrated-inference embeddings/retrieval, wired into the agent's
  instructions via room metadata. See `backend/rag/`,
  `backend/api/routers/documents.py`, `backend/api/routers/sessions.py`.
  Tested live (upload → embed → retrieve).
- **Milestone 3 (not built — owned by teammate)**: MongoDB Atlas
  persistence for users/sessions/transcripts. `backend/db/local_store.py`
  is a temporary SQLite stand-in for document metadata only, used until
  that lands.
- **Milestone 4 (done)**: rubric-based scoring. A shutdown callback in
  `backend/agent/agent.py` captures the session transcript when a call
  ends, scores it against a (default or per-session custom) rubric via
  Groq, and stores the result. See `backend/scoring/`, `GET
  /sessions/{id}/score`. Tested live (scoring logic + storage + API
  round-trip); the LiveKit shutdown-callback trigger itself needs a real
  call to confirm.
- **Frontend (basic, done)**: single-page Next.js app to upload a document,
  start/end a voice session, and poll for the score afterwards. See
  `frontend/`.
- **Web scraping (not built — owned by teammate)**: company research to
  enrich job-description context. Not wired in yet.

## Running everything (3 terminals)

**1. Backend API** (document upload + session tokens):
```
cd backend
python -m venv .venv-api
.venv-api\Scripts\activate
pip install -r api\requirements.txt
copy .env.example .env   # fill in LIVEKIT_*, DEEPGRAM_API_KEY, GROQ_API_KEY, PINECONE_API_KEY
python -m uvicorn api.main:app --reload --port 8001
```

**2. Voice agent worker**:
```
cd backend\agent
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python agent.py dev
```
(Agent reads the same `backend\.env` automatically — no separate copy needed.)

**3. Frontend**:
```
cd frontend
npm install
npm run dev
```
Open http://localhost:3000, upload a `.txt`/`.pdf`, then click **Start
interview** — it connects to LiveKit with your mic, and the agent worker
in terminal 2 grounds its questions in the uploaded document.

To test the voice agent alone without the frontend, `python agent.py
console` talks to it directly in your terminal (no document grounding,
since there's no room metadata in console mode).

**Never commit `.env`/`.env.local` or paste API keys in chat/issues/commits.**
All keys are loaded from environment variables via `python-dotenv`.
