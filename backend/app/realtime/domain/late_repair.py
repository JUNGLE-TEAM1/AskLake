from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from app.realtime.domain.dimension import MissingPolicy


RepairStatus = Literal["pending", "due", "expired"]


@dataclass(frozen=True)
class RepairDecision:
    status: RepairStatus
    next_retry_at: datetime | None
    publish_null: bool
    correction_generation: int


def plan_late_repair(
    *,
    policy: MissingPolicy,
    first_seen_at: datetime,
    now: datetime,
    retry_count: int,
    current_correction_generation: int = 0,
    repair_window: timedelta = timedelta(hours=24),
) -> RepairDecision:
    if retry_count < 0 or current_correction_generation < 0:
        raise ValueError("repair counters cannot be negative")
    if now >= first_seen_at + repair_window:
        return RepairDecision("expired", None, policy == "publish_null_then_correct", current_correction_generation)
    delay_seconds = min(600, 2 ** min(retry_count, 10))
    next_retry = now + timedelta(seconds=delay_seconds)
    return RepairDecision(
        "due" if retry_count == 0 else "pending",
        next_retry,
        policy == "publish_null_then_correct",
        current_correction_generation + (1 if policy == "publish_null_then_correct" else 0),
    )
