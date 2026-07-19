from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
import hashlib
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.models.catalog import CatalogDatasetModel
from app.models.continuous_sql import ContinuousSqlJobModel, ContinuousSqlRunModel
from app.models.dashboard_live import DatasetFreshnessModel
from app.realtime.domain.dimension import default_missing_policy
from app.realtime.domain.receipt import audit_receipt_range
from app.realtime.domain.source_boundary import PartitionBoundary, SourceBoundary
from app.realtime.domain.source_position import SourcePosition
from app.realtime.sql.validator import RealtimeRelation, RealtimeSqlPlan
from app.repositories.catalog_repository import (
    dataset_model_to_payload,
    dataset_payload_to_model_values,
)
from app.realtime.repositories.receipt_repository import ReceiptRepository
from app.services.clickhouse_continuous_sql import (
    continuous_sql_static_join_columns,
    relation_schema,
)
from app.services.clickhouse_client import (
    ClickHouseClient,
    qualified_clickhouse_table,
    quote_clickhouse_string,
)
from app.services.continuous_sql_planner import CompiledContinuousSqlPlan
from app.services.iceberg_dataset_reader import execute_trino_rows, quote_trino_identifier


_RAW_VIEW = "raw_events_v2_current"


def realtime_v2_topic(job: ContinuousSqlJobModel) -> str:
    stream = next(
        (
            item for item in job.relation_bindings or []
            if isinstance(item, dict) and item.get("mode") == "streaming"
        ),
        None,
    )
    source = stream.get("streamingSource") if isinstance(stream, dict) else None
    topic = str(source.get("topic") or "").strip() if isinstance(source, dict) else ""
    if not topic:
        raise ValueError("ClickHouse Realtime V2 streaming topic is missing")
    return topic


def realtime_v2_connector_name(base: str, topic: str) -> str:
    digest = hashlib.sha256(topic.encode("utf-8")).hexdigest()[:16]
    prefix = str(base or "asklake-clickhouse-realtime-v2").strip()[:110].rstrip(".-_")
    return f"{prefix}-{digest}"


def realtime_v2_dlq_topic(topic: str) -> str:
    suffix = ".asklake-v2-dlq"
    if len(topic) + len(suffix) <= 249:
        return topic + suffix
    digest = hashlib.sha256(topic.encode("utf-8")).hexdigest()[:16]
    return f"{topic[:225].rstrip('.-_')}-{digest}.dlq"


def realtime_v2_pipeline_ids(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel,
) -> tuple[str, str, str]:
    pipeline_hash = hashlib.sha256(job.id.encode("utf-8")).hexdigest()
    version_hash = hashlib.sha256(
        f"{job.id}|{run.generation}|{job.plan_hash}".encode("utf-8")
    ).hexdigest()
    pipeline_id = f"rtp_{pipeline_hash[:48]}"
    version_id = f"rtpv_{version_hash[:48]}"
    deployment_id = f"rtpd_{version_hash[:48]}"
    return pipeline_id, version_id, deployment_id


def realtime_v2_dimension_version_id(
    dataset_id: str,
    snapshot_id: str,
    schema_fingerprint: str,
) -> str:
    normalized_schema_fingerprint = realtime_v2_schema_fingerprint(schema_fingerprint)
    digest = hashlib.sha256(
        f"{dataset_id}|{snapshot_id}|{normalized_schema_fingerprint}".encode("utf-8")
    ).hexdigest()
    return f"rtdv_{digest[:48]}"


def realtime_v2_schema_fingerprint(value: str) -> str:
    normalized = str(value or "").strip().casefold()
    if len(normalized) == 64 and all(character in "0123456789abcdef" for character in normalized):
        return normalized
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def realtime_v2_dimension_versions(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel,
) -> dict[str, str]:
    bindings = {
        str(item.get("datasetId") or ""): item
        for item in run.static_bindings or []
        if isinstance(item, dict)
    }
    versions: dict[str, str] = {}
    for relation in job.relation_bindings or []:
        if not isinstance(relation, dict) or relation.get("mode") != "static":
            continue
        dataset_id = str(relation.get("datasetId") or "")
        binding = bindings.get(dataset_id)
        if binding is None:
            raise ValueError("Pinned V2 dimension binding is missing")
        versions[dataset_id] = realtime_v2_dimension_version_id(
            dataset_id,
            str(binding.get("snapshotId") or ""),
            str(relation.get("schemaFingerprint") or ""),
        )
    return versions


