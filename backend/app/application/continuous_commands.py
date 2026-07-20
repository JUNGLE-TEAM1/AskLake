"""Kafka Continuous lifecycle command application use case.

The public service function remains a compatibility facade.  This module owns
the command sequence: reserve desired state, commit it, perform the worker side
effect outside that transaction, and persist the resulting observation.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from fastapi import status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.domain.continuous_runtime import (
    ContinuousErrorStage,
    bind_worker_attempt,
    command_transition,
    record_runtime_command,
    record_runtime_error,
    record_runtime_observation,
)
from app.models import (
    ETLJobModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
)
from app.ports.runtime_io import KafkaRuntimeGateway
from app.repositories import etl_repository
from app.schemas.common import ErrorCode
from app.schemas.etl import JobCommandResponse


CONTINUOUS_ACTION_BY_COMMAND = {
    "startContinuous": "etl.continuous.start_requested",
    "pauseContinuous": "etl.continuous.pause_requested",
    "resumeContinuous": "etl.continuous.resume_requested",
    "stopContinuous": "etl.continuous.stop_requested",
}


@dataclass(frozen=True, slots=True)
class ContinuousCommandRequest:
    command: str
    job_id: str


@dataclass(frozen=True, slots=True)
class ContinuousCommandHooks:
    is_kafka_job: Callable[[ETLJobModel], bool]
    runtime_from_job: Callable[[ETLJobModel], KafkaContinuousRuntimeModel]
    reconcile_stale_maintenance: Callable[..., None]
    require_no_active_maintenance: Callable[[Session, str], None]
    reconcile_pending_replay: Callable[[Session, ETLJobModel], None]
    has_pending_replay: Callable[[Session, ETLJobModel], bool]
    begin_session: Callable[
        [Session | None, ETLJobModel, KafkaContinuousRuntimeModel],
        KafkaContinuousSessionModel | None,
    ]
    persisted_partition_cursors: Callable[
        [Session | None, ETLJobModel, KafkaContinuousRuntimeModel],
        list[dict[str, Any]],
    ]
    fail_session: Callable[[KafkaContinuousSessionModel | None, str, str], None]
    mark_session_stopping: Callable[[Session | None, KafkaContinuousRuntimeModel, str], None]
    with_permissions: Callable[[Session, Any, ActorContext], Any]
    worker_kind: Callable[[ETLJobModel], str] = lambda _job: "spark_structured_streaming"


def execute_continuous_command(
    db: Session,
    job: ETLJobModel,
    request: ContinuousCommandRequest,
    actor: ActorContext,
    *,
    worker: KafkaRuntimeGateway,
    hooks: ContinuousCommandHooks,
    dispatch_worker: bool = True,
) -> JobCommandResponse:
    command = request.command
    if command not in CONTINUOUS_ACTION_BY_COMMAND:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            f"Unsupported Continuous command: {command}",
            status.HTTP_400_BAD_REQUEST,
        )
    if job.execution_mode != "continuous" or not hooks.is_kafka_job(job):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous commands require a Kafka Job created with executionMode=continuous.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    runtime = (
        etl_repository.lock_kafka_continuous_runtime(db, job.id)
        if db is not None
        else etl_repository.get_kafka_continuous_runtime(db, job.id)
    )
    if runtime is None:
        runtime = hooks.runtime_from_job(job)

    if command in {"startContinuous", "resumeContinuous"}:
        job, runtime = _lock_start_resources(db, job, runtime, hooks)
        transition = command_transition(runtime.status, command)
        _require_allowed_transition(job, runtime, transition, verb="start")
        _require_consumer_identity_available(db, job, runtime)
        session = hooks.begin_session(db, job, runtime)
        runtime.metrics = {
            **(runtime.metrics or {}),
            "streamPartitionCursors": hooks.persisted_partition_cursors(db, job, runtime),
        }
        # Reserve a new fence before a separately-owned control plane observes
        # this intent.  It prevents a terminal observation from the previous
        # worker attempt from being treated as the result of this start.
        requested_attempt_id = f"start-{uuid4()}"
        runtime.metrics = record_runtime_command(
            runtime.metrics,
            transition,
            worker_attempt_id=requested_attempt_id,
        )
        runtime.status = transition.next_status.value
        job.status = "running"
        job.last_state = "Continuous Spark worker 시작 요청"
        job.progress = {"label": "Continuous worker 시작 요청", "value": 5}

        # The durable desired state fences another start or maintenance request
        # before the external worker submission begins.
        etl_repository.save_kafka_continuous_command(db, job, runtime)
        worker_result = _dispatch_start(
            db, job, runtime, session, command, worker, hooks, dispatch_worker
        )

        worker_attempt_id = _optional_string(
            worker_result.get("workerAttemptId") or worker_result.get("containerId")
        ) or requested_attempt_id
        if session is not None:
            session.worker_attempt_id = worker_attempt_id
        runtime.metrics = bind_worker_attempt(runtime.metrics, worker_attempt_id)
        runtime.metrics = record_runtime_observation(
            runtime.metrics,
            "starting",
            default_public_status=runtime.status,
            worker_attempt_id=worker_attempt_id,
        )
        runtime.last_error = None
    else:
        transition = command_transition(runtime.status, command)
        verb = "pause" if command == "pauseContinuous" else "stop"
        _require_allowed_transition(job, runtime, transition, verb=verb)
        runtime.status = transition.next_status.value
        runtime.metrics = record_runtime_command(runtime.metrics, transition)
        reason = "paused" if command == "pauseContinuous" else "stopped"
        hooks.mark_session_stopping(db, runtime, reason)
        job.status = "running"
        if command == "pauseContinuous":
            job.last_state = "Continuous worker 마이크로배치 종료 대기"
            job.progress = {"label": "일시정지 중", "value": 95}
        else:
            job.last_state = "Continuous worker 중지 요청"
            job.progress = {"label": "중지 중", "value": 95}

        # Commit the command intent before signaling the worker.  A lost
        # response is reconciled from the deterministic worker identity.
        etl_repository.save_kafka_continuous_command(db, job, runtime)
        worker_result = _dispatch_terminal(
            db, job, runtime, command, verb, worker, hooks, dispatch_worker
        )
        runtime.metrics = record_runtime_observation(
            runtime.metrics,
            "stopping",
            default_public_status=runtime.status,
        )

    saved_job = etl_repository.save_kafka_continuous_command(db, job, runtime)
    return JobCommandResponse(
        action=CONTINUOUS_ACTION_BY_COMMAND[command],
        api_path=f"/api/etl/jobs/{job.id}/commands",
        job=hooks.with_permissions(db, saved_job, actor),
        processing_result={
            "controlPlaneOnly": not dispatch_worker,
            "runtimeStatus": runtime.status,
            "worker": str(worker_result.get("worker") or "spark_structured_streaming"),
            "workerResult": worker_result,
        },
    )


def _dispatch_start(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    session: KafkaContinuousSessionModel | None,
    command: str,
    worker: KafkaRuntimeGateway,
    hooks: ContinuousCommandHooks,
    dispatch_worker: bool,
) -> dict[str, Any]:
    if not dispatch_worker:
        return {
            "deferred": True,
            "owner": "continuous-worker",
            "worker": hooks.worker_kind(job),
        }
    try:
        return worker.command(job, runtime, "start")
    except ApiError as exc:
        recovered = _recover_lost_start_response(worker, job, runtime)
        if recovered is not None:
            return recovered
        _record_start_failure(db, job, runtime, session, command, exc, hooks)
        raise


def _dispatch_terminal(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    command: str,
    verb: str,
    worker: KafkaRuntimeGateway,
    hooks: ContinuousCommandHooks,
    dispatch_worker: bool,
) -> dict[str, Any]:
    if not dispatch_worker:
        return {
            "deferred": True,
            "owner": "continuous-worker",
            "worker": hooks.worker_kind(job),
        }
    try:
        return worker.command(job, runtime, verb)
    except ApiError as exc:
        runtime.metrics = record_runtime_error(
            runtime.metrics,
            stage=ContinuousErrorStage.SUBMISSION,
            code=f"continuous_worker_{verb}_unknown",
            message=exc.message,
            retryable=True,
            context={"jobId": job.id, "command": command},
        )
        runtime.last_error = exc.message
        etl_repository.save_kafka_continuous_command(db, job, runtime)
        raise


def _lock_start_resources(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    hooks: ContinuousCommandHooks,
) -> tuple[ETLJobModel, KafkaContinuousRuntimeModel]:
    if not callable(getattr(db, "get_bind", None)):
        return job, runtime
    hooks.reconcile_stale_maintenance(db, job.id, commit=False)
    hooks.require_no_active_maintenance(db, job.id)
    hooks.reconcile_pending_replay(db, job)
    if hooks.has_pending_replay(db, job):
        raise ApiError(
            ErrorCode.CONFLICT,
            "Continuous Job cannot start until the committed Kafka replay is finalized.",
            status.HTTP_409_CONFLICT,
            {"jobId": job.id, "reason": "replay_catalog_pending"},
        )
    return (
        etl_repository.get_job_for_update(db, job.id) or job,
        etl_repository.lock_kafka_continuous_runtime(db, job.id) or runtime,
    )


def _require_allowed_transition(job, runtime, transition, *, verb: str) -> None:
    if transition.allowed:
        return
    if transition.rejection == "already_active":
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Continuous Job is already active: {job.id}",
            status.HTTP_409_CONFLICT,
        )
    raise ApiError(
        ErrorCode.INVALID_JOB_STATE,
        f"Continuous Job cannot {verb} from: {runtime.status}",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    )


def _require_consumer_identity_available(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
) -> None:
    conflict = etl_repository.find_conflicting_kafka_continuous_runtime(
        db,
        broker=runtime.broker,
        topic=runtime.topic,
        consumer_group_id=runtime.consumer_group_id,
        excluded_job_id=job.id,
    )
    if conflict is not None:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Continuous consumer identity is already active on Job: {conflict.job_id}",
            status.HTTP_409_CONFLICT,
            {"activeJobId": conflict.job_id, "runtimeStatus": conflict.status},
        )
    snapshot_conflict = etl_repository.find_conflicting_kafka_snapshot(
        db,
        broker=runtime.broker,
        topic=runtime.topic,
        consumer_group_id=runtime.consumer_group_id,
        excluded_job_id=job.id,
    )
    if snapshot_conflict is not None:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Kafka snapshot is already active: {snapshot_conflict.snapshot_id}",
            status.HTTP_409_CONFLICT,
            {
                "activeSnapshotId": snapshot_conflict.snapshot_id,
                "activeJobId": snapshot_conflict.job_id,
            },
        )


def _recover_lost_start_response(
    worker: KafkaRuntimeGateway,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
) -> dict[str, Any] | None:
    try:
        observed = worker.command(job, runtime, "status")
    except ApiError:
        return None
    if str(observed.get("containerState") or "").lower() not in {
        "created",
        "healthy",
        "running",
        "starting",
        "submitted",
        "waiting",
    }:
        return None
    return {**observed, "submissionRecovered": True, "started": False}


def _record_start_failure(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    session: KafkaContinuousSessionModel | None,
    command: str,
    exc: ApiError,
    hooks: ContinuousCommandHooks,
) -> None:
    runtime.status = "failed"
    runtime.failed_count += 1
    runtime.last_error = exc.message
    runtime.metrics = record_runtime_observation(
        runtime.metrics,
        "failed",
        default_public_status="failed",
    )
    runtime.metrics = record_runtime_error(
        runtime.metrics,
        stage=ContinuousErrorStage.SUBMISSION,
        code="continuous_worker_start_failed",
        message=exc.message,
        retryable=True,
        context={"jobId": job.id, "command": command},
    )
    hooks.fail_session(session, exc.message, "start_failed")
    job.status = "failed"
    job.last_state = "Continuous worker 시작 실패"
    etl_repository.save_kafka_continuous_command(db, job, runtime)


def _optional_string(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None
