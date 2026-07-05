from datetime import UTC, datetime
import hashlib
import re
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
    SchemaColumnDraft,
    SchemaDraft,
    SourceConnectorAnalysis,
    SourceConnectorRequest,
    SourceDraft,
    DraftPipelinePatch,
)


def create_pipeline(db: Session, request: CreatePipelineRequest) -> CreatePipelineResponse:
    validate_create_request(request)
    dataset_id = f"ds_{normalize_column_name(request.target_dataset)}"

    if etl_repository.get_dataset_by_id(db, dataset_id) or etl_repository.get_dataset_by_name(db, request.target_dataset):
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Dataset already exists: {request.target_dataset}",
            status.HTTP_409_CONFLICT,
        )

    now = iso_now()
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
        target_format=request.target_format,
        target_layer=request.target_layer,
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
    dataset = CatalogDatasetModel(
        id=dataset_id,
        name=request.target_dataset,
        description=f"{request.source_type} 소스 {request.source_label}에서 생성된 데이터셋",
        owner=request.owner,
        layer=request.target_layer,
        status="available",
        freshness="latest",
        source=request.job_name,
        rows=metrics["dataset_rows"],
        size=metrics["dataset_size"],
        quality=quality_summary_from_request(request),
        last_updated=now,
        next_refresh=request.schedule_label,
        rag=request.rag,
        tags=["#생성", f"#{request.target_layer.lower()}"],
        schema_json=tuple_rows_to_lists(dataset_schema),
        sample_rows=sample_rows,
        upstream=[request.source_label, request.job_name],
        downstream=["SQL 분석", "RAG 인덱싱"] if request.rag else ["SQL 분석"],
    )

    saved_job, saved_dataset = etl_repository.create_job_and_dataset(db, job, dataset)
    return CreatePipelineResponse(job=saved_job, dataset=saved_dataset)


def list_jobs(db: Session) -> list[JobRowData]:
    return etl_repository.list_jobs(db)


def get_job(db: Session, job_id: str) -> JobRowData:
    job = etl_repository.get_job_schema(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    return job


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
    if command in {"run", "retry", "cancel"}:
        run_model = run_from_command(job, command)
        run_schema = etl_repository.create_run(db, run_model)

    apply_job_command(job, command)
    if run_schema is not None:
        job.dag_steps = dag_steps_from_command(job, command, run_schema.model_dump(by_alias=True))
        job.stats = stats_from_runs(job, etl_repository.list_runs_for_job(db, job.id))
    saved_job = etl_repository.save_job(db, job)

    return JobCommandResponse(
        action=action_by_command[command],
        api_path=f"/api/etl/jobs/{job_id}/commands",
        job=saved_job,
        run=run_schema,
        dag_steps=[JobDagStep(**step) for step in job.dag_steps] if job.dag_steps else None,
    )


def test_source_connector(request: SourceConnectorRequest) -> SourceConnectorAnalysis:
    source_type = "PostgreSQL" if request.source_type == "Database" else request.source_type
    source_label = get_source_label(source_type, request.source_config)
    source_id = stable_id("source", f"{source_type}:{source_label}")
    run_id = stable_id("run", f"{source_id}:{iso_now()}")
    sample = sample_for_source_type(source_type)
    source_config = upsert_fields(request.source_config, [
        ("__Source ID", source_id),
        ("__Run ID", run_id),
        ("__Source Unit Count", str(len(sample["assets"]) or len(sample["preview_rows"]) or 1)),
        ("__Schema Sample Scope", "current"),
        ("__Schema Sample Scope Label", "현재 샘플"),
        ("__Sample Row Limit", str(len(sample["preview_rows"]))),
    ])
    schema_columns = [
        SchemaColumnDraft(source_name=name, target_name=name, type=type_, nullable=False, confidence=90)
        for name, type_ in sample["columns"]
    ]
    schema_fingerprint = "|".join(f"{column.target_name}:{column.type}:required" for column in schema_columns)

    return SourceConnectorAnalysis(
        action_path="/api/etl/sources/test",
        assets=sample["assets"],
        draft_patch=DraftPipelinePatch(
            schema=SchemaDraft(
                columns=schema_columns,
                sample_rows=sample["preview_rows"],
                schema_fingerprint=schema_fingerprint,
                summary=f"{source_label} backend sample에서 {len(schema_columns)}개 필드 추론",
            ),
            source=SourceDraft(
                connection_message=f"{source_type_label(source_type)} 연결 성공: {source_label}",
                connection_status="success",
                source_config=source_config,
                source_label=source_label,
                source_type=source_type,
            ),
        ),
        logs=[
            f"{source_type_label(source_type)} connector 요청 수신",
            f"샘플 소스 식별: {source_label}",
            f"스키마 필드 {len(schema_columns)}개, 샘플 행 {len(sample['preview_rows'])}개 반환",
        ],
        message=f"{source_type_label(source_type)} 연결 성공",
        preview_columns=[name for name, _ in sample["columns"]],
        preview_note="FastAPI 전환 단계의 backend connector sample입니다. 외부 source runtime은 후속 PR에서 확장합니다.",
        preview_rows=sample["preview_rows"],
        status="success",
        test_items=[("Connector", source_type), ("Mode", "FastAPI"), ("Result", "Success")],
    )


def infer_schema(request: SourceConnectorRequest) -> SchemaDraft:
    analysis = test_source_connector(request)
    if analysis.draft_patch.schema_ is None:
        return SchemaDraft(columns=[], sample_rows=[], summary="스키마 없음")
    return analysis.draft_patch.schema_


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
        if column.target_name.strip()
    ]