def build_realtime_v2_plan(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel,
    *,
    dimension_version_ids: dict[str, str],
    database: str,
) -> RealtimeSqlPlan:
    relations: list[RealtimeRelation] = []
    for relation in job.relation_bindings or []:
        if not isinstance(relation, dict):
            continue
        dataset_id = str(relation.get("datasetId") or "")
        schema = tuple(relation_schema(relation))
        if relation.get("mode") == "streaming":
            source = relation.get("streamingSource")
            topic = str(source.get("topic") or "") if isinstance(source, dict) else ""
            relations.append(RealtimeRelation(
                dataset_id=dataset_id,
                logical_name=str(relation.get("datasetName") or dataset_id),
                role="fact",
                physical_database=database,
                physical_table=_RAW_VIEW,
                schema=schema,
                kafka_topic=topic,
            ))
            continue
        join_columns = tuple(continuous_sql_static_join_columns(job, dataset_id))
        unique_sets = tuple(
            tuple(str(column) for column in item)
            for item in relation.get("uniqueKeySets") or []
            if isinstance(item, (list, tuple))
        ) or (join_columns,)
        relations.append(RealtimeRelation(
            dataset_id=dataset_id,
            logical_name=str(relation.get("datasetName") or dataset_id),
            role="dimension",
            physical_database=database,
            physical_table="dimension_current_v2_latest",
            schema=schema,
            unique_key_sets=unique_sets,
            estimated_row_count=(
                int(relation["estimatedRowCount"])
                if relation.get("estimatedRowCount") is not None
                else None
            ),
            dimension_version_id=dimension_version_ids.get(dataset_id),
            dimension_semantics="current",
        ))
    facts = [item for item in relations if item.role == "fact"]
    dimensions = [item for item in relations if item.role == "dimension"]
    if len(facts) != 1 or not 1 <= len(dimensions) <= 3:
        raise ValueError("ClickHouse Realtime V2 requires one fact and one to three dimensions")
    if relations[0].role != "fact":
        raise ValueError("ClickHouse Realtime V2 fact relation must be left-most")
    output_schema = tuple(
        (str(item[0]), str(item[1]))
        for item in job.compiled_plan.get("outputSchema") or []
        if isinstance(item, (list, tuple)) and len(item) >= 2
    )
    runtime_sql = str(job.compiled_plan.get("runtimeSql") or "").strip()
    if not output_schema or not runtime_sql:
        raise ValueError("ClickHouse Realtime V2 compiled plan is incomplete")
    compiled = CompiledContinuousSqlPlan(
        normalized_sql=job.normalized_sql,
        runtime_sql=runtime_sql,
        plan_hash=job.plan_hash,
        plan=dict(job.compiled_plan or {}),
    )
    joins = tuple(
        dict(item)
        for item in job.compiled_plan.get("joins") or []
        if isinstance(item, dict)
    )
    return RealtimeSqlPlan(
        normalized_sql=job.normalized_sql,
        sql_fingerprint=hashlib.sha256(job.normalized_sql.encode("utf-8")).hexdigest(),
        execution_mode="realtime_incremental",
        referenced_dataset_ids=tuple(item.dataset_id for item in relations),
        join_keys=joins,
        missing_policies=tuple({
            "dimensionDatasetId": str(item.get("rightDatasetId") or ""),
            "joinType": str(item.get("type") or ""),
            "missingPolicy": default_missing_policy(str(item.get("type") or "")),
        } for item in joins),
        output_schema=output_schema,
        business_key_columns=(),
        event_time_column=None,
        warnings=(),
        estimated_cost={
            "sourceRowsPerSecond": 0,
            "dimensionRows": sum(max(0, item.estimated_row_count or 0) for item in dimensions),
            "estimatedP95Ms": min(5_000, 50 + len(dimensions) * 150),
        },
        runtime_plan=compiled,
        relations=tuple(relations),
    )


