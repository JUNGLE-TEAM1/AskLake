import math
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from threading import Timer
from typing import Any
from urllib.parse import urlparse

import duckdb
from fastapi import status
import sqlglot

from app.core.errors import ApiError
from app.services.clickhouse_client import (
    ClickHouseClient,
    ClickHouseError,
    qualified_clickhouse_table,
    validate_clickhouse_identifier,
)
from app.services.iceberg_dataset_reader import (
    execute_trino_rows,
    iceberg_dataset_table,
    iceberg_dataset_user_columns,
    iceberg_read_reason,
)
from app.services.object_storage import object_storage_runtime
from app.services.trino_client import TrinoClient


DASHBOARD_CHART_ROW_LIMIT = 500
DASHBOARD_TABLE_ROW_LIMIT = 500
DASHBOARD_VALUE_ALIAS = "__asklake_widget_value"
MAX_DASHBOARD_INCREMENTAL_GROUPS = 10_000
DEFAULT_DASHBOARD_DUCKDB_MEMORY_BYTES = 256 * 1024 * 1024
DEFAULT_DASHBOARD_DUCKDB_TEMP_BYTES = 256 * 1024 * 1024
DEFAULT_DASHBOARD_DUCKDB_THREADS = 2
DEFAULT_DASHBOARD_QUERY_TIMEOUT_SECONDS = 15.0
DEFAULT_DASHBOARD_REMOTE_MAX_BYTES = 512 * 1024 * 1024
DEFAULT_DASHBOARD_REMOTE_MAX_OBJECTS = 256
SUPPORTED_STORAGE_FORMATS = {"csv", "json", "jsonl", "parquet"}
_DASHBOARD_TABLE_NAME = "asklake_dashboard_dataset"


@dataclass
class DashboardRemoteScanBudget:
    max_bytes: int
    max_objects: int
    used_bytes: int = 0
    used_objects: int = 0
    _seen_objects: set[tuple[str, str]] = field(default_factory=set, repr=False)

    @classmethod
    def from_environment(cls) -> "DashboardRemoteScanBudget":
        return cls(
            max_bytes=positive_int_env(
                "ASKLAKE_DASHBOARD_MAX_REMOTE_BYTES",
                DEFAULT_DASHBOARD_REMOTE_MAX_BYTES,
                maximum=4 * 1024 * 1024 * 1024,
            ),
            max_objects=positive_int_env(
                "ASKLAKE_DASHBOARD_MAX_REMOTE_OBJECTS",
                DEFAULT_DASHBOARD_REMOTE_MAX_OBJECTS,
                maximum=10_000,
            ),
        )

    @property
    def remaining_objects(self) -> int:
        return max(self.max_objects - self.used_objects, 0)

    def reserve_object(
        self,
        *,
        bucket: str,
        object_key: str,
        size_bytes: int,
        include_bytes: bool,
    ) -> None:
        identity = (bucket, object_key)
        if identity in self._seen_objects:
            return

        next_object_count = self.used_objects + 1
        next_byte_count = self.used_bytes + (max(size_bytes, 0) if include_bytes else 0)
        if next_object_count > self.max_objects:
            raise ValueError(
                f"Dashboard remote scan exceeds the {self.max_objects} object budget"
            )
        if next_byte_count > self.max_bytes:
            raise ValueError(
                f"Dashboard remote scan exceeds the {self.max_bytes} byte budget"
            )

        self._seen_objects.add(identity)
        self.used_objects = next_object_count
        self.used_bytes = next_byte_count