def dataset_sample_rows_from_request(request: CreatePipelineRequest, schema: list[tuple[str, str]]) -> list[list[str]]:
    if not request.schema_sample_rows:
        return []
    columns = [(column, index) for index, column in enumerate(request.schema_columns) if column.target_name.strip()]
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


def sample_for_source_type(source_type: str) -> dict[str, Any]:
    samples = {
        "PostgreSQL": {
            "assets": [("commerce.orders", "public", "sampled"), ("commerce.customers", "public", "detected")],
            "columns": [("order_id", "string"), ("customer_id", "string"), ("order_date", "timestamp"), ("total_amount", "decimal"), ("status", "string")],
            "preview_rows": [["ORD-1001", "CUS-204", "2026-07-02", "128000", "paid"], ["ORD-1002", "CUS-118", "2026-07-02", "56000", "shipped"]],
        },
        "MongoDB": {
            "assets": [("events", "42,000 documents", "sampled"), ("profiles", "8,400 documents", "detected")],
            "columns": [("_id", "string"), ("user_id", "string"), ("event_name", "string"), ("event_time", "timestamp"), ("payload", "JSON")],
            "preview_rows": [["evt_001", "u_001", "page_view", "2026-07-04T10:00:00Z", "{\"page\":\"/pricing\"}"], ["evt_002", "u_002", "purchase", "2026-07-04T10:03:00Z", "{\"amount\":42000}"]],
        },
        "REST API": {
            "assets": [("REST endpoint", "246 bytes", "HTTP 200")],
            "columns": [("user_id", "string"), ("email", "string"), ("date", "date"), ("status", "string"), ("amount", "decimal")],
            "preview_rows": [["u_001", "demo1@example.com", "2026-07-04", "active", "42.7"], ["u_002", "demo2@example.com", "2026-07-04", "active", "19.25"]],
        },
        "Data Lake": {
            "assets": [("nyc_taxi/yellow_parquet/part-0001.parquet", "128 MB", "listed"), ("nyc_taxi/yellow_parquet/part-0002.parquet", "126 MB", "listed")],
            "columns": [("pickup_at", "timestamp"), ("dropoff_at", "timestamp"), ("passenger_count", "integer"), ("fare_amount", "decimal"), ("payment_type", "string")],
            "preview_rows": [["2026-07-04 09:12:00", "2026-07-04 09:31:00", "2", "18.4", "card"], ["2026-07-04 09:20:00", "2026-07-04 09:44:00", "1", "24.8", "cash"]],
        },
        "Stream / Kafka": {
            "assets": [("asklake-source-events", "3 partitions", "sampled"), ("consumer-group", "asklake-etl-consumer-01", "ready")],
            "columns": [("event_id", "string"), ("user_id", "string"), ("event_time", "timestamp"), ("page_url", "string"), ("raw_payload", "JSON")],
            "preview_rows": [["EVT-881", "CUS-204", "2026-07-04T10:21:00Z", "/pricing", "{\"action\":\"click\"}"], ["EVT-882", "CUS-118", "2026-07-04T10:22:00Z", "/checkout", "{\"action\":\"view\"}"]],
        },
    }
    return samples.get(source_type, {
        "assets": [("nyc_taxi/csv/yellow_tripdata_sample.csv", "24 MB", "listed"), ("nyc_taxi/csv/yellow_tripdata_02.csv", "27 MB", "listed")],
        "columns": [("trip_id", "string"), ("pickup_at", "timestamp"), ("dropoff_at", "timestamp"), ("fare_amount", "decimal"), ("payment_type", "string")],
        "preview_rows": [["trip_001", "2026-07-04 09:12:00", "2026-07-04 09:31:00", "18.4", "card"], ["trip_002", "2026-07-04 09:20:00", "2026-07-04 09:44:00", "24.8", "cash"]],
    })


def get_source_label(source_type: str, fields: list[tuple[str, str]]) -> str:
    labels = {
        "Data Lake": ["Path"],
        "File / S3": ["Bucket / Stage Name", "Path / Prefix"],
        "MongoDB": ["Database Name", "Collection"],
        "PostgreSQL": ["Endpoint / Host", "Database Name", "DATASET OR TABLE SELECTOR"],
        "REST API": ["Endpoint URL"],
        "Stream / Kafka": ["TOPIC / QUEUE NAME", "Broker / Endpoint"],
    }.get(source_type, [])
    values = [field_value(fields, label) for label in labels]
    return " / ".join(value for value in values if value) or source_type


def upsert_fields(fields: list[tuple[str, str]], patches: list[tuple[str, str]]) -> list[tuple[str, str]]:
    next_fields = list(fields)
    for label, value in patches:
        for index, (field_label, _) in enumerate(next_fields):
            if field_label == label:
                next_fields[index] = (label, value)
                break
        else:
            next_fields.append((label, value))
    return next_fields


def field_value(fields: list[tuple[str, str]], label: str) -> str:
    for field_label, value in fields:
        if field_label == label:
            return str(value).strip()
    return ""


def source_type_label(source_type: str) -> str:
    return {"Stream / Kafka": "Kafka"}.get(source_type, source_type)


def source_unit_label(source_type: str) -> str:
    if source_type == "MongoDB":
        return "컬렉션"
    if source_type == "PostgreSQL":
        return "테이블"
    if source_type == "Stream / Kafka":
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


def iso_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
