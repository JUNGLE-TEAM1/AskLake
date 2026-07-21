import math
from collections.abc import Mapping
from datetime import date, datetime
from decimal import Decimal
from threading import Timer
from typing import Any

import duckdb
from fastapi import status

from app.core.errors import ApiError
from app.services.iceberg_dataset_reader import execute_trino_rows, iceberg_read_reason


DASHBOARD_FILTER_VALUE_LIMIT = 100
DASHBOARD_WIDGET_FILTER_LIMIT = 5
DASHBOARD_WIDGET_FILTER_IN_VALUE_LIMIT = 50


def dashboard_source_config(config: dict[str, Any]) -> dict[str, Any]:
    source = config.get("sourceConfig") or config.get("source_config")
    if isinstance(source, dict):
        return dict(source)
    return {
        key: value
        for key, value in config.items()
        if key not in {"dataMode", "data_mode", "sourceConfig", "source_config"}
    }


def dashboard_iceberg_snapshot_version(dataset: Any) -> str | None:
    value = _dataset_value(dataset, "iceberg_snapshot_id", "icebergSnapshotId")
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized or not normalized.lstrip("-").isdigit():
        raise ValueError("Catalog dataset has an invalid Iceberg snapshot ID")
    return str(int(normalized))


def dashboard_ratio_values(config: dict[str, Any]) -> tuple[str, str]:
    numerator = config.get("numeratorValue") or config.get("numerator_value")
    denominator = config.get("denominatorValue") or config.get("denominator_value")
    if not isinstance(numerator, str) or not numerator:
        raise ValueError("Dashboard ratio requires numeratorValue")
    if not isinstance(denominator, str) or not denominator:
        raise ValueError("Dashboard ratio requires denominatorValue")
    return numerator, denominator


def dashboard_ratio_expression(value_key: str, config: dict[str, Any]) -> str:
    numerator, denominator = dashboard_ratio_values(config)
    column = _quote_identifier(value_key)
    numerator_count = (
        f"SUM(CASE WHEN CAST({column} AS VARCHAR) = {_quote_literal(numerator)} "
        "THEN 1 ELSE 0 END)"
    )
    denominator_count = (
        f"SUM(CASE WHEN CAST({column} AS VARCHAR) = {_quote_literal(denominator)} "
        "THEN 1 ELSE 0 END)"
    )
    return f"100.0 * {numerator_count} / NULLIF({denominator_count}, 0)"


def dashboard_dataset_column_types(
    dataset: Any,
    readable_columns: set[str] | None = None,
) -> dict[str, str]:
    schema = _dataset_value(dataset, "schema_", "schema", default=[])
    resolved: dict[str, str] = {}
    if isinstance(schema, list):
        for item in schema:
            name: Any = None
            raw_type: Any = None
            if isinstance(item, Mapping):
                name = item.get("name")
                raw_type = item.get("type")
            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                name, raw_type = item[0], item[1]
            normalized_name = str(name or "").strip()
            if not normalized_name:
                continue
            if readable_columns is not None and normalized_name not in readable_columns:
                continue
            resolved[normalized_name] = _normalized_column_type(raw_type)
    if readable_columns is not None:
        for column in readable_columns:
            resolved.setdefault(column, "string")
    return resolved


def dashboard_widget_filter_predicates(
    config: Mapping[str, Any],
    columns: set[str],
    column_types: Mapping[str, str] | None = None,
) -> list[str]:
    raw_filters = config.get("filters")
    if raw_filters is None:
        return []
    if not isinstance(raw_filters, list):
        raise ValueError("Dashboard widget filters must be a list")
    if len(raw_filters) > DASHBOARD_WIDGET_FILTER_LIMIT:
        raise ValueError(
            f"Dashboard widget supports at most {DASHBOARD_WIDGET_FILTER_LIMIT} filters"
        )

    resolved_column_types = column_types or {}
    predicates: list[str] = []
    seen_ids: set[str] = set()
    for raw_filter in raw_filters:
        if not isinstance(raw_filter, Mapping):
            raise ValueError("Dashboard widget filter must be an object")
        filter_id = str(raw_filter.get("id") or "").strip()
        if not filter_id:
            raise ValueError("Dashboard widget filter requires an ID")
        if filter_id in seen_ids:
            raise ValueError("Dashboard widget filter IDs must be unique")
        seen_ids.add(filter_id)

        column = str(raw_filter.get("column") or "").strip()
        require_dashboard_column(column, columns)
        operator = str(raw_filter.get("operator") or "").strip().lower()
        predicates.append(
            _dashboard_widget_filter_predicate(
                _quote_identifier(column),
                resolved_column_types.get(column, "string"),
                operator,
                raw_filter,
            )
        )
    return predicates


