from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


ExecutionMode = Literal[
    "realtime_incremental",
    "near_realtime_refresh",
    "streaming_required",
    "rejected",
]


@dataclass(frozen=True)
class ExecutionSignals:
    fact_insert_is_only_trigger: bool = True
    dimensions_are_bounded_n_to_one: bool = True
    right_side_requires_immediate_history: bool = False
    independently_changing_fast_inputs: bool = False
    event_time_retraction_required: bool = False
    estimated_cost_exceeds_limit: bool = False


def classify_execution_mode(signals: ExecutionSignals) -> ExecutionMode:
    if signals.estimated_cost_exceeds_limit:
        return "rejected"
    if signals.independently_changing_fast_inputs or signals.event_time_retraction_required:
        return "streaming_required"
    if signals.right_side_requires_immediate_history:
        return "near_realtime_refresh"
    if signals.fact_insert_is_only_trigger and signals.dimensions_are_bounded_n_to_one:
        return "realtime_incremental"
    return "rejected"
