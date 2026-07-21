from collections.abc import Mapping
from dataclasses import dataclass
import time
from typing import Any

from app.core.config import settings
from app.core.errors import ApiError
from app.schemas.catalog import QueryEngineTableRef
from app.services.trino_client import TrinoClient


@dataclass(frozen=True)
class TrinoRows:
    columns: list[str]
    rows: list[list[Any]]


def iceberg_dataset_table(dataset: Any) -> str | None:
    target = iceberg_dataset_target(dataset)
    if target is None:
        return None
    return qualified_iceberg_table(target)


def iceberg_dataset_target(dataset: Any) -> QueryEngineTableRef | None:
    storage_format = normalized_text(dataset_value(dataset, "storage_format", "storageFormat"))
    if storage_format != "iceberg":
        return None

    query_engine_status = normalized_text(
        dataset_value(dataset, "query_engine_status", "queryEngineStatus")
    )
    mapping = dataset_value(dataset, "query_engine_table", "queryEngineTable")
    if query_engine_status != "available" or mapping is None:
        raise ValueError("Iceberg dataset does not have an available query-engine mapping")

    target = mapping if isinstance(mapping, QueryEngineTableRef) else QueryEngineTableRef.model_validate(mapping)
    if target.format != "iceberg":
        raise ValueError("Iceberg dataset query-engine mapping has an incompatible format")
    return target


def qualified_iceberg_table(target: QueryEngineTableRef, *, suffix: str = "") -> str:
    return ".".join(
        quote_trino_identifier(value)
        for value in (target.catalog, target.schema_, f"{target.table}{suffix}")
    )


def iceberg_dataset_user_columns(dataset: Any) -> list[str]:
    schema = dataset_value(dataset, "schema_", "schema") or []
    columns: list[str] = []
    for item in schema:
        name = item[0] if isinstance(item, (list, tuple)) and item else None
        normalized = str(name or "").strip()
        if normalized and not normalized.casefold().startswith("_asklake_") and normalized not in columns:
            columns.append(normalized)
    return columns


def execute_trino_rows(
    client: TrinoClient,
    query: str,
    *,
    max_pages: int | None = None,
    timeout_seconds: float | None = None,
) -> TrinoRows:
    page_limit = max_pages or settings.trino_max_result_pages
    deadline = time.monotonic() + timeout_seconds if timeout_seconds is not None else None
    page = client.submit(query, **trino_timeout_kwargs(deadline))
    columns = list(page.columns)
    rows = list(page.rows)
    page_count = 0
    while page.next_uri and page.error is None:
        if page_count >= page_limit:
            cancel_trino_query(client, page.next_uri)
            raise RuntimeError("Iceberg dataset query exceeded the Trino page limit")
        if deadline is not None and time.monotonic() >= deadline:
            cancel_trino_query(client, page.next_uri)
            raise RuntimeError("Iceberg dataset query exceeded the execution deadline")
        page = client.fetch(page.next_uri, **trino_timeout_kwargs(deadline))
        if not columns and page.columns:
            columns = list(page.columns)
        rows.extend(page.rows)
        page_count += 1
    if page.error is not None:
        raise RuntimeError(f"{page.error.code}: {page.error.message}")
    return TrinoRows(columns=columns, rows=rows)


def trino_timeout_kwargs(deadline: float | None) -> dict[str, float]:
    if deadline is None:
        return {}
    return {"timeout_seconds": max(deadline - time.monotonic(), 0.001)}


def cancel_trino_query(client: TrinoClient, next_uri: str) -> None:
    try:
        client.cancel(next_uri, timeout_seconds=1.0)
    except Exception:
        pass


def dataset_value(value: Any, *keys: str) -> Any:
    for key in keys:
        if isinstance(value, Mapping) and key in value and value[key] is not None:
            return value[key]
        if hasattr(value, key):
            result = getattr(value, key)
            if result is not None:
                return result
    return None


def normalized_text(value: Any) -> str:
    if hasattr(value, "value"):
        value = value.value
    return str(value or "").strip().casefold()


def quote_trino_identifier(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError("Iceberg query-engine identifier cannot be empty")
    return f'"{text.replace(chr(34), chr(34) * 2)}"'


def iceberg_read_reason(error: Exception) -> str:
    if isinstance(error, ApiError):
        code = error.code
        return str(code.value if hasattr(code, "value") else code)
    return str(error)[:500]
