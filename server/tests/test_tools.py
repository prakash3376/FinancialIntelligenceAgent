"""Run with: cd backend && pytest"""
import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import Transaction
from app.sample_data import sample_transactions
from app.tools import calculate_annual_leakage, detect_stealth_hikes, generate_cancellation_script


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "replace_me")  # force demo mode


def tx(merchant, date, amount, cat="Subscriptions"):
    return Transaction(merchant=merchant, date=dt.date.fromisoformat(date), category=cat, amount=amount)


# ---- tools
def test_sample_contains_expected_price_hike():
    hikes = detect_stealth_hikes(sample_transactions())
    assert len(hikes) == 1
    h = hikes[0]
    assert (h["merchant"], h["old_amount"], h["new_amount"], h["change_pct"]) == ("StreamBox Premium", 37.69, 49.0, 30.0)
    assert h["date"] == "2026-08-03" and h["monthly_increase"] == 11.31


def test_annual_cost():
    assert calculate_annual_leakage("StreamBox Premium", 49.0)["annual_cost"] == 588.0


def test_draft_is_not_sent():
    r = generate_cancellation_script("StreamBox Premium", 37.69, 49.0)
    assert r["sent"] is False and "$11.31" in r["draft"]


def test_flat_spotify_not_flagged():
    assert detect_stealth_hikes([tx("Spotify", f"2026-0{m}-14", 11.99) for m in (6, 7, 8)]) == []


def test_exact_ten_percent_not_flagged():
    assert detect_stealth_hikes([tx("X", "2026-06-01", 10.0), tx("X", "2026-07-01", 11.0)]) == []


def test_negative_monthly_amount_raises():
    with pytest.raises(ValueError):
        calculate_annual_leakage("X", -1)


# ---- API
client = TestClient(app)


def test_health_and_sample():
    assert client.get("/api/health").json() == {"status": "ok", "gemini_configured": False}
    d = client.get("/api/sample").json()
    assert len(d["transactions"]) == 14 and d["currency"] == "USD"


def test_audit_happy_path_and_double_approval():
    txs = client.get("/api/sample").json()["transactions"]
    s = client.post("/api/audits", json={"transactions": txs}).json()
    assert s["status"] == "awaiting_approval" and s["steps"] == 3 and len(s["findings"]) == 1
    assert [e["type"] for e in s["audit_log"]] == [
        "started", "plan", "tool", "plan", "tool", "plan", "tool", "approval_required"]
    pa = s["pending_action"]
    assert pa["annual_cost"] == 588.0 and pa["sent"] is False and "$49.00" in pa["draft"]
    assert s["summary"] == "StreamBox Premium increased from $37.69 to $49.00 (+30.0%). Current annualized cost: $588.00."

    ok = client.post(f"/api/audits/{s['session_id']}/approval", json={"decision": "approve"}).json()
    assert ok["status"] == "done" and ok["pending_action"]["approved"] is True and ok["pending_action"]["sent"] is False
    assert ok["summary"].endswith("Demo action approved and simulated; no message was sent.")
    assert client.post(f"/api/audits/{s['session_id']}/approval", json={"decision": "approve"}).status_code == 409
    assert client.post("/api/audits/nope/approval", json={"decision": "approve"}).status_code == 404


def test_reject_and_no_hike():
    txs = client.get("/api/sample").json()["transactions"]
    s = client.post("/api/audits", json={"transactions": txs}).json()
    r = client.post(f"/api/audits/{s['session_id']}/approval", json={"decision": "reject"}).json()
    assert r["pending_action"]["approved"] is False
    assert r["summary"].endswith("Proposed action rejected; nothing was sent.")
    spot = [t for t in txs if t["merchant"] == "Spotify"]
    n = client.post("/api/audits", json={"transactions": spot}).json()
    assert n["status"] == "done" and n["findings"] == [] and n["pending_action"] is None


def test_audit_empty_is_400():
    assert client.post("/api/audits", json={"transactions": []}).status_code == 400


def test_extract_errors():
    assert client.post("/api/extract", data={"text": "2026-09-14 SPOTIFY 11.99"}).status_code == 503
    assert client.post("/api/extract", data={}).status_code == 400
    assert client.post("/api/extract", files={"file": ("a.txt", b"", "text/plain")}).status_code == 400
    big = b"x" * (13 * 1024 * 1024)
    assert client.post("/api/extract", files={"file": ("a.txt", big, "text/plain")}).status_code == 413
