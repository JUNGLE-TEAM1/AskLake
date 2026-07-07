import json
import re
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import duckdb
from fastapi import status

from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.sql import QueryRunRequest, QueryRunResponse

DEFAULT_PREVIEW_LIMIT = 100
MAX_RESULT_COLUMNS = 100
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


class SqlPreviewExecutionResult:
    def __init__(self, *, columns: list[str], rows: list[list[str]]) -> None:
        self.columns = columns
        self.rows = rows


class SqlService:
    def __init__(
        self,
        repository: SqlRepository,
        catalog_repository: CatalogRepository,
    ) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository

    def create_query_run(self, request: QueryRunRequest) -> QueryRunResponse:
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
        execution_datasets = resolve_execution_datasets(
            statement,
            base_dataset,
            reference_datasets,
        )
        preview_limit = request.limit or DEFAULT_PREVIEW_LIMIT
        result = execute_preview_query(
            statement=statement,
            datasets=execution_datasets,
            preview_limit=preview_limit,
        )

        response = QueryRunResponse(
            base_dataset_id=base_dataset_id,
            columns=result.columns,
            dataset_id=base_dataset.id,
            dataset_name=base_dataset.name,
            executed_at=current_utc_timestamp(),
            mode=request.mode,
            preview_limit=preview_limit,
            query=query,
            reference_dataset_ids=reference_dataset_ids,
            row_count=len(result.rows),
            rows=result.rows,
            run_id=f"sql_{uuid4().hex[:12]}",
            validation_key=request.validation_key,
        )

        self.repository.save_run_payload(
            response.model_dump(by_alias=True, exclude_none=True, mode="json")
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
        return CatalogDatasetResponse.model_validate(payload)


def validate_read_only_query(query: str) -> str:
    if not query.strip():
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "SQL query cannot be empty",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    masked_query = mask_sql_comments_and_literals(query)
    statement = get_single_statement(masked_query, query)
    lowered_statement = mask_sql_comments_and_literals(statement).strip().lower()

    mutation_match = MUTATION_KEYWORD_RE.search(lowered_statement)
    if mutation_match:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Only read-only SELECT queries are allowed",
            status.HTTP_403_FORBIDDEN,
            {"keyword": mutation_match.group(1).upper()},
        )

    if lowered_statement.startswith("select"):
        return statement

    if lowered_statement.startswith("with") and re.search(
        r"\bselect\b",
        lowered_statement,
    ):
        return statement

    raise ApiError(
        ErrorCode.SQL_SYNTAX_ERROR,
        "Only SELECT or WITH ... SELECT statements are supported",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    )


def resolve_execution_datasets(
    statement: str,
    base_dataset: CatalogDatasetResponse,
    reference_datasets: list[CatalogDatasetResponse],
) -> list[CatalogDatasetResponse]:
    context_datasets = [base_dataset, *reference_datasets]
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

    execution_datasets = unique_datasets_by_id(
        dataset_by_table_name[table_name]
        for table_name in physical_table_names
        if table_name in dataset_by_table_name
    )

    if execution_datasets:
        return execution_datasets
    return [base_dataset]


def execute_preview_query(
    *,
    statement: str,
    datasets: list[CatalogDatasetResponse],
    preview_limit: int,
) -> SqlPreviewExecutionResult:
    connection = duckdb.connect(database=":memory:")
    try:
        for dataset in datasets:
            register_dataset_table(connection, dataset)

        cursor = connection.execute(
            f"SELECT * FROM ({statement}) AS asklake_preview_result LIMIT ?",
            [preview_limit],
        )
        columns = [
            str(description[0] or f"column_{index + 1}")
            for index, description in enumerate(cursor.description or [])
        ][:MAX_RESULT_COLUMNS]
        rows = [
            [stringify_result_value(cell) for cell in row[:MAX_RESULT_COLUMNS]]
            for row in cursor.fetchall()
        ]
        return SqlPreviewExecutionResult(columns=columns, rows=rows)
    except duckdb.Error as error:
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "SQL preview execution failed",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"detail": str(error)},
        ) from error
    finally:
        connection.close()


