import json
import re
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import duckdb


MUTATION_RE = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|copy|call|execute)\b",
    re.IGNORECASE,
)


def main() -> None:
    payload = json.load(sys.stdin)
    statement = validate_query(str(payload.get("query") or ""))
    datasets = payload.get("datasets") if isinstance(payload.get("datasets"), list) else []
    limit = normalize_limit(payload.get("limit"))
    offset = normalize_offset(payload.get("offset"))

    connection = duckdb.connect(database=":memory:")
    try:
        for dataset in unique_datasets(datasets):
            register_dataset(connection, dataset)

        count_cursor = connection.execute(
            f"SELECT COUNT(*) FROM ({statement}) AS asklake_query_count",
        )
        total_rows = int((count_cursor.fetchone() or [0])[0] or 0)
        cursor = connection.execute(
            f"SELECT * FROM ({statement}) AS asklake_query_result LIMIT ? OFFSET ?",
            [limit, offset],
        )
        raw_rows = cursor.fetchall()
        columns = [str(description[0]) for description in (cursor.description or [])]
        result = {
            "columns": columns,
            "hasNext": offset + len(raw_rows) < total_rows,
            "limit": limit,
            "offset": offset,
            "returnedRows": len(raw_rows),
            "rowCount": total_rows,
            "rows": [[format_cell(cell) for cell in row] for row in raw_rows],
        }
        print(f"ASKLAKE_QUERY_RUN_RESULT={json.dumps(result, ensure_ascii=False)}")
    finally:
        connection.close()


def validate_query(query: str) -> str:
    statement = query.strip()
    if not statement:
        raise ValueError("SQL query is required.")
    statement = statement.rstrip(";").strip()
    if not statement:
        raise ValueError("SQL query is required.")
    if MUTATION_RE.search(statement):
        raise ValueError("Only read-only SELECT queries are allowed.")
    if ";" in statement:
        raise ValueError("Multiple SQL statements are not allowed.")
    return statement


def normalize_limit(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = 100
    return min(max(parsed, 1), 10000)


def normalize_offset(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = 0
    return max(parsed, 0)


def unique_datasets(datasets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for dataset in datasets:
        if not isinstance(dataset, dict):
            continue
        dataset_id = str(dataset.get("id") or dataset.get("name") or "")
        if not dataset_id or dataset_id in seen:
            continue
        seen.add(dataset_id)
        unique.append(dataset)
    return unique


def register_dataset(connection: duckdb.DuckDBPyConnection, dataset: dict[str, Any]) -> None:
    table_name = str(dataset.get("name") or dataset.get("id") or "dataset")
    if not register_storage_location(connection, dataset, table_name):
        register_sample_rows(connection, dataset, table_name)

    dataset_id = str(dataset.get("id") or "")
    if dataset_id and dataset_id != table_name:
        connection.execute(
            f"CREATE TEMP VIEW {quote_identifier(dataset_id)} AS SELECT * FROM {quote_identifier(table_name)}"
        )


def register_storage_location(connection: duckdb.DuckDBPyConnection, dataset: dict[str, Any], table_name: str) -> bool:
    storage_location = dataset.get("storageLocation") or dataset.get("storage_location")
    if not storage_location:
        return False

    storage_path = Path(str(storage_location))
    if not storage_path.exists():
        return False

    storage_format = str(dataset.get("storageFormat") or dataset.get("storage_format") or "").lower()
    scan_path = dataset_scan_path(storage_path, storage_format)
    if not scan_path:
        return False

    reader = storage_reader(storage_format, scan_path)
    connection.execute(
        f"CREATE TEMP VIEW {quote_identifier(table_name)} AS SELECT * FROM {reader}({quote_literal(scan_path)})",
    )
    return True


def register_sample_rows(connection: duckdb.DuckDBPyConnection, dataset: dict[str, Any], table_name: str) -> None:
    columns = dataset_columns(dataset)
    sample_rows = dataset.get("sampleRows") or dataset.get("sample_rows") or []
    if not columns:
        max_width = max((len(row) for row in sample_rows if isinstance(row, list)), default=0)
        columns = [(f"column_{index + 1}", "string") for index in range(max_width)]
    if not columns:
        columns = [("empty_row", "string")]

    column_defs = ", ".join(
        f"{quote_identifier(name)} {duckdb_column_type(column_type)}"
        for name, column_type in columns
    )
    connection.execute(f"CREATE TEMP TABLE {quote_identifier(table_name)} ({column_defs})")

    if not sample_rows:
        return

    placeholders = ", ".join("?" for _ in columns)
    rows = [
        [
            coerce_cell(row[index] if index < len(row) else None, column_type)
            for index, (_, column_type) in enumerate(columns)
        ]
        for row in sample_rows
        if isinstance(row, list)
    ]
    if rows:
        connection.executemany(
            f"INSERT INTO {quote_identifier(table_name)} VALUES ({placeholders})",
            rows,
        )


def dataset_columns(dataset: dict[str, Any]) -> list[tuple[str, str]]:
    schema = dataset.get("schema") or dataset.get("schema_json") or []
    used: set[str] = set()
    columns: list[tuple[str, str]] = []
    for index, column in enumerate(schema):
        if not isinstance(column, list) or len(column) == 0:
            continue
        name = unique_column_name(str(column[0] or f"column_{index + 1}"), used)
        column_type = str(column[1] if len(column) > 1 else "string")
        columns.append((name, column_type))
    return columns


def unique_column_name(value: str, used: set[str]) -> str:
    base = value.strip() or "column"
    candidate = base
    suffix = 2
    while candidate.lower() in used:
        candidate = f"{base}_{suffix}"
        suffix += 1
    used.add(candidate.lower())
    return candidate


def duckdb_column_type(column_type: str) -> str:
    normalized = column_type.lower()
    if "bool" in normalized:
        return "BOOLEAN"
    if any(token in normalized for token in ("int", "long", "bigint")):
        return "BIGINT"
    if any(token in normalized for token in ("decimal", "double", "float", "number", "numeric")):
        return "DOUBLE"
    if "timestamp" in normalized or "datetime" in normalized:
        return "TIMESTAMP"
    if normalized == "date":
        return "DATE"
    return "VARCHAR"


def coerce_cell(value: Any, column_type: str) -> Any:
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


def format_cell(value: Any) -> str:
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
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def dataset_scan_path(storage_path: Path, storage_format: str) -> str:
    suffix = storage_path.suffix.lower()
    if storage_path.is_file() and suffix in {".parquet", ".csv", ".json", ".jsonl", ".ndjson"}:
        return str(storage_path)
    if storage_path.is_dir():
        if storage_format == "csv" and list(storage_path.rglob("*.csv")):
            return str(storage_path / "**" / "*.csv")
        if storage_format in {"json", "jsonl", "ndjson"} and list(storage_path.rglob("*.json*")):
            return str(storage_path / "**" / "*.json*")
        if list(storage_path.rglob("*.parquet")):
            return str(storage_path / "**" / "*.parquet")
    return ""


def storage_reader(storage_format: str, scan_path: str) -> str:
    lower_path = scan_path.lower()
    if storage_format == "csv" or lower_path.endswith(".csv"):
        return "read_csv_auto"
    if storage_format in {"json", "jsonl", "ndjson"} or lower_path.endswith((".json", ".jsonl", ".ndjson")):
        return "read_json_auto"
    return "read_parquet"


def quote_identifier(identifier: str) -> str:
    return '"' + str(identifier).replace('"', '""') + '"'


def quote_literal(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


if __name__ == "__main__":
    main()