class DashboardDatasetQuerySession:
    """Run bounded widget queries against one physical Catalog dataset."""

    def __init__(
        self,
        dataset: Any,
        *,
        remote_budget: DashboardRemoteScanBudget | None = None,
        query_timeout_seconds: float | None = None,
        trino_client: TrinoClient | None = None,
        clickhouse_client: ClickHouseClient | None = None,
        iceberg_run_id: str | None = None,
    ) -> None:
        self.dataset = dataset
        self.query_timeout_seconds = (
            query_timeout_seconds
            if query_timeout_seconds is not None
            else dashboard_query_timeout_seconds()
        )
        self.connection: duckdb.DuckDBPyConnection | None = None
        self.trino_client: TrinoClient | None = None
        self.clickhouse_client: ClickHouseClient | None = None
        self._aggregate_where_sql = ""
        self.revision_delta_available = iceberg_run_id is None
        try:
            clickhouse_table = clickhouse_dataset_table(dataset)
            if clickhouse_table is not None:
                self.table = clickhouse_table
                self.query_table = f"{self.table} FINAL"
                self.clickhouse_client = clickhouse_client or ClickHouseClient()
                description = self.clickhouse_client.query(
                    f"DESCRIBE TABLE {self.table}",
                    timeout_seconds=self.query_timeout_seconds,
                )
                physical_columns = {
                    str(row[0])
                    for row in description.rows
                    if row and str(row[0]).strip()
                }
                self.columns = set(clickhouse_dataset_user_columns(dataset)).intersection(
                    physical_columns
                )
                if not self.columns:
                    raise ValueError("ClickHouse dataset does not expose Catalog user columns")
                self.revision_delta_available = False
                return

            iceberg_table = iceberg_dataset_table(dataset)
            if iceberg_table is not None:
                self.table = iceberg_table
                snapshot_id = dashboard_iceberg_snapshot_version(dataset)
                self.query_table = (
                    f"{self.table} FOR VERSION AS OF {snapshot_id}"
                    if snapshot_id is not None
                    else self.table
                )
                self.trino_client = trino_client or TrinoClient()
                description = execute_trino_rows(
                    self.trino_client,
                    f"DESCRIBE {self.table}",
                    timeout_seconds=self.query_timeout_seconds,
                )
                physical_columns = {
                    str(row[0])
                    for row in description.rows
                    if row and str(row[0]).strip()
                }
                if iceberg_run_id is not None and "_asklake_run_id" in physical_columns:
                    self._aggregate_where_sql = (
                        ' WHERE "_asklake_run_id" = '
                        f"{quote_duckdb_string_literal(iceberg_run_id)}"
                    )
                    self.revision_delta_available = True
                self.columns = set(iceberg_dataset_user_columns(dataset)).intersection(
                    physical_columns
                )
                if not self.columns:
                    raise ValueError("Iceberg dataset does not expose Catalog user columns")
                return

            self.connection = duckdb.connect(database=":memory:")
            self.table = quote_duckdb_identifier(_DASHBOARD_TABLE_NAME)
            self.query_table = self.table
            configure_dashboard_duckdb_resources(self.connection)
            storage_segments = dataset_storage_segments(dataset)
            if not storage_segments:
                raise dashboard_storage_error(dataset, "Dashboard widgets require physical dataset storage")
            resolved_remote_budget = remote_budget or DashboardRemoteScanBudget.from_environment()
            preflight_dashboard_s3_segments(dataset, storage_segments, resolved_remote_budget)
            register_dashboard_dataset(
                self.connection,
                self.table,
                storage_segments,
                query_timeout_seconds=self.query_timeout_seconds,
            )
            self.columns = {
                str(row[0])
                for row in execute_dashboard_query(
                    self.connection,
                    f"DESCRIBE SELECT * FROM {self.table}",
                    timeout_seconds=self.query_timeout_seconds,
                ).fetchall()
            }
        except ApiError:
            if self.connection is not None:
                self.connection.close()
            raise
        except (OSError, RuntimeError, ValueError, ClickHouseError, duckdb.Error) as error:
            if self.connection is not None:
                self.connection.close()
            if self.clickhouse_client is not None:
                self.clickhouse_client.close()
            raise dashboard_storage_error(dataset, iceberg_read_reason(error)) from error

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()
        if self.clickhouse_client is not None:
            self.clickhouse_client.close()

    def read_widget(self, widget_type: str, config: dict[str, Any]) -> dict[str, Any]:
        source_config = dashboard_source_config(config)
        if widget_type == "table":
            query = dashboard_table_query(self.query_table, self.columns, source_config)
            data_mode = "server_preview"
            runtime_config = dict(source_config)
        else:
            query, runtime_config = dashboard_aggregation_query(
                self.query_table,
                self.columns,
                widget_type,
                source_config,
            )
            data_mode = "server_aggregated"

        runtime_config["dataMode"] = data_mode
        runtime_config["sourceConfig"] = source_config
        try:
            if self.clickhouse_client is not None:
                clickhouse_queries = sqlglot.transpile(
                    query,
                    read="clickhouse",
                    write="clickhouse",
                )
                if len(clickhouse_queries) != 1:
                    raise ValueError("Dashboard ClickHouse query must contain one statement")
                result = self.clickhouse_client.query(
                    clickhouse_queries[0],
                    timeout_seconds=self.query_timeout_seconds,
                )
                column_names = result.columns
                raw_rows = result.rows
            elif self.trino_client is not None:
                result = execute_trino_rows(
                    self.trino_client,
                    query,
                    timeout_seconds=self.query_timeout_seconds,
                )
                column_names = result.columns
                raw_rows = result.rows
            else:
                if self.connection is None:
                    raise ValueError("Dashboard dataset query session is closed")
                cursor = execute_dashboard_query(
                    self.connection,
                    query,
                    timeout_seconds=self.query_timeout_seconds,
                )
                column_names = [str(description[0]) for description in (cursor.description or [])]
                raw_rows = cursor.fetchall()
            rows = [
                {
                    column_name: dashboard_json_cell(row[index])
                    for index, column_name in enumerate(column_names)
                }
                for row in raw_rows
            ]
        except (ApiError, RuntimeError, ValueError, ClickHouseError, duckdb.Error) as error:
            raise dashboard_storage_error(self.dataset, iceberg_read_reason(error)) from error
        return {"config": runtime_config, "data": rows}

    def read_aggregate_state(self, widget_type: str, config: dict[str, Any]) -> dict[str, Any] | None:
        """Read mergeable aggregate state; return None when cardinality is unsafe."""
        if widget_type == "table" or not self.revision_delta_available:
            return None
        source_config = dashboard_source_config(config)
        query, state_template = dashboard_aggregate_state_query(
            self.query_table,
            self.columns,
            widget_type,
            source_config,
            where_sql=self._aggregate_where_sql,
        )
        try:
            if self.trino_client is not None:
                result = execute_trino_rows(
                    self.trino_client,
                    query,
                    timeout_seconds=self.query_timeout_seconds,
                )
                column_names = result.columns
                raw_rows = result.rows
            else:
                if self.connection is None:
                    raise ValueError("Dashboard dataset query session is closed")
                cursor = execute_dashboard_query(
                    self.connection,
                    query,
                    timeout_seconds=self.query_timeout_seconds,
                )
                column_names = [str(description[0]) for description in (cursor.description or [])]
                raw_rows = cursor.fetchall()
            rows = [
                {
                    column_name: dashboard_json_cell(row[index])
                    for index, column_name in enumerate(column_names)
                }
                for row in raw_rows
            ]
        except (ApiError, RuntimeError, ValueError, duckdb.Error) as error:
            raise dashboard_storage_error(self.dataset, iceberg_read_reason(error)) from error
        if len(rows) > MAX_DASHBOARD_INCREMENTAL_GROUPS:
            return None
        return {**state_template, "rows": rows}


