import re
from collections.abc import Iterable
from datetime import date, datetime, timezone
from decimal import Decimal
import json
import math
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import duckdb
from fastapi import status

from app.core.auth_context import ActorContext, require_permission
from app.core.materialization import active_materialization_runs
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.sql import QueryRunRequest, QueryRunResponse
from app.services.governance_enforcement import require_governed_access
from app.services.resource_permission_service import dataset_with_persisted_permission_grants

DEFAULT_PREVIEW_LIMIT = 100
DASHBOARD_CHART_ROW_LIMIT = 500
DASHBOARD_TABLE_ROW_LIMIT = 500
DASHBOARD_VALUE_ALIAS = "__asklake_widget_value"
MUTATION_KEYWORDS = (
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "create",
    "truncate",
    "merge",
    "grant",
    "revoke",
    "replace",
    "copy",
    "call",
    "execute",
)
MUTATION_KEYWORD_RE = re.compile(
    rf"\b({'|'.join(re.escape(keyword) for keyword in MUTATION_KEYWORDS)})\b",
    re.IGNORECASE,
)
SQL_IDENTIFIER_PATTERN = (
    r'(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[a-zA-Z_][\w$]*)'
    r'(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[a-zA-Z_][\w$]*))*'
)
SQL_TABLE_REFERENCE_RE = re.compile(
    rf"\b(?:from|join)\s+({SQL_IDENTIFIER_PATTERN})",
    re.IGNORECASE,
)
SQL_FROM_CLAUSE_RE = re.compile(
    r"\bfrom\s+(.+?)(?=\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\blimit\b|\bhaving\b|\bunion\b|\bintersect\b|\bexcept\b|$)",
    re.IGNORECASE | re.DOTALL,
)
SQL_LEADING_IDENTIFIER_RE = re.compile(
    rf"^\s*({SQL_IDENTIFIER_PATTERN})",
    re.IGNORECASE,
)
SQL_CTE_NAME_RE = re.compile(
    rf"(?:\bwith|,)\s+({SQL_IDENTIFIER_PATTERN})\s+as\s*\(",
    re.IGNORECASE,
)


