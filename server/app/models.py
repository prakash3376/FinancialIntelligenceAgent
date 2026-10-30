"""Pydantic v2 schemas. These are the contract between the AI boundary, the API and the UI."""
import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field

Category = Literal[
    "Dining", "Fuel", "Shopping", "Subscriptions",
    "Food delivery", "Income", "Bills", "Other",
]

DEFAULT_GOAL = "Audit my transactions for subscription traps and silent price hikes."


class Transaction(BaseModel):
    merchant: str = Field(min_length=1, max_length=120)  # normalised merchant name
    date: dt.date | None = None  # ISO date; null when unclear (never guessed)
    category: Category = "Other"
    amount: float  # positive = charge, negative = refund/credit; no currency symbol
    raw_line: str | None = None  # original source line


class Statement(BaseModel):
    """AI extraction output schema."""
    transactions: list[Transaction]
    notes: list[str] = []  # explains uncertainty


class AuditRequest(BaseModel):
    transactions: list[Transaction]
    goal: str = DEFAULT_GOAL


class ApprovalRequest(BaseModel):
    decision: Literal["approve", "reject"]
    reason: str | None = None


class AgentDecision(BaseModel):
    """Planner output. Always treated as UNTRUSTED by main.py."""
    tool_name: Literal[
        "detect_stealth_hikes", "calculate_annual_leakage",
        "generate_cancellation_script", "finish",
    ]
    arguments: dict[str, Any] = {}
    message: str = ""


class AuditSession(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    status: Literal["analyzing", "awaiting_approval", "executing", "done", "failed"] = "analyzing"
    goal: str = DEFAULT_GOAL
    findings: list[dict[str, Any]] = []
    pending_action: dict[str, Any] | None = None
    audit_log: list[dict[str, Any]] = []  # {time, type, message, details}
    summary: str = ""
    steps: int = 0
