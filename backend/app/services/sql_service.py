import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import duckdb
from fastapi import status

from app.core.auth_context import ActorContext, require_permission
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.sql import (
    DEFAULT_QUERY_PAGE_LIMIT,
    MAX_QUERY_PAGE_LIMIT,
    QueryRunRequest,
    QueryRunResponse,
)
from app.services.governance_enforcement import require_governed_access
from app.services.object_storage import object_storage_runtime
from app.services.lake_storage_service import default_storage_root
from app.services.resource_permission_service import dataset_with_persisted_permission_grants

DEFAULT_PREVIEW_LIMIT = DEFAULT_QUERY_PAGE_LIMIT
DEFAULT_REMOTE_PREVIEW_MAX_BYTES = 512 * 1024 * 1024
STORED_RESULT_ROWS_KEY = "resultRows"
RESULT_STORAGE_FORMAT_KEY = "resultStorageFormat"
RESULT_STORAGE_LOCATION_KEY = "resultStorageLocation"
SQL_RESULT_STORAGE_FORMAT = "parquet"
REMOTE_STORAGE_SCHEMES = {"s3", "s3a"}
SUPPORTED_SQL_STORAGE_FORMATS = {"csv", "json", "jsonl", "parquet"}
SQL_MATERIALIZATION_RUNS_ATTR = "_sql_materialization_runs"
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


@dataclass
class RemotePreviewBudget:
    limit_bytes: int
    used_bytes: int = 0

    def reserve(self, size_bytes: int, *, bucket: str, prefix: str) -> None:
        next_used_bytes = self.used_bytes + max(size_bytes, 0)
        if next_used_bytes > self.limit_bytes:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Remote dataset is too large for SQL Preview",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {
                    "bucket": bucket,
                    "prefix": prefix,
                    "requestedBytes": next_used_bytes,
                    "maxBytes": self.limit_bytes,
                },
            )
        self.used_bytes = next_used_bytes


@dataclass(frozen=True)
class RemoteStorageDownloadPlan:
    bucket: str
    client: Any
    dataset_id: str
    objects: tuple[tuple[str, int], ...]
    prefix: str
    storage_format: str
    storage_location: str


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
            self.require_dataset_query_access(
                dataset,
                actor_context,
                api_path="/api/query/runs",
                db=self.repository.db,
                http_method="POST",
                query=query,
            )
        referenced_datasets = resolve_referenced_datasets(
            mask_sql_comments_and_literals(statement),
            context_datasets,
        )
        result_dataset = resolve_result_dataset(base_dataset, referenced_datasets)
        page_limit = request.limit or DEFAULT_PREVIEW_LIMIT
        run_id = f"sql_{uuid4().hex[:12]}"
        result_path = query_result_storage_path(run_id)
        query_result = execute_duckdb_query_to_artifact(
            statement,
            context_datasets=context_datasets,
            page_limit=page_limit,
            result_path=result_path,
        )

        first_page_rows = query_result["rows"]
        page_metadata = query_page_metadata(
            total_rows=query_result["row_count"],
            returned_rows=len(first_page_rows),
            offset=0,
        )

        response = QueryRunResponse(
            base_dataset_id=base_dataset_id,
            columns=query_result["columns"],
            dataset_id=result_dataset.id,
            dataset_name=result_dataset.name,
            executed_at=current_utc_timestamp(),
            mode=request.mode,
            page_limit=page_limit,
            page_offset=0,
            preview_limit=page_limit,
            query=query,
            reference_dataset_ids=reference_dataset_ids,
            row_count=query_result["row_count"],
            rows=first_page_rows,
            run_id=run_id,
            validation_key=request.validation_key,
            **page_metadata,
        )

        stored_payload = response.model_dump(by_alias=True, exclude_none=True, mode="json")
        stored_payload[RESULT_STORAGE_FORMAT_KEY] = SQL_RESULT_STORAGE_FORMAT
        stored_payload[RESULT_STORAGE_LOCATION_KEY] = str(result_path)
        try:
            self.repository.save_run_payload(stored_payload)
        except Exception:
            result_path.unlink(missing_ok=True)
            raise
        return response

    def get_query_run(
        self,
        run_id: str,
        actor: ActorContext | None = None,
        *,
        limit: int = DEFAULT_QUERY_PAGE_LIMIT,
        offset: int = 0,
    ) -> QueryRunResponse:
        payload = self.repository.get_run_payload(run_id)
        if payload is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "SQL run not found",
                status.HTTP_404_NOT_FOUND,
                {"runId": run_id},
            )
        actor_context = actor or ActorContext()
        query = str(payload.get("query") or "")
        dataset_ids = unique_dataset_ids([
            str(payload.get("datasetId") or ""),
            str(payload.get("baseDatasetId") or ""),
            *[str(value) for value in payload.get("referenceDatasetIds") or []],
        ])
        for dataset_id in dataset_ids:
            dataset = self.get_catalog_dataset(dataset_id)
            self.require_dataset_query_access(
                dataset,
                actor_context,
                api_path=f"/api/query/runs/{run_id}",
                audit_forbidden=False,
                db=self.catalog_repository.db,
                http_method="GET",
                query=query,
            )

        return query_run_response_from_payload(payload, limit=limit, offset=offset)

    def require_dataset_query_access(
        self,
        dataset: CatalogDatasetResponse,
        actor: ActorContext,
        *,
        api_path: str,
        db: Any,
        http_method: str,
        query: str,
        audit_forbidden: bool = True,
    ) -> None:
        metadata = {"owner": dataset.owner, "query": query[:500]}
        require_governed_access(
            db,
            actor,
            action="query",
            api_path=api_path,
            http_method=http_method,
            metadata=metadata,
            resource_id=dataset.id,
            resource_name=dataset.name,
            resource_type="dataset",
        )
        try:
            require_permission(
                actor,
                "query",
                owner=dataset.owner,
                grants=dataset.permission_grants,
                resource_label="dataset",
            )
        except ApiError as exc:
            if audit_forbidden:
                safe_record_audit_event(
                    db,
                    action="dataset.query.forbidden",
                    actor=actor,
                    api_path=api_path,
                    http_method=http_method,
                    metadata=metadata,
                    result="forbidden",
                    status_code=exc.status_code,
                    target_id=dataset.id,
                    target_name=dataset.name,
                    target_type="dataset",
                )
            raise

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
        dataset = dataset_with_persisted_permission_grants(
            self.catalog_repository.db,
            CatalogDatasetResponse.model_validate(payload),
        )
        attach_sql_materialization_runs(dataset, payload)
        return dataset


def query_page_metadata(
    *,
    total_rows: int,
    returned_rows: int,
    offset: int,
) -> dict[str, int | bool]:
    range_start = offset + 1 if returned_rows else 0
    range_end = offset + returned_rows if returned_rows else 0
    return {
        "has_next": range_end < total_rows,
        "range_end": range_end,
        "range_start": range_start,
        "returned_rows": returned_rows,
    }


def query_run_response_from_payload(
    payload: dict[str, Any],
    *,
    limit: int,
    offset: int,
) -> QueryRunResponse:
    page_limit = min(max(int(limit), 1), MAX_QUERY_PAGE_LIMIT)
    page_offset = max(int(offset), 0)
    page_rows, total_rows = stored_query_run_page(
        payload,
        limit=page_limit,
        offset=page_offset,
    )
    page_metadata = query_page_metadata(
        total_rows=total_rows,
        returned_rows=len(page_rows),
        offset=page_offset,
    )

    response_payload = query_run_public_payload(payload)
    response_payload.update({
        "pageLimit": page_limit,
        "pageOffset": page_offset,
        "rowCount": total_rows,
        "rows": page_rows,
        **{
            "hasNext": page_metadata["has_next"],
            "rangeEnd": page_metadata["range_end"],
            "rangeStart": page_metadata["range_start"],
            "returnedRows": page_metadata["returned_rows"],
        },
    })
    return QueryRunResponse.model_validate(response_payload)


def full_query_run_response_from_payload(payload: dict[str, Any]) -> QueryRunResponse:
    """Restore the complete persisted SQL snapshot for internal materialization."""
    result_path = stored_query_result_path(payload)
    stored_rows = stored_query_run_rows(payload)
    total_rows = (
        stored_query_run_row_count(payload, result_path=result_path)
        if result_path is not None
        else len(stored_rows)
    )
    response_payload = query_run_public_payload(payload)
    response_payload.update({
        "hasNext": False,
        "pageLimit": total_rows or DEFAULT_QUERY_PAGE_LIMIT,
        "pageOffset": 0,
        "rangeEnd": total_rows,
        "rangeStart": 1 if total_rows else 0,
        "returnedRows": total_rows,
        "rowCount": total_rows,
        "rows": stored_rows,
    })
    return QueryRunResponse.model_validate(response_payload)


def stored_query_run_rows(payload: dict[str, Any]) -> list[list[str]]:
    result_path = stored_query_result_path(payload)
    if result_path is not None:
        return read_query_result_artifact(result_path)

    stored_rows_value = payload.get(STORED_RESULT_ROWS_KEY)
    if not isinstance(stored_rows_value, list):
        # Runs created before pagination only persisted their original preview page.
        stored_rows_value = payload.get("rows") or []
    return [
        [str(cell) for cell in row]
        for row in stored_rows_value
        if isinstance(row, list)
    ]


def stored_query_run_page(
    payload: dict[str, Any],
    *,
    limit: int,
    offset: int,
) -> tuple[list[list[str]], int]:
    result_path = stored_query_result_path(payload)
    if result_path is not None:
        return (
            read_query_result_artifact(result_path, limit=limit, offset=offset),
            stored_query_run_row_count(payload, result_path=result_path),
        )

    stored_rows = stored_query_run_rows(payload)
    return stored_rows[offset:offset + limit], len(stored_rows)


def stored_query_run_row_count(
    payload: dict[str, Any],
    *,
    fallback: int | None = None,
    result_path: Path | None = None,
) -> int:
    raw_row_count = payload.get("rowCount")
    if isinstance(raw_row_count, int) and raw_row_count >= 0:
        return raw_row_count
    if result_path is not None:
        return count_query_result_artifact_rows(result_path)
    return max(fallback or 0, 0)


def query_run_public_payload(payload: dict[str, Any]) -> dict[str, Any]:
    response_payload = dict(payload)
    response_payload.pop(STORED_RESULT_ROWS_KEY, None)
    response_payload.pop(RESULT_STORAGE_FORMAT_KEY, None)
    response_payload.pop(RESULT_STORAGE_LOCATION_KEY, None)
    # Old capped-run metadata is accepted on read but is no longer part of the API.
    response_payload.pop("resultLimit", None)
    response_payload.pop("resultTruncated", None)
    return response_payload


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


def query_result_storage_path(run_id: str) -> Path:
    return default_storage_root() / "sql-runs" / f"{safe_cache_directory_name(run_id)}.parquet"


def execute_duckdb_query_to_artifact(
    statement: str,
    *,
    context_datasets: list[CatalogDatasetResponse],
    page_limit: int,
    result_path: Path,
) -> dict[str, Any]:
    """Execute the full read-only query once and persist its complete snapshot."""
    connection = duckdb.connect(database=":memory:")
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.unlink(missing_ok=True)
    try:
        with TemporaryDirectory(prefix="asklake-sql-preview-") as remote_cache_dir:
            remote_budget = RemotePreviewBudget(remote_preview_max_bytes())
            for dataset in unique_datasets_by_id(context_datasets):
                register_duckdb_dataset(
                    connection,
                    dataset,
                    remote_cache_root=Path(remote_cache_dir),
                    remote_budget=remote_budget,
                )

            connection.execute(
                f"COPY ({statement}) TO {quote_duckdb_string_literal(str(result_path))} "
                "(FORMAT PARQUET)"
            )
            row_count = count_query_result_artifact_rows(result_path, connection=connection)
            page_cursor = connection.execute(
                f"SELECT * FROM read_parquet({quote_duckdb_string_literal(str(result_path))}) "
                "LIMIT ? OFFSET 0",
                [page_limit],
            )
            raw_rows = page_cursor.fetchall()
            columns = [str(description[0]) for description in (page_cursor.description or [])]
            return {
                "columns": columns,
                "row_count": row_count,
                "rows": [
                    [format_sql_cell(cell) for cell in row]
                    for row in raw_rows
                ],
            }
    except ApiError:
        result_path.unlink(missing_ok=True)
        raise
    except (duckdb.Error, OSError) as error:
        result_path.unlink(missing_ok=True)
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "DuckDB SQL execution failed",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"message": str(error)},
        ) from error
    finally:
        connection.close()


def stored_query_result_path(payload: dict[str, Any]) -> Path | None:
    raw_location = payload.get(RESULT_STORAGE_LOCATION_KEY)
    if not raw_location:
        return None
    storage_format = str(payload.get(RESULT_STORAGE_FORMAT_KEY) or "").lower()
    if storage_format != SQL_RESULT_STORAGE_FORMAT:
        raise sql_storage_error(
            "Stored SQL result format is not supported",
            {"storageFormat": storage_format},
        )
    result_path = Path(str(raw_location))
    if not result_path.is_file():
        raise sql_storage_error(
            "Stored SQL result snapshot is unavailable",
            {"storageLocation": str(result_path)},
        )
    return result_path


def read_query_result_artifact(
    result_path: Path,
    *,
    limit: int | None = None,
    offset: int = 0,
) -> list[list[str]]:
    connection = duckdb.connect(database=":memory:")
    try:
        query = f"SELECT * FROM read_parquet({quote_duckdb_string_literal(str(result_path))})"
        parameters: list[int] = []
        if limit is not None:
            query += " LIMIT ? OFFSET ?"
            parameters = [limit, offset]
        cursor = connection.execute(query, parameters)
        return [
            [format_sql_cell(cell) for cell in row]
            for row in cursor.fetchall()
        ]
    except (duckdb.Error, OSError) as error:
        raise sql_storage_error(
            "Stored SQL result snapshot could not be read",
            {"storageLocation": str(result_path), "reason": str(error)[:500]},
        ) from error
    finally:
        connection.close()


def count_query_result_artifact_rows(
    result_path: Path,
    *,
    connection: duckdb.DuckDBPyConnection | None = None,
) -> int:
    owned_connection = connection is None
    active_connection = connection or duckdb.connect(database=":memory:")
    try:
        row = active_connection.execute(
            f"SELECT COUNT(*) FROM read_parquet({quote_duckdb_string_literal(str(result_path))})"
        ).fetchone()
        return int(row[0] if row else 0)
    except (duckdb.Error, OSError) as error:
        raise sql_storage_error(
            "Stored SQL result snapshot could not be counted",
            {"storageLocation": str(result_path), "reason": str(error)[:500]},
        ) from error
    finally:
        if owned_connection:
            active_connection.close()


def execute_duckdb_preview(
    statement: str,
    *,
    context_datasets: list[CatalogDatasetResponse],
    preview_limit: int,
) -> dict[str, Any]:
    connection = duckdb.connect(database=":memory:")
    try:
        with TemporaryDirectory(prefix="asklake-sql-preview-") as remote_cache_dir:
            remote_budget = RemotePreviewBudget(remote_preview_max_bytes())
            for dataset in unique_datasets_by_id(context_datasets):
                register_duckdb_dataset(
                    connection,
                    dataset,
                    remote_cache_root=Path(remote_cache_dir),
                    remote_budget=remote_budget,
                )

            cursor = connection.execute(
                f"SELECT * FROM ({statement}) AS asklake_query_result LIMIT ?",
                [preview_limit + 1],
            )
            raw_rows = cursor.fetchall()
            columns = [str(description[0]) for description in (cursor.description or [])]
            result_truncated = len(raw_rows) > preview_limit
            raw_rows = raw_rows[:preview_limit]
            rows = [
                [format_sql_cell(cell) for cell in row]
                for row in raw_rows
            ]
            return {
                "columns": columns,
                "row_count": len(rows),
                "result_truncated": result_truncated,
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


def register_duckdb_dataset(
    connection: duckdb.DuckDBPyConnection,
    dataset: CatalogDatasetResponse,
    *,
    remote_cache_root: Path | None = None,
    remote_budget: RemotePreviewBudget | None = None,
) -> None:
    table_name = dataset.name
    registered = register_duckdb_storage_location(
        connection,
        dataset,
        table_name,
        remote_cache_root=remote_cache_root,
        remote_budget=remote_budget,
    )
    if not registered:
        raise sql_storage_error(
            "Dataset physical storage is unavailable; SQL Preview will not use sample rows",
            {
                "datasetId": dataset_identifier(dataset, fallback=table_name),
                "storageLocation": object_field(dataset, "storage_location", "storageLocation"),
                "storageFormat": object_field(dataset, "storage_format", "storageFormat"),
            },
        )

    if dataset.id != dataset.name:
        connection.execute(
            f"CREATE TEMP VIEW {quote_duckdb_identifier(dataset.id)} AS SELECT * FROM {quote_duckdb_identifier(table_name)}"
        )


def register_duckdb_storage_location(
    connection: duckdb.DuckDBPyConnection,
    dataset: CatalogDatasetResponse,
    table_name: str,
    *,
    remote_cache_root: Path | None = None,
    remote_budget: RemotePreviewBudget | None = None,
) -> bool:
    storage_segments: list[tuple[str, str]] = []
    dataset_id = dataset_identifier(dataset, fallback=table_name)
    try:
        storage_segments = dataset_storage_segments(dataset)
        if not storage_segments:
            return False

        unsupported_segments = [
            {"storageFormat": storage_format or None, "storageLocation": storage_location}
            for storage_location, storage_format in storage_segments
            if storage_format not in SUPPORTED_SQL_STORAGE_FORMATS
        ]
        if unsupported_segments:
            raise sql_storage_error(
                "Dataset storage format is not supported for SQL Preview",
                {
                    "datasetId": dataset_id,
                    "segments": unsupported_segments,
                },
            )

        scan_segments: list[tuple[str, str] | None] = [None] * len(storage_segments)
        remote_plans: list[tuple[int, RemoteStorageDownloadPlan]] = []
        for index, (storage_location, storage_format) in enumerate(storage_segments):
            if is_remote_storage_location(storage_location):
                if remote_cache_root is None or remote_budget is None:
                    raise sql_storage_error(
                        "Remote SQL Preview cache is not configured",
                        {"datasetId": dataset_id},
                    )
                remote_plans.append(
                    (
                        index,
                        plan_remote_storage_dataset(
                            storage_location,
                            dataset_id=dataset_id,
                            storage_format=storage_format,
                        ),
                    )
                )
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
            scan_segments[index] = (scan_path, storage_format)

        if remote_budget is not None:
            for _, plan in remote_plans:
                remote_budget.reserve(
                    sum(size_bytes for _, size_bytes in plan.objects),
                    bucket=plan.bucket,
                    prefix=plan.prefix,
                )
        if remote_cache_root is not None:
            for index, plan in remote_plans:
                scan_segments[index] = (
                    download_remote_storage_plan(plan, cache_root=remote_cache_root),
                    plan.storage_format,
                )

        resolved_scan_segments = [segment for segment in scan_segments if segment is not None]
        if len(resolved_scan_segments) != len(storage_segments):
            raise ValueError("Not all active storage segments were prepared")
        register_duckdb_scan_segments_view(connection, table_name, resolved_scan_segments)
        return True
    except ApiError:
        raise
    except (OSError, ValueError, duckdb.Error, json.JSONDecodeError) as error:
        raise sql_storage_error(
            "Dataset physical storage could not be read for SQL Preview",
            {
                "datasetId": dataset_id,
                "storageFormats": sorted({storage_format for _, storage_format in storage_segments}),
                "storageLocations": [storage_location for storage_location, _ in storage_segments],
                "reason": str(error)[:500],
            },
        ) from error


def register_duckdb_scan_view(
    connection: duckdb.DuckDBPyConnection,
    table_name: str,
    scan_path: str,
    storage_format: str,
) -> None:
    register_duckdb_scan_segments_view(
        connection,
        table_name,
        [(scan_path, storage_format)],
    )


def register_duckdb_scan_segments_view(
    connection: duckdb.DuckDBPyConnection,
    table_name: str,
    scan_segments: list[tuple[str, str]],
) -> None:
    table = quote_duckdb_identifier(table_name)
    sources = [
        duckdb_scan_source(scan_path, storage_format)
        for scan_path, storage_format in scan_segments
    ]
    union_sql = " UNION ALL BY NAME ".join(f"SELECT * FROM {source}" for source in sources)
    connection.execute(f"CREATE TEMP VIEW {table} AS {union_sql}")


def duckdb_scan_source(scan_path: str, storage_format: str) -> str:
    path = quote_duckdb_string_literal(scan_path)
    if storage_format == "parquet":
        return f"read_parquet({path}, union_by_name = true, hive_partitioning = true)"
    if storage_format == "csv":
        return f"read_csv_auto({path}, header = true, union_by_name = true, hive_partitioning = true)"
    if storage_format in {"json", "jsonl"}:
        return f"read_json_auto({path}, union_by_name = true, hive_partitioning = true)"
    raise ValueError(f"Unsupported storage format: {storage_format or '-'}")


def attach_sql_materialization_runs(
    dataset: CatalogDatasetResponse,
    payload: Mapping[str, Any],
) -> None:
    raw_runs = payload.get("materializationRuns")
    if raw_runs is None:
        raw_runs = payload.get("materialization_runs")
    if isinstance(raw_runs, list):
        object.__setattr__(dataset, SQL_MATERIALIZATION_RUNS_ATTR, list(raw_runs))


def dataset_storage_segments(dataset: CatalogDatasetResponse) -> list[tuple[str, str]]:
    fallback_format = normalize_storage_format(
        object_field(dataset, "storage_format", "storageFormat")
    )
    materialization_runs = dataset_materialization_runs(dataset)
    if not materialization_runs:
        fallback_location = normalize_storage_location(
            object_field(dataset, "storage_location", "storageLocation")
        )
        return [(fallback_location, fallback_format)] if fallback_location else []

    active_runs = active_dataset_materialization_runs(dataset)
    if not active_runs:
        raise sql_storage_error(
            "Dataset materialization history has no successful active segments",
            {
                "datasetId": dataset_identifier(dataset),
                "runStatuses": [
                    str(object_field(run, "status") or "")
                    for run in materialization_runs
                ],
            },
        )

    newest_segments: list[tuple[str, str]] = []
    seen_locations: dict[str, str] = {}
    missing_run_ids: list[str] = []
    for run in active_runs:
        location = normalize_storage_location(run.get("storageLocation"))
        if not location:
            missing_run_ids.append(str(run.get("runId") or "unknown"))
            continue
        storage_format = normalize_storage_format(run.get("storageFormat") or fallback_format)
        location_key = canonical_storage_location(location)
        previous_format = seen_locations.get(location_key)
        if previous_format is not None:
            if previous_format != storage_format:
                raise sql_storage_error(
                    "Duplicate dataset storage location has conflicting formats",
                    {
                        "datasetId": dataset_identifier(dataset),
                        "storageFormats": sorted({previous_format, storage_format}),
                        "storageLocation": location,
                    },
                )
            continue
        seen_locations[location_key] = storage_format
        newest_segments.append((location, storage_format))

    if missing_run_ids:
        raise sql_storage_error(
            "Active dataset materialization segment has no storage location",
            {
                "datasetId": dataset_identifier(dataset),
                "runIds": missing_run_ids,
            },
        )
    if not newest_segments:
        raise sql_storage_error(
            "Dataset materialization history has no readable active segments",
            {"datasetId": dataset_identifier(dataset)},
        )

    return list(reversed(newest_segments))


def active_dataset_materialization_runs(
    dataset: CatalogDatasetResponse,
) -> list[dict[str, Any]]:
    active_runs: list[dict[str, Any]] = []
    for raw_run in dataset_materialization_runs(dataset):
        run = normalize_materialization_run(raw_run)
        if str(run.get("status") or "").strip().casefold() != "success":
            continue
        active_runs.append(run)
        if materialization_mode(run) == "snapshot":
            break
    return active_runs


def dataset_materialization_runs(dataset: CatalogDatasetResponse) -> list[Any]:
    attached_runs = getattr(dataset, SQL_MATERIALIZATION_RUNS_ATTR, None)
    if isinstance(attached_runs, (list, tuple)):
        return list(attached_runs)

    candidates = [
        object_field(dataset, "materialization_runs"),
        object_field(dataset, "materializationRuns"),
    ]
    for candidate in candidates:
        if isinstance(candidate, (list, tuple)) and candidate:
            return list(candidate)
    for candidate in candidates:
        if isinstance(candidate, (list, tuple)):
            return list(candidate)
    return []


def normalize_materialization_run(run: Any) -> dict[str, Any]:
    return {
        "materializationMode": object_field(
            run,
            "materializationMode",
            "materialization_mode",
        ),
        "runId": object_field(run, "runId", "run_id"),
        "sourceKind": object_field(run, "sourceKind", "source_kind"),
        "status": object_field(run, "status"),
        "storageFormat": object_field(run, "storageFormat", "storage_format"),
        "storageLocation": object_field(run, "storageLocation", "storage_location"),
    }


def materialization_mode(run: Mapping[str, Any]) -> str:
    raw_mode = run.get("materializationMode") or run.get("materialization_mode")
    mode = str(raw_mode or "").strip().casefold()
    if mode:
        return mode if mode in {"snapshot", "delta"} else "snapshot"

    source_kind = str(
        run.get("sourceKind")
        or run.get("source_kind")
        or ""
    ).strip().casefold()
    return "delta" if source_kind == "kafka" else "snapshot"


def object_field(value: Any, *names: str) -> Any:
    for name in names:
        if isinstance(value, Mapping):
            field_value = value.get(name)
        else:
            field_value = getattr(value, name, None)
        if field_value is not None:
            return field_value
    return None


def dataset_identifier(dataset: CatalogDatasetResponse, *, fallback: str = "dataset") -> str:
    return str(object_field(dataset, "id") or fallback)


def normalize_storage_format(value: Any) -> str:
    return str(value or "").strip().casefold()


def normalize_storage_location(value: Any) -> str:
    location = str(value or "").strip()
    return "" if location.casefold() in {"", "-", "pending"} else location


def canonical_storage_location(storage_location: str) -> str:
    if is_remote_storage_location(storage_location):
        parsed = urlparse(storage_location)
        prefix = re.sub(r"/+", "/", parsed.path).rstrip("/")
        return f"s3://{parsed.netloc.casefold()}{prefix}"
    return os.path.normcase(str(Path(storage_location).expanduser().resolve(strict=False)))


def is_remote_storage_location(storage_location: str) -> bool:
    return urlparse(storage_location).scheme.lower() in REMOTE_STORAGE_SCHEMES


def remote_preview_max_bytes() -> int:
    raw_value = os.environ.get("ASKLAKE_SQL_PREVIEW_MAX_REMOTE_BYTES", "")
    if not raw_value.strip():
        return DEFAULT_REMOTE_PREVIEW_MAX_BYTES
    try:
        value = int(raw_value)
    except ValueError:
        return DEFAULT_REMOTE_PREVIEW_MAX_BYTES
    return value if value > 0 else DEFAULT_REMOTE_PREVIEW_MAX_BYTES


def download_remote_parquet_dataset(
    storage_location: str,
    *,
    dataset_id: str,
    cache_root: Path,
    budget: RemotePreviewBudget,
) -> str:
    return download_remote_storage_dataset(
        storage_location,
        dataset_id=dataset_id,
        storage_format="parquet",
        cache_root=cache_root,
        budget=budget,
    )


def download_remote_storage_dataset(
    storage_location: str,
    *,
    dataset_id: str,
    storage_format: str,
    cache_root: Path,
    budget: RemotePreviewBudget,
) -> str:
    plan = plan_remote_storage_dataset(
        storage_location,
        dataset_id=dataset_id,
        storage_format=storage_format,
    )
    budget.reserve(
        sum(size_bytes for _, size_bytes in plan.objects),
        bucket=plan.bucket,
        prefix=plan.prefix,
    )
    return download_remote_storage_plan(plan, cache_root=cache_root)


def plan_remote_storage_dataset(
    storage_location: str,
    *,
    dataset_id: str,
    storage_format: str,
) -> RemoteStorageDownloadPlan:
    format_label = storage_format_label(storage_format)
    parsed = urlparse(storage_location)
    bucket = parsed.netloc.strip()
    prefix = parsed.path.lstrip("/").rstrip("/")
    if not bucket or not prefix:
        raise sql_storage_error(
            "Remote dataset storage location is invalid",
            {"datasetId": dataset_id, "storageLocation": storage_location},
        )
    require_allowed_preview_bucket(bucket)

    try:
        client = build_sql_preview_s3_client()
        storage_objects = list_remote_storage_objects(client, bucket, prefix, storage_format)
    except ApiError:
        raise
    except Exception as exc:
        raise sql_storage_error(
            f"Remote {format_label} dataset could not be loaded for SQL Preview",
            {
                "datasetId": dataset_id,
                "bucket": bucket,
                "prefix": prefix,
                "reason": str(exc)[:500],
            },
        ) from exc

    if not storage_objects:
        raise sql_storage_error(
            f"Remote dataset does not contain {format_label} objects",
            {
                "datasetId": dataset_id,
                "bucket": bucket,
                "prefix": prefix,
                "storageFormat": storage_format,
            },
        )
    return RemoteStorageDownloadPlan(
        bucket=bucket,
        client=client,
        dataset_id=dataset_id,
        objects=tuple(storage_objects),
        prefix=prefix,
        storage_format=storage_format,
        storage_location=storage_location,
    )


def download_remote_storage_plan(
    plan: RemoteStorageDownloadPlan,
    *,
    cache_root: Path,
) -> str:
    format_label = storage_format_label(plan.storage_format)
    segment_cache_dir = (
        cache_root
        / safe_cache_directory_name(plan.dataset_id)
        / remote_segment_cache_directory_name(plan.storage_location)
    )
    try:
        segment_cache_dir.mkdir(parents=True, exist_ok=True)
        for object_key, _ in plan.objects:
            destination = remote_object_cache_path(
                segment_cache_dir,
                object_key,
                plan.prefix,
            )
            destination.parent.mkdir(parents=True, exist_ok=True)
            plan.client.download_file(plan.bucket, object_key, str(destination))
        return str(segment_cache_dir / "**" / f"*.{plan.storage_format}")
    except Exception as exc:
        raise sql_storage_error(
            f"Remote {format_label} dataset could not be loaded for SQL Preview",
            {
                "datasetId": plan.dataset_id,
                "bucket": plan.bucket,
                "prefix": plan.prefix,
                "reason": str(exc)[:500],
            },
        ) from exc


def storage_format_label(storage_format: str) -> str:
    return {
        "csv": "CSV",
        "json": "JSON",
        "jsonl": "JSONL",
        "parquet": "Parquet",
    }.get(storage_format, storage_format.upper())


def list_remote_parquet_objects(client: Any, bucket: str, prefix: str) -> list[tuple[str, int]]:
    return list_remote_storage_objects(client, bucket, prefix, "parquet")


def list_remote_storage_objects(
    client: Any,
    bucket: str,
    prefix: str,
    storage_format: str,
) -> list[tuple[str, int]]:
    objects: list[tuple[str, int]] = []
    suffix = f".{storage_format.lower()}"
    continuation_token: str | None = None
    while True:
        request: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
        if continuation_token:
            request["ContinuationToken"] = continuation_token
        response = client.list_objects_v2(**request)
        for item in response.get("Contents") or []:
            object_key = str(item.get("Key") or "")
            size_bytes = max(int(item.get("Size") or 0), 0)
            if object_key.lower().endswith(suffix) and size_bytes > 0:
                objects.append((object_key, size_bytes))
        if not response.get("IsTruncated"):
            break
        continuation_token = response.get("NextContinuationToken")
        if not continuation_token:
            break
    return sorted(objects)


def build_sql_preview_s3_client() -> Any:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as exc:
        raise sql_storage_error("Python S3 client dependency is not installed") from exc

    runtime = object_storage_runtime()
    kwargs: dict[str, Any] = {
        "config": Config(
            connect_timeout=5,
            read_timeout=30,
            retries={"max_attempts": 2, "mode": "standard"},
            s3={"addressing_style": "path" if runtime.force_path_style else "auto"},
        ),
        **runtime.boto3_kwargs(),
    }
    return boto3.client("s3", **kwargs)


def require_allowed_preview_bucket(bucket: str) -> None:
    configured_buckets = (
        os.environ.get("S3_ALLOWED_BUCKETS")
        or os.environ.get("ASKLAKE_S3_ALLOWED_BUCKETS")
        or os.environ.get("MINIO_BUCKET")
        or ""
    )
    allowed_buckets = {value.strip() for value in configured_buckets.split(",") if value.strip()}
    if allowed_buckets and bucket not in allowed_buckets:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Remote dataset bucket is not allowed for SQL Preview",
            status.HTTP_403_FORBIDDEN,
            {"bucket": bucket},
        )


def safe_cache_directory_name(dataset_id: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_.-]+", "_", dataset_id).strip("._")
    return normalized or "dataset"


def remote_segment_cache_directory_name(storage_location: str) -> str:
    return sha256(storage_location.encode("utf-8")).hexdigest()[:16]


def remote_object_cache_path(cache_dir: Path, object_key: str, prefix: str) -> Path:
    relative_key = object_key[len(prefix):].lstrip("/") if object_key.startswith(prefix) else ""
    safe_parts = [
        part
        for part in PurePosixPath(relative_key).parts
        if part not in {"", ".", ".."}
    ]
    if not safe_parts:
        safe_parts = [Path(object_key).name or "part.parquet"]
    return cache_dir.joinpath(*safe_parts)


def sql_storage_error(message: str, details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(
        "SQL_STORAGE_ERROR",
        message,
        status.HTTP_502_BAD_GATEWAY,
        details,
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
