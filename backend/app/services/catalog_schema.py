"""Canonical helpers for Catalog schema bindings.

Catalog payloads can come from the legacy frontend shape (``[name, type]``)
or from API connectors that return objects.  Semantic and query code must use
one canonical representation so a selected physical column is never silently
treated as a free-form string.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def normalize_schema(schema: Any) -> list[dict[str, Any]]:
    columns: list[dict[str, Any]] = []
    if not isinstance(schema, list):
        return columns

    for item in schema:
        if isinstance(item, dict):
            name = item.get("name") or item.get("columnName") or item.get("targetName")
            if not name:
                continue
            data_type = item.get("type") or item.get("dataType") or item.get("logicalType") or "unknown"
            columns.append({
                "name": str(name),
                "dataType": str(data_type),
                "description": str(item.get("description") or ""),
            })
            continue

        if isinstance(item, (list, tuple)) and item:
            columns.append({
                "name": str(item[0]),
                "dataType": str(item[1]) if len(item) > 1 and item[1] else "unknown",
                "description": "",
            })
            continue

        if item is not None:
            columns.append({"name": str(item), "dataType": "unknown", "description": ""})

    return columns


def dataset_schema(dataset: dict[str, Any]) -> list[dict[str, Any]]:
    schema = dataset.get("schema") or dataset.get("schema_") or []
    normalized = normalize_schema(schema)
    if normalized:
        return normalized

    sample_rows = dataset.get("sampleRows") or dataset.get("sample_rows") or []
    first = sample_rows[0] if sample_rows else None
    if isinstance(first, dict):
        return [{"name": str(key), "dataType": "unknown", "description": ""} for key in first]
    return []


def schema_names(dataset: dict[str, Any]) -> list[str]:
    return [str(column["name"]) for column in dataset_schema(dataset)]


def schema_fingerprint(dataset: dict[str, Any]) -> str:
    canonical = [{"name": item["name"], "dataType": item["dataType"]} for item in dataset_schema(dataset)]
    return hashlib.sha256(json.dumps(canonical, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def sample_values(dataset: dict[str, Any], column_name: str, limit: int = 5) -> list[str]:
    sample_rows = dataset.get("sampleRows") or dataset.get("sample_rows") or []
    values: list[str] = []
    columns = schema_names(dataset)
    for row in sample_rows[:limit]:
        value: Any = None
        if isinstance(row, dict):
            value = row.get(column_name)
        elif isinstance(row, list) and column_name in columns:
            index = columns.index(column_name)
            value = row[index] if index < len(row) else None
        if value not in (None, ""):
            values.append(str(value))
    return values
