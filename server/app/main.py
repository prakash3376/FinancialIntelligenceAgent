"""FastAPI routes, bounded agent loop and in-memory sessions.

SAFETY NOTES
- This file imports NO AI SDK. All AI access goes through ai_service.py, and whatever it
  returns is treated as untrusted (re-validated, re-grounded, allowlisted).
- Nothing here sends email, contacts a merchant/bank, or calls a payment API. Approval is a
  local simulation: `sent` is always False.
"""
import csv
import io
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")  # before importing ai_service

from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, ValidationError  # noqa: E402

from .ai_service import choose_next_step, extract_statement  # noqa: E402
from .models import (  # noqa: E402
    ApprovalRequest, AuditRequest, AuditSession, Transaction,
)
from .sample_data import sample_transactions  # noqa: E402
from .tools import (  # noqa: E402
    calculate_annual_leakage, detect_stealth_hikes, generate_cancellation_script,
)

MAX_FILE_BYTES = 12 * 1024 * 1024
MAX_AI_TEXT_CHARS = 100_000
MAX_STEPS = 6
ALLOWED_TOOLS = ["detect_stealth_hikes", "calculate_annual_leakage",
                 "generate_cancellation_script", "finish"]

SESSIONS: dict[str, AuditSession] = {}  # in-memory only; cleared on restart

app = FastAPI(title="Finance Intelligence Agent (Finwise)")

_origins = [o.strip() for o in os.getenv("FRONTEND_ORIGIN", "http://localhost:5173").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["*"], allow_headers=["*"])


def gemini_configured() -> bool:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    return bool(key) and key != "replace_me"


# ---------------------------------------------------------------- simple routes
@app.get("/api/health")
def health():
    return {"status": "ok", "gemini_configured": gemini_configured()}


@app.get("/api/sample")
def sample():
    return {
        "transactions": [t.model_dump(mode="json") for t in sample_transactions()],
        "currency": "USD",
        "source": "fictional workshop sample",
    }


# ---------------------------------------------------------------- extraction (L1)
@app.post("/api/extract")
async def extract(text: str | None = Form(None), file: UploadFile | None = File(None)):
    clean_text = (text or "").strip()
    has_file = file is not None and bool(file.filename)
    if not clean_text and not has_file:
        raise HTTPException(400, "Paste transaction text or choose a file.")

    file_bytes: bytes | None = None
    mime = None
    filename = ""
    if has_file:
        file_bytes = await file.read(MAX_FILE_BYTES + 1)
        if len(file_bytes) > MAX_FILE_BYTES:
            raise HTTPException(413, "Please use a file smaller than 12 MB for this classroom demo.")
        if len(file_bytes) == 0:
            raise HTTPException(400, "The selected file is empty.")
        mime = file.content_type or "application/octet-stream"
        filename = (file.filename or "").lower()

    try:
        if has_file and (mime == "text/csv" or filename.endswith(".csv")):
            # CSV path: Python parses the table; the AI only normalises it.
            try:
                decoded = file_bytes.decode("utf-8-sig")
            except UnicodeDecodeError:
                raise HTTPException(400, "CSV must be UTF-8 encoded.")
            try:
                rows = list(csv.DictReader(io.StringIO(decoded)))
            except csv.Error as e:
                raise HTTPException(400, f"Could not read CSV: {e}")
            if not rows:
                raise HTTPException(400, "Could not read CSV: no data rows found.")
            payload = "CSV rows (extract/normalize only; do not invent values):\n" + repr(rows)
            statement = extract_statement(text=payload[:MAX_AI_TEXT_CHARS])
        else:
            statement = extract_statement(
                text=clean_text[:MAX_AI_TEXT_CHARS] or None,
                file_bytes=file_bytes,
                mime_type=mime,
            )
    except HTTPException:
        raise
    except RuntimeError as e:
        if str(e).startswith("Gemini is not configured"):
            raise HTTPException(503, str(e))
        raise HTTPException(502, f"Gemini extraction failed: {e}")
    except Exception as e:  # network, quota, bad JSON ... (no automatic retry)
        raise HTTPException(502, f"Gemini extraction failed: {e}")

    # Second validation layer: the AI output is untrusted.
    valid: list[dict] = []
    errors: list[dict] = []
    for i, raw in enumerate(getattr(statement, "transactions", []) or []):
        try:
            data = raw.model_dump() if isinstance(raw, BaseModel) else raw
            valid.append(Transaction.model_validate(data).model_dump(mode="json"))
        except ValidationError as e:
            errors.append({"row": i + 1, "error": e.errors()[0]["msg"]})
    return {
        "transactions": valid,
        "notes": list(getattr(statement, "notes", []) or []),
        "validation_errors": errors,
        "count": len(valid),
    }


# ---------------------------------------------------------------- agent (L7-L9)
def _log(s: AuditSession, type_: str, message: str, details: dict | None = None):
    s.audit_log.append({
        "time": datetime.now(timezone.utc).isoformat(),
        "type": type_, "message": message, "details": details or {},
    })


