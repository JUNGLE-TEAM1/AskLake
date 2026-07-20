"""ETL Job identifiers, model projections, and display formatting."""

from datetime import UTC, datetime
import hashlib
import os
import re
from typing import Any
import unicodedata
from uuid import uuid4

from app.application.etl_schedule import job_schedule_kind, schedule_next_run_label
from app.core.config import settings
from app.domain.continuous_runtime import record_runtime_observation
from app.domain.realtime_job_engine import selected_realtime_job_engine
from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel, KafkaContinuousRuntimeModel
from app.schemas.etl import CreatePipelineRequest, UpdatePipelineRequest


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
        job.last_run = iso_now()
        job.last_state = "사용자 일시정지"
        job.next_run = "재개 대기"
        job.progress = job.progress or {"label": "일시정지됨", "value": 50}
        job.status = "paused"
        return
    if command == "stopSchedule":
        if job.status == "running" and job_schedule_kind(job.schedule) == "realtime":
            job.last_run = iso_now()
        job.last_state = "실시간 수집 중지" if job_schedule_kind(job.schedule) == "realtime" else "스케줄 일시중지"
        job.next_run = "-"
        job.progress = None
        job.status = "stopped"
        return
    if command == "resumeSchedule":
        policy_next_run = (job.schedule_policy or {}).get("nextRunUtc")
        job.last_state = "실시간 수집 재개됨" if job_schedule_kind(job.schedule) == "realtime" else "스케줄 재개됨"
        job.next_run = schedule_next_run_label(job.schedule, policy_next_run)
        job.progress = None
        job.status = "scheduled"
        return

    job.last_run = iso_now()
    job.last_state = "취소됨"
    job.next_run = schedule_next_run_label(job.schedule, job.next_run)
    job.progress = None
    job.status = "scheduled"


def run_from_command(job: ETLJobModel, command: str) -> ETLRunModel:
    now = iso_now()
    run_id = stable_id("run", f"{job.id}:{command}:{now}")
    input_rows = job.stats.get("inputRows") or job.stats.get("input_rows") or "0"
    if command in {"cancelRun", "stopSchedule"}:
        realtime_stop = command == "stopSchedule"
        return ETLRunModel(
            run_id=run_id,
            job_id=job.id,
            status="canceled",
            started_at=now,
            ended_at=now,
            duration="수집 중지" if realtime_stop else "-",
            input_rows=input_rows,
            output_rows="0",
            output_path=None,
            failed_stage="실시간 수집 중지" if realtime_stop else "실행 취소",
            error_summary="사용자 요청으로 실시간 수집 중지" if realtime_stop else "사용자 취소",
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
    if command in {"cancelRun", "stopSchedule"}:
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
    base_path = (request.storage_path or f"s3a://asklake-output/{dataset_storage_key(request.target_dataset)}/").rstrip("/")
    return {
        # The deployment profile selects the engine; markerless legacy Jobs remain Spark V1.
        "runtimeEngine": selected_realtime_job_engine(settings),
        "runtimeGeneration": 1,
        "initialOffsetPolicy": config.initial_offset_policy if config else "earliest",
        "triggerIntervalSeconds": config.trigger_interval_seconds if config else 30,
        "maxOffsetsPerTrigger": config.max_offsets_per_trigger if config else 10000,
        "schemaEvolutionPolicy": config.schema_evolution_policy.model_dump(mode="json", by_alias=True) if config else {
            "additiveNullable": "allow",
            "missingRequired": "quarantine",
            "incompatibleType": "quarantine",
            "unknownField": "preserve",
        },
        "checkpointPath": f"{base_path}/_checkpoints/{job_id}",
    }


def continuous_runtime_from_job(job: ETLJobModel) -> KafkaContinuousRuntimeModel:
    fields = job.source_config or []
    broker = kafka_field_value(fields, "Broker / Endpoint", "BROKER / ENDPOINT") or os.environ.get("ASKLAKE_KAFKA_BROKER") or "127.0.0.1:19092"
    topic = kafka_field_value(fields, "TOPIC / QUEUE NAME", "Topic") or "reviews.raw"
    consumer_group_id = kafka_field_value(fields, "Consumer Group ID", "CONSUMER GROUP ID") or f"asklake-stream-{job.id.lower()}"
    config = job.continuous_config or {}
    checkpoint_path = str(config.get("checkpointPath") or f"s3a://asklake-output/{dataset_storage_key(job.target)}/_checkpoints/{job.id}")
    metrics = record_runtime_observation(
        {"publicationRecoveryPending": False},
        "stopped",
        default_public_status="stopped",
    )
    runtime = KafkaContinuousRuntimeModel(
        job_id=job.id,
        broker=broker,
        topic=topic,
        consumer_group_id=consumer_group_id,
        target_identity=str(job.storage_path or job.target_path or job.target),
        checkpoint_path=checkpoint_path,
        status="stopped",
        metrics=metrics,
    )
    from app.services.continuous_runtime_sync import assign_runtime_admission_owner_claim
    assign_runtime_admission_owner_claim(
            runtime,
            runtime_engine="spark_structured_streaming",
            configured_settings=settings,
            fencing_token=f"create-{uuid4()}",
    )
    return runtime


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


def make_dataset_id(value: str) -> str:
    display_name = unicodedata.normalize("NFC", value.strip())
    slug = normalize_column_name(display_name)
    if display_name == slug and re.fullmatch(r"[a-z0-9_]+", display_name):
        return f"ds_{slug}"
    digest = hashlib.sha1(display_name.encode("utf-8")).hexdigest()[:12]
    return f"ds_{slug}_{digest}"


def dataset_storage_key(value: str) -> str:
    return make_dataset_id(value).removeprefix("ds_")


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
