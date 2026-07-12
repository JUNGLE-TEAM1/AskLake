import math
import os
import re
from collections.abc import Mapping
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import duckdb
from fastapi import status

from app.core.errors import ApiError


DASHBOARD_CHART_ROW_LIMIT = 500
DASHBOARD_TABLE_ROW_LIMIT = 500
DASHBOARD_VALUE_ALIAS = "__asklake_widget_value"
SUPPORTED_STORAGE_FORMATS = {"csv", "json", "jsonl", "parquet"}
_DASHBOARD_TABLE_NAME = "asklake_dashboard_dataset"


class DashboardDatasetQuerySession:
    """Run bounded widget queries against one physical Catalog dataset."""

    def __init__(self, dataset: Any) -> None:
        self.dataset = dataset
        self.connection = duckdb.connect(database=":memory:")
        self.table = quote_duckdb_identifier(_DASHBOARD_TABLE_NAME)
        try:
            storage_segments = dataset_storage_segments(dataset)
            if not storage_segments:
                raise dashboard_storage_error(dataset, "Dashboard widgets require physical dataset storage")
            register_dashboard_dataset(self.connection, self.table, storage_segments)
            self.columns = {
                str(row[0])
                for row in self.connection.execute(f"DESCRIBE SELECT * FROM {self.table}").fetchall()
            }
        except ApiError:
            self.connection.close()
            raise
        except (OSError, ValueError, duckdb.Error) as error:
            self.connection.close()
            raise dashboard_storage_error(dataset, str(error)) from error

    def close(self) -> None:
        self.connection.close()

    def read_widget(self, widget_type: str, config: dict[str, Any]) -> dict[str, Any]:
        source_config = dashboard_source_config(config)
        if widget_type == "table":
            query = dashboard_table_query(self.table, self.columns, source_config)
            data_mode = "server_preview"
            runtime_config = dict(source_config)
        else:
            query, runtime_config = dashboard_aggregation_query(
                self.table,
                self.columns,
                widget_type,
                source_config,
            )
            data_mode = "server_aggregated"

        runtime_config["dataMode"] = data_mode
        runtime_config["sourceConfig"] = source_config
        try:
            cursor = self.connection.execute(query)
            column_names = [str(description[0]) for description in (cursor.description or [])]
            rows = [
                {
                    column_name: dashboard_json_cell(row[index])
                    for index, column_name in enumerate(column_names)
                }
                for row in cursor.fetchall()
            ]
        except duckdb.Error as error:
            raise dashboard_storage_error(self.dataset, str(error)) from error
        return {"config": runtime_config, "data": rows}


def dashboard_source_config(config: dict[str, Any]) -> dict[str, Any]:
    source = config.get("sourceConfig") or config.get("source_config")
    if isinstance(source, dict):
        return dict(source)
    return {
        key: value
        for key, value in config.items()
        if key not in {"dataMode", "data_mode", "sourceConfig", "source_config"}
    }


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
    select_parts: list[str] = []
    dimension_aliases: list[str] = []
    for column, date_unit in dimension_specs:
        if not column:
            continue
        require_dashboard_column(column, columns)
        expression = quote_duckdb_identifier(column)
        if date_unit in {"day", "month", "year"}:
            expression = f"date_trunc('{date_unit}', TRY_CAST({expression} AS TIMESTAMP))"
        select_parts.append(f"{expression} AS {quote_duckdb_identifier(column)}")
        dimension_aliases.append(column)

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
        f"{dashboard_aggregate_expression(aggregation, configured_value_key)} "
        f"AS {quote_duckdb_identifier(value_alias)}"
    )

    runtime_config = dict(config)
    if aggregation == "count":
        runtime_config["aggregation"] = "sum"
    if value_alias != configured_value_key:
        runtime_config[value_config_key] = value_alias

    group_sql = " GROUP BY ALL" if dimension_aliases else ""
    if widget_type in {"line_chart", "area_chart", "heatmap_chart"} and dimension_aliases:
        order_sql = " ORDER BY " + ", ".join(
            f"{quote_duckdb_identifier(alias)} ASC NULLS LAST" for alias in dimension_aliases
        )
    elif dimension_aliases:
        order_sql = f" ORDER BY {quote_duckdb_identifier(value_alias)} DESC NULLS LAST"
    else:
        order_sql = ""
    limit_sql = f" LIMIT {DASHBOARD_CHART_ROW_LIMIT}" if dimension_aliases else ""
    return f"SELECT {', '.join(select_parts)} FROM {table}{group_sql}{order_sql}{limit_sql}", runtime_config


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


def dashboard_aggregate_expression(aggregation: str, value_key: Any) -> str:
    if aggregation == "count":
        return "COUNT(*)"
    column = quote_duckdb_identifier(str(value_key))
    function = {"sum": "SUM", "avg": "AVG", "min": "MIN", "max": "MAX"}[aggregation]
    return f"{function}(TRY_CAST({column} AS DOUBLE))"


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
    connection.execute(f"CREATE TEMP VIEW {table} AS {union_sql}")


def dataset_storage_segments(dataset: Any) -> list[tuple[str, str]]:
    fallback_format = normalize_storage_format(dataset_value(dataset, "storage_format", "storageFormat"))
    runs = dataset_value(dataset, "materialization_runs", "materializationRuns", default=[])
    active_runs: list[Any] = []
    if isinstance(runs, list):
        for run in runs:
            if normalized_text(dataset_value(run, "status")) != "success":
                continue
            active_runs.append(run)
            mode = normalized_text(dataset_value(run, "materialization_mode", "materializationMode")) or "snapshot"
            if mode == "snapshot":
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


def configure_duckdb_s3(connection: duckdb.DuckDBPyConnection) -> None:
    try:
        connection.execute("LOAD httpfs")
    except duckdb.Error:
        connection.execute("INSTALL httpfs")
        connection.execute("LOAD httpfs")

    endpoint = str(os.environ.get("S3_ENDPOINT") or os.environ.get("MINIO_ENDPOINT") or "").strip()
    access_key = str(os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("MINIO_ACCESS_KEY") or "").strip()
    secret_key = str(os.environ.get("AWS_SECRET_ACCESS_KEY") or os.environ.get("MINIO_SECRET_KEY") or "").strip()
    session_token = str(os.environ.get("AWS_SESSION_TOKEN") or "").strip()
    region = str(os.environ.get("AWS_REGION") or os.environ.get("MINIO_REGION") or "us-east-1").strip()

    set_duckdb_option(connection, "s3_region", region)
    if access_key:
        set_duckdb_option(connection, "s3_access_key_id", access_key)
    if secret_key:
        set_duckdb_option(connection, "s3_secret_access_key", secret_key)
    if session_token:
        set_duckdb_option(connection, "s3_session_token", session_token)
    if endpoint:
        parsed = urlparse(endpoint if "://" in endpoint else f"https://{endpoint}")
        endpoint_host = parsed.netloc or parsed.path
        set_duckdb_option(connection, "s3_endpoint", endpoint_host.rstrip("/"))
        connection.execute(f"SET s3_use_ssl = {'true' if parsed.scheme.lower() == 'https' else 'false'}")

    force_path_style = str(os.environ.get("S3_FORCE_PATH_STYLE") or "true").strip().lower() != "false"
    set_duckdb_option(connection, "s3_url_style", "path" if force_path_style else "vhost")


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
