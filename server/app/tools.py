"""Deterministic finance tools. Pure, read-only functions: none of them sends anything.

SAFETY: all money maths happens here in Python, never inside the LLM.
"""
import datetime as dt
from collections import defaultdict

from .models import Transaction


def detect_stealth_hikes(transactions: list[Transaction], threshold: float = 0.10) -> list[dict]:
    """Flag consecutive subscription charges that rose by MORE than `threshold` (strictly greater)."""
    groups: dict[str, list[Transaction]] = defaultdict(list)
    for t in transactions:
        # Refunds (amount <= 0) and non-subscriptions are ignored.
        if t.category == "Subscriptions" and t.amount > 0:
            groups[t.merchant.strip().casefold()].append(t)

    hikes: list[dict] = []
    for items in groups.values():
        items.sort(key=lambda t: t.date or dt.date.min)  # undated rows sort first
        for prev, cur in zip(items, items[1:]):
            if prev.amount <= 0:
                continue
            change = (cur.amount - prev.amount) / prev.amount
            if round(change, 9) > threshold:  # rounding avoids float noise at exactly 10%
                hikes.append({
                    "merchant": cur.merchant,
                    "old_amount": round(prev.amount, 2),
                    "new_amount": round(cur.amount, 2),
                    "change_pct": round(change * 100, 1),
                    "date": cur.date.isoformat() if cur.date else None,
                    "monthly_increase": round(cur.amount - prev.amount, 2),
                })
    return hikes


def calculate_annual_leakage(merchant: str, monthly_amount: float) -> dict:
    if monthly_amount < 0:
        raise ValueError("monthly_amount must not be negative")
    return {
        "merchant": merchant,
        "monthly_amount": round(monthly_amount, 2),
        "annual_cost": round(monthly_amount * 12, 2),
    }


def generate_cancellation_script(merchant: str, old_amount: float, new_amount: float) -> dict:
    """Builds a DRAFT only. It is never sent anywhere (`sent` is always False)."""
    increase = round(new_amount - old_amount, 2)
    draft = (
        "Subject: Request to review subscription price change\n\n"
        f"Hello {merchant} Support,\n\n"
        f"I noticed my recurring subscription changed from ${old_amount:.2f} to ${new_amount:.2f}. "
        "Please confirm when and how this price change was communicated. "
        f"I request a review of the ${increase:.2f} increase and information about "
        "cancellation options and any applicable refund policy.\n\n"
        "Thank you."
    )
    return {"merchant": merchant, "draft": draft, "sent": False}