def _summary(findings: list[dict]) -> str:
    if not findings:
        return "No subscription price hikes above 10% were found in the provided data."
    return " ".join(
        f"{f['merchant']} increased from ${f['old_amount']:.2f} to ${f['new_amount']:.2f} "
        f"(+{f['change_pct']:.1f}%). Current annualized cost: ${f['new_amount'] * 12:.2f}."
        for f in findings
    )


def _match(findings: list[dict], merchant) -> dict | None:
    """Re-ground planner arguments: only real findings can be acted on."""
    for f in findings:
        if f["merchant"] == merchant:
            return f
    return findings[0] if findings else None


def run_audit(transactions: list[Transaction], goal: str) -> AuditSession:
    s = AuditSession(goal=goal)
    SESSIONS[s.session_id] = s
    _log(s, "started", "Audit started.", {"transaction_count": len(transactions)})
    tool_results: list[dict] = []
    try:
        for _ in range(MAX_STEPS):  # hard cap on the loop
            s.steps += 1
            d = choose_next_step(goal, s.findings, tool_results, ALLOWED_TOOLS)
            name = d.tool_name
            if name not in ALLOWED_TOOLS:
                raise ValueError("Tool is not allowed")
            args = d.arguments if isinstance(d.arguments, dict) else {}
            _log(s, "plan", d.message or f"Selected {name}.", {"tool": name, "arguments": args})
            if name == "finish":
                break

            if name == "detect_stealth_hikes":
                s.findings = detect_stealth_hikes(transactions)
                result = {"findings": s.findings}
            elif name == "calculate_annual_leakage":
                f = _match(s.findings, args.get("merchant"))
                try:  # prefer the finding whose price matches the planner's argument
                    amt = float(args.get("monthly_amount"))
                    f = next((x for x in s.findings
                              if x["merchant"] == args.get("merchant")
                              and abs(x["new_amount"] - amt) < 0.001), f)
                except (TypeError, ValueError):
                    pass
                # Always compute from the matched finding, never from raw model arguments.
                result = (calculate_annual_leakage(f["merchant"], f["new_amount"])
                          if f else {"skipped": "No price hike found."})
            else:  # generate_cancellation_script
                f = _match(s.findings, args.get("merchant"))
                if f:
                    result = generate_cancellation_script(f["merchant"], f["old_amount"], f["new_amount"])
                    s.pending_action = {
                        "type": "review_subscription_change",
                        "merchant": f["merchant"], "old_amount": f["old_amount"],
                        "new_amount": f["new_amount"], "change_pct": f["change_pct"],
                        "date": f["date"], "annual_cost": round(f["new_amount"] * 12, 2),
                        "monthly_increase": f["monthly_increase"],
                        "draft": result["draft"], "sent": False,
                    }
                else:
                    result = {"skipped": "No price hike found."}

            tool_results.append({"tool": name, "result": result})
            _log(s, "tool", f"Executed {name}.", result)

            if name == "generate_cancellation_script" and s.pending_action:
                s.status = "awaiting_approval"  # HUMAN GATE: stop and wait for a decision
                s.summary = _summary(s.findings)
                _log(s, "approval_required",
                     "Draft ready. Waiting for human approval; nothing has been sent.")
                return s

        s.status = "done"
        s.summary = _summary(s.findings) or "Audit completed. No subscription price hikes above the threshold were found."
        _log(s, "completed", "Audit completed.", {"steps": s.steps})
    except Exception as e:
        s.status = "failed"
        s.summary = f"Audit stopped safely: {e}"
        _log(s, "error", str(e))
    return s


@app.post("/api/audits")
def start_audit(req: AuditRequest):
    if not req.transactions:
        raise HTTPException(400, "Add transactions before starting an audit.")
    return run_audit(req.transactions, req.goal)


@app.get("/api/audits/{session_id}")
def get_audit(session_id: str):
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "Audit session not found.")
    return s


@app.post("/api/audits/{session_id}/approval")
def decide(session_id: str, req: ApprovalRequest):
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "Audit session not found. Start a new audit.")
    if s.status != "awaiting_approval" or not s.pending_action:
        raise HTTPException(409, "This audit has no pending approval.")
    pa = s.pending_action
    if req.decision == "approve":
        s.status = "executing"
        # LOCAL SIMULATION ONLY: nothing is sent anywhere.
        pa["simulated_execution"] = "Approved and recorded locally; no external message was sent."
        pa["approved"] = True
        _log(s, "approved_simulation", "Human approved the draft (simulation only).",
             {"merchant": pa["merchant"], "reason": req.reason})
        s.status = "done"
        s.summary += " Demo action approved and simulated; no message was sent."
    else:
        pa["approved"] = False
        _log(s, "rejected", "Human rejected the proposed action. Nothing was sent.",
             {"merchant": pa["merchant"], "reason": req.reason})
        s.status = "done"
        s.summary += " Proposed action rejected; nothing was sent."
    pa["sent"] = False
    return s
