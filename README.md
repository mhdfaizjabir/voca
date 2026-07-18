---

## 📄 Complete README.md (full replacement)

Copy **everything** below from the very first line (`# Voca AI`) to the very last line (`python-dotenv.`):

---

```markdown
# Voca AI

Voice‑based interview practice platform. Users upload course material (viva practice) or a job description (mock interview) – an AI voice agent conducts a spoken interview grounded in that material, then scores the transcript against a user‑defined rubric.

---

## Status

| Milestone | Status |
| :--- | :--- |
| **1. LiveKit Voice Agent** | ✅ Done – `backend/agent/` (Deepgram STT → Groq LLM → Deepgram TTS) |
| **2. RAG (Upload / Embed / Retrieve)** | ✅ Done – `backend/rag/`, `backend/api/routers/` |
| **3. MongoDB Persistence** | ✅ Done – research cache stored in MongoDB Atlas (`backend/db/mongo_store.py`) |
| **4. Rubric‑based Scoring** | ✅ Done – `backend/scoring/`, `GET /sessions/{id}/score` |
| **5. Company Research (Tiered + Cache)** | ✅ Done – Tier 1 (LLM) → fallback to Tier 2 (Tavily web search), cached by `company` + `position` |
| **6. Position‑Specific Lookup** | ✅ Done – agent accepts `position` in room metadata and uses it in prompts |
| **7. Cache Expiry (TTL)** | ✅ Done – MongoDB auto‑deletes research entries after 30 days |
| **8. Vague‑Output Detector** | ✅ Done – forces Tavily fallback if LLM gives generic hedging phrases |
| **9. Frontend (basic)** | ✅ Done – Next.js single‑page app (`frontend/`) |

---

## 🗄️ MongoDB Setup (for research cache)

We use **MongoDB Atlas** (free tier) to cache company research results.

1. Create a free cluster at [MongoDB Atlas](https://www.mongodb.com/atlas).
2. In your `backend/.env` file, add:
   ```
   MONGODB_URI=mongodb+srv://<username>:<password>@cluster...mongodb.net/
   ```
3. The agent will automatically create the `company_research_db` database and `research` collection on first use.
4. A TTL index auto‑deletes entries older than 30 days – no manual cleanup.

---

## 🧪 Testing the Research Pipeline (without frontend)

```bash
cd backend/agent
python test_research.py
```

Enter a company and position – the script runs the tiered research, shows the source/confidence, and caches the result in MongoDB. Run it again with the same inputs to confirm the cache hit.

---

## 🔧 Environment Variables

Create a `backend/.env` file (copy from `.env.example`) with at least:

```
LIVEKIT_URL=...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
DEEPGRAM_API_KEY=...
GROQ_API_KEY=...
TAVILY_API_KEY=...          # required for company research fallback
PINECONE_API_KEY=...        # for RAG
MONGODB_URI=...             # for research cache
```

Never commit `.env` to Git.

---

## 🚀 Running Everything (3 terminals)

### 1. Backend API (document upload + session tokens)

```bash
cd backend
python -m venv .venv-api
# Windows: .venv-api\Scripts\activate   | Mac/Linux: source .venv-api/bin/activate
pip install -r api\requirements.txt
python -m uvicorn api.main:app --reload --port 8001
```

### 2. Voice Agent Worker

```bash
cd backend\agent
python -m venv .venv
# activate as above
pip install -r requirements.txt
python agent.py dev
```

The agent reads the same `backend/.env` automatically.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000, upload a document, and click **Start Interview**.

To test the voice agent alone (no document grounding), run `python agent.py console`.

---

## 🔍 How Company Research Works

1. Frontend passes `company_name` and `position` in room metadata.
2. Agent calls `get_company_context(company, position)`.
3. **Cache check** – MongoDB returns cached result if exists.
4. **Tier 1** – parametric LLM (Groq) – if confidence ≥ 0.4 and no hedging phrases → saved.
5. **Tier 2** – Tavily web search (Glassdoor, Reddit, etc.) → synthesised summary → saved.
6. **Fallback** – generic "no info" message.

The summary is woven into the agent's system prompt via `build_instructions()`.

---

## 📊 Scoring

When a call ends, a shutdown callback scores the transcript against the rubric and stores it. Retrieve the score via:

```
GET /sessions/{session_id}/score
```

---

## 📬 Next Steps (optional)

- Frontend polish (real‑time transcript, progress indicators)
- Multi‑language support
- Advanced analytics dashboard

---

## 🤝 Contributing

- Keep `.env` out of Git.
- Use `test_research.py` to validate changes to the research pipeline.
- Open pull requests for new features.

---

**Never commit `.env`/`.env.local` or paste API keys in chat/issues/commits.**  
All keys are loaded from environment variables via `python-dotenv`.
```

---
The file should now end with:
```
All keys are loaded from environment variables via `python-dotenv`.
```
