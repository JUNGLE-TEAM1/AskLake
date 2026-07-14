import math
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

from app.core.errors import ApiError
from app.services.object_storage import object_storage_runtime


DASHBOARD_CHART_ROW_LIMIT = 500
DASHBOARD_TABLE_ROW_LIMIT = 500
DASHBOARD_VALUE_ALIAS = "__asklake_widget_value"
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
    ) -> None:
        self.dataset = dataset
        self.query_timeout_seconds = (
            query_timeout_seconds
            if query_timeout_seconds is not None
            else dashboard_query_timeout_seconds()
        )
        self.connection = duckdb.connect(database=":memory:")
        self.table = quote_duckdb_identifier(_DASHBOARD_TABLE_NAME)
        try:
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
            self.connection.close()
            raise
        except (OSError, RuntimeError, ValueError, duckdb.Error) as error:
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
            cursor = execute_dashboard_query(
                self.connection,
                query,
                timeout_seconds=self.query_timeout_seconds,
            )
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
