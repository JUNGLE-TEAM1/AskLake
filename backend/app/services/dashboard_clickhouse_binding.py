from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.services.clickhouse_client import (
    qualified_clickhouse_table,
    quote_clickhouse_identifier,
    quote_clickhouse_string,
    validate_clickhouse_identifier,
)


def _dataset_value(value: Any, *keys: str, default: Any = None) -> Any:
    for key in keys:
        if isinstance(value, Mapping) and key in value and value[key] is not None:
            return value[key]
        if hasattr(value, key):
            result = getattr(value, key)
            if result is not None:
                return result
    return default


def clickhouse_dataset_table(dataset: Any) -> str | None:
    storage_format = str(
        _dataset_value(dataset, "storage_format", "storageFormat", default="") or ""
    ).strip().casefold()
    if storage_format != "clickhouse":
        return None
    mapping = _dataset_value(dataset, "clickhouse_table", "clickhouseTable")
    if hasattr(mapping, "model_dump"):
        mapping = mapping.model_dump(mode="json", by_alias=True)
    if not isinstance(mapping, Mapping):
        raise ValueError("ClickHouse dataset does not have a physical table mapping")
    database = validate_clickhouse_identifier(mapping.get("database"))
    table = validate_clickhouse_identifier(mapping.get("table"))
    return qualified_clickhouse_table(database, table)


def _active_clickhouse_v2_binding(
    dataset: Any,
    expected_binding_epoch: int | None,
) -> tuple[str, str, str, int] | None:
    raw_bindings = _dataset_value(dataset, "physical_bindings", "physicalBindings")
    if not isinstance(raw_bindings, (list, tuple)):
        return None
    bindings: list[dict[str, Any]] = []
    for item in raw_bindings:
        if hasattr(item, "model_dump"):
            item = item.model_dump(mode="json", by_alias=True)
        if isinstance(item, Mapping):
            bindings.append(dict(item))
    active = [
        item for item in bindings
        if item.get("role") == "serving" and item.get("status") == "active"
    ]
    if len(active) > 1:
        raise ValueError("Dataset has more than one active serving binding")
    if not active:
        return None
    binding = active[0]
    if binding.get("engine") != "clickhouse":
        return None
    database = validate_clickhouse_identifier(binding.get("database"))
    table = validate_clickhouse_identifier(binding.get("table"))
    pipeline_version_id = str(
        binding.get("pipelineVersionId") or binding.get("pipeline_version_id") or ""
    ).strip()
    if not pipeline_version_id:
        raise ValueError("Active V2 serving binding has no pipeline version")
    try:
        binding_epoch = int(binding.get("bindingEpoch", binding.get("binding_epoch", -1)))
    except (TypeError, ValueError) as exc:
        raise ValueError("Active V2 serving binding epoch is invalid") from exc
    if binding_epoch < 0 or (
        expected_binding_epoch is not None and binding_epoch != int(expected_binding_epoch)
    ):
        raise ValueError("Active V2 serving binding epoch is stale")
    return database, table, pipeline_version_id, binding_epoch


def _v2_value_expression(identifier: str, type_name: str) -> str:
    path = quote_clickhouse_string(f"$.{identifier}")
    raw_value = f"JSON_VALUE(payload, {path})"
    normalized_type = type_name.strip().casefold().replace(" ", "")
    if normalized_type in {
        "byte", "short", "smallint", "int", "integer", "int32",
        "long", "bigint", "int64",
    }:
        return f"toInt64OrNull({raw_value})"
    if normalized_type in {
        "float", "real", "double", "decimal", "number", "numeric",
        "float32", "float64",
    } or normalized_type.startswith("decimal("):
        return f"toFloat64OrNull({raw_value})"
    if normalized_type in {"boolean", "bool"}:
        return f"accurateCastOrNull({raw_value}, 'Bool')"
    if normalized_type in {"timestamp", "datetime", "timestampwithtimezone", "date"}:
        return f"parseDateTime64BestEffortOrNull({raw_value}, 3)"
    return raw_value


def _v2_projection_columns(dataset: Any) -> tuple[list[str], set[str]]:
    schema = _dataset_value(dataset, "schema_", "schema", default=[]) or []
    projections: list[str] = []
    columns: set[str] = set()
    for item in schema:
        name = item[0] if isinstance(item, (list, tuple)) and item else None
        type_name = str(item[1]) if isinstance(item, (list, tuple)) and len(item) >= 2 else "string"
        identifier = validate_clickhouse_identifier(name)
        if identifier.casefold().startswith("_asklake_"):
            continue
        columns.add(identifier)
        value = _v2_value_expression(identifier, type_name)
        projections.append(f"{value} AS {quote_clickhouse_identifier(identifier)}")
    if not projections or len(projections) > 200:
        raise ValueError("V2 serving binding exposes an invalid number of Catalog columns")
    return projections, columns


def _v2_query_table(
    dataset: Any,
    *,
    database: str,
    table: str,
    projections: list[str],
    dataset_id: str,
    pipeline_version_id: str,
) -> tuple[str, str] | None:
    target = qualified_clickhouse_table(database, table)
    selected = ", ".join(projections)
    if table == "serving_current_v2":
        return target, (
            f"(SELECT {selected} FROM {target} WHERE scope_id = 'deployment' "
            f"AND serving_dataset_id = {quote_clickhouse_string(dataset_id)} "
            f"AND pipeline_version_id = {quote_clickhouse_string(pipeline_version_id)}) "
            "AS __asklake_serving"
        )
    if table != "raw_events_v2_current":
        return None
    streaming_source = _dataset_value(dataset, "streaming_source", "streamingSource")
    topic = str(streaming_source.get("topic") or "").strip() if isinstance(streaming_source, Mapping) else ""
    if not topic:
        raise ValueError("V2 raw ingest binding requires a Kafka topic")
    return target, (
        f"(SELECT {selected} FROM {target} WHERE scope_id = 'deployment' "
        f"AND kafka_topic = {quote_clickhouse_string(topic)}) AS __asklake_serving"
    )


def clickhouse_v2_query_binding(
    dataset: Any,
    *,
    expected_binding_epoch: int | None,
) -> tuple[str, str, set[str], int] | None:
    binding = _active_clickhouse_v2_binding(dataset, expected_binding_epoch)
    if binding is None:
        return None
    database, table, pipeline_version_id, binding_epoch = binding

    dataset_id = str(_dataset_value(dataset, "id") or "").strip()
    if not dataset_id:
        raise ValueError("V2 serving query requires a Dataset identity")
    projections, columns = _v2_projection_columns(dataset)
    query = _v2_query_table(
        dataset,
        database=database,
        table=table,
        projections=projections,
        dataset_id=dataset_id,
        pipeline_version_id=pipeline_version_id,
    )
    if query is None:
        return None
    target, query_table = query
    return target, query_table, columns, binding_epoch


def clickhouse_dataset_user_columns(dataset: Any) -> list[str]:
    schema = _dataset_value(dataset, "schema_", "schema", default=[]) or []
    columns: list[str] = []
    for item in schema:
        name = item[0] if isinstance(item, (list, tuple)) and item else None
        normalized = str(name or "").strip()
        if normalized and not normalized.casefold().startswith("_asklake_") and normalized not in columns:
            columns.append(normalized)
    return columns