class SqlService:
    def __init__(
        self,
        repository: SqlRepository,
        catalog_repository: CatalogRepository,
    ) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository

    def create_query_run(self, request: QueryRunRequest, actor: ActorContext | None = None) -> QueryRunResponse:
        actor_context = actor or ActorContext()
        query = request.query
        statement = validate_read_only_query(query)

        request_dataset = self.get_catalog_dataset(request.dataset_id)
        base_dataset_id = request.base_dataset_id or request.dataset_id
        base_dataset = request_dataset
        if base_dataset_id != request.dataset_id:
            base_dataset = self.get_catalog_dataset(base_dataset_id, label="Base dataset")

        reference_dataset_ids = unique_dataset_ids(request.reference_dataset_ids)
        reference_datasets = [
            self.get_catalog_dataset(reference_dataset_id, label="Reference dataset")
            for reference_dataset_id in reference_dataset_ids
        ]
        context_datasets = [base_dataset, *reference_datasets]
        for dataset in context_datasets:
            require_governed_access(
                self.repository.db,
                actor_context,
                action="query",
                api_path="/api/query/runs",
                http_method="POST",
                metadata={"owner": dataset.owner, "query": query[:500]},
                resource_id=dataset.id,
                resource_name=dataset.name,
                resource_type="dataset",
            )
            try:
                require_permission(
                    actor_context,
                    "query",
                    owner=dataset.owner,
                    grants=dataset.permission_grants,
                    resource_label="dataset",
                )
            except ApiError as exc:
                safe_record_audit_event(
                    self.repository.db,
                    action="dataset.query.forbidden",
                    actor=actor_context,
                    api_path="/api/query/runs",
                    http_method="POST",
                    metadata={"owner": dataset.owner, "query": query[:500]},
                    result="forbidden",
                    status_code=exc.status_code,
                    target_id=dataset.id,
                    target_name=dataset.name,
                    target_type="dataset",
                )
                raise
        referenced_datasets = resolve_referenced_datasets(
            mask_sql_comments_and_literals(statement),
            context_datasets,
        )
        result_dataset = resolve_result_dataset(base_dataset, referenced_datasets)
        preview_limit = request.limit or DEFAULT_PREVIEW_LIMIT
        query_result = execute_duckdb_preview(
            statement,
            context_datasets=context_datasets,
            preview_limit=preview_limit,
        )

        response = QueryRunResponse(
            base_dataset_id=base_dataset_id,
            columns=query_result["columns"],
            dataset_id=result_dataset.id,
            dataset_name=result_dataset.name,
            executed_at=current_utc_timestamp(),
            mode=request.mode,
            preview_limit=preview_limit,
            query=query,
            reference_dataset_ids=reference_dataset_ids,
            row_count=query_result["row_count"],
            rows=query_result["rows"],
            run_id=f"sql_{uuid4().hex[:12]}",
            validation_key=request.validation_key,
        )

        self.repository.save_run_payload(
            response.model_dump(by_alias=True, exclude_none=True, mode="json")
        )
        return response

    def get_query_run(self, run_id: str, actor: ActorContext) -> QueryRunResponse:
        payload = self.repository.get_run_payload(run_id)
        if payload is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "SQL run not found",
                status.HTTP_404_NOT_FOUND,
                {"runId": run_id},
            )
        response = QueryRunResponse.model_validate(payload)
        dataset_ids = unique_dataset_ids([
            response.dataset_id,
            response.base_dataset_id or "",
            *response.reference_dataset_ids,
        ])
        for dataset_id in dataset_ids:
            dataset = self.get_catalog_dataset(dataset_id)
            require_governed_access(
                self.repository.db,
                actor,
                action="query",
                api_path=f"/api/query/runs/{run_id}",
                http_method="GET",
                metadata={"owner": dataset.owner},
                resource_id=dataset.id,
                resource_name=dataset.name,
                resource_type="dataset",
            )
            require_permission(
                actor,
                "query",
                owner=dataset.owner,
                grants=dataset.permission_grants,
                resource_label="dataset",
            )
        return response

    def get_catalog_dataset(
        self,
        dataset_id: str,
        *,
        label: str = "Dataset",
    ) -> CatalogDatasetResponse:
        payload = self.catalog_repository.get_dataset_payload(dataset_id)
        if payload is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                f"{label} not found",
                status.HTTP_404_NOT_FOUND,
                {"datasetId": dataset_id},
            )
        return dataset_with_persisted_permission_grants(
            self.catalog_repository.db,
            CatalogDatasetResponse.model_validate(payload),
        )


def validate_read_only_query(query: str) -> str:
    if not query.strip():
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "SQL query cannot be empty",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    masked_query = mask_sql_comments_and_literals(query)
    statement = get_single_statement(masked_query)
    original_statement = get_original_single_statement(query, masked_query)
    lowered_statement = statement.strip().lower()

    mutation_match = MUTATION_KEYWORD_RE.search(lowered_statement)
    if mutation_match:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Only read-only SELECT queries are allowed",
            status.HTTP_403_FORBIDDEN,
            {"keyword": mutation_match.group(1).upper()},
        )

    reject_single_quoted_relation_sources(original_statement)

    if lowered_statement.startswith("select"):
        return original_statement

    if lowered_statement.startswith("with") and re.search(
        r"\bselect\b",
        lowered_statement,
    ):
        return original_statement

    raise ApiError(
        ErrorCode.SQL_SYNTAX_ERROR,
        "Only SELECT or WITH ... SELECT statements are supported",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    )


def reject_single_quoted_relation_sources(query: str) -> None:
    index = 0
    query_length = len(query)
    while index < query_length:
        char = query[index]
        next_char = query[index + 1] if index + 1 < query_length else ""

        if char == "-" and next_char == "-":
            index = skip_line_comment(query, index)
            continue
        if char == "/" and next_char == "*":
            index = skip_block_comment(query, index)
            continue
        if char in {"'", '"', "`"}:
            index = skip_quoted_sql_token(query, index, char)
            continue
        if char == "[":
            index = skip_bracket_identifier(query, index)
            continue

        keyword = relation_keyword_at(query, index)
        if keyword:
            relation_start = skip_sql_whitespace_and_comments(query, index + len(keyword))
            if relation_start < query_length and query[relation_start] == "'":
                raise ApiError(
                    ErrorCode.VALIDATION_ERROR,
                    "SQL relation sources must use selected catalog tables, not file path literals",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    {"keyword": keyword.upper()},
                )
            index = relation_start
            continue

        index += 1