def _dashboard_widget_filter_predicate(
    column_sql: str,
    column_type: str,
    operator: str,
    raw_filter: Mapping[str, Any],
) -> str:
    if operator == "is_null":
        return f"{column_sql} IS NULL"
    if operator == "is_not_null":
        return f"{column_sql} IS NOT NULL"
    if operator == "contains":
        if column_type != "string":
            raise ValueError("Dashboard CONTAINS filter requires a string column")
        value = raw_filter.get("value")
        if not isinstance(value, str) or not value:
            raise ValueError("Dashboard CONTAINS filter requires a non-empty string value")
        return _dashboard_contains_filter_predicate(column_sql, value)
    if operator == "in":
        if column_type != "string":
            raise ValueError("Dashboard IN filter currently supports string columns only")
        values = raw_filter.get("values")
        if not isinstance(values, list) or not values:
            raise ValueError("Dashboard IN filter requires values")
        if len(values) > DASHBOARD_WIDGET_FILTER_IN_VALUE_LIMIT:
            raise ValueError("Dashboard IN filter exceeds the bounded value limit")
        literals = [_dashboard_filter_literal(value, column_type) for value in values]
        return f"CAST({column_sql} AS VARCHAR) IN ({', '.join(literals)})"
    if operator == "between":
        if column_type not in {"number", "date"}:
            raise ValueError("Dashboard BETWEEN filter requires a number or date column")
        values = raw_filter.get("values")
        if not isinstance(values, list) or len(values) != 2:
            raise ValueError("Dashboard BETWEEN filter requires exactly two values")
        operand = _dashboard_filter_operand(column_sql, column_type)
        lower = _dashboard_filter_literal(values[0], column_type)
        upper = _dashboard_filter_literal(values[1], column_type)
        return f"{operand} BETWEEN {lower} AND {upper}"

    comparison = {"eq": "=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}.get(operator)
    if comparison is None:
        raise ValueError(f"Unsupported dashboard filter operator: {operator}")
    if operator != "eq" and column_type not in {"number", "date"}:
        raise ValueError(
            f"Dashboard {operator.upper()} filter requires a number or date column"
        )
    value = raw_filter.get("value")
    if value is None:
        raise ValueError(f"Dashboard {operator.upper()} filter requires a value")
    return (
        f"{_dashboard_filter_operand(column_sql, column_type)} {comparison} "
        f"{_dashboard_filter_literal(value, column_type)}"
    )


def read_dashboard_filter_values(
    session: Any,
    column: str,
    *,
    context_filters: list[dict[str, Any]] | None = None,
    search: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    try:
        require_dashboard_column(column, session.columns)
        resolved_limit = dashboard_row_limit(
            limit,
            default=50,
            maximum=DASHBOARD_FILTER_VALUE_LIMIT,
        )
        column_sql = _quote_identifier(column)
        filter_parts = dashboard_widget_filter_predicates(
            {"filters": context_filters or []},
            session.columns,
            dashboard_dataset_column_types(session.dataset, session.columns),
        )
        filter_parts.append(f"{column_sql} IS NOT NULL")
        normalized_search = str(search or "").strip()
        if normalized_search:
            filter_parts.append(
                _dashboard_contains_filter_predicate(column_sql, normalized_search)
            )
        value_alias = _quote_identifier("__asklake_filter_value")
        query = (
            f"SELECT DISTINCT {column_sql} AS {value_alias} FROM {session.query_table} "
            f"WHERE {' AND '.join(filter_parts)} "
            f"ORDER BY CAST({column_sql} AS VARCHAR) ASC NULLS LAST "
            f"LIMIT {resolved_limit + 1}"
        )
    except ValueError as error:
        raise dashboard_widget_config_error(session.dataset, error) from error
    try:
        if session.trino_client is not None:
            raw_rows = execute_trino_rows(
                session.trino_client,
                query,
                timeout_seconds=session.query_timeout_seconds,
            ).rows
        else:
            if session.connection is None:
                raise ValueError("Dashboard dataset query session is closed")
            raw_rows = execute_dashboard_query(
                session.connection,
                query,
                timeout_seconds=session.query_timeout_seconds,
            ).fetchall()
    except (ApiError, RuntimeError, ValueError, duckdb.Error) as error:
        raise dashboard_storage_error(session.dataset, iceberg_read_reason(error)) from error

    truncated = len(raw_rows) > resolved_limit
    values = [
        dashboard_json_cell(row[0])
        for row in raw_rows[:resolved_limit]
        if row and row[0] is not None
    ]
    return {"truncated": truncated, "values": values}


def require_dashboard_column(column: str, columns: set[str]) -> None:
    if column not in columns:
        raise ValueError(f"Dashboard column does not exist: {column}")


def dashboard_row_limit(value: Any, *, default: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(maximum, parsed))


def execute_dashboard_query(
    connection: duckdb.DuckDBPyConnection,
    query: str,
    *,
    timeout_seconds: float,
) -> Any:
    timer = Timer(max(timeout_seconds, 0.001), connection.interrupt)
    timer.daemon = True
    timer.start()
    try:
        return connection.execute(query)
    finally:
        timer.cancel()


def dashboard_storage_error(dataset: Any, reason: str) -> ApiError:
    return ApiError(
        "DASHBOARD_DATA_UNAVAILABLE",
        "Dashboard widget physical data could not be read",
        status.HTTP_503_SERVICE_UNAVAILABLE,
        {
            "datasetId": str(_dataset_value(dataset, "id") or ""),
            "reason": reason[:500],
            "storageFormat": str(
                _dataset_value(dataset, "storage_format", "storageFormat") or ""
            ),
            "storageLocation": str(
                _dataset_value(dataset, "storage_location", "storageLocation") or ""
            ),
        },
    )


def dashboard_widget_config_error(dataset: Any, error: ValueError) -> ApiError:
    return ApiError(
        "DASHBOARD_WIDGET_CONFIG_INVALID",
        "Dashboard widget configuration is invalid for this dataset",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        {
            "datasetId": str(_dataset_value(dataset, "id") or ""),
            "reason": str(error)[:500],
        },
    )


def _normalized_column_type(value: Any) -> str:
    normalized = _normalized_text(value)
    if any(hint in normalized for hint in ("date", "time", "timestamp")):
        return "date"
    numeric_hints = (
        "bigint", "decimal", "double", "float", "int", "long", "number",
        "numeric", "real", "smallint", "tinyint",
    )
    return "number" if any(hint in normalized for hint in numeric_hints) else "string"


def _dashboard_filter_operand(column_sql: str, column_type: str) -> str:
    if column_type == "number":
        return f"TRY_CAST({column_sql} AS DOUBLE)"
    if column_type == "date":
        return f"TRY_CAST({column_sql} AS TIMESTAMP)"
    return f"CAST({column_sql} AS VARCHAR)"


def _dashboard_filter_literal(value: Any, column_type: str) -> str:
    if column_type == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Dashboard numeric filter requires a number value")
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError("Dashboard numeric filter requires a finite value")
        return str(value) if isinstance(value, int) else repr(parsed)
    if column_type == "date":
        if not isinstance(value, str) or not value.strip():
            raise ValueError("Dashboard date filter requires an ISO date value")
        normalized = value.strip()
        try:
            datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        except ValueError:
            try:
                date.fromisoformat(normalized)
            except ValueError as error:
                raise ValueError("Dashboard date filter requires an ISO date value") from error
        return f"TRY_CAST({_quote_literal(normalized)} AS TIMESTAMP)"
    if not isinstance(value, str):
        raise ValueError("Dashboard string filter requires a string value")
    return _quote_literal(value)


def _dashboard_contains_filter_predicate(column_sql: str, value: str) -> str:
    return f"STRPOS(LOWER(CAST({column_sql} AS VARCHAR)), LOWER({_quote_literal(value)})) > 0"


def dashboard_json_cell(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Decimal):
        converted = float(value)
        return converted if math.isfinite(converted) else None
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _dataset_value(value: Any, *keys: str, default: Any = None) -> Any:
    for key in keys:
        if isinstance(value, Mapping) and key in value and value[key] is not None:
            return value[key]
        if hasattr(value, key):
            result = getattr(value, key)
            if result is not None:
                return result
    return default


def _normalized_text(value: Any) -> str:
    if hasattr(value, "value"):
        value = value.value
    return str(value or "").strip().lower()


def _quote_identifier(identifier: str) -> str:
    return f'"{identifier.replace(chr(34), chr(34) * 2)}"'


def _quote_literal(value: str) -> str:
    return f"'{value.replace(chr(39), chr(39) * 2)}'"
