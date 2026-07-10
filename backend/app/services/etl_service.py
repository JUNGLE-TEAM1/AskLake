from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, require_permission
from app.core.errors import ApiError
from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel, KafkaContinuousRuntimeModel, KafkaSnapshotModel
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories import etl_repository
from app.schemas.common import ErrorCode
from app.schemas.etl import (
    CatalogDataset,
    CreatePipelineRequest,
    CreatePipelineResponse,
    JobCommandResponse,
    JobDagStep,
    JobRowData,
    KafkaReviewIngestRequest,
    KafkaReviewIngestResponse,
    QueryRunRequest,
    QueryRunResponse,
    ScheduledJobRunItem,
    ScheduledJobRunRequest,
    ScheduledJobRunResponse,
    SchemaDraft,
    SourceAssetsRequest,
    SourceAssetsResponse,
    SourceConnectorAnalysis,
    SourceConnectorRequest,
    UpdatePipelineRequest,
)

from app.services.airflow_client import AirflowDagRun, AirflowTaskInstance, build_airflow_client
from app.services.governance_enforcement import require_governed_access
from app.services.resource_permission_service import job_with_persisted_permission_grants, permission_grants_for_resource, permissions_for_actor_with_governance

BACKEND_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = BACKEND_DIR / "scripts"
ACTIVE_RUN_STATUSES = {"queued", "running"}
TERMINAL_RUN_STATUSES = {"success", "failed", "canceled"}


def create_pipeline(db: Session, request: CreatePipelineRequest, actor_name: str = "demo-user") -> CreatePipelineResponse:
    validate_create_request(request)
    created_by = identity_name(request.created_by or actor_name or request.owner)
    created_by_profile = request.created_by_profile or identity_profile(created_by)
    dataset_id = f"ds_{normalize_column_name(request.target_dataset)}"
    existing_job = etl_repository.get_job_by_dataset_id(db, dataset_id) or etl_repository.get_job_by_target(db, request.target_dataset)
    if existing_job is not None:
        if existing_job.execution_mode != request.execution_mode:
            raise ApiError(
                ErrorCode.CONFLICT,
                "Kafka execution mode cannot change on an existing target. Copy the Job to use another mode.",
                status.HTTP_409_CONFLICT,
            )
        if request.execution_mode == "continuous":
            raise ApiError(
                ErrorCode.CONFLICT,
                "Continuous Job configuration is immutable. Copy the Job to create another continuous stream.",
                status.HTTP_409_CONFLICT,
            )
        update_existing_append_job(existing_job, request, dataset_id, created_by, created_by_profile)
        saved_job = etl_repository.save_job(db, existing_job)
        return CreatePipelineResponse(
            catalog_target={
                "id": dataset_id,
                "layer": request.target_layer,
                "name": request.target_dataset,
                "status": "pending_run",
            },
            job=saved_job,
        )

    dataset_schema = dataset_schema_from_request(request)
    sample_rows = dataset_sample_rows_from_request(request, dataset_schema)
    metrics = source_metrics_from_request(request, dataset_schema, sample_rows)
    job_id = make_job_id(request.id or request.job_name)
    dag_steps = initial_dag_steps(request, metrics)
    stats = initial_job_stats(metrics)
    schedule_policy = schedule_policy_from_request(request)

    job = ETLJobModel(
        id=job_id,
        name=request.job_name,
        owner=request.owner,
        created_by=created_by,
        created_by_profile=created_by_profile,
        status="scheduled",
        tag="[생성]",
        source=f"{request.source_type} / {request.source_label}",
        target=request.target_dataset,
        schedule=request.schedule_label,
        schedule_policy=schedule_policy,
        schedule_summary=request.schedule_summary,
        retry_policy=request.retry_policy.model_dump(mode="json", by_alias=True) if request.retry_policy else None,
        retry_policy_summary=request.retry_policy_summary,
        run_limit_summary=request.run_limit_summary,
        source_config=tuple_rows_to_lists(request.source_config),
        source_label=request.source_label,
        source_type=request.source_type,
        execution_mode=request.execution_mode,
        continuous_config=continuous_config_from_request(request, job_id),
        schema_columns=[column.model_dump(mode="json", by_alias=True) for column in request.schema_columns],
        schema_fingerprint=request.schema_fingerprint,
        schema_sample_rows=request.schema_sample_rows,
        schema_summary=request.schema_summary,
        rule_summary=request.rule_summary,
        permission_summary=request.permission_summary,
        permission_roles=request.permission_roles,
        storage_type=request.storage_type,
        partition=request.partition,
        partition_columns=normalize_string_list(request.partition_columns),
        index_columns=normalize_string_list(request.index_columns),
        compression=request.compression,
        storage_path=request.storage_path,
        target_description=normalize_optional_text(request.target_description),
        target_database=normalize_optional_text(request.target_database),
        target_tags=normalize_target_tags(request.target_tags),
        target_format=request.target_format,
        target_layer=request.target_layer,
        target_path=request.storage_path,
        rag=request.rag,
        transform_output_columns=tuple_rows_to_lists(request.transform_output_columns),
        transform_steps=[step.model_dump(mode="json", by_alias=True) for step in request.transform_steps],
        quality_invalid_rows=request.quality_invalid_rows,
        quality_rules=[rule.model_dump(mode="json", by_alias=True) for rule in request.quality_rules],
        quality_score=request.quality_score,
        quality_status=request.quality_status,
        last_run="생성 후 미실행",
        last_state=f"{metrics['schema_columns']}개 컬럼 추론 완료",
        next_run=schedule_next_run_label(request.schedule_label, request.schedule_summary),
        progress=None,
        stats=stats,
        dag_steps=dag_steps,
        dataset_id=dataset_id,
    )

    saved_job = etl_repository.create_job(db, job)
    if request.execution_mode == "continuous":
        etl_repository.save_kafka_continuous_runtime(db, continuous_runtime_from_job(job))
        saved_job = etl_repository.get_job_schema(db, job_id) or saved_job
    return CreatePipelineResponse(
        catalog_target={
            "id": dataset_id,
            "layer": request.target_layer,
            "name": request.target_dataset,
            "status": "pending_run",
        },
        job=saved_job,
    )


def list_jobs(db: Session, actor: ActorContext | None = None) -> list[JobRowData]:
    for job in etl_repository.list_job_models(db):
        refresh_kafka_continuous_runtime(db, job)
    jobs = [
        with_job_permissions(db, job, actor or ActorContext())
        for job in etl_repository.list_jobs(db)
    ]
    return [job for job in jobs if job.permissions.can_view]


def run_due_scheduled_jobs(
    db: Session,
    request: ScheduledJobRunRequest,
    actor: ActorContext | None = None,
) -> ScheduledJobRunResponse:
    jobs = etl_repository.list_job_models(db)
    if request.job_id:
        jobs = [job for job in jobs if job.id == request.job_id]
    items: list[ScheduledJobRunItem] = []
    actor_context = actor or ActorContext(name="scheduler", role="admin")

    for job in jobs:
        should_run, reason = should_run_scheduled_job(job, request)
        if not should_run:
            items.append(ScheduledJobRunItem(
                job_id=job.id,
                job_name=job.name,
                reason=reason,
                schedule=job.schedule,
                triggered=False,
            ))
            continue

        response = command_job(db, job.id, "run", actor_context)
        if reason == "due":
            advance_scheduled_job_after_tick(db, job.id)
        items.append(ScheduledJobRunItem(
            job_id=job.id,
            job_name=job.name,
            reason=reason,
            response=response,
            schedule=job.schedule,
            triggered=True,
        ))

    return ScheduledJobRunResponse(
        checked_count=len(items),
        items=items,
        triggered_count=sum(1 for item in items if item.triggered),
    )


def get_job(db: Session, job_id: str, actor: ActorContext | None = None) -> JobRowData:
    actor_context = actor or ActorContext()
    job_model = etl_repository.get_job(db, job_id)
    if job_model is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    sync_airflow_runs_for_job(db, job_model)
    refresh_kafka_continuous_runtime(db, job_model)
    job = etl_repository.get_job_schema(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    job_with_permissions = with_job_permissions(db, job, actor_context)
    if not job_with_permissions.permissions.can_view:
        safe_record_audit_event(
            db,
            actor=actor_context,
            action="etl_job.view.forbidden",
            result="forbidden",
            target_id=job_id,
            target_type="etl_job",
            details={"reason": "missing_view_permission"},
        )
        raise ApiError(ErrorCode.FORBIDDEN, "Job access denied", status.HTTP_403_FORBIDDEN)
    return job_with_permissions


def update_pipeline(
    db: Session,
    job_id: str,
    request: UpdatePipelineRequest,
    actor: ActorContext | None = None,
) -> JobRowData:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)

    actor_context = actor or ActorContext()
    require_governed_access(
        db,
        actor_context,
        action="manage",
        api_path=f"/api/etl/jobs/{job_id}",
        http_method="PATCH",
        metadata={"owner": job.owner},
        resource_id=job.id,
        resource_name=job.name,
        resource_type="etl_job",
    )
    require_permission(
        actor_context,
        "manage",
        owner=job.owner,
        grants=permission_grants_for_resource(
            db,
            "etl_job",
            job.id,
            permission_grants_from_roles(job.owner, job.permission_roles, default_actions=["view", "run"]),
        ),
        resource_label="job",
    )
    if job.status == "running":
        raise ApiError(ErrorCode.CONFLICT, f"Job is running and cannot be updated: {job_id}", status.HTTP_409_CONFLICT)

    validate_update_request(request)
    target_changed = target_identity_changed(job, request)
    if target_changed and has_successful_run(db, job.id):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Target dataset, database, layer, format, storage type, and path are immutable after a successful run. Clone the job to change its destination.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    apply_update_request(job, request, target_changed)
    saved_job = etl_repository.save_job(db, job)
    return with_job_permissions(db, saved_job, actor_context)


def list_datasets(db: Session) -> list[CatalogDataset]:
    return etl_repository.list_datasets(db)


def get_dataset(db: Session, dataset_id: str) -> CatalogDataset:
    dataset = etl_repository.get_dataset_schema_by_id(db, dataset_id)
    if dataset is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {dataset_id}", status.HTTP_404_NOT_FOUND)
    return dataset


def get_dataset_lineage(db: Session, dataset_id: str) -> dict[str, Any]:
    dataset = etl_repository.get_dataset_by_id(db, dataset_id)
    if dataset is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {dataset_id}", status.HTTP_404_NOT_FOUND)
    payload_lineage = dataset.payload.get("lineageGraph") if dataset.payload else None
    if isinstance(payload_lineage, dict):
        return payload_lineage
    return dataset.lineage_graph or fallback_lineage_graph(dataset)


def execute_query(db: Session, request: QueryRunRequest) -> QueryRunResponse:
    dataset = etl_repository.get_dataset_by_id(db, request.dataset_id)
    if dataset is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {request.dataset_id}", status.HTTP_404_NOT_FOUND)

    columns = [column[0] for column in (dataset.schema_json or [])[:6] if column]
    if not columns and dataset.sample_rows:
        columns = [f"col_{index + 1}" for index in range(len(dataset.sample_rows[0]))]
    width = max(len(columns), 1)
    rows = [[str(cell) for cell in row[:width]] for row in (dataset.sample_rows or [])]
    return QueryRunResponse(
        columns=columns,
        dataset_id=dataset.id,
        dataset_name=dataset.name,
        executed_at=iso_now(),
        query=request.query,
        row_count=len(rows),
        rows=rows,
        run_id=stable_id("sql", f"{dataset.id}:{request.query}:{iso_now()}"),
    )


def command_job(db: Session, job_id: str, command: str, actor: ActorContext | None = None) -> JobCommandResponse:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)

    continuous_commands = {"startContinuous", "pauseContinuous", "resumeContinuous", "stopContinuous"}
    if command not in {"run", "retry", "pause", "cancelRun", "stopSchedule", *continuous_commands}:
        raise ApiError(ErrorCode.VALIDATION_ERROR, f"Unsupported job command: {command}", status.HTTP_400_BAD_REQUEST)
    actor_context = actor or ActorContext()
    required_action = "run" if command in {"run", "retry", "startContinuous", "resumeContinuous"} else "manage"
    require_governed_access(
        db,
        actor_context,
        action=required_action,
        api_path=f"/api/etl/jobs/{job_id}/commands",
        http_method="POST",
        metadata={"command": command, "owner": job.owner},
        resource_id=job.id,
        resource_name=job.name,
        resource_type="etl_job",
    )
    try:
        require_permission(
            actor_context,
            required_action,
            owner=job.owner,
            grants=permission_grants_for_resource(
                db,
                "etl_job",
                job.id,
                permission_grants_from_roles(job.owner, job.permission_roles, default_actions=["view", "run"]),
            ),
            resource_label="job",
        )
    except ApiError as exc:
        safe_record_audit_event(
            db,
            action="etl_job.command.forbidden",
            actor=actor_context,
            api_path=f"/api/etl/jobs/{job_id}/commands",
            http_method="POST",
            metadata={"command": command, "requiredAction": required_action, "owner": job.owner},
            result="forbidden",
            status_code=exc.status_code,
            target_id=job.id,
            target_name=job.name,
            target_type="etl_job",
        )
        raise
    if job.execution_mode == "continuous" and command not in continuous_commands:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous Jobs accept only continuous lifecycle commands.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if command in continuous_commands:
        return command_kafka_continuous_job(db, job, command, actor_context)
    if command == "run" and job.status == "running":
        raise ApiError(ErrorCode.CONFLICT, f"Job is already running: {job_id}", status.HTTP_409_CONFLICT)
    if command == "pause" and job.status != "running":
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            f"Job cannot be paused from status: {job.status}",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if command == "cancelRun" and job.status != "running":
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            f"Current run cannot be canceled from status: {job.status}",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if command == "stopSchedule" and not has_scheduled_execution(job):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            f"Job has no schedule to stop: {job_id}",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    action_by_command = {
        "cancelRun": "etl.run.cancel_requested",
        "pause": "etl.job.pause_requested",
        "retry": "etl.run.retry_requested",
        "run": "etl.run.requested",
        "stopSchedule": "etl.schedule.stop_requested",
    }

    run_schema = None
    dataset_schema = None
    run_model = None
    dataset_model = None
    if command in {"run", "retry"}:
        if is_kafka_job(job):
            run_id = stable_id("run", f"{job.id}:{command}:kafka:{iso_now()}")
            kafka_request = kafka_ingest_request_from_job(job, run_id)
            db.commit()
            try:
                result = run_kafka_ingest_request(db, kafka_request, command, job.id)
            except ApiError as exc:
                bridge_error = exc.details.get("bridge") if isinstance(exc.details, dict) else None
                result = kafka_failure_result(kafka_request, run_id, exc, bridge_error if isinstance(bridge_error, dict) else {})
            job = etl_repository.get_job(db, job_id)
            if job is None:
                raise ApiError(ErrorCode.NOT_FOUND, f"Job not found after Kafka ingest: {job_id}", status.HTTP_404_NOT_FOUND)
            run_model = run_from_kafka_result(job, result)
            run_schema = etl_repository.run_to_schema(run_model)
            finalize_job_from_kafka_result(job, command, result)
            job.dag_steps = dag_steps_from_kafka_result(job, command, run_schema.model_dump(by_alias=True), result)
        else:
            run_model = submit_airflow_job_run(job, command)
            run_schema = etl_repository.run_to_schema(run_model)
            apply_airflow_submit_job_state(job, command, run_model)
            job.dag_steps = dag_steps_from_airflow_submit(job, command, run_schema.model_dump(by_alias=True))
        job.dag_steps_by_run_id = {**(job.dag_steps_by_run_id or {}), run_schema.run_id: job.dag_steps}
        job.stats = stats_from_runs(job, [run_schema, *etl_repository.list_runs_for_job(db, job.id)])
    elif command == "cancelRun":
        run_model = run_from_command(job, command)
        run_schema = etl_repository.run_to_schema(run_model)
        apply_job_command(job, command)
        job.dag_steps = dag_steps_from_command(job, command, run_schema.model_dump(by_alias=True))
        job.dag_steps_by_run_id = {**(job.dag_steps_by_run_id or {}), run_schema.run_id: job.dag_steps}
        job.stats = stats_from_runs(job, [run_schema, *etl_repository.list_runs_for_job(db, job.id)])
    else:
        apply_job_command(job, command)

    saved_job, persisted_run, dataset_schema = etl_repository.save_command_result(db, job, run_model, dataset_model)
    run_schema = persisted_run or run_schema
    if dataset_schema is None and job.dataset_id:
        dataset_schema = etl_repository.get_dataset_schema_by_id(db, job.dataset_id)

    return JobCommandResponse(
        action=action_by_command[command],
        api_path=f"/api/etl/jobs/{job_id}/commands",
        dataset=dataset_schema,
        job=with_job_permissions(db, saved_job, actor or ActorContext()),
        run=run_schema,
        dag_steps=[JobDagStep(**step) for step in job.dag_steps] if job.dag_steps else None,
    )


def command_kafka_continuous_job(
    db: Session,
    job: ETLJobModel,
    command: str,
    actor: ActorContext,
) -> JobCommandResponse:
    if job.execution_mode != "continuous" or not is_kafka_job(job):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous commands require a Kafka Job created with executionMode=continuous.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
    if runtime is None:
        runtime = continuous_runtime_from_job(job)

    action_by_command = {
        "startContinuous": "etl.continuous.start_requested",
        "pauseContinuous": "etl.continuous.pause_requested",
        "resumeContinuous": "etl.continuous.resume_requested",
        "stopContinuous": "etl.continuous.stop_requested",
    }
    active_statuses = {"starting", "running", "pausing", "stopping"}

    if command in {"startContinuous", "resumeContinuous"}:
        if runtime.status in active_statuses:
            raise ApiError(ErrorCode.CONFLICT, f"Continuous Job is already active: {job.id}", status.HTTP_409_CONFLICT)
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
                {"activeSnapshotId": snapshot_conflict.snapshot_id, "activeJobId": snapshot_conflict.job_id},
            )
        try:
            worker_result = run_kafka_continuous_worker(job, runtime, "start")
        except ApiError as exc:
            runtime.status = "failed"
            runtime.failed_count += 1
            runtime.last_error = exc.message
            job.status = "failed"
            job.last_state = "Continuous worker 시작 실패"
            etl_repository.save_kafka_continuous_command(db, job, runtime)
            raise
        runtime.status = "starting"
        runtime.last_error = None
        job.status = "running"
        job.last_state = "Continuous Spark worker 시작 요청"
        job.progress = {"label": "Continuous worker 시작 요청", "value": 5}
    elif command == "pauseContinuous":
        if runtime.status not in {"starting", "running"}:
            raise ApiError(ErrorCode.INVALID_JOB_STATE, f"Continuous Job cannot pause from: {runtime.status}", status.HTTP_422_UNPROCESSABLE_ENTITY)
        worker_result = run_kafka_continuous_worker(job, runtime, "pause")
        runtime.status = "pausing"
        job.status = "running"
        job.last_state = "Continuous worker 마이크로배치 종료 대기"
        job.progress = {"label": "일시정지 중", "value": 95}
    else:
        if runtime.status in {"stopped", "stopping"}:
            raise ApiError(ErrorCode.INVALID_JOB_STATE, f"Continuous Job cannot stop from: {runtime.status}", status.HTTP_422_UNPROCESSABLE_ENTITY)
        worker_result = run_kafka_continuous_worker(job, runtime, "stop")
        runtime.status = "stopping"
        job.status = "running"
        job.last_state = "Continuous worker 중지 요청"
        job.progress = {"label": "중지 중", "value": 95}

    saved_job = etl_repository.save_kafka_continuous_command(db, job, runtime)
    return JobCommandResponse(
        action=action_by_command[command],
        api_path=f"/api/etl/jobs/{job.id}/commands",
        job=with_job_permissions(db, saved_job, actor),
        processing_result={
            "controlPlaneOnly": False,
            "runtimeStatus": runtime.status,
            "worker": "spark_structured_streaming",
            "workerResult": worker_result,
        },
    )


def with_job_permissions(db: Session, job: JobRowData, actor: ActorContext) -> JobRowData:
    job_with_grants = job_with_persisted_permission_grants(db, job)
    grant_payloads = [
        grant.model_dump(by_alias=True) if hasattr(grant, "model_dump") else grant
        for grant in job_with_grants.permission_grants
    ]
    return job_with_grants.model_copy(update={
        "permissions": permissions_for_actor_with_governance(
            db,
            actor,
            owner=job_with_grants.owner,
            grants=grant_payloads,
            resource_id=job_with_grants.id,
            resource_type="etl_job",
        ),
    })


def test_source_connector(request: SourceConnectorRequest) -> SourceConnectorAnalysis:
    result = run_node_bridge(
        "test-source-connector.mjs",
        "ASKLAKE_SOURCE_CONNECTOR_RESULT",
        {
            "sourceConfig": request.source_config,
            "sourceType": request.source_type,
        },
        error_marker="ASKLAKE_SOURCE_CONNECTOR_ERROR",
        timeout_seconds=120,
    )
    return SourceConnectorAnalysis.model_validate(result)


def list_source_assets(request: SourceAssetsRequest) -> SourceAssetsResponse:
    result = run_node_bridge(
        "list-source-assets.mjs",
        "ASKLAKE_SOURCE_ASSETS_RESULT",
        {
            "prefix": request.prefix,
            "sourceConfig": request.source_config,
            "sourceType": request.source_type,
        },
        error_marker="ASKLAKE_SOURCE_ASSETS_ERROR",
        timeout_seconds=120,
    )
    return SourceAssetsResponse.model_validate(result)


def infer_schema(request: SourceConnectorRequest) -> SchemaDraft:
    analysis = test_source_connector(request)
    if analysis.draft_patch.schema_ is None:
        return SchemaDraft(columns=[], sample_rows=[], summary="스키마 없음")
    return analysis.draft_patch.schema_


def ingest_kafka_reviews(db: Session, request: KafkaReviewIngestRequest) -> KafkaReviewIngestResponse:
    result = run_kafka_ingest_request(db, request.model_dump(by_alias=True, exclude_none=True), "ingest", None)
    return KafkaReviewIngestResponse.model_validate(result)


def run_kafka_ingest_job(db: Session, job: ETLJobModel, command: str, run_id: str) -> dict[str, Any]:
    request = kafka_ingest_request_from_job(job, run_id)
    return run_kafka_ingest_request(db, request, command, job.id)


def run_kafka_ingest_request(db: Session, request: dict[str, Any], command: str, job_id: str | None) -> dict[str, Any]:
    snapshot_record, request_with_snapshot = kafka_request_with_durable_snapshot(db, request, job_id)
    try:
        result = run_node_bridge(
            "ingest-kafka-reviews.mjs",
            "ASKLAKE_KAFKA_REVIEW_INGEST_RESULT",
            request_with_snapshot,
            error_marker="ASKLAKE_KAFKA_REVIEW_INGEST_ERROR",
            timeout_seconds=max(30, int(request["timeoutMs"] / 1000) + 30),
        )
    except ApiError as exc:
        etl_repository.update_kafka_snapshot(db, snapshot_record, "failed", exc.message)
        raise
    etl_repository.update_kafka_snapshot(db, snapshot_record, "success")
    result["command"] = command
    return result


def kafka_request_with_durable_snapshot(
    db: Session,
    request: dict[str, Any],
    job_id: str | None,
) -> tuple[KafkaSnapshotModel, dict[str, Any]]:
    topic = str(request.get("topic") or "reviews.raw")
    consumer_group_id = str(request.get("consumerGroupId") or "")
    broker = str(request.get("broker") or "")
    continuous_conflict = etl_repository.find_conflicting_kafka_continuous_runtime(
        db,
        broker=broker,
        topic=topic,
        consumer_group_id=consumer_group_id,
        excluded_job_id=job_id or "",
    )
    if continuous_conflict is not None:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Continuous Kafka worker is already active on Job: {continuous_conflict.job_id}",
            status.HTTP_409_CONFLICT,
            {"activeJobId": continuous_conflict.job_id, "runtimeStatus": continuous_conflict.status},
        )
    existing = etl_repository.get_active_kafka_snapshot(db, topic, consumer_group_id, job_id)
    if existing is None:
        capture_request = {**request, "snapshotOnly": True}
        captured = run_node_bridge(
            "ingest-kafka-reviews.mjs",
            "ASKLAKE_KAFKA_REVIEW_INGEST_RESULT",
            capture_request,
            error_marker="ASKLAKE_KAFKA_REVIEW_INGEST_ERROR",
            timeout_seconds=max(30, int(request["timeoutMs"] / 1000) + 30),
        )
        snapshot = captured.get("snapshot")
        if not isinstance(snapshot, dict):
            raise ApiError("KAFKA_SNAPSHOT_BAD_RESPONSE", "Kafka snapshot capture did not return a snapshot.", status.HTTP_502_BAD_GATEWAY)
        snapshot["broker"] = broker
        existing = KafkaSnapshotModel(
            snapshot_id=str(snapshot["snapshotId"]),
            job_id=job_id,
            topic=topic,
            consumer_group_id=consumer_group_id,
            status="running",
            snapshot=snapshot,
        )
        existing = etl_repository.save_kafka_snapshot(db, existing)
    return existing, {**request, "snapshot": existing.snapshot}


def kafka_failure_result(request: dict[str, Any], run_id: str, error: ApiError, bridge_error: dict[str, Any]) -> dict[str, Any]:
    return {
        "broker": bridge_error.get("broker") or request.get("broker"),
        "consumedCount": int(bridge_error.get("consumedCount") or 0),
        "endedAt": bridge_error.get("endedAt") or iso_now(),
        "error": bridge_error.get("message") or error.message,
        "failedCount": int(bridge_error.get("failedCount") or 0),
        "failedStage": bridge_error.get("failedStage") or "Kafka ingest",
        "runId": bridge_error.get("runId") or run_id,
        "snapshot": bridge_error.get("snapshot"),
        "startedAt": bridge_error.get("startedAt") or iso_now(),
        "status": "failed",
        "storedCount": 0,
        "targetLayer": request.get("targetLayer") or "BRONZE",
        "topic": bridge_error.get("topic") or request.get("topic"),
        "transform": bridge_error.get("transform"),
        "quality": bridge_error.get("quality"),
    }


def kafka_ingest_request_from_job(job: ETLJobModel, run_id: str) -> dict[str, Any]:
    fields = job.source_config or []
    topic = (
        field_value(fields, "TOPIC / QUEUE NAME")
        or field_value(fields, "Topic")
        or field_value(fields, "topic")
        or "reviews.raw"
    )
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    max_messages = (
        parse_positive_integer(field_value(fields, "Batch Max Messages (per partition)"))
        or parse_positive_integer(field_value(fields, "Batch Max Messages"))
        or parse_positive_integer(field_value(fields, "Max Messages"))
        or parse_positive_integer(field_value(fields, "__Batch Max Messages"))
        or 100
    )
    timeout_ms = (
        parse_positive_integer(field_value(fields, "Timeout Ms"))
        or parse_positive_integer(field_value(fields, "Timeout Milliseconds"))
        or 10000
    )
    consumer_group_id = (
        field_value(fields, "CONSUMER GROUP ID")
        or field_value(fields, "Consumer Group ID")
        or f"asklake-{normalize_column_name(job.id)}"
    )
    offset_policy = kafka_offset_policy(field_value(fields, "Offset Policy") or field_value(fields, "offsetPolicy"))
    return {
        "allowEmpty": True,
        "broker": field_value(fields, "Broker / Endpoint") or field_value(fields, "Broker") or "127.0.0.1:19092",
        "consumerGroupId": consumer_group_id,
        "datasetId": job.dataset_id or f"ds_{normalize_column_name(job.target)}",
        "datasetName": job.target or "reviews_raw",
        "landingBucket": target["bucket"],
        "landingEndpoint": (
            field_value(fields, "Landing Endpoint URL")
            or field_value(fields, "Target Endpoint URL")
            or os.environ.get("MINIO_ENDPOINT_IN_DOCKER")
            or os.environ.get("MINIO_ENDPOINT")
            or "http://127.0.0.1:19000"
        ),
        "landingPrefix": target["prefix"],
        "maxMessages": max_messages,
        "offsetPolicy": offset_policy,
        "registerCatalog": True,
        "runId": run_id,
        "storageMode": target["storageMode"],
        "targetBucket": target["bucket"],
        "targetDescription": job.target_description or None,
        "targetFormat": job.target_format or "jsonl",
        "targetLayer": job.target_layer or "BRONZE",
        "targetPrefix": target["prefix"],
        "timeoutMs": timeout_ms,
        "topic": topic,
        "transformSteps": job.transform_steps or [],
        "qualityRules": job.quality_rules or [],
    }


def kafka_offset_policy(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if "latest" in normalized or "new" in normalized:
        return "latest"
    return "earliest"


def parse_kafka_target_path(storage_path: str | None, target_dataset: str, target_layer: str | None) -> dict[str, str]:
    default_prefix = f"{normalize_column_name(target_dataset or 'reviews_raw')}/{str(target_layer or 'BRONZE').lower()}"
    if storage_path:
        match = re.match(r"^s3a?://([^/]+)(?:/(.*))?$", storage_path.strip())
        if match:
            prefix = (match.group(2) or default_prefix).strip("/") or default_prefix
            if prefix == "kafka-landing" or prefix.startswith("kafka-landing/"):
                return {"bucket": "asklake-output", "prefix": default_prefix, "storageMode": "s3"}
            return {
                "bucket": match.group(1),
                "prefix": prefix,
                "storageMode": "s3",
            }
    return {"bucket": "asklake-output", "prefix": default_prefix, "storageMode": "s3"}


def is_kafka_job(job: ETLJobModel) -> bool:
    source_type = str(job.source_type or "").lower()
    if "kafka" in source_type:
        return True
    fields = job.source_config or []
    return bool(field_value(fields, "Broker / Endpoint") and (field_value(fields, "TOPIC / QUEUE NAME") or field_value(fields, "Topic")))


def run_spark_job(job: ETLJobModel, command: str, run_id: str) -> dict[str, Any]:
    return run_node_bridge(
        "run-spark-job-once.mjs",
        "ASKLAKE_SPARK_RUN_RESULT",
        {
            "command": command,
            "job": job_payload_for_spark(job),
            "runId": run_id,
        },
        error_marker="ASKLAKE_SPARK_RUN_ERROR",
        timeout_seconds=900,
    )


def submit_airflow_job_run(job: ETLJobModel, command: str) -> ETLRunModel:
    submitted_at = iso_now()
    run_id = stable_id("run", f"{job.id}:{command}:airflow:{submitted_at}")
    airflow_client = build_airflow_client()
    dag_run = airflow_client.trigger_dag_run(
        dag_run_id=run_id,
        conf=airflow_dag_run_conf(job, command, run_id, submitted_at),
        note=f"AskLake {command} command for {job.id}",
    )
    if not dag_run.dag_run_id:
        raise ApiError(
            "AIRFLOW_BAD_RESPONSE",
            "Airflow DAG Run response did not include dag_run_id.",
            status.HTTP_502_BAD_GATEWAY,
            {"dagId": airflow_client.config.dag_id, "runId": run_id},
        )
    return run_from_airflow_submit(
        job,
        command,
        run_id,
        submitted_at,
        dag_run,
        airflow_client.dag_run_url(dag_run.dag_run_id),
    )


def airflow_dag_run_conf(job: ETLJobModel, command: str, run_id: str, submitted_at: str) -> dict[str, Any]:
    return {
        "command": command,
        "job": job_payload_for_spark(job),
        "jobId": job.id,
        "runId": run_id,
        "submittedAt": submitted_at,
    }


def job_payload_for_spark(job: ETLJobModel) -> dict[str, Any]:
    return {
        "id": job.id,
        "name": job.name,
        "owner": job.owner,
        "qualityInvalidRows": job.quality_invalid_rows or [],
        "qualityRules": job.quality_rules or [],
        "qualityScore": job.quality_score,
        "qualityStatus": job.quality_status,
        "rag": job.rag,
        "schedule": job.schedule,
        "schemaColumns": job.schema_columns or [],
        "schemaSampleRows": job.schema_sample_rows or [],
        "source": job.source,
        "sourceConfig": job.source_config or [],
        "sourceLabel": job.source_label,
        "sourceType": job.source_type,
        "stats": job.stats or {},
        "target": job.target,
        "targetDescription": job.target_description,
        "targetFormat": job.target_format,
        "targetLayer": job.target_layer,
        "targetPath": job.target_path,
        "targetTags": job.target_tags or [],
        "storagePath": job.storage_path,
        "storageType": job.storage_type,
        "partition": job.partition,
        "partitionColumns": job.partition_columns or [],
        "indexColumns": job.index_columns or [],
        "compression": job.compression,
        "transformOutputColumns": job.transform_output_columns or [],
        "transformSteps": job.transform_steps or [],
    }


def run_from_airflow_submit(
    job: ETLJobModel,
    command: str,
    run_id: str,
    submitted_at: str,
    dag_run: AirflowDagRun,
    airflow_run_url: str | None,
) -> ETLRunModel:
    return ETLRunModel(
        run_id=run_id,
        job_id=job.id,
        status=dag_run.asklake_status,
        started_at=submitted_at,
        ended_at="-",
        duration="-",
        input_rows="-",
        output_rows="-",
        output_path=job.target_path,
        failed_stage="-",
        error_summary="-",
        airflow_dag_id=dag_run.dag_id,
        airflow_dag_run_id=dag_run.dag_run_id,
        airflow_run_url=airflow_run_url,
        airflow_state=dag_run.state,
        task_states=None,
        last_synced_at=submitted_at,
        sync_error=None,
    )


def run_from_spark_result(job: ETLJobModel, result: dict[str, Any]) -> ETLRunModel:
    success = result.get("status") == "success"
    return ETLRunModel(
        run_id=str(result.get("runId") or stable_id("run", f"{job.id}:spark:{iso_now()}")),
        job_id=job.id,
        status="success" if success else "failed",
        started_at=str(result.get("startedAt") or iso_now()),
        ended_at=str(result.get("endedAt") or iso_now()),
        duration=format_duration_ms(result.get("durationMs")),
        input_rows=format_rows(result.get("inputRows")),
        output_rows=format_rows(result.get("outputRows")),
        output_path=result.get("outputPath") or "-",
        failed_stage="-" if success else spark_failed_stage(result),
        error_summary="-" if success else spark_error_summary(result),
    )


def run_from_kafka_result(job: ETLJobModel, result: dict[str, Any]) -> ETLRunModel:
    success = result.get("status") == "success"
    started_at = str(result.get("startedAt") or iso_now())
    ended_at = str(result.get("endedAt") or iso_now())
    return ETLRunModel(
        run_id=str(result.get("runId") or stable_id("run", f"{job.id}:kafka:{iso_now()}")),
        job_id=job.id,
        status="success" if success else "failed",
        started_at=started_at,
        ended_at=ended_at,
        duration=format_iso_duration(started_at, ended_at),
        input_rows=format_rows(result.get("consumedCount")),
        output_rows=format_rows(result.get("storedCount")),
        output_path=result.get("storageLocation") or "-",
        failed_stage="-" if success else str(result.get("failedStage") or "Kafka ingest"),
        error_summary="-" if success else str(result.get("error") or "Kafka ingest failed."),
        task_states={
            "kafkaSnapshot": result.get("snapshot"),
            "transform": result.get("transform"),
            "quality": result.get("quality"),
        } if result.get("snapshot") else None,
    )


def apply_airflow_submit_job_state(job: ETLJobModel, command: str, run: ETLRunModel) -> None:
    action_label = "재실행" if command == "retry" else "실행"
    state_label = run.airflow_state or run.status
    job.last_run = run.started_at
    job.last_state = f"Airflow {action_label} 접수 · {state_label}"
    job.next_run = "-"
    if run.status == "failed":
        job.progress = None
        job.status = "failed"
        return
    if run.status == "success":
        job.progress = None
        job.status = "scheduled"
        return
    job.progress = {
        "label": f"Airflow DAG Run {state_label}",
        "value": 10 if run.status == "queued" else 20,
    }
    job.status = "running"


def sync_airflow_runs_for_job(db: Session, job: ETLJobModel) -> None:
    runs = etl_repository.list_run_models_for_job(db, job.id)
    active_runs = [
        run
        for run in runs
        if run.status in ACTIVE_RUN_STATUSES and run.airflow_dag_run_id
    ]
    if not active_runs:
        return

    try:
        airflow_client = build_airflow_client()
    except ApiError as exc:
        sync_error = exc.message
        synced_at = iso_now()
        for run in active_runs:
            run.sync_error = sync_error
            run.last_synced_at = synced_at
        job.last_state = f"Airflow 상태 동기화 실패 · {sync_error}"
        etl_repository.save_job(db, job)
        return

    for run in active_runs:
        sync_airflow_run(job, run, airflow_client)

    latest_run = runs[0]
    apply_job_state_from_latest_run(job, latest_run)
    job.stats = stats_from_runs(job, [etl_repository.run_to_schema(run) for run in runs])
    etl_repository.save_job(db, job)


def sync_airflow_run(job: ETLJobModel, run: ETLRunModel, airflow_client: Any) -> None:
    synced_at = iso_now()
    try:
        dag_run = airflow_client.get_dag_run(run.airflow_dag_run_id)
        task_instances = airflow_client.list_task_instances(run.airflow_dag_run_id)
    except ApiError as exc:
        run.sync_error = exc.message
        run.last_synced_at = synced_at
        return

    run.status = dag_run.asklake_status
    run.airflow_dag_id = dag_run.dag_id or run.airflow_dag_id
    run.airflow_dag_run_id = dag_run.dag_run_id or run.airflow_dag_run_id
    run.airflow_run_url = airflow_client.dag_run_url(run.airflow_dag_run_id) or run.airflow_run_url
    run.airflow_state = dag_run.state
    run.task_states = task_state_snapshot(task_instances)
    run.last_synced_at = synced_at
    run.sync_error = None

    if run.status in TERMINAL_RUN_STATUSES and run.ended_at == "-":
        run.ended_at = synced_at
        run.duration = format_iso_duration(run.started_at, synced_at)

    if run.status == "failed":
        failed_task = first_problem_task(task_instances)
        run.failed_stage = task_title(failed_task.task_id) if failed_task else "Airflow DAG Run"
        run.error_summary = f"Airflow task failed: {failed_task.task_id}" if failed_task else "Airflow DAG Run failed."
    elif run.status == "success":
        run.failed_stage = "-"
        run.error_summary = "-"

    run_schema = etl_repository.run_to_schema(run)
    dag_steps = dag_steps_from_airflow_sync(job, run_schema.model_dump(by_alias=True), task_instances)
    job.dag_steps_by_run_id = {
        **(job.dag_steps_by_run_id or {}),
        run.run_id: dag_steps,
    }
    job.dag_steps = dag_steps


def apply_job_state_from_latest_run(job: ETLJobModel, latest_run: ETLRunModel) -> None:
    job.last_run = latest_run.ended_at if latest_run.status in TERMINAL_RUN_STATUSES else latest_run.started_at
    job.next_run = "-" if job.schedule in {"수동 실행", "manual"} else job.schedule

    if latest_run.status == "success":
        job.status = "scheduled"
        job.progress = None
        job.last_state = "최근 실행 성공 · 다음 실행 대기"
        return
    if latest_run.status == "failed":
        job.status = "failed"
        job.progress = None
        job.last_state = f"최근 실행 실패 · {latest_run.failed_stage}"
        return
    if latest_run.status == "canceled":
        job.status = "canceled"
        job.progress = None
        job.last_state = "최근 실행 취소"
        return

    state_label = latest_run.airflow_state or latest_run.status
    job.status = "running"
    job.progress = {
        "label": f"Airflow DAG Run {state_label}",
        "value": 10 if latest_run.status == "queued" else 55,
    }
    job.last_state = f"Airflow 실행 중 · {state_label}"
    job.next_run = "-"


AIRFLOW_TASK_TITLES = {
    "receive_asklake_run": "1. Airflow DAG Run 접수",
    "spark_source_read": "2. Spark 소스 읽기",
    "transform_quality_write": "3. 처리/품질/적재",
    "catalog_update": "4. 카탈로그 갱신",
}


def task_state_snapshot(task_instances: list[AirflowTaskInstance]) -> dict[str, dict[str, Any]]:
    return {
        task.task_id: {
            "airflowState": task.state,
            "dagId": task.dag_id,
            "dagRunId": task.dag_run_id,
            "status": task.asklake_status,
            "taskId": task.task_id,
        }
        for task in task_instances
        if task.task_id
    }


def first_problem_task(task_instances: list[AirflowTaskInstance]) -> AirflowTaskInstance | None:
    for task in task_instances:
        if task.asklake_status in {"failed", "blocked"}:
            return task
    return None


def task_title(task_id: str) -> str:
    if task_id in AIRFLOW_TASK_TITLES:
        return AIRFLOW_TASK_TITLES[task_id]
    return str(task_id or "Airflow task").replace("_", " ").strip().title()


def dag_steps_from_airflow_submit(job: ETLJobModel, command: str, run: dict[str, Any]) -> list[dict[str, Any]]:
    action_label = "재실행" if command == "retry" else "실행"
    state_label = str(run.get("airflowState") or run.get("status") or "queued")
    return [
        dag_step("airflow-submit", "Airflow DAG Run 접수", state_label, "running", [
            ["Job", job.name],
            ["Run ID", run.get("runId", "-")],
            ["DAG Run ID", run.get("airflowDagRunId", "-")],
        ], [f"AskLake {action_label} 명령이 Airflow에 접수되었습니다."]),
        *[
            dag_step(task_id, title, "대기", "pending", [
                ["Airflow task", task_id],
            ], ["Airflow Task Instance 상태 polling 대기 중입니다."])
            for task_id, title in AIRFLOW_TASK_TITLES.items()
        ],
    ]


def dag_steps_from_airflow_sync(
    job: ETLJobModel,
    run: dict[str, Any],
    task_instances: list[AirflowTaskInstance],
) -> list[dict[str, Any]]:
    task_by_id = {task.task_id: task for task in task_instances if task.task_id}
    run_status = str(run.get("status") or "running")
    run_state = str(run.get("airflowState") or run_status)
    submit_status = "success" if run_status in TERMINAL_RUN_STATUSES else "running"
    if run_status == "failed":
        submit_status = "failed"

    steps = [
        dag_step("airflow-submit", "Airflow DAG Run 상태", run_state, submit_status, [
            ["Job", job.name],
            ["Run ID", run.get("runId", "-")],
            ["DAG Run ID", run.get("airflowDagRunId", "-")],
            ["Airflow state", run_state],
        ], [f"Airflow DAG Run 상태: {run_state}"]),
    ]

    for task_id, title in AIRFLOW_TASK_TITLES.items():
        task = task_by_id.get(task_id)
        status_value = task.asklake_status if task else "pending"
        airflow_state = task.state if task and task.state else "not_started"
        logs = [f"Airflow Task Instance state: {airflow_state}"]
        if task and task.raw.get("try_number") is not None:
            logs.append(f"try_number={task.raw.get('try_number')}")
        steps.append(dag_step(task_id, title, airflow_state, status_value, [
            ["Airflow task", task_id],
            ["Airflow state", airflow_state],
        ], logs))

    extra_tasks = [
        task for task in task_instances
        if task.task_id and task.task_id not in AIRFLOW_TASK_TITLES
    ]
    for task in extra_tasks:
        steps.append(dag_step(task.task_id, task_title(task.task_id), task.state or "-", task.asklake_status, [
            ["Airflow task", task.task_id],
            ["Airflow state", task.state or "-"],
        ], [f"Airflow Task Instance state: {task.state or '-'}"]))

    return steps


def finalize_job_from_spark_result(job: ETLJobModel, command: str, result: dict[str, Any]) -> None:
    success = result.get("status") == "success"
    job.last_run = str(result.get("endedAt") or iso_now())
    job.last_state = (
        f"{'재실행' if command == 'retry' else '실행'} 완료 · Spark Parquet 적재"
        if success
        else f"Spark 실행 실패 · {spark_error_summary(result, limit=180)}"
    )
    job.next_run = schedule_next_run_label(job.schedule, job.next_run)
    job.progress = None
    job.status = "scheduled" if success else "failed"
    job.target_path = result.get("outputPath") or job.target_path


def spark_failed_stage(result: dict[str, Any]) -> str:
    return compact_storage_text(result.get("failedStage") or "Spark ETL", limit=500)


def spark_error_summary(result: dict[str, Any], *, limit: int = 1800) -> str:
    return compact_storage_text(result.get("error") or result.get("stderr") or result.get("stdout") or "Spark job failed.", limit=limit)


def compact_storage_text(value: Any, *, limit: int) -> str:
    text_value = str(value or "").replace("\r", "\n")
    lines = [line.strip() for line in text_value.splitlines() if line.strip()]
    compact = " | ".join(lines) if lines else "-"
    if len(compact) <= limit:
        return compact
    return f"{compact[: max(0, limit - 32)]} ... [truncated {len(compact)} chars]"


def finalize_job_from_kafka_result(job: ETLJobModel, command: str, result: dict[str, Any]) -> None:
    success = result.get("status") == "success"
    stored_count = int(result.get("storedCount") or 0)
    failed_count = int(result.get("failedCount") or 0)
    snapshot_id = str((result.get("snapshot") or {}).get("snapshotId") or "-")
    job.last_run = str(result.get("endedAt") or iso_now())
    job.last_state = (
        f"{'재실행' if command == 'retry' else '실행'} 완료 · Kafka snapshot {snapshot_id} · {stored_count:,}건 target 저장"
        if success
        else f"Kafka 실행 실패 · {result.get('error') or '원인 확인 필요'}"
    )
    job.next_run = schedule_next_run_label(job.schedule, job.next_run)
    job.progress = None
    job.status = "scheduled" if success else "failed"
    job.target_path = result.get("storageLocation") or job.target_path
    job.stats = {
        **(job.stats or {}),
        "currentStage": "Kafka snapshot target 저장 완료" if success else "Kafka snapshot target 저장 실패",
        "inputRows": format_rows(result.get("consumedCount")),
        "lastSuccess": str(result.get("endedAt") or iso_now()) if success else job.stats.get("lastSuccess", "-"),
        "outputPath": result.get("storageLocation") or job.target_path,
        "outputRows": format_rows(result.get("storedCount")),
        "sampleScope": f"{result.get('topic') or 'Kafka'} batch",
        "sourceUnits": "Kafka topic",
        "successRate": "100%" if success and failed_count == 0 else "확인 필요",
    }


def dataset_from_spark_result(job: ETLJobModel, result: dict[str, Any], existing_dataset: CatalogDatasetModel | None = None) -> CatalogDatasetModel:
    now = str(result.get("endedAt") or iso_now())
    schema = result.get("schema")
    schema_json = [
        [str(field.get("name") or "-"), str(field.get("type") or "string")]
        for field in schema
    ] if isinstance(schema, list) and schema else schema_from_job(job)
    dataset_id = f"ds_{normalize_column_name(job.target)}"
    previous_payload = existing_dataset.payload if existing_dataset and existing_dataset.payload else None
    dataset_payload = dataset_payload_from_spark_result(job, result, dataset_id, schema_json, now, previous_payload)
    storage_size_bytes = int(dataset_payload.get("storageSizeBytes") or 0)
    display_size = format_storage_size(storage_size_bytes) if storage_size_bytes > 0 else "Pending"
    target_description = target_dataset_description(job)
    target_tags = target_dataset_tags(job)
    return CatalogDatasetModel(
        id=dataset_id,
        payload=dataset_payload,
        name=job.target,
        description=target_description,
        owner=job.owner,
        layer=job.target_layer,
        status="available",
        freshness="latest",
        source=job.name,
        rows=format_rows(result.get("outputRows")),
        size=display_size,
        quality=quality_summary_from_spark_result(job, result),
        last_updated=now,
        next_refresh=job.schedule,
        rag=job.rag,
        tags=target_tags,
        schema_json=schema_json,
        sample_rows=job.schema_sample_rows or [],
        upstream=[job.source_label, job.name],
        downstream=["SQL 분석", "RAG 인덱싱"] if job.rag else ["SQL 분석"],
    )


def dataset_payload_from_spark_result(
    job: ETLJobModel,
    result: dict[str, Any],
    dataset_id: str,
    schema_json: list[list[str]],
    last_updated: str,
    previous_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    output_path = str(result.get("outputPath") or "-")
    storage_size_bytes = dataset_storage_size_bytes(output_path)
    display_size = format_storage_size(storage_size_bytes) if storage_size_bytes > 0 else "Pending"
    lineage_graph = etl_dataset_lineage_graph(job, dataset_id, schema_json)
    partition_columns = normalize_string_list(job.partition_columns)
    index_columns = normalize_string_list(job.index_columns)
    partition = "/".join(partition_columns) if partition_columns else normalize_optional_text(job.partition)
    materialization_runs = append_materialization_run(
        previous_payload.get("materializationRuns") if previous_payload else [],
        {
            "createdAt": last_updated,
            "jobId": job.id,
            "rowCount": parse_count_value(result.get("outputRows")),
            "runId": str(result.get("runId") or ""),
            "sourceKind": result.get("sourceKind") or ("sql" if job.source_type == "SQL Result" else "etl"),
            "sourceLabel": job.name or job.source or job.source_label or job.id,
            "status": "success" if result.get("status") == "success" else "failed",
            "storageLocation": output_path,
            "storageSizeBytes": storage_size_bytes,
        },
    )
    aggregate = aggregate_materialization_runs(materialization_runs)
    return {
        "description": target_dataset_description(job),
        "downstream": ["SQL 분석", "RAG 인덱싱"] if job.rag else ["SQL 분석"],
        "freshness": "latest",
        "id": dataset_id,
        "layer": job.target_layer,
        "lastUpdated": aggregate["lastUpdated"] or last_updated,
        "lineageGraph": lineage_graph,
        "materializationRuns": materialization_runs,
        "name": job.target,
        "nextRefresh": job.schedule,
        "owner": job.owner,
        "createdBy": job.created_by or job.owner,
        "createdByProfile": job.created_by_profile or identity_profile(job.created_by or job.owner),
        "permissionGrants": permission_grants_from_roles(job.owner, job.permission_roles, default_actions=["view", "query"]),
        "permissions": resource_permissions(can_query=True),
        "quality": quality_summary_from_spark_result(job, result),
        "rag": job.rag,
        "rows": format_rows(aggregate["rowCount"]),
        "sampleRows": job.schema_sample_rows or [],
        "schema": schema_json,
        "size": format_storage_size(aggregate["storageSizeBytes"]) if aggregate["storageSizeBytes"] > 0 else display_size,
        "source": job.name,
        "sourceRunId": aggregate["latestRunId"] or result.get("runId"),
        "status": "available",
        "storageFormat": "parquet",
        "storageLocation": output_path,
        "storageSizeBytes": aggregate["storageSizeBytes"],
        "partition": partition,
        "partitionColumns": partition_columns,
        "indexColumns": index_columns,
        "tags": target_dataset_tags(job),
        "upstream": [job.source_label, job.name],
    }


def update_existing_append_job(
    job: ETLJobModel,
    request: CreatePipelineRequest,
    dataset_id: str,
    created_by: str,
    created_by_profile: dict[str, Any],
) -> None:
    dataset_schema = dataset_schema_from_request(request)
    sample_rows = dataset_sample_rows_from_request(request, dataset_schema)
    metrics = source_metrics_from_request(request, dataset_schema, sample_rows)
    job.name = request.job_name or job.name
    job.owner = request.owner
    job.created_by = job.created_by or created_by
    job.created_by_profile = job.created_by_profile or created_by_profile
    job.tag = "[append]"
    job.source = f"{request.source_type} / {request.source_label}"
    job.target = request.target_dataset
    job.schedule = request.schedule_label
    job.schedule_policy = schedule_policy_from_request(request)
    job.schedule_summary = request.schedule_summary
    job.retry_policy = request.retry_policy.model_dump(mode="json", by_alias=True) if request.retry_policy else None
    job.retry_policy_summary = request.retry_policy_summary
    job.run_limit_summary = request.run_limit_summary
    job.source_config = tuple_rows_to_lists(request.source_config)
    job.source_label = request.source_label
    job.source_type = request.source_type
    job.execution_mode = request.execution_mode
    job.continuous_config = continuous_config_from_request(request, job.id)
    job.schema_columns = [column.model_dump(mode="json", by_alias=True) for column in request.schema_columns]
    job.schema_fingerprint = request.schema_fingerprint
    job.schema_sample_rows = request.schema_sample_rows
    job.schema_summary = request.schema_summary
    job.rule_summary = request.rule_summary
    job.permission_summary = request.permission_summary
    job.permission_roles = request.permission_roles
    job.storage_type = request.storage_type
    job.partition = request.partition
    job.partition_columns = normalize_string_list(request.partition_columns)
    job.index_columns = normalize_string_list(request.index_columns)
    job.compression = request.compression
    job.storage_path = request.storage_path
    job.target_description = normalize_optional_text(request.target_description)
    job.target_database = normalize_optional_text(request.target_database)
    job.target_tags = normalize_target_tags(request.target_tags)
    job.target_format = request.target_format
    job.target_layer = request.target_layer
    job.target_path = request.storage_path
    job.rag = request.rag
    job.transform_output_columns = tuple_rows_to_lists(request.transform_output_columns)
    job.transform_steps = [step.model_dump(mode="json", by_alias=True) for step in request.transform_steps]
    job.quality_invalid_rows = request.quality_invalid_rows
    job.quality_rules = [rule.model_dump(mode="json", by_alias=True) for rule in request.quality_rules]
    job.quality_score = request.quality_score
    job.quality_status = request.quality_status
    job.last_run = "append draft updated"
    job.last_state = f"{metrics['schema_columns']}개 컬럼 · 기존 데이터셋 append 대기"
    job.next_run = schedule_next_run_label(request.schedule_label, request.schedule_summary)
    job.progress = None
    job.stats = initial_job_stats(metrics)
    job.dag_steps = initial_dag_steps(request, metrics)
    job.dataset_id = dataset_id


def append_materialization_run(previous_runs: Any, next_run: dict[str, Any]) -> list[dict[str, Any]]:
    runs = [run for run in previous_runs if isinstance(run, dict)] if isinstance(previous_runs, list) else []
    run_id = str(next_run.get("runId") or "")
    if not run_id:
        return runs
    return [next_run, *[run for run in runs if str(run.get("runId") or "") != run_id]]


def identity_name(value: str | None) -> str:
    return (value or "").strip() or "demo-user"


def identity_profile(name: str) -> dict[str, str]:
    display_name = identity_name(name)
    words = [word for word in display_name.replace("_", " ").replace("-", " ").split(" ") if word]
    initials = "".join(word[0].upper() for word in words[:2]) or display_name[:2].upper()
    return {
        "avatarInitials": initials[:2],
        "displayName": display_name,
    }


def aggregate_materialization_runs(runs: list[dict[str, Any]]) -> dict[str, Any]:
    active_runs = [run for run in runs if run.get("status") == "success"]
    latest_run = active_runs[0] if active_runs else None
    return {
        "latestRunId": latest_run.get("runId") if latest_run else None,
        "lastUpdated": latest_run.get("createdAt") if latest_run else None,
        "rowCount": sum(parse_count_value(run.get("rowCount")) for run in active_runs),
        "storageSizeBytes": sum(parse_count_value(run.get("storageSizeBytes")) for run in active_runs),
    }


def parse_count_value(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, int):
        return max(value, 0)
    if isinstance(value, float):
        return max(int(value), 0)
    digits = re.sub(r"[^0-9]", "", str(value))
    return int(digits) if digits else 0


def etl_dataset_lineage_graph(job: ETLJobModel, dataset_id: str, schema_json: list[list[str]]) -> dict[str, Any]:
    source_node_id = normalize_lineage_id(f"{dataset_id}-{job.source_label or job.source_type or 'source'}")
    source_node = lineage_node(
        source_node_id,
        job.source_label or job.source_type or "Source",
        "SOURCE",
        schema_json,
        "SOURCE",
    )
    job_node = lineage_node(normalize_lineage_id(job.id), job.name, "BRONZE", schema_json, "SPARK")
    target_node = lineage_node(dataset_id, job.target, job.target_layer or "RAW", schema_json, "ICEBERG")
    return {
        "datasetId": dataset_id,
        "datasets": [source_node, job_node, target_node],
        "edges": [
            *lineage_edges_between(source_node, job_node),
            *lineage_edges_between(job_node, target_node),
        ],
    }


def lineage_edges_between(source_node: dict[str, Any], target_node: dict[str, Any]) -> list[dict[str, str]]:
    source_columns = source_node.get("columns") if isinstance(source_node.get("columns"), list) else []
    target_columns = target_node.get("columns") if isinstance(target_node.get("columns"), list) else []
    edges = []
    for index, target_column in enumerate(target_columns):
        source_column = source_columns[index] if index < len(source_columns) else target_column
        edges.append({
            "fromColumnId": str(source_column.get("id") or target_column.get("id")),
            "fromDatasetId": str(source_node.get("id")),
            "toColumnId": str(target_column.get("id")),
            "toDatasetId": str(target_node.get("id")),
        })
    return edges


def dataset_storage_size_bytes(output_path: str) -> int:
    path = Path(output_path)
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            total += item.stat().st_size
    return total


def format_storage_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes}B"
    units = ["KB", "MB", "GB", "TB"]
    size = float(size_bytes)
    for unit in units:
        size /= 1024
        if size < 1024:
            return f"{size:.1f}{unit}"
    return f"{size:.1f}PB"


def dag_steps_from_spark_result(job: ETLJobModel, command: str, run: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    failed = result.get("status") != "success"
    failed_stage = str(result.get("failedStage") or "").lower()
    read_failed = failed and ("read" in failed_stage or "source" in failed_stage or not failed_stage)
    transform_failed = failed and "transform" in failed_stage
    quality_failed = failed and "quality" in failed_stage
    transform_meta = f"{len(job.transform_steps or [])}개 규칙"
    quality_meta = f"{len(job.quality_rules or [])}개 검사"
    source_path = str(result.get("sourcePath") or job.source)
    output_path = str(result.get("outputPath") or run.get("outputPath") or "-")
    spark_logs = compact_spark_logs(result)
    quality_result = result.get("quality") if isinstance(result.get("quality"), dict) else {}
    quality_summary = str(quality_result.get("summary") or "-")

    return [
        dag_step("source", "1. 소스 연결", job.source, "success", [
            ["소스", job.source],
            ["소스 경로", source_path],
        ], [f"{job.source_type} 커넥터 설정 확인 완료."]),
        dag_step("schema", "2. 스키마 확인", job.stats.get("schemaColumns", "-"), "success", [
            ["스키마", job.stats.get("schemaColumns", "-")],
            ["샘플 범위", job.stats.get("sampleScope", "-")],
        ], ["생성 시 확정된 스키마를 Spark 실행 계약에 사용했습니다."]),
        dag_step("read", "3. Spark 소스 읽기", run.get("inputRows", "0"), "failed" if read_failed else "success", [
            ["입력 행", run.get("inputRows", "0")],
            ["Spark source", source_path],
        ], [f"Spark 소스 읽기 실패: {run.get('errorSummary')}" if read_failed else f"Spark가 {run.get('inputRows', '0')}을 읽었습니다.", *spark_logs]),
        dag_step("transform", "4. 처리 규칙 적용", transform_meta, "failed" if transform_failed else "blocked" if read_failed else "success", [
            ["처리 규칙", transform_meta],
        ], [f"처리 규칙 적용 실패: {run.get('errorSummary')}" if transform_failed else "소스 읽기 실패로 처리 규칙 적용이 중단되었습니다." if read_failed else "처리 규칙 적용 완료."]),
        dag_step("quality", "5. 품질 검증", quality_meta, "failed" if quality_failed else "blocked" if read_failed or transform_failed else "success", [
            ["품질 검사", quality_meta],
            ["품질 결과", quality_summary],
        ], [f"품질 검증 실패: {run.get('errorSummary')}" if quality_failed else "이전 단계 실패로 품질 검증이 실행되지 않았습니다." if read_failed or transform_failed else quality_summary if quality_summary != "-" else "품질 검증 완료."]),
        dag_step("write", "6. Parquet 적재", output_path, "blocked" if failed else "success", [
            ["출력 경로", output_path],
            ["출력 행", run.get("outputRows", "0")],
        ], ["이전 단계 실패로 Parquet 적재가 수행되지 않았습니다." if failed else f"Parquet 출력 완료: {output_path}"]),
        dag_step("catalog", "7. 카탈로그 데이터셋 갱신", job.target, "blocked" if failed else "success", [
            ["데이터셋", job.target],
            ["레이어", job.target_layer],
        ], ["실행 실패로 카탈로그 데이터셋을 갱신하지 않았습니다." if failed else "실행 성공 후 카탈로그 데이터셋을 갱신했습니다."]),
    ]


def dag_steps_from_kafka_result(job: ETLJobModel, command: str, run: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    failed = result.get("status") != "success"
    failed_stage = str(result.get("failedStage") or "").lower()
    consume_failed = failed and failed_stage in {"kafka ingest", "consume", "source"}
    transform_failed = failed and failed_stage == "transform"
    quality_failed = failed and failed_stage == "quality"
    topic = str(result.get("topic") or field_value(job.source_config or [], "TOPIC / QUEUE NAME") or "-")
    broker = str(result.get("broker") or field_value(job.source_config or [], "Broker / Endpoint") or "-")
    storage_location = str(result.get("storageLocation") or run.get("outputPath") or "-")
    dataset_id = str(result.get("datasetId") or job.dataset_id or f"ds_{normalize_column_name(job.target)}")
    consumer_group_id = str(result.get("consumerGroupId") or field_value(job.source_config or [], "CONSUMER GROUP ID") or "-")
    snapshot = result.get("snapshot") or {}
    transform = result.get("transform") or {}
    quality = result.get("quality") or {}
    snapshot_ranges = ", ".join(
        f"p{item.get('partition')}:{item.get('startOffset')}~{item.get('endOffset')}"
        for item in snapshot.get("partitions", [])
    ) or "-"
    return [
        dag_step("source", "1. Kafka 소스 연결", topic, "failed" if consume_failed else "success", [
            ["Broker", broker],
            ["Topic", topic],
        ], [f"Kafka topic {topic} batch consume 요청을 실행했습니다."]),
        dag_step("consume", "2. 메시지 batch consume", format_rows(result.get("consumedCount")), "failed" if consume_failed else "success", [
            ["Consumer group", consumer_group_id],
            ["Snapshot", str(snapshot.get("snapshotId") or "-")],
            ["Offset ranges", snapshot_ranges],
            ["Consumed", format_rows(result.get("consumedCount"))],
            ["Failed", format_rows(result.get("failedCount"))],
        ], [f"Kafka consume 실패: {run.get('errorSummary')}" if consume_failed else "Kafka 메시지를 batch 단위로 읽었습니다."]),
        dag_step("transform", "3. 변환 규칙 적용", f"{transform.get('appliedStepCount', 0)}개 규칙", "failed" if transform_failed else "blocked" if failed else "success", [
            ["Configured", str(transform.get("configuredStepCount", 0))],
            ["Applied", str(transform.get("appliedStepCount", 0))],
            ["Transform errors", str(transform.get("errorCount", 0))],
        ], [f"변환 규칙 적용 실패: {run.get('errorSummary')}" if transform_failed else "이전 단계 실패로 변환이 수행되지 않았습니다." if failed else "Kafka snapshot 레코드에 변환 규칙을 적용했습니다."]),
        dag_step("quality", "4. 품질 검증", str(quality.get("summary") or "규칙 없음"), "failed" if quality_failed else "blocked" if failed else "success", [
            ["Configured", str(quality.get("configuredRuleCount", 0))],
            ["Invalid", str(quality.get("invalidRowCount", 0))],
            ["Quarantined", str(quality.get("quarantinedCount", 0))],
            ["Dropped", str(quality.get("droppedCount", 0))],
        ], [f"품질 검증 실패: {run.get('errorSummary')}" if quality_failed else "이전 단계 실패로 품질 검증이 수행되지 않았습니다." if failed else str(quality.get("summary") or "품질 규칙 없음")]),
        dag_step("target", "5. Direct target 저장", storage_location, "blocked" if failed else "success", [
            ["Storage", str(result.get("storageMode") or "s3")],
            ["Format", str(result.get("storageFormat") or "jsonl")],
            ["Layer", str(result.get("targetLayer") or job.target_layer)],
            ["Stored", format_rows(result.get("storedCount"))],
        ], ["이전 단계 실패로 target 저장이 수행되지 않았습니다." if failed else f"Kafka snapshot 결과를 target에 저장했습니다: {storage_location}"]),
        dag_step("catalog", "6. 카탈로그 갱신", dataset_id, "blocked" if failed else "success", [
            ["Dataset", dataset_id],
            ["Run ID", run.get("runId", "-")],
        ], ["이전 단계 실패로 카탈로그 갱신이 중단되었습니다." if failed else "Catalog materialization run이 Kafka sourceKind로 갱신되었습니다."]),
    ]


def dag_step(id_: str, title: str, meta: str, status_value: str, details: list[list[Any]] | None = None, logs: list[str] | None = None) -> dict[str, Any]:
    normalized_details = [
        [str(label or "-"), str(value if value is not None else "-")]
        for label, value in (details or [])
    ]
    return {
        "details": normalized_details,
        "id": id_,
        "logs": [str(line) for line in (logs or []) if line],
        "meta": str(meta or "-"),
        "status": status_value,
        "title": title,
    }


def compact_spark_logs(result: dict[str, Any]) -> list[str]:
    lines = "\n".join(str(result.get(key) or "") for key in ["error", "stderr", "stdout"]).splitlines()
    return [line for line in lines if line.strip()][-80:]


def schema_from_job(job: ETLJobModel) -> list[list[str]]:
    return [
        [str(column.get("targetName") or column.get("sourceName") or f"column_{index + 1}"), str(column.get("type") or "string")]
        for index, column in enumerate(job.schema_columns or [])
        if schema_column_included(column)
    ]


def schema_column_included(column: Any) -> bool:
    if not isinstance(column, dict):
        return True
    value = column.get("included", True)
    if isinstance(value, str):
        return value.strip().lower() not in {"false", "0", "no", "off"}
    return value is not False


def quality_summary_from_spark_result(job: ETLJobModel, result: dict[str, Any]) -> str:
    quality = result.get("quality") if isinstance(result.get("quality"), dict) else None
    if quality:
        if quality.get("summary"):
            return str(quality["summary"])
        if quality.get("score") is not None:
            return f"품질 점수 {quality.get('score')}% · 상태 {quality_status_label(str(quality.get('status') or job.quality_status))}"
    return f"품질 점수 {job.quality_score if job.quality_score is not None else '-'}% · 상태 {quality_status_label(job.quality_status)}"


def run_node_bridge(script_name: str, success_marker: str, payload: dict[str, Any], *, error_marker: str, timeout_seconds: int) -> dict[str, Any]:
    script_path = SCRIPTS_DIR / script_name
    result = subprocess.run(
        ["node", str(script_path)],
        cwd=str(BACKEND_DIR),
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_seconds,
    )
    stdout = result.stdout or ""
    stderr = result.stderr or ""
    if result.returncode != 0:
        error_payload = marker_payload(stdout, error_marker) or {}
        raise ApiError(
            error_payload.get("code") or "BACKEND_BRIDGE_FAILED",
            error_payload.get("message") or (stderr.strip() or f"{script_name} failed."),
            int(error_payload.get("status") or status.HTTP_502_BAD_GATEWAY),
            {"bridge": error_payload, "stderr": stderr[-4000:], "stdout": stdout[-4000:]},
        )
    payload_result = marker_payload(stdout, success_marker)
    if payload_result is None:
        raise ApiError(
            "BACKEND_BRIDGE_BAD_RESPONSE",
            f"{script_name} did not return {success_marker}.",
            status.HTTP_502_BAD_GATEWAY,
            {"stderr": stderr[-4000:], "stdout": stdout[-4000:]},
        )
    if isinstance(payload_result, dict):
        payload_result.setdefault("stdout", stdout)
        payload_result.setdefault("stderr", stderr)
    return payload_result


def marker_payload(output: str, marker: str) -> dict[str, Any] | None:
    prefix = f"{marker}="
    for line in reversed(str(output or "").splitlines()):
        if line.startswith(prefix):
            return json.loads(line[len(prefix):])
    return None


def run_kafka_continuous_worker(job: ETLJobModel, runtime: KafkaContinuousRuntimeModel, action: str) -> dict[str, Any]:
    config = job.continuous_config or {}
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    output_path = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}"
    return run_node_bridge(
        "manage-kafka-continuous.mjs",
        "ASKLAKE_KAFKA_CONTINUOUS_RESULT",
        {
            "action": action,
            "broker": runtime.broker,
            "checkpointPath": runtime.checkpoint_path,
            "consumerGroupId": runtime.consumer_group_id,
            "initialOffsetPolicy": config.get("initialOffsetPolicy", "earliest"),
            "initialCounts": {
                "consumedCount": runtime.consumed_count,
                "storedCount": runtime.stored_count,
                "quarantinedCount": runtime.quarantined_count,
                "failedCount": runtime.failed_count,
            },
            "jobId": job.id,
            "maxOffsetsPerTrigger": config.get("maxOffsetsPerTrigger", 10000),
            "outputPath": output_path,
            "schemaColumns": job.schema_columns or [],
            "topic": runtime.topic,
            "triggerIntervalSeconds": config.get("triggerIntervalSeconds", 30),
        },
        error_marker="ASKLAKE_KAFKA_CONTINUOUS_ERROR",
        timeout_seconds=90 if action == "start" else 20,
    )


def refresh_kafka_continuous_runtime(db: Session, job: ETLJobModel) -> None:
    if job.execution_mode != "continuous":
        return
    runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
    if runtime is None:
        return
    report_path = continuous_runtime_report_path(job.id)
    worker_status = continuous_worker_status(job, runtime)
    container_state = str(worker_status.get("containerState") or "unknown")
    if runtime.status in {"pausing", "stopping"} and container_state in {"exited", "missing"}:
        # Pause and stop intentionally terminate the worker after persisting its
        # checkpoint. The previous running report can outlive that container,
        # so the requested control transition is authoritative here.
        runtime.status = "paused" if runtime.status == "pausing" else "stopped"
        runtime.last_error = None
        if runtime.status == "paused":
            job.status = "paused"
            job.last_state = "Continuous worker 일시정지됨"
        else:
            job.status = "stopped"
            job.last_state = "Continuous worker 중지됨 · checkpoint 보존"
        job.progress = None
        etl_repository.save_kafka_continuous_command(db, job, runtime)
        return
    if not report_path.exists():
        if runtime.status in {"starting", "running", "pausing", "stopping"} and container_state in {"exited", "missing"}:
            mark_continuous_runtime_failed(job, runtime, f"Continuous worker container is {container_state} without a runtime report.")
            etl_repository.save_kafka_continuous_command(db, job, runtime)
        return
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    runtime_status = str(payload.get("status") or runtime.status)
    if runtime_status not in {"starting", "running", "pausing", "paused", "stopping", "stopped", "failed"}:
        return
    runtime.status = runtime_status
    runtime.heartbeat_at = optional_string(payload.get("heartbeatAt")) or runtime.heartbeat_at
    runtime.last_flush_at = optional_string(payload.get("lastFlushAt")) or runtime.last_flush_at
    runtime.last_batch_id = optional_string(payload.get("lastBatchId")) or runtime.last_batch_id
    runtime.lag = optional_int(payload.get("lag"))
    runtime.consumed_count = nonnegative_int(payload.get("consumedCount"), runtime.consumed_count)
    runtime.stored_count = nonnegative_int(payload.get("storedCount"), runtime.stored_count)
    runtime.quarantined_count = nonnegative_int(payload.get("quarantinedCount"), runtime.quarantined_count)
    runtime.failed_count = nonnegative_int(payload.get("failedCount"), runtime.failed_count)
    runtime.last_error = optional_string(payload.get("lastError"))
    heartbeat_stale = continuous_heartbeat_is_stale(runtime.heartbeat_at, job)
    if runtime_status in {"starting", "running", "pausing", "stopping"} and container_state in {"exited", "missing"}:
        mark_continuous_runtime_failed(job, runtime, f"Continuous worker container is {container_state} (exitCode={worker_status.get('exitCode')}).")
    elif runtime_status in {"starting", "running", "pausing", "stopping"} and heartbeat_stale:
        mark_continuous_runtime_failed(job, runtime, "Continuous worker heartbeat expired.")
        stop_stale_continuous_worker(job, runtime)
    if runtime.status == "running":
        job.status = "running"
        job.last_state = f"Continuous Spark streaming · {runtime.stored_count:,}건 적재"
        job.progress = {"label": "Continuous micro-batch 실행 중", "value": 66}
    elif runtime.status == "paused":
        job.status = "paused"
        job.last_state = "Continuous worker 일시정지됨"
        job.progress = None
    elif runtime.status == "stopped":
        job.status = "stopped"
        job.last_state = "Continuous worker 중지됨 · checkpoint 보존"
        job.progress = None
    elif runtime.status == "failed":
        job.status = "failed"
        job.last_state = "Continuous worker 실패"
        job.progress = None
    if runtime.status == "running":
        materialize_continuous_batch(db, job, runtime, payload)
    etl_repository.save_kafka_continuous_command(db, job, runtime)


def continuous_worker_status(job: ETLJobModel, runtime: KafkaContinuousRuntimeModel) -> dict[str, Any]:
    try:
        return run_kafka_continuous_worker(job, runtime, "status")
    except ApiError as exc:
        return {"containerState": "unknown", "error": exc.message}


def continuous_heartbeat_is_stale(heartbeat_at: str | None, job: ETLJobModel) -> bool:
    if not heartbeat_at:
        return False
    try:
        heartbeat = datetime.fromisoformat(heartbeat_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    trigger_seconds = int((job.continuous_config or {}).get("triggerIntervalSeconds") or 30)
    timeout_seconds = int(os.environ.get("ASKLAKE_CONTINUOUS_HEARTBEAT_TIMEOUT_SECONDS") or max(90, trigger_seconds * 3))
    return datetime.now(UTC) - heartbeat > timedelta(seconds=timeout_seconds)


def mark_continuous_runtime_failed(job: ETLJobModel, runtime: KafkaContinuousRuntimeModel, message: str) -> None:
    runtime.status = "failed"
    runtime.failed_count += 1
    runtime.last_error = message
    job.status = "failed"
    job.last_state = "Continuous worker 실패"
    job.progress = None


def stop_stale_continuous_worker(job: ETLJobModel, runtime: KafkaContinuousRuntimeModel) -> None:
    try:
        run_kafka_continuous_worker(job, runtime, "stop")
    except ApiError:
        # The runtime is already failed; cleanup must not hide the liveness cause.
        pass


def materialize_continuous_batch(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    report: dict[str, Any],
) -> None:
    batch_id = optional_string(report.get("lastBatchId"))
    if not batch_id or not bool(report.get("lastBatchWritten")):
        return
    run_id = f"continuous:{job.id}:batch:{batch_id}"
    existing = etl_repository.get_dataset_by_id(db, job.dataset_id or f"ds_{normalize_column_name(job.target)}")
    existing_runs = (existing.payload or {}).get("materializationRuns") if existing and existing.payload else []
    if any(str(item.get("runId") or "") == run_id for item in existing_runs if isinstance(item, dict)):
        return
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    output_path = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}/_batches"
    result = {
        "endedAt": runtime.last_flush_at or runtime.heartbeat_at or iso_now(),
        "outputPath": output_path,
        "outputRows": int(report.get("lastBatchStoredCount") or 0),
        "runId": run_id,
        "sourceKind": "kafka_continuous",
        "status": "success",
    }
    try:
        dataset = dataset_from_spark_result(job, result, existing)
        etl_repository.save_dataset(db, dataset)
    except Exception as exc:  # Catalog metadata must not roll back a committed streaming checkpoint.
        runtime.last_error = f"Catalog materialization pending retry: {compact_storage_text(str(exc), limit=500)}"
    else:
        job.stats = {
            **(job.stats or {}),
            "inputRows": format_rows(runtime.consumed_count),
            "lastSuccess": runtime.last_flush_at or runtime.heartbeat_at or "-",
            "outputPath": output_path,
            "outputRows": format_rows(runtime.stored_count),
            "sampleScope": f"{runtime.topic} continuous micro-batch",
            "sourceUnits": "Kafka topic",
            "successRate": "100%" if runtime.failed_count == 0 else "확인 필요",
        }


def continuous_runtime_report_path(job_id: str) -> Path:
    safe_job_id = re.sub(r"[^a-z0-9_.-]+", "-", job_id.lower()).strip("-") or "job"
    report_dir = Path(os.environ.get("ASKLAKE_SPARK_REPORT_DIR") or BACKEND_DIR / "tmp" / "spark-runs")
    return report_dir / f"kafka-continuous-{safe_job_id}.json"


def optional_string(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def nonnegative_int(value: Any, fallback: int) -> int:
    parsed = optional_int(value)
    return parsed if parsed is not None and parsed >= 0 else fallback


def validate_create_request(request: CreatePipelineRequest) -> None:
    missing = []
    if not request.job_name:
        missing.append("jobName")
    if not request.source_type:
        missing.append("sourceType")
    if not request.source_label:
        missing.append("sourceLabel")
    if not request.target_dataset:
        missing.append("targetDataset")
    if not request.target_layer:
        missing.append("targetLayer")
    if not request.owner:
        missing.append("owner")
    if request.execution_mode == "continuous":
        if "kafka" not in request.source_type.lower():
            missing.append("continuousKafkaSource")
        if request.target_format.lower() != "parquet":
            missing.append("continuousTargetFormat=parquet")
        if any(step.enabled for step in request.transform_steps) or any(rule.enabled for rule in request.quality_rules):
            missing.append("continuousTransformAndQualityRules=unsupported")
    if not request.schema_columns:
        missing.append("schemaColumns")
    elif not any(column.included and column.target_name.strip() for column in request.schema_columns):
        missing.append("schemaColumns[included]")
    if missing:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            f"Missing required fields: {', '.join(missing)}",
            status.HTTP_400_BAD_REQUEST,
        )


def validate_update_request(request: UpdatePipelineRequest) -> None:
    missing = []
    if not request.job_name:
        missing.append("jobName")
    if not request.target_dataset:
        missing.append("targetDataset")
    if not request.target_layer:
        missing.append("targetLayer")
    if not request.owner:
        missing.append("owner")
    if not request.schema_columns:
        missing.append("schemaColumns")
    elif not any(column.included and column.target_name.strip() for column in request.schema_columns):
        missing.append("schemaColumns[included]")
    if missing:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            f"Missing required fields: {', '.join(missing)}",
            status.HTTP_400_BAD_REQUEST,
        )


def target_identity_changed(job: ETLJobModel, request: UpdatePipelineRequest) -> bool:
    return any((
        str(job.target or "") != request.target_dataset,
        str(job.target_layer or "") != request.target_layer,
        str(job.target_format or "") != request.target_format,
        str(job.target_database or "asklake") != str(request.target_database or "asklake"),
        str(job.storage_type or "") != str(request.storage_type or ""),
        str(job.storage_path or "") != str(request.storage_path or ""),
    ))


def has_successful_run(db: Session, job_id: str) -> bool:
    return any(run.status == "success" for run in etl_repository.list_runs_for_job(db, job_id))


def apply_update_request(job: ETLJobModel, request: UpdatePipelineRequest, target_changed: bool) -> None:
    job.name = request.job_name
    job.owner = request.owner
    job.target = request.target_dataset
    job.schedule = request.schedule_label
    job.schedule_policy = schedule_policy_from_request(request)
    job.schedule_summary = request.schedule_summary
    job.retry_policy = request.retry_policy.model_dump(mode="json", by_alias=True) if request.retry_policy else None
    job.retry_policy_summary = request.retry_policy_summary
    job.run_limit_summary = request.run_limit_summary
    job.schema_columns = [column.model_dump(mode="json", by_alias=True) for column in request.schema_columns]
    job.schema_fingerprint = request.schema_fingerprint
    job.schema_sample_rows = request.schema_sample_rows
    job.schema_summary = request.schema_summary
    job.rule_summary = request.rule_summary
    job.permission_summary = request.permission_summary
    job.permission_roles = request.permission_roles
    job.storage_type = request.storage_type
    job.partition = request.partition
    job.partition_columns = normalize_string_list(request.partition_columns)
    job.index_columns = normalize_string_list(request.index_columns)
    job.compression = request.compression
    job.storage_path = request.storage_path
    job.target_path = request.storage_path
    job.target_database = normalize_optional_text(request.target_database)
    job.target_description = normalize_optional_text(request.target_description)
    job.target_tags = normalize_target_tags(request.target_tags)
    job.target_format = request.target_format
    job.target_layer = request.target_layer
    job.rag = request.rag
    job.transform_output_columns = tuple_rows_to_lists(request.transform_output_columns)
    job.transform_steps = [step.model_dump(mode="json", by_alias=True) for step in request.transform_steps]
    job.quality_invalid_rows = request.quality_invalid_rows
    job.quality_rules = [rule.model_dump(mode="json", by_alias=True) for rule in request.quality_rules]
    job.quality_score = request.quality_score
    job.quality_status = request.quality_status
    job.last_state = "설정 수정됨"
    job.next_run = schedule_next_run_label(request.schedule_label, request.next_run_utc or job.next_run)
    job.stats = {
        **(job.stats or {}),
        "currentStage": "설정 수정됨",
        "schemaColumns": f"{len(dataset_schema_from_request(request)):,}개",
    }
    if target_changed:
        job.dataset_id = f"ds_{normalize_column_name(request.target_dataset)}"


def schedule_next_run_label(schedule_label: str | None, fallback: str | None = None) -> str:
    schedule = str(schedule_label or "").strip()
    fallback_label = str(fallback or "").strip()
    if not schedule or not has_scheduled_label(schedule):
        return "-"
    if "1회" in schedule or "예약" in schedule:
        return fallback_label if fallback_label and fallback_label != "-" else re.sub(r"\s*(예약\s*)?1회 실행\s*$", "", schedule).strip()
    return fallback_label if fallback_label and fallback_label != "-" else schedule


def has_scheduled_label(schedule_label: str | None) -> bool:
    schedule = str(schedule_label or "").strip().lower()
    if not schedule or schedule == "-":
        return False
    return not any(token in schedule for token in ["manual", "수동", "스케줄 없음", "건너뛰기"])


def schedule_policy_from_request(request: CreatePipelineRequest | UpdatePipelineRequest) -> dict[str, Any]:
    watermark_policy = request.watermark_policy
    if hasattr(watermark_policy, "model_dump"):
        watermark_policy = watermark_policy.model_dump(mode="json", by_alias=True)
    return {
        "endDate": request.end_date,
        "nextRunUtc": request.next_run_utc,
        "overlapPolicy": request.overlap_policy or ("skip_if_running" if has_scheduled_label(request.schedule_label) else None),
        "startDate": request.start_date,
        "timezone": request.timezone,
        "watermarkPolicy": watermark_policy,
    }


def has_scheduled_execution(job: ETLJobModel) -> bool:
    return job.status != "stopped" and has_scheduled_label(job.schedule)


def should_run_scheduled_job(job: ETLJobModel, request: ScheduledJobRunRequest) -> tuple[bool, str]:
    if request.kafka_only and not is_kafka_job(job):
        return False, "not_kafka_job"
    if job.status == "stopped":
        return False, "stopped"
    if job.status == "running":
        return False, "already_running"
    if request.force:
        return True, "forced"
    if not has_scheduled_execution(job):
        return False, "not_scheduled"

    next_run_utc = ""
    if isinstance(job.schedule_policy, dict):
        next_run_utc = str(job.schedule_policy.get("nextRunUtc") or "")
    if not next_run_utc:
        return False, "next_run_not_set"

    try:
        next_run_at = datetime.fromisoformat(next_run_utc.replace("Z", "+00:00"))
    except ValueError:
        return False, "invalid_next_run"

    if next_run_at <= datetime.now(UTC):
        return True, "due"
    return False, "not_due"


def advance_scheduled_job_after_tick(db: Session, job_id: str) -> None:
    job = etl_repository.get_job(db, job_id)
    if job is None or not isinstance(job.schedule_policy, dict):
        return

    next_run_utc = next_scheduled_run_utc(job)
    if not next_run_utc:
        return

    job.schedule_policy = {
        **job.schedule_policy,
        "nextRunUtc": next_run_utc,
    }
    job.next_run = next_run_utc
    etl_repository.save_job(db, job)


def next_scheduled_run_utc(job: ETLJobModel) -> str:
    schedule = str(job.schedule or "")
    current = ""
    if isinstance(job.schedule_policy, dict):
        current = str(job.schedule_policy.get("nextRunUtc") or "")
    try:
        base = datetime.fromisoformat(current.replace("Z", "+00:00")) if current else datetime.now(UTC)
    except ValueError:
        base = datetime.now(UTC)

    now = datetime.now(UTC)
    if schedule.startswith("매시간"):
        minute_match = re.search(r"매시간\s+(\d{1,2})분", schedule)
        minute = max(0, min(59, int(minute_match.group(1)) if minute_match else base.minute))
        candidate = base.replace(minute=minute, second=0, microsecond=0)
        while candidate <= now:
            candidate += timedelta(hours=1)
        return candidate.isoformat().replace("+00:00", "Z")

    if schedule.startswith("매일"):
        time_match = re.search(r"매일\s+(\d{1,2}):(\d{2})", schedule)
        hour = max(0, min(23, int(time_match.group(1)) if time_match else base.hour))
        minute = max(0, min(59, int(time_match.group(2)) if time_match else base.minute))
        candidate = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
        while candidate <= now:
            candidate += timedelta(days=1)
        return candidate.isoformat().replace("+00:00", "Z")

    if schedule.startswith("매주"):
        candidate = base.replace(second=0, microsecond=0)
        while candidate <= now:
            candidate += timedelta(days=7)
        return candidate.isoformat().replace("+00:00", "Z")

    return ""


def apply_job_command(job: ETLJobModel, command: str) -> None:
    if command in {"run", "retry"}:
        now = iso_now()
        job.last_run = now
        job.last_state = "Spark 재실행 중" if command == "retry" else "Spark 실행 중"
        job.next_run = "-"
        job.progress = {"label": "Spark ETL 실행 중", "value": 66}
        job.status = "running"
        return
    if command == "pause":
        job.last_state = "사용자 일시정지"
        job.next_run = "재개 대기"
        job.progress = job.progress or {"label": "일시정지됨", "value": 50}
        job.status = "paused"
        return
    if command == "stopSchedule":
        job.last_state = "스케줄 중지됨"
        job.next_run = "-"
        job.progress = None
        job.schedule = "스케줄링 건너뛰기"
        job.schedule_policy = {
            "endDate": None,
            "nextRunUtc": "",
            "overlapPolicy": None,
            "startDate": "",
            "timezone": "",
            "watermarkPolicy": {
                "column": "updated_at",
                "enabled": False,
                "lookbackMinutes": 0,
                "mode": "full_refresh",
            },
        }
        job.schedule_summary = "스케줄링 건너뛰기 · 나중에 목록에서 직접 실행"
        job.status = "stopped"
        return

    job.last_run = "방금 취소"
    job.last_state = "취소됨"
    job.next_run = schedule_next_run_label(job.schedule, job.next_run)
    job.progress = None
    job.status = "canceled"


def run_from_command(job: ETLJobModel, command: str) -> ETLRunModel:
    now = iso_now()
    run_id = stable_id("run", f"{job.id}:{command}:{now}")
    input_rows = job.stats.get("inputRows") or job.stats.get("input_rows") or "0"
    if command == "cancelRun":
        return ETLRunModel(
            run_id=run_id,
            job_id=job.id,
            status="canceled",
            started_at=now,
            ended_at=now,
            duration="-",
            input_rows=input_rows,
            output_rows="0",
            output_path=None,
            failed_stage="실행 취소",
            error_summary="사용자 취소",
        )
    return ETLRunModel(
        run_id=run_id,
        job_id=job.id,
        status="running",
        started_at=now,
        ended_at="-",
        duration="실행 중",
        input_rows=input_rows,
        output_rows="0",
        output_path="-",
        failed_stage="-",
        error_summary="-",
    )


def source_metrics_from_request(request: CreatePipelineRequest, schema: list[tuple[str, str]], sample_rows: list[list[str]]) -> dict[str, Any]:
    sample_rows_count = len(sample_rows)
    schema_columns = len(schema)
    row_limit = parse_positive_integer(field_value(request.source_config, "__Sample Row Limit"))
    requested_bytes = parse_positive_integer(field_value(request.source_config, "__Sample Requested Bytes"))
    source_units = parse_positive_integer(field_value(request.source_config, "__Source Unit Count"))
    sample_scope = field_value(request.source_config, "__Schema Sample Scope Label") or "현재 샘플"
    unit_label = source_unit_label(request.source_type)
    row_label = "문서" if request.source_type == "MongoDB" else "행"
    dataset_rows = (
        f"샘플 {sample_rows_count:,}{row_label}"
        if sample_rows_count > 0
        else f"{source_units:,}개 {unit_label} 감지"
        if source_units > 0
        else "샘플 없음"
    )
    dataset_size = (
        format_bytes(requested_bytes)
        if requested_bytes > 0
        else f"최대 {row_limit:,}{row_label} 샘플"
        if row_limit > 0
        else f"{source_units:,}개 {unit_label}"
        if source_units > 0
        else "확인 대기"
    )
    return {
        "dataset_rows": dataset_rows,
        "dataset_size": dataset_size,
        "row_label": row_label,
        "sample_rows": sample_rows_count,
        "sample_scope": sample_scope,
        "schema_columns": schema_columns,
        "source_units": source_units,
        "unit_label": unit_label,
    }


def initial_job_stats(metrics: dict[str, Any]) -> dict[str, str]:
    return {
        "averageDuration": "-",
        "currentStage": "생성 완료 · 실행 전",
        "inputRows": f"{metrics['sample_rows']:,} 샘플 {metrics['row_label']}" if metrics["sample_rows"] > 0 else "-",
        "lastSuccess": "-",
        "outputRows": "0",
        "sampleScope": metrics["sample_scope"],
        "schemaColumns": f"{metrics['schema_columns']:,}개",
        "sourceUnits": f"{metrics['source_units']:,}개 {metrics['unit_label']}" if metrics["source_units"] > 0 else "-",
        "successRate": "-",
        "totalRuns": "0회",
    }


def initial_dag_steps(request: CreatePipelineRequest, metrics: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {"id": "source", "meta": f"{request.source_type} / {request.source_label}", "status": "success", "title": "1. 소스 연결"},
        {"id": "schema", "meta": f"{metrics['schema_columns']:,}개 컬럼 · {metrics['sample_scope']}", "status": "success" if metrics["schema_columns"] > 0 else "pending", "title": "2. 스키마 추론"},
        {"id": "create", "meta": request.target_dataset, "status": "success", "title": "3. Job 생성"},
        {"id": "transform", "meta": f"{len(request.transform_steps)}개 규칙", "status": "pending", "title": "4. 처리 규칙 대기"},
        {"id": "quality", "meta": f"{len(request.quality_rules)}개 검사", "status": "pending", "title": "5. 품질 검증 대기"},
        {"id": "run", "meta": "아직 실행되지 않음", "status": "pending", "title": "6. 실행 대기"},
    ]


def dag_steps_from_command(job: ETLJobModel, command: str, run: dict[str, Any]) -> list[dict[str, str]]:
    if command == "cancelRun":
        return [
            {"id": "source", "meta": job.source, "status": "blocked", "title": "1. 소스 연결"},
            {"id": "schema", "meta": job.stats.get("schemaColumns", "-"), "status": "blocked", "title": "2. 스키마 확인"},
            {"id": "read", "meta": run.get("inputRows", "0"), "status": "blocked", "title": "3. 소스 읽기"},
            {"id": "transform", "meta": f"{len(job.transform_steps)}개 규칙", "status": "blocked", "title": "4. 처리 규칙"},
            {"id": "quality", "meta": f"{len(job.quality_rules)}개 검사", "status": "pending", "title": "5. 품질 검증"},
            {"id": "target", "meta": job.target, "status": "pending", "title": "6. Lake 적재"},
        ]
    return [
        {"id": "source", "meta": job.source, "status": "success", "title": "1. 소스 연결"},
        {"id": "schema", "meta": job.stats.get("schemaColumns", "-"), "status": "success", "title": "2. 스키마 확인"},
        {"id": "read", "meta": run.get("inputRows", "0"), "status": "running", "title": "3. Spark 소스 읽기"},
        {"id": "transform", "meta": f"{len(job.transform_steps)}개 규칙", "status": "pending", "title": "4. 처리 규칙 적용"},
        {"id": "quality", "meta": f"{len(job.quality_rules)}개 검사", "status": "pending", "title": "5. 품질 검증"},
        {"id": "write", "meta": run.get("outputPath", "-"), "status": "pending", "title": "6. Parquet 적재"},
        {"id": "catalog", "meta": job.target, "status": "pending", "title": "7. 카탈로그 데이터셋 갱신"},
    ]


def stats_from_runs(job: ETLJobModel, runs: list[Any]) -> dict[str, Any]:
    total_runs = len(runs)
    success_runs = len([run for run in runs if run.status == "success"])
    latest_run = runs[0] if runs else None
    return {
        **(job.stats or {}),
        "averageDuration": latest_run.duration if latest_run else "-",
        "currentStage": job.last_state,
        "lastSuccess": next((run.ended_at for run in runs if run.status == "success"), "-"),
        "outputPath": latest_run.output_path if latest_run else job.stats.get("outputPath", "-"),
        "outputRows": latest_run.output_rows if latest_run else job.stats.get("outputRows", "0"),
        "successRate": f"{round((success_runs / total_runs) * 100)}%" if total_runs else "-",
        "totalRuns": f"{total_runs:,}회",
    }


def dataset_schema_from_request(request: CreatePipelineRequest | UpdatePipelineRequest) -> list[tuple[str, str]]:
    if request.transform_output_columns:
        return [(name, type_ or "string") for name, type_ in request.transform_output_columns if name]
    return [
        (column.target_name, (column.type or "string").lower())
        for column in request.schema_columns
        if column.included and column.target_name.strip()
    ]


def dataset_sample_rows_from_request(request: CreatePipelineRequest, schema: list[tuple[str, str]]) -> list[list[str]]:
    if not request.schema_sample_rows:
        return []
    columns = [(column, index) for index, column in enumerate(request.schema_columns) if column.included and column.target_name.strip()]
    source_index_by_output_name = {
        name: index
        for column, index in columns
        for name in [column.target_name, column.source_name]
        if name
    }
    if not columns:
        return [[str(row[index] if index < len(row) else "-") for index, _ in enumerate(schema)] for row in request.schema_sample_rows]
    return [
        [str(row[source_index_by_output_name[name]] if name in source_index_by_output_name and source_index_by_output_name[name] < len(row) else "") for name, _ in schema]
        for row in request.schema_sample_rows
    ]


def quality_summary_from_request(request: CreatePipelineRequest) -> str:
    if request.quality_score is not None:
        return f"품질 점수 {request.quality_score:.1f}% · 상태 {quality_status_label(request.quality_status)}"
    return request.rule_summary or "확인 대기"


def quality_status_label(status_value: str | None) -> str:
    return {"pass": "통과", "warn": "주의", "fail": "실패"}.get(str(status_value or "checked").lower(), "확인됨")


def field_value(fields: list[tuple[str, str]], label: str) -> str:
    for field_label, value in fields:
        if field_label == label:
            return str(value).strip()
    return ""


def kafka_field_value(fields: list[tuple[str, str]], *labels: str) -> str:
    for label in labels:
        value = field_value(fields, label)
        if value:
            return value
    return ""


def continuous_config_from_request(request: CreatePipelineRequest, job_id: str) -> dict[str, Any] | None:
    if request.execution_mode != "continuous":
        return None
    config = request.continuous_config
    base_path = (request.storage_path or f"s3a://asklake-output/{normalize_column_name(request.target_dataset)}/").rstrip("/")
    return {
        "initialOffsetPolicy": config.initial_offset_policy if config else "earliest",
        "triggerIntervalSeconds": config.trigger_interval_seconds if config else 30,
        "maxOffsetsPerTrigger": config.max_offsets_per_trigger if config else 10000,
        "checkpointPath": f"{base_path}/_checkpoints/{job_id}",
    }


def continuous_runtime_from_job(job: ETLJobModel) -> KafkaContinuousRuntimeModel:
    fields = job.source_config or []
    broker = kafka_field_value(fields, "Broker / Endpoint", "BROKER / ENDPOINT") or "127.0.0.1:19092"
    topic = kafka_field_value(fields, "TOPIC / QUEUE NAME", "Topic") or "reviews.raw"
    consumer_group_id = kafka_field_value(fields, "Consumer Group ID", "CONSUMER GROUP ID") or f"asklake-stream-{job.id.lower()}"
    config = job.continuous_config or {}
    checkpoint_path = str(config.get("checkpointPath") or f"s3a://asklake-output/{normalize_column_name(job.target)}/_checkpoints/{job.id}")
    return KafkaContinuousRuntimeModel(
        job_id=job.id,
        broker=broker,
        topic=topic,
        consumer_group_id=consumer_group_id,
        target_identity=str(job.storage_path or job.target_path or job.target),
        checkpoint_path=checkpoint_path,
        status="stopped",
    )


def source_unit_label(source_type: str) -> str:
    if source_type == "MongoDB":
        return "컬렉션"
    if source_type == "PostgreSQL":
        return "테이블"
    if source_type in ("Stream / Kafka", "Kafka JSON"):
        return "파티션"
    return "오브젝트"


def make_job_id(value: str) -> str:
    return f"JOB-{stable_id('job', f'{value}:{iso_now()}')[-8:].upper()}"


def stable_id(prefix: str, value: str) -> str:
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def normalize_column_name(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_]+", "_", value.strip().lower())
    normalized = re.sub(r"_+", "_", normalized).strip("_")
    return normalized or "dataset"


def fallback_lineage_graph(dataset: CatalogDatasetModel) -> dict[str, Any]:
    current_node = lineage_node(dataset.id, dataset.name, dataset.layer, dataset.schema_json or [], "ICEBERG")
    upstream_nodes = [
        lineage_node(
            normalize_lineage_id(f"{dataset.id}-{item}"),
            item,
            "SOURCE" if index == 0 else "BRONZE",
            dataset.schema_json or [],
            "SOURCE" if index == 0 else "ICEBERG",
        )
        for index, item in enumerate(dataset.upstream or [])
    ]
    edges = []
    for upstream_node in upstream_nodes:
        for source_column, target_column in zip(upstream_node["columns"], current_node["columns"], strict=False):
            edges.append({
                "fromColumnId": source_column["id"],
                "fromDatasetId": upstream_node["id"],
                "toColumnId": target_column["id"],
                "toDatasetId": current_node["id"],
            })
    return {
        "datasetId": dataset.id,
        "datasets": [*upstream_nodes, current_node],
        "edges": edges,
    }


def lineage_node(dataset_id: str, name: str, layer: str, schema: list[list[str]], engine: str) -> dict[str, Any]:
    return {
        "columns": [
            {
                "id": normalize_lineage_id(f"{dataset_id}-{column_name}"),
                "name": str(column_name),
                "type": str(column_type or "string"),
            }
            for column_name, column_type in schema
            if column_name
        ],
        "engine": engine,
        "id": dataset_id,
        "layer": layer,
        "name": name,
    }


def normalize_lineage_id(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    return normalized.strip("-") or "lineage"


def tuple_rows_to_lists(rows: list[tuple[str, str]]) -> list[list[str]]:
    return [[str(key), str(value)] for key, value in rows]


def normalize_string_list(values: list[str] | None) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for value in values or []:
        item = str(value).strip()
        if not item or item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return normalized


def normalize_target_tags(values: list[str] | None) -> list[str]:
    normalized = []
    for value in normalize_string_list(values):
        normalized.append(value if value.startswith("#") else f"#{value}")
    return normalized


def normalize_optional_text(value: str | None) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def target_dataset_description(job: ETLJobModel) -> str:
    return (
        normalize_optional_text(job.target_description)
        or f"{job.source_type} 소스 {job.source_label} 실행 결과 데이터셋"
    )


def target_dataset_tags(job: ETLJobModel) -> list[str]:
    return normalize_target_tags(job.target_tags) or ["#생성", f"#{str(job.target_layer).lower()}"]


def parse_positive_integer(value: str) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 0
    return parsed if parsed > 0 else 0


def format_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(value)
    unit = 0
    while size >= 1024 and unit < len(units) - 1:
        size /= 1024
        unit += 1
    return f"{size:.1f} {units[unit]}" if unit > 0 else f"{int(size)} {units[unit]}"


def format_rows(value: Any) -> str:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return str(value or "0")
    return f"{parsed:,}\ud589"


def format_duration_ms(value: Any) -> str:
    try:
        ms = int(float(value))
    except (TypeError, ValueError):
        return "-"
    if ms < 1000:
        return f"{ms}ms"
    seconds = round(ms / 1000)
    if seconds < 60:
        return f"{seconds}\ucd08"
    minutes, rest = divmod(seconds, 60)
    return f"{minutes}\ubd84 {rest}\ucd08"


def format_iso_duration(started_at: str, ended_at: str) -> str:
    try:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        end = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
    except ValueError:
        return "-"
    return format_duration_ms(max(0, int((end - start).total_seconds() * 1000)))


def iso_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