def realtime_json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="strict")
    if isinstance(value, dict):
        return {str(key): realtime_json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [realtime_json_value(item) for item in value]
    return str(value)


def prepare_dimension_snapshot(
    trino_client: Any,
    runtime_settings: Any,
    job: ContinuousSqlJobModel,
    relation: dict[str, Any],
    binding: dict[str, Any],
) -> tuple[list[str], list[str], str, int, Any]:
    mapping = relation.get("queryEngineTable")
    if not isinstance(mapping, dict):
        raise ValueError("V2 dimension has no Iceberg mapping")
    columns = [item[0] for item in relation_schema(relation)]
    if not columns:
        raise ValueError("V2 dimension schema is empty")
    snapshot_id = int(str(binding.get("snapshotId")))
    source = ".".join(
        quote_trino_identifier(mapping.get(key))
        for key in ("catalog", "schema", "table")
    )
    count = execute_trino_rows(
        trino_client,
        f"SELECT count(*) FROM {source} FOR VERSION AS OF {snapshot_id}",
        timeout_seconds=runtime_settings.trino_query_timeout_seconds,
    )
    if not count.rows or not count.rows[0]:
        raise ValueError("V2 dimension snapshot count is unavailable")
    total_rows = int(count.rows[0][0])
    if total_rows > int(runtime_settings.continuous_sql_static_cache_max_rows):
        raise ValueError("V2 dimension exceeds CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS")
    dataset_id = str(relation.get("datasetId") or "")
    join_columns = continuous_sql_static_join_columns(job, dataset_id)
    indexes = {name: index for index, name in enumerate(columns)}
    if any(item not in indexes for item in join_columns):
        raise ValueError("V2 dimension JOIN key is missing from the snapshot")
    projection = ", ".join(quote_trino_identifier(item) for item in columns)
    order_by = ", ".join(quote_trino_identifier(item) for item in join_columns)
    page = trino_client.submit(
        f"SELECT {projection} FROM {source} FOR VERSION AS OF {snapshot_id} "
        f"ORDER BY {order_by}",
        timeout_seconds=runtime_settings.trino_query_timeout_seconds,
    )
    return columns, join_columns, dataset_id, total_rows, page


def pending_realtime_v2_positions(
    client: ClickHouseClient,
    *,
    database: str,
    raw_view: str,
    topic: str,
    checkpoint_state: dict[int, dict[str, int]],
    max_positions: int,
) -> dict[int, tuple[SourcePosition, ...]]:
    target = qualified_clickhouse_table(database, raw_view)
    positions_by_partition: dict[int, tuple[SourcePosition, ...]] = {}
    for partition, state in checkpoint_state.items():
        offsets = client.query(
            "SELECT kafka_offset "
            f"FROM {target} WHERE scope_id = 'deployment' "
            f"AND kafka_topic = {quote_clickhouse_string(topic)} "
            f"AND kafka_partition = {partition} "
            f"AND kafka_offset > {int(state['applied'])} "
            f"ORDER BY kafka_offset LIMIT {max_positions}"
        )
        items = tuple(
            SourcePosition(topic, partition, int(row[0]))
            for row in offsets.rows
            if row
        )
        if items:
            positions_by_partition[partition] = items
    return positions_by_partition


def upsert_realtime_v2_pipeline(
    db: Session,
    job: ContinuousSqlJobModel,
    *,
    pipeline_id: str,
) -> None:
    db.execute(text("""
        INSERT INTO realtime_pipelines (
            id, scope_id, logical_dataset_id, name, execution_mode,
            desired_state, owner_user_id
        ) VALUES (
            :id, 'deployment', :dataset_id, :name, 'realtime_incremental',
            'running', :owner
        )
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, desired_state = 'running',
            updated_at = CURRENT_TIMESTAMP
    """), {
        "id": pipeline_id,
        "dataset_id": job.output_dataset_id,
        "name": job.name,
        "owner": job.owner,
    })


def build_realtime_v2_materialization_context(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel,
    *,
    database: str,
    topic: str,
    positions_by_partition: dict[int, tuple[SourcePosition, ...]],
    checkpoint_state: dict[int, dict[str, int]],
) -> tuple[dict[str, str], RealtimeSqlPlan, SourceBoundary]:
    dimension_versions = realtime_v2_dimension_versions(job, run)
    plan = build_realtime_v2_plan(
        job,
        run,
        dimension_version_ids=dimension_versions,
        database=database,
    )
    boundary = SourceBoundary.build([
        PartitionBoundary(
            topic,
            partition,
            int(checkpoint_state[partition]["applied"]),
            int(items[-1].offset),
        )
        for partition, items in positions_by_partition.items()
    ])
    return dimension_versions, plan, boundary


def save_realtime_v2_receipts(
    db: Session,
    *,
    version_id: str,
    positions_by_partition: dict[int, tuple[SourcePosition, ...]],
    checkpoint_state: dict[int, dict[str, int]],
) -> None:
    receipts = ReceiptRepository(db)
    for partition, positions in positions_by_partition.items():
        audit = audit_receipt_range(expected=positions, raw=positions)
        advanced = receipts.save_audit(
            pipeline_version_id=version_id,
            audit=audit,
            expected_previous_contiguous=int(checkpoint_state[partition]["contiguous"]),
        )
        if not advanced:
            raise RuntimeError("V2 receipt checkpoint lost its lease")


def activate_realtime_v2_serving_binding(
    db: Session,
    job: ContinuousSqlJobModel,
    plan: RealtimeSqlPlan,
    *,
    version_id: str,
    updated_at: str,
    database: str,
    serving_view: str,
) -> None:
    freshness = db.get(DatasetFreshnessModel, job.output_dataset_id)
    if freshness is None:
        freshness = DatasetFreshnessModel(
            dataset_id=job.output_dataset_id,
            latest_revision=0,
            next_check_after_ms=max(1_000, int(job.trigger_interval_seconds) * 1_000),
            binding_epoch=1,
        )
    elif (
        freshness.active_serving_engine != "clickhouse"
        or freshness.active_serving_version_id != version_id
    ):
        freshness.binding_epoch = int(freshness.binding_epoch or 0) + 1
    freshness.active_serving_engine = "clickhouse"
    freshness.active_serving_version_id = version_id
    freshness.updated_at = datetime.now(UTC)
    db.add(freshness)
    db.flush()
    upsert_realtime_v2_catalog_dataset(
        db,
        job,
        plan,
        version_id=version_id,
        binding_epoch=int(freshness.binding_epoch),
        updated_at=updated_at,
        database=database,
        serving_view=serving_view,
    )


def update_realtime_v2_catalog_rows(
    db: Session,
    job: ContinuousSqlJobModel,
    *,
    total_rows: int,
    updated_at: str,
) -> None:
    catalog = db.get(CatalogDatasetModel, job.output_dataset_id)
    if catalog is None:
        return
    payload = dataset_model_to_payload(catalog)
    payload["rows"] = f"{total_rows:,}"
    payload["lastUpdated"] = updated_at
    payload["quality"] = "Realtime V2 offset publication verified"
    catalog.payload = payload
    catalog.rows = payload["rows"]
    catalog.last_updated = payload["lastUpdated"]
    catalog.quality = payload["quality"]
    db.add(catalog)


def upsert_realtime_v2_catalog_dataset(
    db: Session,
    job: ContinuousSqlJobModel,
    plan: RealtimeSqlPlan,
    *,
    version_id: str,
    binding_epoch: int,
    updated_at: str,
    database: str,
    serving_view: str,
) -> None:
    model = db.scalars(
        select(CatalogDatasetModel)
        .where(CatalogDatasetModel.id == job.output_dataset_id)
        .with_for_update()
    ).first()
    previous = dataset_model_to_payload(model) if model is not None else {}
    bindings = [
        dict(item)
        for item in previous.get("physicalBindings") or []
        if isinstance(item, dict) and item.get("role") != "serving"
    ]
    bindings.append({
        "role": "serving",
        "engine": "clickhouse",
        "status": "active",
        "bindingEpoch": binding_epoch,
        "versionId": version_id,
        "pipelineVersionId": version_id,
        "database": database,
        "table": serving_view,
    })
    payload = {
        **previous,
        "clickhouseTable": {"database": database, "table": serving_view},
        "createdBy": previous.get("createdBy") or job.created_by,
        "description": previous.get("description") or f"ClickHouse Realtime V2 output for {job.name}",
        "downstream": previous.get("downstream") or ["Dashboard"],
        "freshness": "realtime",
        "id": job.output_dataset_id,
        "indexColumns": ["kafka_partition", "kafka_offset"],
        "lastUpdated": updated_at,
        "layer": job.output_layer,
        "name": job.output_dataset_name,
        "nextRefresh": f"Every {job.trigger_interval_seconds} seconds",
        "owner": job.owner,
        "permissionGrants": previous.get("permissionGrants")
        or permission_grants_from_roles(job.owner, default_actions=["view", "query"]),
        "permissions": previous.get("permissions") or resource_permissions(can_query=True),
        "physicalBindings": bindings,
        "quality": "Realtime V2 serving binding ready",
        "queryEngineStatus": "unavailable",
        "rag": bool(previous.get("rag")),
        "relationMode": "static",
        "rows": previous.get("rows") or "0",
        "sampleRows": previous.get("sampleRows") or [],
        "schema": [list(item) for item in plan.output_schema],
        "size": previous.get("size") or "ClickHouse managed",
        "source": job.name,
        "status": "available",
        "storageFormat": "clickhouse",
        "storageLocation": f"clickhouse://{database}/{serving_view}",
        "tags": previous.get("tags") or ["continuous-sql", "clickhouse", "realtime-v2"],
        "upstream": [item.dataset_id for item in plan.relations],
    }
    values = dataset_payload_to_model_values(payload)
    if model is None:
        model = CatalogDatasetModel(id=job.output_dataset_id, **values)
    else:
        for key, value in values.items():
            setattr(model, key, value)
    db.add(model)


def realtime_v2_worker_result(
    job: ContinuousSqlJobModel,
    state: str,
    *,
    progress: list[dict[str, Any]] | None = None,
    output_row_count: int = 0,
    publication_revision: int | None = None,
) -> dict[str, Any]:
    return {
        "containerState": state,
        "workerAttemptId": f"clickhouse-v2:{job.id}",
        "clickhouseOffsets": [],
        "realtimeV2Offsets": progress or [],
        "servingMode": "clickhouse",
        "servingGeneration": "v2",
        "jobId": job.id,
        "clickhouseOutputRowCount": max(0, int(output_row_count)),
        "consumerMessagesRead": sum(
            max(0, int(item.get("rowCount") or 0))
            for item in progress or []
        ),
        "publicationRevision": publication_revision,
        "lastErrorCode": None,
        "lastErrorMessage": None,
    }