def resolve_referenced_datasets(
    statement: str,
    context_datasets: list[CatalogDatasetResponse],
) -> list[CatalogDatasetResponse]:
    dataset_by_table_name = build_dataset_context_map(context_datasets)
    referenced_table_names = extract_referenced_table_names(statement)
    cte_names = extract_cte_names(statement)
    physical_table_names = [
        table_name
        for table_name in referenced_table_names
        if table_name not in cte_names
    ]
    unknown_table_names = [
        table_name
        for table_name in physical_table_names
        if table_name not in dataset_by_table_name
    ]

    if unknown_table_names:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "SQL references tables outside the selected dataset context",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"tables": unknown_table_names},
        )

    preview_datasets = unique_datasets_by_id(
        dataset_by_table_name[table_name]
        for table_name in physical_table_names
        if table_name in dataset_by_table_name
    )
    return preview_datasets


def resolve_result_dataset(
    base_dataset: CatalogDatasetResponse,
    referenced_datasets: list[CatalogDatasetResponse],
) -> CatalogDatasetResponse:
    if len(referenced_datasets) == 1:
        return referenced_datasets[0]
    return base_dataset


def execute_duckdb_preview(
    statement: str,
    *,
    context_datasets: list[CatalogDatasetResponse],
    preview_limit: int,
) -> dict[str, Any]:
    connection = duckdb.connect(database=":memory:")
    try:
        for dataset in unique_datasets_by_id(context_datasets):
            register_duckdb_dataset(connection, dataset)

        cursor = connection.execute(
            f"SELECT * FROM ({statement}) AS asklake_query_result LIMIT ?",
            [preview_limit],
        )
        raw_rows = cursor.fetchall()
        columns = [str(description[0]) for description in (cursor.description or [])]
        rows = [
            [format_sql_cell(cell) for cell in row]
            for row in raw_rows
        ]
        return {
            "columns": columns,
            "row_count": len(rows),
            "rows": rows,
        }
    except duckdb.Error as error:
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "DuckDB SQL execution failed",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"message": str(error)},
        ) from error
    finally:
        connection.close()


def read_duckdb_dataset_page(
    dataset: CatalogDatasetResponse,
    *,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    connection = duckdb.connect(database=":memory:")
    table = quote_duckdb_identifier(dataset.name)
    try:
        register_duckdb_dataset(connection, dataset)
        declared_row_count = dataset_declared_row_count(dataset)
        row_count = (
            declared_row_count
            if declared_row_count is not None
            else int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        )
        cursor = connection.execute(
            f"SELECT * FROM {table} LIMIT ? OFFSET ?",
            [limit, offset],
        )
        rows = [
            [format_sql_cell(cell) for cell in row]
            for row in cursor.fetchall()
        ]
        return {
            "columns": [str(description[0]) for description in (cursor.description or [])],
            "row_count": row_count,
            "rows": rows,
        }
    except ApiError:
        raise
    except duckdb.Error as error:
        raise dataset_storage_error(dataset, str(error)) from error
    finally:
        connection.close()


class DashboardDatasetQuerySession:
    """Registers one Catalog dataset once and runs bounded widget queries against it."""

    def __init__(self, dataset: CatalogDatasetResponse) -> None:
        self.dataset = dataset
        self.connection = duckdb.connect(database=":memory:")
        self.table = quote_duckdb_identifier(dataset.name)
        try:
            if not dataset_storage_locations(dataset):
                raise dataset_storage_error(dataset, "Dashboard widgets require physical dataset storage")
            register_duckdb_dataset(self.connection, dataset)
            self.columns = {
                str(row[0])
                for row in self.connection.execute(f"DESCRIBE SELECT * FROM {self.table}").fetchall()
            }
        except ApiError:
            self.connection.close()
            raise
        except duckdb.Error as error:
            self.connection.close()
            raise dataset_storage_error(dataset, str(error)) from error

    def close(self) -> None:
        self.connection.close()

    def read_widget(self, widget_type: str, config: dict[str, Any]) -> dict[str, Any]:
        source_config = dashboard_source_config(config)
        if widget_type == "table":
            sql = dashboard_table_query(self.table, self.columns, source_config)
            data_mode = "server_preview"
            runtime_config = dict(source_config)
        else:
            sql, runtime_config = dashboard_aggregation_query(
                self.table,
                self.columns,
                widget_type,
                source_config,
            )
            data_mode = "server_aggregated"

        runtime_config["dataMode"] = data_mode
        runtime_config["sourceConfig"] = source_config
        try:
            cursor = self.connection.execute(sql)
            column_names = [str(description[0]) for description in (cursor.description or [])]
            rows = [
                {
                    column_name: dashboard_json_cell(row[index])
                    for index, column_name in enumerate(column_names)
                }
                for row in cursor.fetchall()
            ]
        except duckdb.Error as error:
            raise dataset_storage_error(self.dataset, str(error)) from error
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
        direction_sql = "DESC" if direction == "desc" else "ASC"
        order_sql = f" ORDER BY {quote_duckdb_identifier(sort_key)} {direction_sql} NULLS LAST"
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
    for _config_key, column, date_unit in dimension_specs:
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
    aggregate_expression = dashboard_aggregate_expression(aggregation, configured_value_key)
    select_parts.append(f"{aggregate_expression} AS {quote_duckdb_identifier(value_alias)}")

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
) -> tuple[list[tuple[str, str, str | None]], str]:
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
        return [("xKey", required("xKey"), None), ("groupKey", text("groupKey"), None)], "yKey"
    if widget_type in {"line_chart", "area_chart"}:
        date_unit = text("dateUnit") or None
        return [("xKey", required("xKey"), date_unit), ("seriesKey", text("seriesKey"), None)], "yKey"
    if widget_type in {"donut_chart", "pie_chart", "treemap_chart"}:
        return [("labelKey", required("labelKey"), None)], "valueKey"
    if widget_type == "radial_bar_chart":
        return [("labelKey", text("labelKey"), None)], "valueKey"
    if widget_type == "heatmap_chart":
        return [("xKey", required("xKey"), None), ("yKey", required("yKey"), None)], "valueKey"
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


