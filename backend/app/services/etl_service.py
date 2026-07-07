from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel
from app.repositories import etl_repository
from app.schemas.common import ErrorCode
from app.schemas.etl import (
    CatalogDataset,
    CreatePipelineRequest,
    CreatePipelineResponse,
    JobCommandResponse,
    JobDagStep,
    JobRowData,
    QueryRunRequest,
    QueryRunResponse,
    SchemaDraft,
    SourceConnectorAnalysis,
    SourceConnectorRequest,
)

BACKEND_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = BACKEND_DIR / "scripts"


def create_pipeline(db: Session, request: CreatePipelineRequest) -> CreatePipelineResponse:
    validate_create_request(request)
    dataset_id = f"ds_{normalize_column_name(request.target_dataset)}"

    if (
        etl_repository.get_dataset_by_id(db, dataset_id)
        or etl_repository.get_dataset_by_name(db, request.target_dataset)
        or etl_repository.get_job_by_dataset_id(db, dataset_id)
        or etl_repository.get_job_by_target(db, request.target_dataset)
    ):
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Dataset already exists or is pending run: {request.target_dataset}",
            status.HTTP_409_CONFLICT,
        )

    dataset_schema = dataset_schema_from_request(request)
    sample_rows = dataset_sample_rows_from_request(request, dataset_schema)
    metrics = source_metrics_from_request(request, dataset_schema, sample_rows)
    job_id = make_job_id(request.id or request.job_name)
    dag_steps = initial_dag_steps(request, metrics)
    stats = initial_job_stats(metrics)

    job = ETLJobModel(
        id=job_id,
        name=request.job_name,
        owner=request.owner,
        status="scheduled",
        tag="[생성]",
        source=f"{request.source_type} / {request.source_label}",
        target=request.target_dataset,
        schedule=request.schedule_label,
        source_config=tuple_rows_to_lists(request.source_config),
        source_label=request.source_label,
        source_type=request.source_type,
        schema_columns=[column.model_dump(mode="json", by_alias=True) for column in request.schema_columns],
        schema_fingerprint=request.schema_fingerprint,
        schema_sample_rows=request.schema_sample_rows,
        permission_roles=request.permission_roles,
        storage_type=request.storage_type,
        partition=request.partition,
        compression=request.compression,
        storage_path=request.storage_path,
        target_format=request.target_format,
        target_layer=request.target_layer,
        rag=request.rag,
        transform_output_columns=tuple_rows_to_lists(request.transform_output_columns),
        transform_steps=[step.model_dump(mode="json", by_alias=True) for step in request.transform_steps],
        quality_invalid_rows=request.quality_invalid_rows,
        quality_rules=[rule.model_dump(mode="json", by_alias=True) for rule in request.quality_rules],
        quality_score=request.quality_score,
        quality_status=request.quality_status,
        last_run="생성 후 미실행",
        last_state=f"{metrics['schema_columns']}개 컬럼 추론 완료",
        next_run="-" if request.schedule_label == "manual" else request.schedule_label,
        progress=None,
        stats=stats,
        dag_steps=dag_steps,
        dataset_id=dataset_id,
    )

    saved_job = etl_repository.create_job(db, job)
    return CreatePipelineResponse(
        catalog_target={
            "id": dataset_id,
            "layer": request.target_layer,
            "name": request.target_dataset,
            "status": "pending_run",
        },
        job=saved_job,
    )


def list_jobs(db: Session) -> list[JobRowData]:
    return etl_repository.list_jobs(db)


def get_job(db: Session, job_id: str) -> JobRowData:
    job = etl_repository.get_job_schema(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    return job


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


def command_job(db: Session, job_id: str, command: str) -> JobCommandResponse:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)

    if command not in {"run", "retry", "pause", "cancel"}:
        raise ApiError(ErrorCode.VALIDATION_ERROR, f"Unsupported job command: {command}", status.HTTP_400_BAD_REQUEST)
    if command == "run" and job.status == "running":
        raise ApiError(ErrorCode.CONFLICT, f"Job is already running: {job_id}", status.HTTP_409_CONFLICT)
    if command == "cancel" and job.status not in {"running", "scheduled", "paused"}:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            f"Job cannot be canceled from status: {job.status}",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    action_by_command = {
        "cancel": "etl.run.cancel_requested",
        "pause": "etl.job.pause_requested",
        "retry": "etl.run.retry_requested",
        "run": "etl.run.requested",
    }

    run_schema = None
    dataset_schema = None
    run_model = None
    dataset_model = None
    if command in {"run", "retry"}:
        apply_job_command(job, command)
        spark_result = run_spark_job(job, command, stable_id("run", f"{job.id}:{command}:{iso_now()}"))
        run_model = run_from_spark_result(job, spark_result)
        run_schema = etl_repository.run_to_schema(run_model)
        finalize_job_from_spark_result(job, command, spark_result)
        job.dag_steps = dag_steps_from_spark_result(job, command, run_schema.model_dump(by_alias=True), spark_result)
        job.dag_steps_by_run_id = {**(job.dag_steps_by_run_id or {}), run_schema.run_id: job.dag_steps}
        job.stats = stats_from_runs(job, [run_schema, *etl_repository.list_runs_for_job(db, job.id)])
        if spark_result.get("status") == "success":
            dataset_model = dataset_from_spark_result(job, spark_result)
    elif command == "cancel":
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

    return JobCommandResponse(
        action=action_by_command[command],
        api_path=f"/api/etl/jobs/{job_id}/commands",
        dataset=dataset_schema,
        job=saved_job,
        run=run_schema,
        dag_steps=[JobDagStep(**step) for step in job.dag_steps] if job.dag_steps else None,
    )


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