def dashboard_source_config(config: dict[str, Any]) -> dict[str, Any]:
    source = config.get("sourceConfig") or config.get("source_config")
    if isinstance(source, dict):
        return dict(source)
    return {
        key: value
        for key, value in config.items()
        if key not in {"dataMode", "data_mode", "sourceConfig", "source_config"}
    }


def clickhouse_dataset_table(dataset: Any) -> str | None:
    storage_format = str(
        dataset_value(dataset, "storage_format", "storageFormat", default="") or ""
    ).strip().casefold()
    if storage_format != "clickhouse":
        return None
    mapping = dataset_value(dataset, "clickhouse_table", "clickhouseTable")
    if hasattr(mapping, "model_dump"):
        mapping = mapping.model_dump(mode="json", by_alias=True)
    if not isinstance(mapping, Mapping):
        raise ValueError("ClickHouse dataset does not have a physical table mapping")
    database = validate_clickhouse_identifier(mapping.get("database"))
    table = validate_clickhouse_identifier(mapping.get("table"))
    return qualified_clickhouse_table(database, table)


def clickhouse_dataset_user_columns(dataset: Any) -> list[str]:
    schema = dataset_value(dataset, "schema_", "schema", default=[]) or []
    columns: list[str] = []
    for item in schema:
        name = item[0] if isinstance(item, (list, tuple)) and item else None
        normalized = str(name or "").strip()
        if normalized and not normalized.casefold().startswith("_asklake_") and normalized not in columns:
            columns.append(normalized)
    return columns


def dashboard_iceberg_snapshot_version(dataset: Any) -> str | None:
    value = dataset_value(dataset, "iceberg_snapshot_id", "icebergSnapshotId")
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized or not normalized.lstrip("-").isdigit():
        raise ValueError("Catalog dataset has an invalid Iceberg snapshot ID")
    return str(int(normalized))


def dashboard_table_query(table: str, columns: set[str], config: dict[str, Any]) -> str:
    requested_columns = config.get("columns")
    selected = (
        [value for value in requested_columns if isinstance(value, str) and value]
        if isinstance(requested_columns, list)
        else []
    )
    if not selected:
        selected = sorted(columns)[:20]
    if not selected:
        raise ValueError("Dashboard table has no readable columns")
    for column in selected:
        require_dashboard_column(column, columns)

    select_sql = ", ".join(quote_duckdb_identifier(column) for column in selected)
    sort_key = config.get("sortKey") or config.get("sort_key")
    order_sql = ""
    if isinstance(sort_key, str) and sort_key:
        require_dashboard_column(sort_key, columns)
        direction = str(config.get("sortDirection") or config.get("sort_direction") or "asc").lower()
        order_sql = f" ORDER BY {quote_duckdb_identifier(sort_key)} {'DESC' if direction == 'desc' else 'ASC'} NULLS LAST"
    limit = dashboard_row_limit(config.get("limit"), default=100, maximum=DASHBOARD_TABLE_ROW_LIMIT)
    return f"SELECT {select_sql} FROM {table}{order_sql} LIMIT {limit}"


