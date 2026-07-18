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


def clickhouse_v2_query_binding(
    dataset: Any,
    *,
    expected_binding_epoch: int | None,
) -> tuple[str, str, set[str], int] | None:
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
    if binding.get("engine") != "clickhouse" or binding.get("table") != "serving_current_v2":
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

    dataset_id = str(_dataset_value(dataset, "id") or "").strip()
    if not dataset_id:
        raise ValueError("V2 serving query requires a Dataset identity")
    schema = _dataset_value(dataset, "schema_", "schema", default=[]) or []
    projections: list[str] = []
    columns: set[str] = set()
    for item in schema:
        name = item[0] if isinstance(item, (list, tuple)) and item else None
        identifier = validate_clickhouse_identifier(name)
        if identifier.casefold().startswith("_asklake_"):
            continue
        columns.add(identifier)
        path = quote_clickhouse_string(f"$.{identifier}")
        projections.append(
            f"JSON_VALUE(payload, {path}) AS {quote_clickhouse_identifier(identifier)}"
        )
    if not projections or len(projections) > 200:
        raise ValueError("V2 serving binding exposes an invalid number of Catalog columns")
    target = qualified_clickhouse_table(database, table)
    query_table = (
        f"(SELECT {', '.join(projections)} FROM {target} "
        "WHERE scope_id = 'deployment' "
        f"AND serving_dataset_id = {quote_clickhouse_string(dataset_id)} "
        f"AND pipeline_version_id = {quote_clickhouse_string(pipeline_version_id)}) "
        "AS __asklake_serving"
    )
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