def register_dataset_table(
    connection: duckdb.DuckDBPyConnection,
    dataset: CatalogDatasetResponse,
) -> None:
    columns = dataset.schema_ or [("value", "string")]
    column_names = unique_column_names([column_name for column_name, _ in columns])
    quoted_columns = ", ".join(
        f"{quote_sql_identifier(column_name)} TEXT"
        for column_name in column_names
    )
    primary_table_name = dataset.name
    connection.execute(
        f"CREATE TABLE {quote_sql_identifier(primary_table_name)} ({quoted_columns})"
    )

    dataset_rows = load_dataset_rows(dataset, len(column_names))
    if dataset_rows:
        placeholders = ", ".join("?" for _ in column_names)
        connection.executemany(
            f"INSERT INTO {quote_sql_identifier(primary_table_name)} VALUES ({placeholders})",
            dataset_rows,
        )

    if normalize_sql_identifier(dataset.id) != normalize_sql_identifier(primary_table_name):
        connection.execute(
            f"CREATE VIEW {quote_sql_identifier(dataset.id)} AS SELECT * FROM {quote_sql_identifier(primary_table_name)}"
        )


def load_dataset_rows(
    dataset: CatalogDatasetResponse,
    column_count: int,
) -> list[list[str | None]]:
    storage_rows = load_jsonl_storage_rows(dataset, column_count)
    if storage_rows is not None:
        return storage_rows
    return normalize_dataset_rows(dataset.sample_rows, column_count)


def load_jsonl_storage_rows(
    dataset: CatalogDatasetResponse,
    column_count: int,
) -> list[list[str | None]] | None:
    if dataset.storage_format != "jsonl" or not dataset.storage_location:
        return None

    storage_path = Path(dataset.storage_location)
    if not storage_path.exists() or not storage_path.is_file():
        return None

    column_names = [column_name for column_name, _ in dataset.schema_]
    rows: list[list[str | None]] = []
    with storage_path.open("r", encoding="utf-8") as data_file:
        for line in data_file:
            if not line.strip():
                continue
            record = json.loads(line)
            if isinstance(record, dict):
                rows.append([
                    stringify_sql_value(record.get(column_names[index]))
                    if index < len(column_names)
                    else None
                    for index in range(column_count)
                ])
            elif isinstance(record, list):
                rows.append(normalize_dataset_row(record, column_count))
    return rows


def normalize_dataset_rows(
    rows: list[list[str]],
    column_count: int,
) -> list[list[str | None]]:
    return [normalize_dataset_row(row, column_count) for row in rows]


def normalize_dataset_row(row: list[object], column_count: int) -> list[str | None]:
    return [
        stringify_sql_value(row[index]) if index < len(row) else None
        for index in range(column_count)
    ]


def unique_column_names(column_names: list[str]) -> list[str]:
    unique_names: list[str] = []
    seen_names: dict[str, int] = {}
    for index, column_name in enumerate(column_names):
        base_name = column_name.strip() or f"column_{index + 1}"
        normalized_name = base_name.lower()
        seen_count = seen_names.get(normalized_name, 0)
        seen_names[normalized_name] = seen_count + 1
        unique_names.append(base_name if seen_count == 0 else f"{base_name}_{seen_count + 1}")
    return unique_names


def quote_sql_identifier(identifier: str) -> str:
    return f'"{identifier.replace("\"", "\"\"")}"'


def stringify_sql_value(value: object) -> str | None:
    if value is None:
        return None
    return str(value)


def stringify_result_value(value: object) -> str:
    if value is None:
        return ""
    return str(value)


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


def get_single_statement(masked_query: str, original_query: str) -> str:
    masked_statement = masked_query.strip()
    original_statement = original_query.strip()
    semicolon_count = masked_statement.count(";")
    if semicolon_count == 0:
        return original_statement
    if semicolon_count == 1 and masked_statement.endswith(";"):
        return original_statement[:-1].strip()

    raise ApiError(
        ErrorCode.SQL_SYNTAX_ERROR,
        "Only a single SQL statement is allowed",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    )


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
