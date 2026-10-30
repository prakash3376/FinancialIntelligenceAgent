# Finance Intelligence Agent (Finwise)

A minimal, classroom-friendly full-stack demo of two AI patterns on personal-finance data:

- **Layer 1, GenAI extraction:** paste raw bank text or upload a receipt/statement. An LLM (Gemini) extracts structured JSON, Pydantic validates it, and a dashboard shows the result.
- **Layer 2, AI agent audit:** a bounded (max 6 steps) agent loop uses deterministic Python tools to find silent subscription price hikes, compute their annual cost and draft a dispute message. The draft waits for **human approval**, and every step is shown in a trace.

> **Educational demo, not financial advice.** Approval is a local simulation: the app never sends email, contacts merchants or banks, or moves money.
> **Privacy:** use fictional or redacted data only. **Do not upload real bank statements.** Nothing is stored (in-memory only).

## Project structure
```
finance-intelligence-agent/
├── backend/
│   ├── app/ (ai_service.py [STUB], main.py, models.py, sample_data.py, tools.py)
│   ├── tests/test_tools.py
│   ├── .env.example, pytest.ini, requirements.txt
├── frontend/ (src/App.jsx, src/main.jsx, src/styles.css, index.html, package.json, vite.config.js)
└── README.md
```

## Prerequisites
Python 3.11+ (3.12 recommended), Node 20+.

## Run the backend (port 8000)
```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # Windows: copy .env.example .env
uvicorn app.main:app --reload --port 8000
```
Interactive API docs: http://localhost:8000/docs

## Run the frontend (port 5173)
```bash
cd frontend
npm install
npm run dev                        # http://localhost:5173
npm run build                      # production build check
```

## Run the tests
```bash
cd backend && pytest
```

## Configuration (`backend/.env`)
| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | `replace_me` | `replace_me` or empty = demo mode |
| `GEMINI_MODEL` | `gemini-2.5-flash` | |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | comma-separated list allowed (CORS) |

Frontend: optional `VITE_API_URL` (default `http://localhost:8000`).

## 6-step demo flow
1. Open the app: the 14 fictional sample transactions load automatically (Total outflow **$364.34**).
2. Review the dashboard: monthly chart, category list, transactions table with raw source lines.
3. (Optional) Click **Use example** then **Extract transactions**. Without an API key a red banner explains Gemini is not configured; your data stays.
4. Click **Run agent audit**. The agent inspects, calculates, then asks first.
5. Inspect the **+30% StreamBox Premium** card ($37.69 → $49.00, **$588.00/year**) and the draft marked **NOT SENT**.
6. Click **Approve simulation** or **Reject**, then read the trace.

## API
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Status + `gemini_configured` flag |
| GET | `/api/sample` | Fictional starter transactions |
| POST | `/api/extract` | Multipart `text` and/or `file` → validated transactions |
| POST | `/api/audits` | Start a bounded audit from typed transactions |
| GET | `/api/audits/{session_id}` | Read audit state and trace |
| POST | `/api/audits/{session_id}/approval` | `{"decision": "approve" \| "reject", "reason"?: str}` |

## Hand-coding the Gemini integration
Only `backend/app/ai_service.py` needs editing. Search for `TODO(manual)`:
1. `_client()`: create `google.genai.Client(api_key=key)` and return it.
2. `extract_statement()`: call Gemini with `SYSTEM_EXTRACTION_PROMPT`, `response_schema=Statement`, `temperature=0`.
3. `choose_next_step()`: LLM planner returning `AgentDecision` via structured output.

`main.py` treats every AI output as untrusted: it re-validates rows with Pydantic, enforces the 4-tool allowlist, caps the loop at 6 steps and re-grounds tool arguments against detected findings. `google-genai` is already in `requirements.txt`.

## Teaching notes and limits
- The LLM never computes money values: all totals and annual costs are Python/JavaScript.
- Transaction text is untrusted data, never instructions (prompt-injection defence).
- No authentication, database or multi-user support; sessions are lost on restart. No deduplication of transactions. USD only.
- Until the manual AI integration is written, extraction always returns 503; the sample data and full agent audit work in demo mode.

## Troubleshooting
- **Frontend cannot connect:** make sure the backend runs on port 8000, or set `VITE_API_URL` (e.g. in `frontend/.env`: `VITE_API_URL=http://localhost:8001`) and check `FRONTEND_ORIGIN` matches the URL in your browser.
- **"Gemini is not configured":** add a real `GEMINI_API_KEY` to `backend/.env` and finish the `TODO(manual)` code.
- **Model errors (502):** check the key, quota and `GEMINI_MODEL`; retry manually (no automatic retries).
- **Port in use:** start uvicorn with another `--port` and set `VITE_API_URL` accordingly.
- **"Audit session not found":** the backend restarted; run the audit again.
