"""Staged and idempotent Kafka Continuous publication workflows."""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from enum import StrEnum
import hashlib
import json
from typing import Any

from sqlalchemy.orm import Session

from app.domain.continuous_runtime import (
    ContinuousErrorStage,
    clear_runtime_error,
    record_runtime_error,
)
from app.models import ETLJobModel, KafkaContinuousRuntimeModel
from app.repositories import etl_repository


class PublicationStage(StrEnum):
    OUTPUT = "output"
    MANIFEST = "manifest"
    CATALOG = "catalog"
    DASHBOARD = "dashboard"


class PublicationStageStatus(StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass(frozen=True, slots=True)
class PublicationIdentity:
    job_id: str
    batch_id: int
    run_id: str
    manifest_fingerprint: str
    output_fingerprint: str
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class PublicationInputEvidence:
    data_path: str | None
    manifest_path: str
    source_ranges: list[dict[str, Any]]


@dataclass(frozen=True, slots=True)
class PublicationOutputEvidence:
    target_uri: str
    verified_result: dict[str, Any]


@dataclass(frozen=True, slots=True)
class PublicationCatalogEvidence:
    dataset_id: str
    materialization_mode: str
    catalog_created: bool
    catalog_skipped: bool = False


@dataclass(frozen=True, slots=True)
class ContinuousPublicationHooks:
    prepare: Callable[
        [ETLJobModel, KafkaContinuousRuntimeModel, dict[str, Any], PublicationIdentity],
        PublicationInputEvidence,
    ]
    verify_output: Callable[
        [ETLJobModel, KafkaContinuousRuntimeModel, dict[str, Any], PublicationIdentity, PublicationInputEvidence],
        PublicationOutputEvidence,
    ]
    verify_manifest: Callable[
        [ETLJobModel, dict[str, Any], PublicationInputEvidence],
        None,
    ]
    register_catalog: Callable[
        [Session, ETLJobModel, KafkaContinuousRuntimeModel, dict[str, Any], PublicationIdentity, PublicationInputEvidence, PublicationOutputEvidence | None],
        PublicationCatalogEvidence,
    ]
    publish_dashboard: Callable[
        [Session, ETLJobModel, KafkaContinuousRuntimeModel, dict[str, Any], PublicationIdentity, PublicationInputEvidence, PublicationOutputEvidence | None, PublicationCatalogEvidence],
        None,
    ]
    update_job_stats: Callable[
        [ETLJobModel, KafkaContinuousRuntimeModel, PublicationOutputEvidence | None],
        None,
    ]
    compact_error: Callable[[Any], str]


@dataclass(frozen=True, slots=True)
class ContinuousBatchPublicationHooks:
    list_manifest_batch_ids: Callable[..., list[int] | None]
    read_manifest: Callable[[ETLJobModel, str], dict[str, Any] | None]
    publish_one: Callable[
        [Session, ETLJobModel, KafkaContinuousRuntimeModel, dict[str, Any]],
        bool,
    ]
    dataset_id: Callable[[ETLJobModel], str]
    list_partition_cursors: Callable[
        [Session, str, str],
        list[dict[str, Any]] | None,
    ]
    merge_partition_cursors: Callable[[Any, Any], list[dict[str, Any]]]


def build_publication_identity(
    job: ETLJobModel,
    publication: dict[str, Any],
) -> PublicationIdentity:
    batch_id = _optional_int(publication.get("batchId"))
    if batch_id is None or batch_id < 0:
        raise ValueError("Continuous publication batch identity is invalid.")
    run_id = _optional_string(publication.get("runId")) or ""
    expected_prefix = f"continuous:{job.id}:batch:{batch_id}:"
    if not run_id.startswith(expected_prefix):
        raise ValueError("Continuous publication run identity is invalid.")
    source_ranges = _fingerprint_source_ranges(publication.get("sourceRanges"))
    source_boundary = _fingerprint_source_boundary(publication.get("sourceBoundary"))
    manifest_payload = {
        "manifestPath": _optional_string(publication.get("manifestPath")),
        "sourceBoundary": source_boundary,
        "sourceRanges": source_ranges,
    }
    manifest_fingerprint = _sha256_json(manifest_payload)
    iceberg_commit = (
        publication.get("icebergCommit")
        if isinstance(publication.get("icebergCommit"), dict)
        else {}
    )
    output_fingerprint = _sha256_json({
        "dataPath": _optional_string(publication.get("dataPath")),
        "icebergCommit": {
            "operation": _optional_string(iceberg_commit.get("operation")),
            "runId": _optional_string(iceberg_commit.get("runId")),
            "snapshotId": _optional_string(iceberg_commit.get("snapshotId")),
            "sourceBoundary": _fingerprint_source_boundary(
                iceberg_commit.get("sourceBoundary")
            ),
        },
        "storedCount": _nonnegative_int(publication.get("storedCount"), 0),
    })
    idempotency_key = _sha256_json({
        "batchId": batch_id,
        "jobId": job.id,
        "manifestFingerprint": manifest_fingerprint,
        "outputFingerprint": output_fingerprint,
        "runId": run_id,
    })
    return PublicationIdentity(
        job_id=job.id,
        batch_id=batch_id,
        run_id=run_id,
        manifest_fingerprint=manifest_fingerprint,
        output_fingerprint=output_fingerprint,
        idempotency_key=idempotency_key,
    )


def execute_continuous_publication(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    *,
    hooks: ContinuousPublicationHooks,
) -> bool:
    context = _prepare_publication_context(db, job, runtime, publication, hooks)
    if context is None:
        return False
    identity, inputs, stored_count = context

    output_ok, output = _verify_output_stage(
        db,
        job,
        runtime,
        publication,
        identity,
        inputs,
        stored_count,
        hooks,
    )
    if not output_ok or not _verify_manifest_stage(
        db,
        job,
        runtime,
        publication,
        identity,
        inputs,
        hooks,
    ):
        return False

    catalog = _register_catalog_stage(
        db,
        job,
        runtime,
        publication,
        identity,
        inputs,
        output,
        hooks,
    )
    if catalog is None or not _publish_dashboard_stage(
        db,
        job,
        runtime,
        publication,
        identity,
        inputs,
        output,
        catalog,
        hooks,
    ):
        return False

    hooks.update_job_stats(job, runtime, output)
    _clear_publication_error(runtime)
    return True


def _prepare_publication_context(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    hooks: ContinuousPublicationHooks,
) -> tuple[PublicationIdentity, PublicationInputEvidence, int] | None:
    try:
        identity = build_publication_identity(job, publication)
    except Exception as exc:
        _rollback(db)
        _record_unidentified_failure(runtime, publication, hooks.compact_error(exc))
        return None

    stored_count = _nonnegative_int(publication.get("storedCount"), 0)
    try:
        inputs = hooks.prepare(job, runtime, publication, identity)
    except Exception as exc:
        _rollback_preserving_workflow(db, runtime)
        _record_stage_failure(
            runtime,
            identity,
            PublicationStage.OUTPUT,
            "publication_input_invalid",
            hooks.compact_error(exc),
        )
        return None
    return identity, inputs, stored_count


def _verify_output_stage(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
    inputs: PublicationInputEvidence,
    stored_count: int,
    hooks: ContinuousPublicationHooks,
) -> tuple[bool, PublicationOutputEvidence | None]:
    if stored_count == 0:
        _record_stage(runtime, identity, PublicationStage.OUTPUT, PublicationStageStatus.SKIPPED)
        return True, None

    _record_stage(runtime, identity, PublicationStage.OUTPUT, PublicationStageStatus.RUNNING)
    try:
        output = hooks.verify_output(job, runtime, publication, identity, inputs)
    except Exception as exc:
        _rollback_preserving_workflow(db, runtime)
        _record_stage_failure(
            runtime,
            identity,
            PublicationStage.OUTPUT,
            "publication_output_unverified",
            hooks.compact_error(exc),
        )
        return False, None
    _record_stage(runtime, identity, PublicationStage.OUTPUT, PublicationStageStatus.SUCCEEDED)
    return True, output


def _verify_manifest_stage(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
    inputs: PublicationInputEvidence,
    hooks: ContinuousPublicationHooks,
) -> bool:
    _record_stage(runtime, identity, PublicationStage.MANIFEST, PublicationStageStatus.RUNNING)
    try:
        hooks.verify_manifest(job, publication, inputs)
    except Exception as exc:
        _rollback_preserving_workflow(db, runtime)
        _record_stage_failure(
            runtime,
            identity,
            PublicationStage.MANIFEST,
            "publication_manifest_unavailable",
            hooks.compact_error(exc),
        )
        return False
    _record_stage(runtime, identity, PublicationStage.MANIFEST, PublicationStageStatus.SUCCEEDED)
    return True


def _register_catalog_stage(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
    inputs: PublicationInputEvidence,
    output: PublicationOutputEvidence | None,
    hooks: ContinuousPublicationHooks,
) -> PublicationCatalogEvidence | None:
    _record_stage(runtime, identity, PublicationStage.CATALOG, PublicationStageStatus.RUNNING)
    try:
        catalog = hooks.register_catalog(
            db,
            job,
            runtime,
            publication,
            identity,
            inputs,
            output,
        )
    except Exception as exc:
        _rollback_preserving_workflow(db, runtime)
        _record_stage_failure(
            runtime,
            identity,
            PublicationStage.CATALOG,
            "catalog_publication_pending",
            hooks.compact_error(exc),
        )
        return None
    _record_stage(
        runtime,
        identity,
        PublicationStage.CATALOG,
        (
            PublicationStageStatus.SKIPPED
            if catalog.catalog_skipped
            else PublicationStageStatus.SUCCEEDED
        ),
    )
    return catalog


def _publish_dashboard_stage(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
    inputs: PublicationInputEvidence,
    output: PublicationOutputEvidence | None,
    catalog: PublicationCatalogEvidence,
    hooks: ContinuousPublicationHooks,
) -> bool:
    _record_stage(runtime, identity, PublicationStage.DASHBOARD, PublicationStageStatus.RUNNING)
    try:
        hooks.publish_dashboard(
            db,
            job,
            runtime,
            publication,
            identity,
            inputs,
            output,
            catalog,
        )
    except Exception as exc:
        _rollback_preserving_workflow(db, runtime)
        _record_stage_failure(
            runtime,
            identity,
            PublicationStage.DASHBOARD,
            "dashboard_publication_pending",
            hooks.compact_error(exc),
        )
        return False
    _record_stage(runtime, identity, PublicationStage.DASHBOARD, PublicationStageStatus.SUCCEEDED)
    return True


def reconcile_continuous_publications(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    report: dict[str, Any],
    *,
    hooks: ContinuousBatchPublicationHooks,
    recover_completed_manifests: bool = False,
) -> int | None:
    metrics = dict(runtime.metrics or {})
    cursor = _optional_int(metrics.get("catalogBatchCursor"))
    publications, recovery_requested = _select_publications(
        job,
        runtime,
        report,
        cursor,
        metrics,
        hooks,
        recover_completed_manifests=recover_completed_manifests,
    )
    if publications is None:
        return cursor

    normalized = _normalize_publications(publications)
    cursor, metrics, recovery_failed = _publish_pending_batches(
        db,
        job,
        runtime,
        normalized,
        cursor,
        metrics,
        hooks,
    )
    if recovery_requested or recovery_failed:
        metrics["publicationRecoveryPending"] = recovery_failed
        runtime.metrics = metrics
        if not recovery_failed and str(runtime.last_error or "").startswith((
            "Catalog materialization pending retry:",
            "Dashboard revision pending retry:",
        )):
            runtime.last_error = None
    return cursor


def _select_publications(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    report: dict[str, Any],
    cursor: int | None,
    metrics: dict[str, Any],
    hooks: ContinuousBatchPublicationHooks,
    *,
    recover_completed_manifests: bool,
) -> tuple[list[dict[str, Any]] | None, bool]:
    publications: list[dict[str, Any]] = (
        report.get("publishedBatches")
        if isinstance(report.get("publishedBatches"), list)
        else []
    )
    recovery_requested = (
        recover_completed_manifests
        or metrics.get("publicationRecoveryPending") is True
    )
    if recovery_requested:
        completed_batch_ids = hooks.list_manifest_batch_ids(
            job,
            after_batch_id=cursor if cursor is not None else -1,
            through_batch_id=None,
        )
        if completed_batch_ids is None:
            _record_manifest_recovery_failure(
                runtime,
                metrics,
                cursor,
                "Completed Continuous publication manifests could not be listed",
            )
            return None, recovery_requested
        recovered_publications: list[dict[str, Any]] = []
        for expected_batch_id in completed_batch_ids:
            recovered_manifest = hooks.read_manifest(job, str(expected_batch_id))
            if recovered_manifest is None:
                _record_manifest_recovery_failure(
                    runtime,
                    metrics,
                    cursor,
                    f"Completed Continuous publication manifest {expected_batch_id} could not be read",
                )
                return None, recovery_requested
            recovered_publications.append(recovered_manifest)
        publications = recovered_publications

    report_has_unapplied_publication = any(
        isinstance(publication, dict)
        and _optional_int(publication.get("batchId")) is not None
        and (cursor is None or int(publication["batchId"]) > cursor)
        for publication in publications
    )
    if not recovery_requested and not report_has_unapplied_publication:
        publications = _recover_terminal_publications(
            job,
            runtime,
            report,
            cursor,
            hooks,
        )
        if publications is None:
            return None, recovery_requested
    return publications, recovery_requested


def _normalize_publications(
    publications: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    normalized = [
        item
        for item in publications
        if isinstance(item, dict)
        and _optional_int(item.get("batchId")) is not None
        and int(item["batchId"]) >= 0
    ]
    normalized.sort(key=lambda item: _nonnegative_int(item.get("batchId"), 0))
    return normalized


def _publish_pending_batches(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publications: list[dict[str, Any]],
    cursor: int | None,
    metrics: dict[str, Any],
    hooks: ContinuousBatchPublicationHooks,
) -> tuple[int | None, dict[str, Any], bool]:
    job_id = job.id
    dataset_id = hooks.dataset_id(job) if db is not None else None
    recovery_failed = False
    for publication in publications:
        publication_batch_id = _nonnegative_int(publication.get("batchId"), 0)
        if cursor is not None and publication_batch_id <= cursor:
            continue
        materialized = hooks.publish_one(db, job, runtime, publication)
        if db is not None:
            with db.no_autoflush:
                locked_runtime = etl_repository.lock_kafka_continuous_runtime(db, job_id)
            if locked_runtime is not None:
                runtime = locked_runtime
                persisted_metrics = dict(runtime.metrics or {})
                persisted_cursor = _optional_int(persisted_metrics.get("catalogBatchCursor"))
                if persisted_cursor is not None and (
                    cursor is None or persisted_cursor > cursor
                ):
                    cursor = persisted_cursor
                metrics = {**metrics, **persisted_metrics}
        if not materialized:
            recovery_failed = True
            metrics["publicationRecoveryPending"] = True
            runtime.metrics = metrics
            break
        if db is not None:
            persisted_cursors = hooks.list_partition_cursors(
                db,
                str(dataset_id),
                runtime.topic,
            )
            if persisted_cursors is not None:
                metrics["streamPartitionCursors"] = persisted_cursors
            else:
                metrics["streamPartitionCursors"] = hooks.merge_partition_cursors(
                    metrics.get("streamPartitionCursors"),
                    publication.get("sourceRanges"),
                )
        cursor = publication_batch_id if cursor is None else max(cursor, publication_batch_id)
        metrics["catalogBatchCursor"] = cursor
        runtime.metrics = metrics
    return cursor, metrics, recovery_failed


def _recover_terminal_publications(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    report: dict[str, Any],
    cursor: int | None,
    hooks: ContinuousBatchPublicationHooks,
) -> list[dict[str, Any]] | None:
    last_batch_id = _optional_int(report.get("lastBatchId"))
    if not (
        last_batch_id is not None
        and last_batch_id >= 0
        and bool(report.get("lastBatchWritten"))
        and (cursor is None or last_batch_id > cursor)
    ):
        return []
    last_evidence = report.get("lastBatchEvidence")
    if not isinstance(last_evidence, dict):
        last_evidence = (runtime.metrics or {}).get("lastBatchEvidence")
    completed_batch_ids = hooks.list_manifest_batch_ids(
        job,
        after_batch_id=cursor if cursor is not None else -1,
        through_batch_id=last_batch_id,
    )
    if completed_batch_ids is None or last_batch_id not in completed_batch_ids:
        runtime.last_error = (
            "Catalog materialization pending retry: The terminal Continuous publication "
            f"manifest for batch {last_batch_id} is not durably complete; "
            "Catalog ACK was not advanced."
        )
        return None
    recovered_publications: list[dict[str, Any]] = []
    for expected_batch_id in completed_batch_ids:
        recovered_manifest: dict[str, Any] | None = None
        if (
            expected_batch_id == last_batch_id
            and isinstance(last_evidence, dict)
            and _optional_int(last_evidence.get("batchId")) == expected_batch_id
            and _optional_string(last_evidence.get("manifestPath")) is not None
            and isinstance(last_evidence.get("sourceRanges"), list)
            and bool(last_evidence.get("sourceRanges"))
            and (
                _nonnegative_int(last_evidence.get("storedCount"), 0) == 0
                or _optional_string(last_evidence.get("dataPath")) is not None
            )
        ):
            recovered_manifest = dict(last_evidence)
        else:
            recovered_manifest = hooks.read_manifest(job, str(expected_batch_id))
        if recovered_manifest is None:
            runtime.last_error = (
                "Catalog materialization pending retry: Continuous publication manifest "
                f"gap at batch {expected_batch_id}; Catalog ACK was not advanced."
            )
            return None
        recovered_publications.append(recovered_manifest)
    return recovered_publications


def _record_manifest_recovery_failure(
    runtime: KafkaContinuousRuntimeModel,
    metrics: dict[str, Any],
    cursor: int | None,
    reason: str,
) -> int | None:
    metrics["publicationRecoveryPending"] = True
    runtime.metrics = metrics
    runtime.last_error = (
        f"Catalog materialization pending retry: {reason}; Catalog ACK was not advanced."
    )
    return cursor


def _record_unidentified_failure(
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    message: str,
) -> None:
    runtime.metrics = record_runtime_error(
        runtime.metrics,
        stage=ContinuousErrorStage.MATERIALIZATION,
        code="publication_identity_invalid",
        message=message,
        retryable=False,
        context={
            "batchId": _optional_int(publication.get("batchId")),
            "publicationStage": PublicationStage.OUTPUT.value,
        },
    )
    runtime.last_error = f"Catalog materialization pending retry: {message}"


def _record_stage_failure(
    runtime: KafkaContinuousRuntimeModel,
    identity: PublicationIdentity,
    stage: PublicationStage,
    code: str,
    message: str,
) -> None:
    _record_stage(
        runtime,
        identity,
        stage,
        PublicationStageStatus.FAILED,
        error_code=code,
        message=message,
    )
    error_stage = {
        PublicationStage.OUTPUT: ContinuousErrorStage.MATERIALIZATION,
        PublicationStage.MANIFEST: ContinuousErrorStage.MATERIALIZATION,
        PublicationStage.CATALOG: ContinuousErrorStage.CATALOG,
        PublicationStage.DASHBOARD: ContinuousErrorStage.DASHBOARD_PUBLICATION,
    }[stage]
    runtime.metrics = record_runtime_error(
        runtime.metrics,
        stage=error_stage,
        code=code,
        message=message,
        retryable=True,
        context={
            "batchId": identity.batch_id,
            "idempotencyKey": identity.idempotency_key,
            "jobId": identity.job_id,
            "outputFingerprint": identity.output_fingerprint,
            "publicationStage": stage.value,
            "runId": identity.run_id,
        },
    )
    prefix = (
        "Dashboard revision pending retry:"
        if stage is PublicationStage.DASHBOARD
        else "Catalog materialization pending retry:"
    )
    runtime.last_error = f"{prefix} {message}"


def _record_stage(
    runtime: KafkaContinuousRuntimeModel,
    identity: PublicationIdentity,
    stage: PublicationStage,
    status: PublicationStageStatus,
    *,
    error_code: str | None = None,
    message: str | None = None,
) -> None:
    metrics = dict(runtime.metrics or {})
    previous = metrics.get("publicationWorkflow")
    if not isinstance(previous, dict) or previous.get("idempotencyKey") != identity.idempotency_key:
        previous = {}
    stages = dict(previous.get("stages") or {})
    previous_stage = stages.get(stage.value)
    if not isinstance(previous_stage, dict):
        previous_stage = {}
    attempts = int(previous_stage.get("attempts") or 0)
    if status is PublicationStageStatus.RUNNING:
        attempts += 1
    stage_state: dict[str, Any] = {
        "attempts": attempts,
        "status": status.value,
    }
    if error_code:
        stage_state["errorCode"] = error_code
    if message:
        stage_state["message"] = message
    stages[stage.value] = stage_state
    terminal_statuses = {
        PublicationStageStatus.SUCCEEDED.value,
        PublicationStageStatus.SKIPPED.value,
    }
    workflow_status = (
        "partial_failure"
        if any(item.get("status") == PublicationStageStatus.FAILED.value for item in stages.values())
        else "completed"
        if all(
            isinstance(stages.get(item.value), dict)
            and stages[item.value].get("status") in terminal_statuses
            for item in PublicationStage
        )
        else "in_progress"
    )
    metrics["publicationWorkflow"] = {
        "batchId": identity.batch_id,
        "idempotencyKey": identity.idempotency_key,
        "jobId": identity.job_id,
        "manifestFingerprint": identity.manifest_fingerprint,
        "outputFingerprint": identity.output_fingerprint,
        "runId": identity.run_id,
        "stages": stages,
        "status": workflow_status,
    }
    runtime.metrics = metrics


def _clear_publication_error(runtime: KafkaContinuousRuntimeModel) -> None:
    if str(runtime.last_error or "").startswith((
        "Catalog materialization pending retry:",
        "Dashboard revision pending retry:",
    )):
        runtime.last_error = None
        runtime.metrics = clear_runtime_error(runtime.metrics)


def _rollback(db: Session | None) -> None:
    rollback = getattr(db, "rollback", None)
    if callable(rollback):
        rollback()


def _rollback_preserving_workflow(
    db: Session | None,
    runtime: KafkaContinuousRuntimeModel,
) -> None:
    workflow = (runtime.metrics or {}).get("publicationWorkflow")
    workflow = deepcopy(workflow) if isinstance(workflow, dict) else None
    _rollback(db)
    if workflow is None:
        return
    runtime.metrics = {
        **dict(runtime.metrics or {}),
        "publicationWorkflow": workflow,
    }


def _sha256_json(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _fingerprint_source_boundary(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    boundary = dict(value)
    if isinstance(boundary.get("sourceRanges"), list):
        boundary["sourceRanges"] = _fingerprint_source_ranges(boundary["sourceRanges"])
    return boundary


def _fingerprint_source_ranges(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    ranges = [dict(item) for item in value if isinstance(item, dict)]
    return sorted(
        ranges,
        key=lambda item: (
            str(item.get("topic") or ""),
            _optional_int(item.get("partition")) or 0,
            _optional_int(item.get("startOffset")) or 0,
            _optional_int(item.get("endOffset")) or 0,
            _sha256_json(item),
        ),
    )


def _optional_string(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _nonnegative_int(value: Any, fallback: int) -> int:
    parsed = _optional_int(value)
    return parsed if parsed is not None and parsed >= 0 else fallback
