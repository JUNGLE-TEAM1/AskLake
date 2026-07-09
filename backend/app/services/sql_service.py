import re
from collections.abc import Iterable
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import duckdb
from fastapi import status

from app.core.auth_context import ActorContext, require_permission
from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.sql import QueryRunRequest, QueryRunResponse

DEFAULT_PREVIEW_LIMIT = 100
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
            require_permission(
                actor_context,
                "query",
                owner=dataset.owner,
                grants=dataset.permission_grants,
                resource_label="dataset",
            )
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

    def get_query_run(self, run_id: str) -> QueryRunResponse:
        payload = self.repository.get_run_payload(run_id)
        if payload is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "SQL run not found",
                status.HTTP_404_NOT_FOUND,
                {"runId": run_id},
            )
        return QueryRunResponse.model_validate(payload)

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
        return CatalogDatasetResponse.model_validate(payload)


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


def register_duckdb_dataset(
    connection: duckdb.DuckDBPyConnection,
    dataset: CatalogDatasetResponse,
) -> None:
    table_name = dataset.name
    registered = register_duckdb_storage_location(connection, dataset, table_name)
    if not registered:
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
    storage_location = dataset.storage_location
    if not storage_location:
        return False

    storage_path = Path(storage_location)
    if not storage_path.exists():
        return False

    storage_format = str(dataset.storage_format or "").lower()
    try:
        if storage_format == "jsonl" and storage_path.is_file():
            records = read_jsonl_records(storage_path)
            if not records:
                return False
            register_duckdb_records(connection, table_name, records)
            return True

        if storage_format == "parquet":
            parquet_path = parquet_scan_path(storage_path)
            if not parquet_path:
                return False
            connection.execute(
                f"CREATE TEMP VIEW {quote_duckdb_identifier(table_name)} AS "
                f"SELECT * FROM read_parquet({quote_duckdb_string_literal(parquet_path)})"
            )
            return True
    except (OSError, duckdb.Error, json.JSONDecodeError):
        return False

    return False


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
