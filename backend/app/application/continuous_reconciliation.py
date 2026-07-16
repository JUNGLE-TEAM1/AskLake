"""Idempotent Kafka Continuous runtime reconciliation policy and use case."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.domain.continuous_runtime import (
    ContinuousErrorStage,
    bind_worker_attempt,
    clear_runtime_error,
    derive_public_status,
    observed_state_from_evidence,
    record_runtime_error,
    record_runtime_observation,
    runtime_contract_initialized,
    runtime_contract_projection,
)
from app.models import ETLJobModel, KafkaContinuousRuntimeModel
from app.ports.runtime_io import JsonDocument, JsonDocumentState, KafkaRuntimeGateway
from app.repositories import etl_repository


class ReconciliationAction(StrEnum):
    APPLY_REPORT = "apply_report"
    APPLY_TERMINAL_INTENT = "apply_terminal_intent"
    IGNORE_STALE_REPORT = "ignore_stale_report"
    RECOVER_PUBLICATION = "recover_publication"
    RESTART_WORKER = "restart_worker"
    WAIT_FOR_REPORT = "wait_for_report"
    RECORD_REPORT_ERROR = "record_report_error"


class ReconciliationCertainty(StrEnum):
    CONFIRMED = "confirmed"
    UNCERTAIN = "uncertain"


@dataclass(frozen=True, slots=True)
class RuntimeEvidence:
    desired_state: str
    public_status: str
    container_state: str
    report_state: JsonDocumentState
    report_status: str | None = None
    expected_worker_attempt_id: str | None = None
    observed_worker_attempt_id: str | None = None
    requested_action: str | None = None
    publication_pending: bool = False
    contract_initialized: bool = False
    output_present: bool | None = None
    manifest_present: bool | None = None
    catalog_applied: bool | None = None
    dashboard_applied: bool | None = None


@dataclass(frozen=True, slots=True)
class ReconciliationDecision:
    action: ReconciliationAction
    certainty: ReconciliationCertainty
    reason: str
    terminal_status: str | None = None


@dataclass(frozen=True, slots=True)
class ContinuousReconciliationHooks:
    reconcile_stale_maintenance: Callable[..., None]
    reconcile_pending_replay: Callable[[Session, ETLJobModel], None]
    report_path: Callable[[str], Path]
    read_report: Callable[[Path], JsonDocument]
    worker_status: Callable[[ETLJobModel, KafkaContinuousRuntimeModel], dict[str, Any]]
    materialize_batch: Callable[..., int | None]
    sync_session: Callable[..., None]
    write_ack: Callable[[str, int], None]
    mark_failed: Callable[..., None]
    apply_report: Callable[..., None]


def decide_reconciliation(evidence: RuntimeEvidence) -> ReconciliationDecision:
    """Return one deterministic action from immutable runtime evidence."""
    requested_terminal = (
        "paused"
        if evidence.requested_action == "pause"
        else "stopped"
        if evidence.requested_action == "stop"
        else None
    )
    if (
        requested_terminal
        or evidence.public_status in {"pausing", "stopping"}
    ) and evidence.container_state in {"exited", "missing"}:
        terminal_status = requested_terminal or (
            "paused" if evidence.public_status == "pausing" else "stopped"
        )
        if evidence.report_state is JsonDocumentState.FOUND:
            return ReconciliationDecision(
                ReconciliationAction.APPLY_REPORT,
                ReconciliationCertainty.CONFIRMED,
                "apply the final report while preserving the durable terminal command",
                terminal_status=terminal_status,
            )
        return ReconciliationDecision(
            ReconciliationAction.APPLY_TERMINAL_INTENT,
            ReconciliationCertainty.CONFIRMED,
            "terminal command is durable and the worker is no longer active",
            terminal_status=terminal_status,
        )
    if (
        evidence.observed_worker_attempt_id
        and evidence.expected_worker_attempt_id
        and evidence.observed_worker_attempt_id != evidence.expected_worker_attempt_id
    ):
        return ReconciliationDecision(
            ReconciliationAction.IGNORE_STALE_REPORT,
            ReconciliationCertainty.CONFIRMED,
            "report belongs to an older worker attempt",
        )
    if evidence.report_state in {JsonDocumentState.INVALID, JsonDocumentState.UNREADABLE}:
        return ReconciliationDecision(
            ReconciliationAction.RECORD_REPORT_ERROR,
            ReconciliationCertainty.CONFIRMED,
            f"runtime report is {evidence.report_state.value}",
        )
    if evidence.report_state is JsonDocumentState.FOUND:
        pending_stages = [
            stage
            for stage, complete in (
                ("manifest", evidence.manifest_present),
                ("catalog", evidence.catalog_applied),
                ("dashboard", evidence.dashboard_applied),
            )
            if complete is False
        ]
        return ReconciliationDecision(
            ReconciliationAction.APPLY_REPORT,
            ReconciliationCertainty.CONFIRMED,
            (
                f"current worker report has pending stages: {', '.join(pending_stages)}"
                if pending_stages
                else "current worker report is available"
            ),
        )
    if evidence.publication_pending:
        return ReconciliationDecision(
            ReconciliationAction.RECOVER_PUBLICATION,
            ReconciliationCertainty.CONFIRMED,
            "durable publication still needs reconciliation",
        )
    if evidence.desired_state == "running" and evidence.contract_initialized:
        if evidence.container_state in {"running", "starting", "created", "healthy"}:
            return ReconciliationDecision(
                ReconciliationAction.WAIT_FOR_REPORT,
                ReconciliationCertainty.UNCERTAIN,
                "worker is active but has not published its first report",
            )
        if evidence.container_state in {"exited", "missing"}:
            return ReconciliationDecision(
                ReconciliationAction.RESTART_WORKER,
                ReconciliationCertainty.UNCERTAIN,
                "desired state is running but the deterministic worker is absent",
            )
    return ReconciliationDecision(
        ReconciliationAction.RECOVER_PUBLICATION,
        ReconciliationCertainty.UNCERTAIN,
        "no current report; recover durable manifests without guessing success",
    )


def reconcile_continuous_runtime(
    db: Session,
    job: ETLJobModel,
    *,
    worker: KafkaRuntimeGateway,
    hooks: ContinuousReconciliationHooks,
) -> None:
    if job.execution_mode != "continuous":
        return
    if db is not None:
        hooks.reconcile_stale_maintenance(db, job.id)
        hooks.reconcile_pending_replay(db, job)
    runtime = (
        etl_repository.lock_kafka_continuous_runtime(db, job.id)
        if db is not None
        else etl_repository.get_kafka_continuous_runtime(db, job.id)
    )
    if runtime is None:
        return

    report_document = hooks.read_report(hooks.report_path(job.id))
    worker_status = hooks.worker_status(job, runtime)
    container_state = str(worker_status.get("containerState") or "unknown")
    payload = report_document.value or {}
    contract_initialized = runtime_contract_initialized(runtime.metrics)
    contract = runtime_contract_projection(
        runtime.metrics,
        public_status=runtime.status,
        legacy_error=runtime.last_error,
    )
    evidence = RuntimeEvidence(
        desired_state=str(contract.get("desiredState") or "stopped"),
        public_status=runtime.status,
        container_state=container_state,
        report_state=report_document.state,
        report_status=_optional_string(payload.get("status")),
        expected_worker_attempt_id=_optional_string(contract.get("fencingToken")),
        observed_worker_attempt_id=_optional_string(payload.get("workerAttemptId")),
        requested_action=_optional_string(worker_status.get("requestedAction")),
        publication_pending=(runtime.metrics or {}).get("publicationRecoveryPending") is True,
        contract_initialized=contract_initialized,
        output_present=(
            bool(payload.get("lastBatchWritten"))
            if "lastBatchWritten" in payload
            else None
        ),
        manifest_present=(
            bool(payload.get("publishedBatches"))
            if "publishedBatches" in payload
            else None
        ),
        catalog_applied=(
            not bool((runtime.metrics or {}).get("publicationRecoveryPending"))
            if "publicationRecoveryPending" in (runtime.metrics or {})
            else None
        ),
    )
    decision = decide_reconciliation(evidence)
    runtime.metrics = {
        **(runtime.metrics or {}),
        "lastReconciliation": {
            "action": decision.action.value,
            "certainty": decision.certainty.value,
            "reason": decision.reason,
            "containerState": container_state,
            "reportState": report_document.state.value,
        },
    }

    if decision.action is ReconciliationAction.APPLY_TERMINAL_INTENT:
        _apply_terminal_intent(db, job, runtime, decision.terminal_status or "stopped", container_state, hooks)
        return
    if decision.action is ReconciliationAction.IGNORE_STALE_REPORT:
        runtime.metrics = record_runtime_error(
            runtime.metrics,
            stage=ContinuousErrorStage.RECONCILIATION,
            code="stale_worker_observation",
            message="Ignored a Continuous runtime report from a stale worker attempt.",
            retryable=False,
            context={
                "jobId": job.id,
                "expectedWorkerAttemptId": evidence.expected_worker_attempt_id,
                "observedWorkerAttemptId": evidence.observed_worker_attempt_id,
            },
        )
        if db is not None:
            etl_repository.save_kafka_continuous_command(db, job, runtime)
        return
    if decision.action is ReconciliationAction.RECORD_REPORT_ERROR:
        _record_report_error(db, job, runtime, report_document)
        return
    if decision.action is ReconciliationAction.RESTART_WORKER:
        _restart_missing_worker(db, job, runtime, worker, hooks)
        return
    if decision.action is ReconciliationAction.WAIT_FOR_REPORT:
        observed = observed_state_from_evidence(runtime.status, container_state)
        public_status = derive_public_status(evidence.desired_state, observed).value
        runtime.status = public_status
        runtime.metrics = record_runtime_observation(
            runtime.metrics,
            observed,
            default_public_status=public_status,
            worker_attempt_id=_optional_string(worker_status.get("workerAttemptId")),
        )
        job.status = "running"
        job.last_state = "Continuous worker report 대기"
        job.progress = {"label": "Continuous worker 시작 확인 중", "value": 10}
        etl_repository.save_kafka_continuous_command(db, job, runtime)
        return
    if decision.action is ReconciliationAction.RECOVER_PUBLICATION:
        _recover_without_report(db, job, runtime, container_state, hooks)
        return

    hooks.apply_report(
        db,
        job,
        runtime,
        payload,
        worker_status,
        forced_terminal_status=decision.terminal_status,
        contract_was_initialized=contract_initialized,
    )


def _apply_terminal_intent(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    terminal_status: str,
    container_state: str,
    hooks: ContinuousReconciliationHooks,
) -> None:
    runtime.status = terminal_status
    runtime.metrics = record_runtime_observation(
        runtime.metrics,
        observed_state_from_evidence(terminal_status, container_state),
        default_public_status=terminal_status,
    )
    runtime.metrics = clear_runtime_error(runtime.metrics)
    runtime.last_error = None
    if terminal_status == "paused":
        job.status = "paused"
        job.last_state = "Continuous worker 일시정지됨"
    else:
        job.status = "stopped"
        job.last_state = "Continuous worker 중지됨 · checkpoint 보존"
    job.progress = None
    cursor = hooks.materialize_batch(
        db,
        job,
        runtime,
        {},
        recover_completed_manifests=True,
    )
    hooks.sync_session(db, runtime)
    etl_repository.save_kafka_continuous_command(db, job, runtime)
    if cursor is not None and db is not None:
        hooks.write_ack(job.id, cursor)


def _recover_without_report(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    container_state: str,
    hooks: ContinuousReconciliationHooks,
) -> None:
    recovery_requested = db is not None and (
        runtime.status in {"paused", "stopped", "failed"}
        or container_state in {"exited", "missing"}
        or (runtime.metrics or {}).get("publicationRecoveryPending") is True
    )
    if not recovery_requested:
        return
    cursor = hooks.materialize_batch(
        db,
        job,
        runtime,
        {},
        recover_completed_manifests=True,
    )
    hooks.sync_session(db, runtime)
    etl_repository.save_kafka_continuous_command(db, job, runtime)
    if cursor is not None and db is not None:
        hooks.write_ack(job.id, cursor)


def _record_report_error(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    document: JsonDocument,
) -> None:
    invalid = document.state is JsonDocumentState.INVALID
    runtime.metrics = record_runtime_error(
        runtime.metrics,
        stage=ContinuousErrorStage.REPORT,
        code="runtime_report_invalid" if invalid else "runtime_report_unreadable",
        message=(
            "Continuous runtime report is not valid JSON."
            if invalid
            else "Continuous runtime report could not be read: "
            f"{document.error or 'unknown read error'}"
        ),
        retryable=True,
        context={
            "jobId": job.id,
            **({"line": document.line} if document.line is not None else {}),
            **({"column": document.column} if document.column is not None else {}),
        },
    )
    if db is not None:
        etl_repository.save_kafka_continuous_command(db, job, runtime)


def _restart_missing_worker(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    worker: KafkaRuntimeGateway,
    hooks: ContinuousReconciliationHooks,
) -> None:
    try:
        result = worker.command(job, runtime, "start")
    except Exception as exc:
        hooks.mark_failed(
            job,
            runtime,
            f"Continuous worker recovery failed: {exc}",
            error_stage=ContinuousErrorStage.SUBMISSION,
            error_code="worker_recovery_failed",
            retryable=True,
        )
        etl_repository.save_kafka_continuous_command(db, job, runtime)
        return
    worker_attempt_id = _optional_string(result.get("workerAttemptId") or result.get("containerId"))
    runtime.status = "starting"
    runtime.metrics = bind_worker_attempt(runtime.metrics, worker_attempt_id)
    runtime.metrics = record_runtime_observation(
        runtime.metrics,
        "starting",
        default_public_status="starting",
        worker_attempt_id=worker_attempt_id,
    )
    runtime.last_error = None
    job.status = "running"
    job.last_state = "Continuous worker 자동 복구 요청"
    job.progress = {"label": "Continuous worker 자동 복구 중", "value": 10}
    etl_repository.save_kafka_continuous_command(db, job, runtime)


def _optional_string(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None