def infer_schema(request: SourceConnectorRequest) -> SchemaDraft:
    analysis = test_source_connector(request)
    if analysis.draft_patch.schema_ is None:
        return SchemaDraft(columns=[], sample_rows=[], summary="스키마 없음")
    return analysis.draft_patch.schema_


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
        "targetFormat": job.target_format,
        "targetLayer": job.target_layer,
        "targetPath": job.target_path,
        "transformOutputColumns": job.transform_output_columns or [],
        "transformSteps": job.transform_steps or [],
    }


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
        failed_stage="-" if success else str(result.get("failedStage") or "Spark ETL"),
        error_summary="-" if success else str(result.get("error") or "Spark job failed."),
    )


def finalize_job_from_spark_result(job: ETLJobModel, command: str, result: dict[str, Any]) -> None:
    success = result.get("status") == "success"
    job.last_run = str(result.get("endedAt") or iso_now())
    job.last_state = (
        f"{'재실행' if command == 'retry' else '실행'} 완료 · Spark Parquet 적재"
        if success
        else f"Spark 실행 실패 · {result.get('error') or '원인 확인 필요'}"
    )
    job.next_run = "-" if job.schedule in {"수동 실행", "manual"} else job.schedule
    job.progress = None
    job.status = "scheduled" if success else "failed"
    job.target_path = result.get("outputPath") or job.target_path


def dataset_from_spark_result(job: ETLJobModel, result: dict[str, Any]) -> CatalogDatasetModel:
    now = str(result.get("endedAt") or iso_now())
    schema = result.get("schema")
    schema_json = [
        [str(field.get("name") or "-"), str(field.get("type") or "string")]
        for field in schema
    ] if isinstance(schema, list) and schema else schema_from_job(job)
    dataset_id = f"ds_{normalize_column_name(job.target)}"
    dataset_payload = dataset_payload_from_spark_result(job, result, dataset_id, schema_json, now)
    storage_size_bytes = int(dataset_payload.get("storageSizeBytes") or 0)
    display_size = format_storage_size(storage_size_bytes) if storage_size_bytes > 0 else "Pending"
    return CatalogDatasetModel(
        id=dataset_id,
        payload=dataset_payload,
        name=job.target,
        description=f"{job.source_type} 소스 {job.source_label} 실행 결과 데이터셋",
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
        tags=["#생성", f"#{str(job.target_layer).lower()}"],
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
) -> dict[str, Any]:
    output_path = str(result.get("outputPath") or "-")
    storage_size_bytes = dataset_storage_size_bytes(output_path)
    display_size = format_storage_size(storage_size_bytes) if storage_size_bytes > 0 else "Pending"
    lineage_graph = etl_dataset_lineage_graph(job, dataset_id, schema_json)
    return {
        "description": f"{job.source_type} 소스 {job.source_label} 실행 결과 데이터셋",
        "downstream": ["SQL 분석", "RAG 인덱싱"] if job.rag else ["SQL 분석"],
        "freshness": "latest",
        "id": dataset_id,
        "layer": job.target_layer,
        "lastUpdated": last_updated,
        "lineageGraph": lineage_graph,
        "name": job.target,
        "nextRefresh": job.schedule,
        "owner": job.owner,
        "quality": quality_summary_from_spark_result(job, result),
        "rag": job.rag,
        "rows": format_rows(result.get("outputRows")),
        "sampleRows": job.schema_sample_rows or [],
        "schema": schema_json,
        "size": display_size,
        "source": job.name,
        "sourceRunId": result.get("runId"),
        "status": "available",
        "storageFormat": "parquet",
        "storageLocation": output_path,
        "storageSizeBytes": storage_size_bytes,
        "tags": ["#생성", f"#{str(job.target_layer).lower()}"],
        "upstream": [job.source_label, job.name],
    }


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


def dag_step(id_: str, title: str, meta: str, status_value: str, details: list[list[str]] | None = None, logs: list[str] | None = None) -> dict[str, Any]:
    return {
        "details": details or [],
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
            {"stderr": stderr[-4000:], "stdout": stdout[-4000:]},
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

    job.last_run = "방금 취소"
    job.last_state = "취소됨"
    job.next_run = "-" if job.schedule in {"수동 실행", "manual"} else job.schedule
    job.progress = None
    job.status = "canceled"


def run_from_command(job: ETLJobModel, command: str) -> ETLRunModel:
    now = iso_now()
    run_id = stable_id("run", f"{job.id}:{command}:{now}")
    input_rows = job.stats.get("inputRows") or job.stats.get("input_rows") or "0"
    if command == "cancel":
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
    if command == "cancel":
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


def dataset_schema_from_request(request: CreatePipelineRequest) -> list[tuple[str, str]]:
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


def iso_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
