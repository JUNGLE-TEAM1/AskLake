"""Pure command planning for finite Snapshot Jobs.

External runtimes (Airflow, Kafka bridge, Trino) stay behind service adapters.
This module owns which command is valid and which finite execution path must be
used, keeping Snapshot lifecycle policy separate from Continuous lifecycle.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


SNAPSHOT_COMMANDS = frozenset({
    "run",
    "retry",
    "pause",
    "cancelRun",
    "stopSchedule",
    "resumeSchedule",
})


class SnapshotExecutionPath(StrEnum):
    RUN = "run"
    CANCEL = "cancel"
    CONTROL = "control"
    TRINO = "trino"


@dataclass(frozen=True, slots=True)
class SnapshotCommandPlan:
    action: str
    command: str
    execution_path: SnapshotExecutionPath
    requires_lock: bool
    required_permission: str


@dataclass(frozen=True, slots=True)
class SnapshotCommandViolation:
    code: str
    message: str
    http_status: int


ACTION_BY_COMMAND = {
    "cancelRun": "etl.run.cancel_requested",
    "pause": "etl.job.pause_requested",
    "retry": "etl.run.retry_requested",
    "run": "etl.run.requested",
    "stopSchedule": "etl.schedule.stop_requested",
    "resumeSchedule": "etl.schedule.resume_requested",
}


def plan_snapshot_command(
    *,
    command: str,
    execution_mode: str,
    has_active_schedule: bool,
    has_schedule_label: bool,
    job_id: str,
    job_kind: str | None,
    status: str,
) -> SnapshotCommandPlan | SnapshotCommandViolation:
    if command not in SNAPSHOT_COMMANDS:
        return SnapshotCommandViolation(
            code="VALIDATION_ERROR",
            message=f"Unsupported Snapshot command: {command}",
            http_status=400,
        )
    if str(execution_mode or "snapshot").lower() == "continuous":
        return SnapshotCommandViolation(
            code="INVALID_JOB_STATE",
            message="Continuous Jobs accept only continuous lifecycle commands.",
            http_status=422,
        )
    if command in {"run", "retry"} and status == "running":
        return SnapshotCommandViolation(
            code="CONFLICT",
            message=f"Job is already running: {job_id}",
            http_status=409,
        )
    if command == "pause" and status != "running":
        return SnapshotCommandViolation(
            code="INVALID_JOB_STATE",
            message=f"Job cannot be paused from status: {status}",
            http_status=422,
        )
    if command == "cancelRun" and status != "running":
        return SnapshotCommandViolation(
            code="INVALID_JOB_STATE",
            message=f"Current run cannot be canceled from status: {status}",
            http_status=422,
        )
    if command == "stopSchedule" and not has_active_schedule:
        return SnapshotCommandViolation(
            code="INVALID_JOB_STATE",
            message=f"Job has no schedule to stop: {job_id}",
            http_status=422,
        )
    if command == "resumeSchedule" and (status != "stopped" or not has_schedule_label):
        return SnapshotCommandViolation(
            code="INVALID_JOB_STATE",
            message=f"Job has no paused schedule to resume: {job_id}",
            http_status=422,
        )

    if job_kind == "trino_sql_materialization" and command in {"run", "retry", "cancelRun"}:
        execution_path = SnapshotExecutionPath.TRINO
    elif command in {"run", "retry"}:
        execution_path = SnapshotExecutionPath.RUN
    elif command == "cancelRun":
        execution_path = SnapshotExecutionPath.CANCEL
    else:
        execution_path = SnapshotExecutionPath.CONTROL
    return SnapshotCommandPlan(
        action=ACTION_BY_COMMAND[command],
        command=command,
        execution_path=execution_path,
        requires_lock=command in {"run", "retry"},
        required_permission="run" if command in {"run", "retry"} else "manage",
    )