def dashboard_aggregation_query(
    table: str,
    columns: set[str],
    widget_type: str,
    config: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    aggregation = str(config.get("aggregation") or "sum").lower()
    if aggregation not in {"sum", "avg", "count", "min", "max"}:
        raise ValueError(f"Unsupported dashboard aggregation: {aggregation}")

    dimension_specs, value_config_key = dashboard_widget_query_fields(widget_type, config)
    source_alias = "__asklake_source"
    source_table = dashboard_aliased_source_table(table, source_alias)
    select_parts: list[str] = []
    group_expressions: list[str] = []
    dimension_aliases: list[str] = []
    for column, date_unit in dimension_specs:
        if not column:
            continue
        require_dashboard_column(column, columns)
        expression = qualified_dashboard_column(column, source_alias)
        if date_unit in {"day", "month", "year"}:
            expression = f"date_trunc('{date_unit}', TRY_CAST({expression} AS TIMESTAMP))"
        select_parts.append(f"{expression} AS {quote_duckdb_identifier(column)}")
        dimension_aliases.append(column)
        group_expressions.append(expression)

    configured_value_key = config.get(value_config_key) or config.get(camel_to_snake_key(value_config_key))
    if aggregation != "count":
        if not isinstance(configured_value_key, str) or not configured_value_key:
            raise ValueError(f"Dashboard {widget_type} requires {value_config_key}")
        require_dashboard_column(configured_value_key, columns)

    value_alias = (
        DASHBOARD_VALUE_ALIAS
        if aggregation == "count" or configured_value_key in dimension_aliases
        else str(configured_value_key)
    )
    select_parts.append(
        f"{dashboard_aggregate_expression(aggregation, configured_value_key, source_alias)} "
        f"AS {quote_duckdb_identifier(value_alias)}"
    )

    runtime_config = dict(config)
    if aggregation == "count":
        runtime_config["aggregation"] = "sum"
    if value_alias != configured_value_key:
        runtime_config[value_config_key] = value_alias

    group_sql = f" GROUP BY {', '.join(group_expressions)}" if group_expressions else ""
    if widget_type in {"line_chart", "area_chart", "heatmap_chart"} and dimension_aliases:
        order_sql = " ORDER BY " + ", ".join(
            f"{quote_duckdb_identifier(alias)} ASC NULLS LAST" for alias in dimension_aliases
        )
    elif dimension_aliases:
        order_sql = f" ORDER BY {quote_duckdb_identifier(value_alias)} DESC NULLS LAST"
    else:
        order_sql = ""
    limit_sql = f" LIMIT {DASHBOARD_CHART_ROW_LIMIT}" if dimension_aliases else ""
    return f"SELECT {', '.join(select_parts)} FROM {source_table}{group_sql}{order_sql}{limit_sql}", runtime_config


def dashboard_aggregate_state_query(
    table: str,
    columns: set[str],
    widget_type: str,
    config: dict[str, Any],
    *,
    where_sql: str = "",
) -> tuple[str, dict[str, Any]]:
    aggregation = str(config.get("aggregation") or "sum").lower()
    if aggregation not in {"sum", "avg", "count", "min", "max"}:
        raise ValueError(f"Unsupported dashboard aggregation: {aggregation}")

    dimension_specs, value_config_key = dashboard_widget_query_fields(widget_type, config)
    source_alias = "__asklake_source"
    source_table = dashboard_aliased_source_table(table, source_alias)
    select_parts: list[str] = []
    group_expressions: list[str] = []
    dimension_keys: list[str] = []
    for column, date_unit in dimension_specs:
        if not column:
            continue
        require_dashboard_column(column, columns)
        expression = qualified_dashboard_column(column, source_alias)
        if date_unit in {"day", "month", "year"}:
            expression = f"date_trunc('{date_unit}', TRY_CAST({expression} AS TIMESTAMP))"
        select_parts.append(f"{expression} AS {quote_duckdb_identifier(column)}")
        group_expressions.append(expression)
        dimension_keys.append(column)

    configured_value_key = config.get(value_config_key) or config.get(camel_to_snake_key(value_config_key))
    if aggregation != "count":
        if not isinstance(configured_value_key, str) or not configured_value_key:
            raise ValueError(f"Dashboard {widget_type} requires {value_config_key}")
        require_dashboard_column(configured_value_key, columns)

    value_alias = (
        DASHBOARD_VALUE_ALIAS
        if aggregation == "count" or configured_value_key in dimension_keys
        else str(configured_value_key)
    )
    if aggregation == "count":
        select_parts.extend([
            "COUNT(*) AS __asklake_state_count",
            "CAST(COUNT(*) AS DOUBLE) AS __asklake_state_sum",
            "CAST(NULL AS DOUBLE) AS __asklake_state_min",
            "CAST(NULL AS DOUBLE) AS __asklake_state_max",
        ])
    else:
        numeric_value = (
            f"TRY_CAST({qualified_dashboard_column(str(configured_value_key), source_alias)} "
            "AS DOUBLE)"
        )
        select_parts.extend([
            f"COUNT({numeric_value}) AS __asklake_state_count",
            f"SUM({numeric_value}) AS __asklake_state_sum",
            f"MIN({numeric_value}) AS __asklake_state_min",
            f"MAX({numeric_value}) AS __asklake_state_max",
        ])
    group_sql = f" GROUP BY {', '.join(group_expressions)}" if group_expressions else ""
    query = (
        f"SELECT {', '.join(select_parts)} FROM {source_table}{where_sql}{group_sql} "
        f"LIMIT {MAX_DASHBOARD_INCREMENTAL_GROUPS + 1}"
    )
    return query, {
        "version": 1,
        "widgetType": widget_type,
        "aggregation": aggregation,
        "dimensionKeys": dimension_keys,
        "valueConfigKey": value_config_key,
        "valueAlias": value_alias,
        "sourceConfig": config,
    }


def dashboard_widget_supports_incremental_merge(
    widget_type: str,
    config: dict[str, Any],
) -> bool:
    if widget_type == "table":
        return False
    aggregation = str(config.get("aggregation") or "sum").strip().lower()
    return aggregation in {"count", "sum", "avg"}


def merge_dashboard_aggregate_states(
    current: dict[str, Any],
    delta: dict[str, Any],
) -> dict[str, Any] | None:
    identity_fields = ("version", "widgetType", "aggregation", "dimensionKeys", "valueConfigKey", "valueAlias")
    if any(current.get(field) != delta.get(field) for field in identity_fields):
        return None
    dimension_keys = [str(value) for value in current.get("dimensionKeys") or []]
    merged: dict[str, dict[str, Any]] = {}

    def merge_row(row: dict[str, Any]) -> None:
        identity = json.dumps(
            [row.get(key) for key in dimension_keys],
            ensure_ascii=True,
            separators=(",", ":"),
            default=str,
        )
        existing = merged.get(identity)
        if existing is None:
            merged[identity] = dict(row)
            return
        existing_count = int(existing.get("__asklake_state_count") or 0)
        delta_count = int(row.get("__asklake_state_count") or 0)
        existing["__asklake_state_count"] = existing_count + delta_count
        existing["__asklake_state_sum"] = (
            numeric_state(existing.get("__asklake_state_sum")) + numeric_state(row.get("__asklake_state_sum"))
            if existing_count + delta_count > 0
            else None
        )
        existing["__asklake_state_min"] = state_min(existing.get("__asklake_state_min"), row.get("__asklake_state_min"))
        existing["__asklake_state_max"] = state_max(existing.get("__asklake_state_max"), row.get("__asklake_state_max"))

    for item in [*(current.get("rows") or []), *(delta.get("rows") or [])]:
        if isinstance(item, dict):
            merge_row(item)
    if len(merged) > MAX_DASHBOARD_INCREMENTAL_GROUPS:
        return None
    return {**current, "rows": list(merged.values())}


def dashboard_result_from_aggregate_state(state: dict[str, Any]) -> dict[str, Any]:
    aggregation = str(state.get("aggregation") or "sum")
    widget_type = str(state.get("widgetType") or "")
    dimension_keys = [str(value) for value in state.get("dimensionKeys") or []]
    value_alias = str(state.get("valueAlias") or DASHBOARD_VALUE_ALIAS)
    value_config_key = str(state.get("valueConfigKey") or "valueKey")
    source_config = dict(state.get("sourceConfig") or {})

    data: list[dict[str, Any]] = []
    for state_row in state.get("rows") or []:
        if not isinstance(state_row, dict):
            continue
        row = {key: state_row.get(key) for key in dimension_keys}
        count = int(state_row.get("__asklake_state_count") or 0)
        total = numeric_state(state_row.get("__asklake_state_sum"))
        if aggregation == "count":
            value: Any = count
        elif aggregation == "avg":
            value = total / count if count else None
        elif aggregation == "min":
            value = state_row.get("__asklake_state_min")
        elif aggregation == "max":
            value = state_row.get("__asklake_state_max")
        else:
            value = state_row.get("__asklake_state_sum")
        row[value_alias] = value
        data.append(row)

    if dimension_keys:
        if widget_type in {"line_chart", "area_chart", "heatmap_chart"}:
            data.sort(key=lambda row: tuple(sortable_dashboard_value(row.get(key)) for key in dimension_keys))
        else:
            data.sort(key=lambda row: sortable_dashboard_number(row.get(value_alias)), reverse=True)
        data = (
            data[-DASHBOARD_CHART_ROW_LIMIT:]
            if widget_type in {"line_chart", "area_chart"}
            else data[:DASHBOARD_CHART_ROW_LIMIT]
        )

    runtime_config = dict(source_config)
    if aggregation == "count":
        runtime_config["aggregation"] = "sum"
    if value_alias != source_config.get(value_config_key):
        runtime_config[value_config_key] = value_alias
    runtime_config["dataMode"] = "server_aggregated"
    runtime_config["sourceConfig"] = source_config
    return {"config": runtime_config, "data": data}


def numeric_state(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    return parsed if math.isfinite(parsed) else 0.0


def state_min(left: Any, right: Any) -> Any:
    values = [value for value in (left, right) if value is not None]
    return min(values) if values else None


def state_max(left: Any, right: Any) -> Any:
    values = [value for value in (left, right) if value is not None]
    return max(values) if values else None


def sortable_dashboard_value(value: Any) -> tuple[int, str]:
    return (1, "") if value is None else (0, str(value))


def sortable_dashboard_number(value: Any) -> float:
    if value is None:
        return float("-inf")
    return numeric_state(value)


def dashboard_widget_query_fields(
    widget_type: str,
    config: dict[str, Any],
) -> tuple[list[tuple[str, str | None]], str]:
    def text(key: str) -> str:
        value = config.get(key) or config.get(camel_to_snake_key(key))
        return str(value) if isinstance(value, str) else ""

    def required(key: str) -> str:
        value = text(key)
        if not value:
            raise ValueError(f"Dashboard {widget_type} requires {key}")
        return value

    if widget_type == "metric":
        return [], "valueKey"
    if widget_type == "bar_chart":
        return [(required("xKey"), None), (text("groupKey"), None)], "yKey"
    if widget_type in {"line_chart", "area_chart"}:
        return [(required("xKey"), text("dateUnit") or None), (text("seriesKey"), None)], "yKey"
    if widget_type in {"donut_chart", "pie_chart", "treemap_chart"}:
        return [(required("labelKey"), None)], "valueKey"
    if widget_type == "radial_bar_chart":
        return [(text("labelKey"), None)], "valueKey"
    if widget_type == "heatmap_chart":
        return [(required("xKey"), None), (required("yKey"), None)], "valueKey"
    raise ValueError(f"Unsupported dashboard widget type: {widget_type}")


def dashboard_aggregate_expression(
    aggregation: str,
    value_key: Any,
    source_alias: str | None = None,
) -> str:
    if aggregation == "count":
        return "COUNT(*)"
    column = qualified_dashboard_column(str(value_key), source_alias)
    function = {"sum": "SUM", "avg": "AVG", "min": "MIN", "max": "MAX"}[aggregation]
    return f"{function}(TRY_CAST({column} AS DOUBLE))"


def qualified_dashboard_column(column: str, source_alias: str | None = None) -> str:
    quoted_column = quote_duckdb_identifier(column)
    if not source_alias:
        return quoted_column
    return f"{quote_duckdb_identifier(source_alias)}.{quoted_column}"


def dashboard_aliased_source_table(table: str, source_alias: str) -> str:
    normalized = table.rstrip()
    alias_sql = f"AS {quote_duckdb_identifier(source_alias)}"
    if normalized.casefold().endswith(" final"):
        return f"{normalized[:-6].rstrip()} {alias_sql} FINAL"
    return f"{normalized} {alias_sql}"


def require_dashboard_column(column: str, columns: set[str]) -> None:
    if column not in columns:
        raise ValueError(f"Dashboard column does not exist: {column}")


def dashboard_row_limit(value: Any, *, default: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(maximum, parsed))


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


def register_dashboard_dataset(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    storage_segments: list[tuple[str, str]],
    *,
    query_timeout_seconds: float,
) -> None:
    if any(is_s3_storage_location(location) for location, _storage_format in storage_segments):
        configure_duckdb_s3(connection)

    sources: list[str] = []
    for storage_location, storage_format in storage_segments:
        if storage_format not in SUPPORTED_STORAGE_FORMATS:
            raise ValueError(f"Unsupported storage format: {storage_format or '-'}")
        scan_path = (
            s3_scan_path(storage_location, storage_format)
            if is_s3_storage_location(storage_location)
            else local_scan_path(storage_location, storage_format)
        )
        sources.append(duckdb_scan_source(scan_path, storage_format))

    if not sources:
        raise ValueError("Dashboard dataset has no readable physical segments")
    union_sql = " UNION ALL BY NAME ".join(f"SELECT * FROM {source}" for source in sources)
    execute_dashboard_query(
        connection,
        f"CREATE TEMP VIEW {table} AS {union_sql}",
        timeout_seconds=query_timeout_seconds,
    )


def dataset_storage_segments(dataset: Any) -> list[tuple[str, str]]:
    fallback_format = normalize_storage_format(dataset_value(dataset, "storage_format", "storageFormat"))
    runs = dataset_value(dataset, "materialization_runs", "materializationRuns", default=[])
    active_runs: list[Any] = []
    if isinstance(runs, list):
        for run in runs:
            if normalized_text(dataset_value(run, "status")) != "success":
                continue
            active_runs.append(run)
            if canonical_materialization_mode(run) == "snapshot":
                break

    segments: list[tuple[str, str]] = []
    for run in reversed(active_runs):
        location = clean_text(dataset_value(run, "storage_location", "storageLocation"))
        storage_format = normalize_storage_format(
            dataset_value(run, "storage_format", "storageFormat") or fallback_format,
            location,
        )
        segment = (location, storage_format)
        if location and location not in {"-", "pending"} and segment not in segments:
            segments.append(segment)
    if segments:
        return segments

    fallback_location = clean_text(dataset_value(dataset, "storage_location", "storageLocation"))
    if not fallback_location or fallback_location in {"-", "pending"}:
        return []
    return [(fallback_location, normalize_storage_format(fallback_format, fallback_location))]


def dataset_value(value: Any, *keys: str, default: Any = None) -> Any:
    for key in keys:
        if isinstance(value, Mapping) and key in value and value[key] is not None:
            return value[key]
        if hasattr(value, key):
            result = getattr(value, key)
            if result is not None:
                return result
    return default


def normalize_storage_format(value: Any, storage_location: str = "") -> str:
    normalized = normalized_text(value)
    if normalized == "ndjson":
        return "jsonl"
    if normalized:
        return normalized
    suffix = Path(urlparse(storage_location).path).suffix.lower().lstrip(".")
    return "jsonl" if suffix == "ndjson" else suffix


def normalized_text(value: Any) -> str:
    if hasattr(value, "value"):
        value = value.value
    return str(value or "").strip().lower()


def canonical_materialization_mode(run: Any) -> str:
    explicit_mode = normalized_text(
        dataset_value(run, "materializationMode")
        or dataset_value(run, "materialization_mode")
    )
    if explicit_mode:
        return explicit_mode if explicit_mode in {"snapshot", "delta"} else "snapshot"

    source_kind = normalized_text(
        dataset_value(run, "sourceKind")
        or dataset_value(run, "source_kind")
    )
    return "delta" if source_kind == "kafka" else "snapshot"


def clean_text(value: Any) -> str:
    if hasattr(value, "value"):
        value = value.value
    return str(value or "").strip()


def local_scan_path(storage_location: str, storage_format: str) -> str:
    storage_path = Path(storage_location)
    if not storage_path.exists():
        raise FileNotFoundError(f"Storage location does not exist: {storage_location}")
    if storage_path.is_file():
        return storage_path.resolve().as_posix()
    matching_files = sorted(storage_path.rglob(f"*.{storage_format}"))
    if not matching_files:
        raise FileNotFoundError(
            f"{storage_format.upper()} storage does not contain readable files: {storage_location}"
        )
    return (storage_path.resolve() / "**" / f"*.{storage_format}").as_posix()


def duckdb_scan_source(scan_path: str, storage_format: str) -> str:
    path = quote_duckdb_string_literal(scan_path)
    if storage_format == "parquet":
        return f"read_parquet({path}, union_by_name = true, hive_partitioning = true)"
    if storage_format == "csv":
        return f"read_csv_auto({path}, header = true, union_by_name = true, hive_partitioning = true)"
    return f"read_json_auto({path}, union_by_name = true, hive_partitioning = true)"


def is_s3_storage_location(value: str) -> bool:
    return bool(re.match(r"^s3a?://", value, re.IGNORECASE))


def s3_scan_path(storage_location: str, storage_format: str) -> str:
    normalized = re.sub(r"^s3a://", "s3://", storage_location.strip(), flags=re.IGNORECASE).rstrip("/")
    suffix = f".{storage_format}"
    return normalized if normalized.lower().endswith(suffix) else f"{normalized}/**/*{suffix}"


def preflight_dashboard_s3_segments(
    dataset: Any,
    storage_segments: list[tuple[str, str]],
    budget: DashboardRemoteScanBudget,
) -> None:
    remote_segments = [
        parse_dashboard_s3_segment(storage_location, storage_format)
        for storage_location, storage_format in storage_segments
        if is_s3_storage_location(storage_location)
    ]
    if not remote_segments:
        return

    try:
        for bucket, _prefix, _exact_key, _storage_format in remote_segments:
            require_allowed_dashboard_bucket(bucket)
        client = build_dashboard_s3_client()
        for bucket, prefix, exact_key, storage_format in remote_segments:
            matched_objects = list_dashboard_s3_segment_objects(
                client,
                bucket=bucket,
                prefix=prefix,
                exact_key=exact_key,
                storage_format=storage_format,
                budget=budget,
            )
            if matched_objects == 0:
                raise ValueError(
                    f"Remote dashboard segment has no .{storage_format} objects"
                )
    except ApiError:
        raise
    except Exception as error:
        raise dashboard_storage_error(dataset, str(error)) from error


def parse_dashboard_s3_segment(
    storage_location: str,
    storage_format: str,
) -> tuple[str, str, str | None, str]:
    normalized_location = re.sub(
        r"^s3a://",
        "s3://",
        storage_location.strip(),
        flags=re.IGNORECASE,
    )
    parsed = urlparse(normalized_location)
    bucket = parsed.netloc.strip().casefold()
    key = parsed.path.lstrip("/").rstrip("/")
    if not bucket or not key:
        raise ValueError("Remote dashboard storage location is invalid")
    suffix = f".{storage_format.casefold()}"
    exact_key = key if key.casefold().endswith(suffix) else None
    prefix = exact_key or f"{key}/"
    return bucket, prefix, exact_key, storage_format.casefold()


def list_dashboard_s3_segment_objects(
    client: Any,
    *,
    bucket: str,
    prefix: str,
    exact_key: str | None,
    storage_format: str,
    budget: DashboardRemoteScanBudget,
) -> int:
    continuation_token: str | None = None
    matched_objects = 0
    suffix = f".{storage_format}"
    while True:
        request: dict[str, Any] = {
            "Bucket": bucket,
            "Prefix": prefix,
            "MaxKeys": min(1000, max(1, budget.remaining_objects + 1)),
        }
        if continuation_token:
            request["ContinuationToken"] = continuation_token
        response = client.list_objects_v2(**request)
        for item in response.get("Contents") or []:
            object_key = str(item.get("Key") or "")
            if not object_key:
                continue
            is_scan_object = (
                object_key == exact_key
                if exact_key is not None
                else object_key.startswith(prefix) and object_key.casefold().endswith(suffix)
            )
            budget.reserve_object(
                bucket=bucket,
                object_key=object_key,
                size_bytes=max(int(item.get("Size") or 0), 0),
                include_bytes=is_scan_object,
            )
            if is_scan_object:
                matched_objects += 1
        if not response.get("IsTruncated"):
            return matched_objects
        continuation_token = str(response.get("NextContinuationToken") or "").strip()
        if not continuation_token:
            raise ValueError("Remote dashboard object listing did not provide a continuation token")


def require_allowed_dashboard_bucket(bucket: str) -> None:
    configured_buckets = (
        os.environ.get("S3_ALLOWED_BUCKETS")
        or os.environ.get("ASKLAKE_S3_ALLOWED_BUCKETS")
        or os.environ.get("AWS_S3_ALLOWED_BUCKETS")
        or os.environ.get("MINIO_BUCKET")
        or "asklake-output"
    )
    allowed_buckets = {
        value.strip().casefold()
        for value in configured_buckets.split(",")
        if value.strip()
    }
    if bucket.casefold() not in allowed_buckets:
        raise ValueError("Remote dashboard bucket is not allowlisted")


def build_dashboard_s3_client() -> Any:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise RuntimeError("Python S3 client dependency is not installed") from error

    runtime = object_storage_runtime()
    kwargs: dict[str, Any] = {
        "config": Config(
            connect_timeout=5,
            read_timeout=15,
            retries={"max_attempts": 2, "mode": "standard"},
            s3={"addressing_style": "path" if runtime.force_path_style else "auto"},
        ),
        **runtime.boto3_kwargs(),
    }
    return boto3.client("s3", **kwargs)


def configure_dashboard_duckdb_resources(connection: duckdb.DuckDBPyConnection) -> None:
    memory_bytes = positive_int_env(
        "ASKLAKE_DASHBOARD_DUCKDB_MEMORY_BYTES",
        DEFAULT_DASHBOARD_DUCKDB_MEMORY_BYTES,
        maximum=2 * 1024 * 1024 * 1024,
    )
    temp_bytes = positive_int_env(
        "ASKLAKE_DASHBOARD_DUCKDB_TEMP_BYTES",
        DEFAULT_DASHBOARD_DUCKDB_TEMP_BYTES,
        maximum=2 * 1024 * 1024 * 1024,
    )
    threads = positive_int_env(
        "ASKLAKE_DASHBOARD_DUCKDB_THREADS",
        DEFAULT_DASHBOARD_DUCKDB_THREADS,
        maximum=8,
    )
    connection.execute(f"SET memory_limit = '{memory_bytes}B'")
    connection.execute(f"SET max_temp_directory_size = '{temp_bytes}B'")
    connection.execute(f"SET threads = {threads}")
    connection.execute("SET preserve_insertion_order = false")
    connection.execute("SET autoinstall_known_extensions = false")
    connection.execute("SET autoload_known_extensions = false")


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


def dashboard_query_timeout_seconds() -> float:
    raw_value = str(os.environ.get("ASKLAKE_DASHBOARD_QUERY_TIMEOUT_SECONDS") or "").strip()
    try:
        value = float(raw_value) if raw_value else DEFAULT_DASHBOARD_QUERY_TIMEOUT_SECONDS
    except ValueError:
        return DEFAULT_DASHBOARD_QUERY_TIMEOUT_SECONDS
    if not math.isfinite(value) or value <= 0:
        return DEFAULT_DASHBOARD_QUERY_TIMEOUT_SECONDS
    return min(value, 60.0)


def positive_int_env(name: str, default: int, *, maximum: int) -> int:
    raw_value = str(os.environ.get(name) or "").strip()
    try:
        value = int(raw_value) if raw_value else default
    except ValueError:
        return default
    if value <= 0:
        return default
    return min(value, maximum)


def configure_duckdb_s3(connection: duckdb.DuckDBPyConnection) -> None:
    try:
        connection.execute("LOAD httpfs")
    except duckdb.Error as error:
        raise RuntimeError(
            "DuckDB httpfs is not installed in the backend image"
        ) from error

    runtime = object_storage_runtime()
    if runtime.provider == "aws":
        try:
            connection.execute("LOAD aws")
            connection.execute(
                "CREATE OR REPLACE SECRET asklake_s3_runtime "
                "(TYPE s3, PROVIDER credential_chain, REFRESH auto, "
                f"REGION {quote_duckdb_string_literal(runtime.region)})"
            )
        except duckdb.Error as error:
            raise RuntimeError(
                "DuckDB AWS credential-chain support is not installed or IAM credentials are unavailable"
            ) from error
        return

    set_duckdb_option(connection, "s3_region", runtime.region)
    if runtime.access_key:
        set_duckdb_option(connection, "s3_access_key_id", runtime.access_key)
    if runtime.secret_key:
        set_duckdb_option(connection, "s3_secret_access_key", runtime.secret_key)
    if runtime.endpoint:
        parsed = urlparse(runtime.endpoint if "://" in runtime.endpoint else f"https://{runtime.endpoint}")
        endpoint_host = parsed.netloc or parsed.path
        set_duckdb_option(connection, "s3_endpoint", endpoint_host.rstrip("/"))
        connection.execute(f"SET s3_use_ssl = {'true' if parsed.scheme.lower() == 'https' else 'false'}")

    set_duckdb_option(connection, "s3_url_style", "path" if runtime.force_path_style else "vhost")


def set_duckdb_option(connection: duckdb.DuckDBPyConnection, name: str, value: str) -> None:
    connection.execute(f"SET {name} = {quote_duckdb_string_literal(value)}")


def dashboard_storage_error(dataset: Any, reason: str) -> ApiError:
    return ApiError(
        "DASHBOARD_DATA_UNAVAILABLE",
        "Dashboard widget physical data could not be read",
        status.HTTP_503_SERVICE_UNAVAILABLE,
        {
            "datasetId": str(dataset_value(dataset, "id") or ""),
            "reason": reason[:500],
            "storageFormat": str(dataset_value(dataset, "storage_format", "storageFormat") or ""),
            "storageLocation": str(dataset_value(dataset, "storage_location", "storageLocation") or ""),
        },
    )


def camel_to_snake_key(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


def quote_duckdb_identifier(identifier: str) -> str:
    return f'"{identifier.replace(chr(34), chr(34) * 2)}"'


def quote_duckdb_string_literal(value: str) -> str:
    return f"'{value.replace(chr(39), chr(39) * 2)}'"