def camel_to_snake_key(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


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


def register_duckdb_dataset(
    connection: duckdb.DuckDBPyConnection,
    dataset: CatalogDatasetResponse,
) -> None:
    table_name = dataset.name
    if dataset_storage_locations(dataset):
        register_duckdb_storage_location(connection, dataset, table_name)
    else:
        register_duckdb_sample_rows(connection, dataset, table_name)

    if dataset.id != dataset.name:
        connection.execute(
            f"CREATE TEMP VIEW {quote_duckdb_identifier(dataset.id)} AS SELECT * FROM {quote_duckdb_identifier(table_name)}"
        )


def register_duckdb_storage_location(
    connection: duckdb.DuckDBPyConnection,
    dataset: CatalogDatasetResponse,
    table_name: str,
) -> bool:
    storage_segments = dataset_storage_segments(dataset)
    if not storage_segments:
        return False

    try:
        if any(is_s3_storage_location(location) for location, _format in storage_segments):
            configure_duckdb_s3(connection)
        scan_segments: list[tuple[str, str]] = []
        for storage_location, storage_format in storage_segments:
            if storage_format not in {"csv", "json", "jsonl", "parquet"}:
                raise ValueError(f"Unsupported storage format: {storage_format or '-'}")
            if is_s3_storage_location(storage_location):
                scan_segments.append((s3_scan_path(storage_location, storage_format), storage_format))
                continue

            storage_path = Path(storage_location)
            if not storage_path.exists():
                raise FileNotFoundError(f"Storage location does not exist: {storage_location}")
            scan_path = (
                parquet_scan_path(storage_path)
                if storage_format == "parquet"
                else delimited_scan_path(storage_path, storage_format)
            )
            if not scan_path:
                raise FileNotFoundError(
                    f"{storage_format.upper()} storage does not contain readable files: {storage_location}"
                )
            scan_segments.append((scan_path, storage_format))

        register_duckdb_scan_segments_view(connection, table_name, scan_segments)
        return True
    except ApiError:
        raise
    except (OSError, ValueError, duckdb.Error, json.JSONDecodeError) as error:
        raise dataset_storage_error(dataset, str(error)) from error

    return False


def register_duckdb_scan_view(
    connection: duckdb.DuckDBPyConnection,
    table_name: str,
    scan_path: str | list[str],
    storage_format: str,
) -> None:
    scan_paths = [scan_path] if isinstance(scan_path, str) else scan_path
    register_duckdb_scan_segments_view(
        connection,
        table_name,
        [(path, storage_format) for path in scan_paths],
    )


def register_duckdb_scan_segments_view(
    connection: duckdb.DuckDBPyConnection,
    table_name: str,
    scan_segments: list[tuple[str, str]],
) -> None:
    table = quote_duckdb_identifier(table_name)
    sources = [duckdb_scan_source(path, storage_format) for path, storage_format in scan_segments]
    union_sql = " UNION ALL BY NAME ".join(f"SELECT * FROM {source}" for source in sources)
    connection.execute(f"CREATE TEMP VIEW {table} AS {union_sql}")


def duckdb_scan_source(scan_path: str, storage_format: str) -> str:
    path = quote_duckdb_string_literal(scan_path)
    if storage_format == "parquet":
        return f"read_parquet({path}, union_by_name = true, hive_partitioning = true)"
    if storage_format == "csv":
        return f"read_csv_auto({path}, header = true, union_by_name = true, hive_partitioning = true)"
    return f"read_json_auto({path}, union_by_name = true, hive_partitioning = true)"


def dataset_storage_locations(dataset: CatalogDatasetResponse) -> list[str]:
    return [location for location, _format in dataset_storage_segments(dataset)]


def dataset_declared_row_count(dataset: CatalogDatasetResponse) -> int | None:
    counts: list[int] = []
    for run in active_dataset_materialization_runs(dataset):
        if not run.get("_rowCountDeclared"):
            return None
        value = run.get("rowCount")
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return None
        if parsed < 0:
            return None
        counts.append(parsed)
    return sum(counts) if counts else None


def dataset_storage_segments(dataset: CatalogDatasetResponse) -> list[tuple[str, str]]:
    segments: list[tuple[str, str]] = []
    fallback_format = str(getattr(dataset, "storage_format", None) or "").strip().lower()
    for run in reversed(active_dataset_materialization_runs(dataset)):
        status_value = run.get("status")
        location_value = run.get("storageLocation")
        format_value = run.get("storageFormat")
        location = str(location_value or "").strip()
        storage_format = str(format_value or fallback_format).strip().lower()
        segment = (location, storage_format)
        if status_value == "success" and location and location not in {"-", "Pending"} and segment not in segments:
            segments.append(segment)
    if segments:
        return segments
    fallback = str(getattr(dataset, "storage_location", None) or "").strip()
    return [(fallback, fallback_format)] if fallback and fallback not in {"-", "Pending"} else []


def active_dataset_materialization_runs(dataset: CatalogDatasetResponse) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    for run in getattr(dataset, "materialization_runs", None) or []:
        if isinstance(run, dict):
            payload = dict(run)
            payload["_rowCountDeclared"] = "rowCount" in run or "row_count" in run
            if "rowCount" not in payload and "row_count" in payload:
                payload["rowCount"] = payload.get("row_count")
            if "storageLocation" not in payload:
                payload["storageLocation"] = payload.get("storage_location")
            if "storageFormat" not in payload:
                payload["storageFormat"] = payload.get("storage_format")
            if "materializationMode" not in payload:
                payload["materializationMode"] = payload.get("materialization_mode")
        else:
            fields_set = getattr(run, "model_fields_set", set())
            payload = run.model_dump(mode="json", by_alias=True) if hasattr(run, "model_dump") else {
                "status": getattr(run, "status", None),
                "rowCount": getattr(run, "row_count", None),
                "storageLocation": getattr(run, "storage_location", None),
                "storageFormat": getattr(run, "storage_format", None),
                "materializationMode": getattr(run, "materialization_mode", None),
            }
            payload["_rowCountDeclared"] = "row_count" in fields_set
        payloads.append(payload)
    return active_materialization_runs(payloads)


def is_s3_storage_location(value: str) -> bool:
    return bool(re.match(r"^s3a?://", value, re.IGNORECASE))


def s3_scan_path(storage_location: str, storage_format: str) -> str:
    normalized = re.sub(r"^s3a://", "s3://", storage_location.strip(), flags=re.IGNORECASE).rstrip("/")
    suffix = f".{storage_format.lower()}"
    if normalized.lower().endswith(suffix):
        return normalized
    return f"{normalized}/**/*{suffix}"


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


def dataset_storage_error(dataset: CatalogDatasetResponse, reason: str) -> ApiError:
    return ApiError(
        ErrorCode.SERVICE_UNAVAILABLE,
        "Dataset physical storage could not be read",
        status.HTTP_503_SERVICE_UNAVAILABLE,
        {
            "datasetId": str(getattr(dataset, "id", "") or ""),
            "reason": reason[:500],
            "storageFormat": str(getattr(dataset, "storage_format", "") or ""),
            "storageLocation": str(getattr(dataset, "storage_location", "") or ""),
        },
    )


def register_duckdb_sample_rows(
    connection: duckdb.DuckDBPyConnection,
    dataset: CatalogDatasetResponse,
    table_name: str,
) -> None:
    columns = dataset_columns(dataset)
    if not columns:
        max_width = max((len(row) for row in dataset.sample_rows), default=0)
        columns = [(f"column_{index + 1}", "string") for index in range(max_width)]

    column_defs = ", ".join(
        f"{quote_duckdb_identifier(column_name)} {duckdb_column_type(column_type)}"
        for column_name, column_type in columns
    )
    if not column_defs:
        column_defs = "empty_row VARCHAR"
        columns = [("empty_row", "string")]

    connection.execute(
        f"CREATE TEMP TABLE {quote_duckdb_identifier(table_name)} ({column_defs})"
    )

    if not dataset.sample_rows:
        return

    placeholders = ", ".join("?" for _ in columns)
    rows = [
        [
            coerce_duckdb_cell(row[index] if index < len(row) else None, column_type)
            for index, (_, column_type) in enumerate(columns)
        ]
        for row in dataset.sample_rows
    ]
    connection.executemany(
        f"INSERT INTO {quote_duckdb_identifier(table_name)} VALUES ({placeholders})",
        rows,
    )


def register_duckdb_records(
    connection: duckdb.DuckDBPyConnection,
    table_name: str,
    records: list[dict[str, Any]],
) -> None:
    columns = record_columns(records)
    column_defs = ", ".join(
        f"{quote_duckdb_identifier(column_name)} VARCHAR"
        for column_name, _ in columns
    )
    connection.execute(
        f"CREATE TEMP TABLE {quote_duckdb_identifier(table_name)} ({column_defs})"
    )
    placeholders = ", ".join("?" for _ in columns)
    rows = [
        [format_record_cell(record.get(source_name)) for _, source_name in columns]
        for record in records
    ]
    connection.executemany(
        f"INSERT INTO {quote_duckdb_identifier(table_name)} VALUES ({placeholders})",
        rows,
    )


def record_columns(records: list[dict[str, Any]]) -> list[tuple[str, str]]:
    source_names: list[str] = []
    seen_source_names: set[str] = set()
    for record in records:
        for raw_name in record:
            name = str(raw_name)
            if name in seen_source_names:
                continue
            source_names.append(name)
            seen_source_names.add(name)

    used_names: set[str] = set()
    return [
        (unique_column_name(name, used_names), name)
        for name in source_names
    ] or [("value", "value")]


def format_record_cell(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def dataset_columns(dataset: CatalogDatasetResponse) -> list[tuple[str, str]]:
    used_names: set[str] = set()
    columns: list[tuple[str, str]] = []
    for index, (raw_name, raw_type) in enumerate(dataset.schema_):
        column_name = unique_column_name(str(raw_name or f"column_{index + 1}"), used_names)
        columns.append((column_name, str(raw_type or "string")))
    return columns


def unique_column_name(column_name: str, used_names: set[str]) -> str:
    base_name = column_name.strip() or "column"
    candidate = base_name
    suffix = 2
    while candidate.lower() in used_names:
        candidate = f"{base_name}_{suffix}"
        suffix += 1
    used_names.add(candidate.lower())
    return candidate


def duckdb_column_type(column_type: str) -> str:
    normalized = column_type.lower()
    if "bool" in normalized:
        return "BOOLEAN"
    if any(token in normalized for token in ("int", "long", "bigint")):
        return "BIGINT"
    if any(token in normalized for token in ("decimal", "double", "float", "number", "numeric")):
        return "DOUBLE"
    return "VARCHAR"


def coerce_duckdb_cell(value: Any, column_type: str) -> Any:
    if value is None:
        return None
    text = str(value)
    if text == "":
        return None

    target_type = duckdb_column_type(column_type)
    if target_type == "BIGINT":
        try:
            return int(float(text))
        except ValueError:
            return None
    if target_type == "DOUBLE":
        try:
            return float(text)
        except ValueError:
            return None
    if target_type == "BOOLEAN":
        normalized = text.strip().lower()
        if normalized in {"true", "1", "yes", "y"}:
            return True
        if normalized in {"false", "0", "no", "n"}:
            return False
        return None
    return text


def format_sql_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else str(value)
    if isinstance(value, Decimal):
        normalized = value.normalize()
        return format(normalized, "f")
    if isinstance(value, (datetime,)):
        return value.isoformat()
    return str(value)


def parquet_scan_path(storage_path: Path) -> str:
    if storage_path.is_file() and storage_path.suffix.lower() == ".parquet":
        return str(storage_path)
    if storage_path.is_dir():
        parquet_files = list(storage_path.rglob("*.parquet"))
        if parquet_files:
            return str(storage_path / "**" / "*.parquet")
    return ""


def delimited_scan_path(storage_path: Path, storage_format: str) -> str:
    suffix = f".{storage_format.lower()}"
    if storage_path.is_file() and storage_path.suffix.lower() == suffix:
        return str(storage_path)
    if storage_path.is_dir() and any(storage_path.rglob(f"*{suffix}")):
        return str(storage_path / "**" / f"*{suffix}")
    return ""


def read_jsonl_records(storage_path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with storage_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            value = json.loads(text)
            if isinstance(value, dict):
                records.append(value)
    return records


def quote_duckdb_identifier(identifier: str) -> str:
    escaped = str(identifier).replace('"', '""')
    return f'"{escaped}"'


def quote_duckdb_string_literal(value: str) -> str:
    escaped = str(value).replace("'", "''")
    return f"'{escaped}'"


def build_dataset_context_map(
    datasets: list[CatalogDatasetResponse],
) -> dict[str, CatalogDatasetResponse]:
    dataset_by_table_name: dict[str, CatalogDatasetResponse] = {}
    for dataset in datasets:
        dataset_by_table_name[normalize_sql_identifier(dataset.name)] = dataset
        dataset_by_table_name[normalize_sql_identifier(dataset.id)] = dataset
    return dataset_by_table_name


def extract_referenced_table_names(statement: str) -> list[str]:
    table_names: list[str] = []
    seen_table_names: set[str] = set()
    for table_name in [
        *extract_explicit_table_references(statement),
        *extract_comma_table_references(statement),
    ]:
        if not table_name or table_name in seen_table_names:
            continue
        table_names.append(table_name)
        seen_table_names.add(table_name)
    return table_names


def extract_explicit_table_references(statement: str) -> list[str]:
    return [
        normalize_sql_identifier(match.group(1))
        for match in SQL_TABLE_REFERENCE_RE.finditer(statement)
    ]


def extract_comma_table_references(statement: str) -> list[str]:
    table_names: list[str] = []
    for match in SQL_FROM_CLAUSE_RE.finditer(statement):
        from_clause = match.group(1)
        from_clause_before_join = re.split(
            r"\b(?:join|left|right|inner|outer|full|cross)\b",
            from_clause,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0]
        for table_candidate in from_clause_before_join.split(",")[1:]:
            table_match = SQL_LEADING_IDENTIFIER_RE.match(table_candidate)
            if table_match:
                table_names.append(normalize_sql_identifier(table_match.group(1)))
    return table_names


def extract_cte_names(statement: str) -> set[str]:
    return {
        normalize_sql_identifier(match.group(1))
        for match in SQL_CTE_NAME_RE.finditer(statement)
    }


def normalize_sql_identifier(identifier: str) -> str:
    parts = [
        strip_sql_identifier_part(part.strip())
        for part in re.split(r"\s*\.\s*", identifier)
        if part.strip()
    ]
    return ".".join(parts).lower()


def strip_sql_identifier_part(identifier: str) -> str:
    if len(identifier) >= 2 and (
        (identifier[0] == identifier[-1] == '"')
        or (identifier[0] == identifier[-1] == "`")
        or (identifier[0] == "[" and identifier[-1] == "]")
    ):
        return identifier[1:-1]
    return identifier


def unique_datasets_by_id(
    datasets: Iterable[CatalogDatasetResponse],
) -> list[CatalogDatasetResponse]:
    unique_datasets: list[CatalogDatasetResponse] = []
    seen_dataset_ids: set[str] = set()
    for dataset in datasets:
        if dataset.id in seen_dataset_ids:
            continue
        unique_datasets.append(dataset)
        seen_dataset_ids.add(dataset.id)
    return unique_datasets


def get_single_statement(masked_query: str) -> str:
    statement = masked_query.strip()
    semicolon_count = statement.count(";")
    if semicolon_count == 0:
        return statement
    if semicolon_count == 1 and statement.endswith(";"):
        return statement[:-1].strip()

    raise ApiError(
        ErrorCode.SQL_SYNTAX_ERROR,
        "Only a single SQL statement is allowed",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    )


def get_original_single_statement(query: str, masked_query: str) -> str:
    masked_statement = masked_query.strip()
    if masked_statement.count(";") == 1 and masked_statement.endswith(";"):
        semicolon_index = masked_query.find(";")
        return query[:semicolon_index].strip()
    return query.strip()


def mask_sql_comments_and_literals(query: str) -> str:
    masked_chars: list[str] = []
    index = 0
    query_length = len(query)

    while index < query_length:
        char = query[index]
        next_char = query[index + 1] if index + 1 < query_length else ""

        if char == "-" and next_char == "-":
            index = mask_line_comment(query, index, masked_chars)
            continue

        if char == "/" and next_char == "*":
            index = mask_block_comment(query, index, masked_chars)
            continue

        if char == "'":
            index = mask_quoted_value(query, index, "'", masked_chars)
            continue

        masked_chars.append(char)
        index += 1

    return "".join(masked_chars)


def mask_line_comment(query: str, index: int, masked_chars: list[str]) -> int:
    while index < len(query) and query[index] != "\n":
        masked_chars.append(" ")
        index += 1
    if index < len(query):
        masked_chars.append("\n")
        index += 1
    return index


def mask_block_comment(query: str, index: int, masked_chars: list[str]) -> int:
    masked_chars.extend("  ")
    index += 2
    while index < len(query):
        if query[index] == "*" and index + 1 < len(query) and query[index + 1] == "/":
            masked_chars.extend("  ")
            return index + 2
        masked_chars.append("\n" if query[index] == "\n" else " ")
        index += 1
    return index


def mask_quoted_value(
    query: str,
    index: int,
    quote_char: str,
    masked_chars: list[str],
) -> int:
    masked_chars.append(" ")
    index += 1
    while index < len(query):
        masked_chars.append(" ")
        if query[index] == quote_char:
            if index + 1 < len(query) and query[index + 1] == quote_char:
                masked_chars.append(" ")
                index += 2
                continue
            return index + 1
        index += 1
    return index


def relation_keyword_at(query: str, index: int) -> str:
    for keyword in ("from", "join"):
        if not query[index:index + len(keyword)].lower() == keyword:
            continue
        before = query[index - 1] if index > 0 else ""
        after_index = index + len(keyword)
        after = query[after_index] if after_index < len(query) else ""
        if is_sql_identifier_char(before) or is_sql_identifier_char(after):
            continue
        return keyword
    return ""


def is_sql_identifier_char(char: str) -> bool:
    return char.isalnum() or char in {"_", "$"}


def skip_sql_whitespace_and_comments(query: str, index: int) -> int:
    while index < len(query):
        while index < len(query) and query[index].isspace():
            index += 1
        next_char = query[index + 1] if index + 1 < len(query) else ""
        if index < len(query) and query[index] == "-" and next_char == "-":
            index = skip_line_comment(query, index)
            continue
        if index < len(query) and query[index] == "/" and next_char == "*":
            index = skip_block_comment(query, index)
            continue
        return index
    return index


def skip_line_comment(query: str, index: int) -> int:
    while index < len(query) and query[index] != "\n":
        index += 1
    return index + 1 if index < len(query) else index


def skip_block_comment(query: str, index: int) -> int:
    index += 2
    while index < len(query):
        if query[index] == "*" and index + 1 < len(query) and query[index + 1] == "/":
            return index + 2
        index += 1
    return index


def skip_quoted_sql_token(query: str, index: int, quote_char: str) -> int:
    index += 1
    while index < len(query):
        if query[index] == quote_char:
            if index + 1 < len(query) and query[index + 1] == quote_char:
                index += 2
                continue
            return index + 1
        index += 1
    return index


def skip_bracket_identifier(query: str, index: int) -> int:
    while index < len(query):
        if query[index] == "]":
            return index + 1
        index += 1
    return index


def unique_dataset_ids(dataset_ids: list[str]) -> list[str]:
    unique_ids: list[str] = []
    seen_ids: set[str] = set()
    for dataset_id in dataset_ids:
        if not dataset_id or dataset_id in seen_ids:
            continue
        unique_ids.append(dataset_id)
        seen_ids.add(dataset_id)
    return unique_ids


def current_utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )
