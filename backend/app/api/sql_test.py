import re
from typing import Any

import duckdb
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.services.sql_service import validate_read_only_query

router = APIRouter(prefix="/sql", tags=["sql-test"])


class SqlTestSource(BaseModel):
    source_dataset_id: str
    columns: list[str] = Field(default_factory=list)


class SqlTestRequest(BaseModel):
    sources: list[SqlTestSource] = Field(default_factory=list)
    sql: str
    limit: int | None = Field(default=5, ge=1, le=100)


@router.post("/test")
def test_sql_transform(request: SqlTestRequest) -> dict[str, Any]:
    limit = request.limit or 5
    columns = unique_columns(
        column
        for source in request.sources
        for column in source.columns
        if column.strip()
    )
    if not columns:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No source columns available.",
        )

    try:
        validated_sql = validate_read_only_query(request.sql)
        duckdb_sql = convert_spark_identifiers_to_duckdb(validated_sql)
        source_rows = build_source_rows(columns, limit)

        con = duckdb.connect(database=":memory:")
        create_preview_table(con, "input", columns, source_rows)
        preview_sql = with_preview_limit(duckdb_sql, limit * max(len(request.sources), 1))
        result = con.execute(preview_sql)
        result_columns = [description[0] for description in result.description or []]
        result_rows = [row_to_dict(result_columns, row) for row in result.fetchall()]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    source_samples = [
        {
            "source_dataset_id": source.source_dataset_id,
            "source_name": source.source_dataset_id,
            "rows": project_source_rows(source_rows, source.columns),
        }
        for source in request.sources
    ]

    return {
        "valid": True,
        "schema": [
            {"name": column, "type": infer_preview_type(result_rows, column), "nullable": True}
            for column in result_columns
        ],
        "sample_rows": result_rows,
        "before_rows": source_rows,
        "source_samples": source_samples,
        "spark_warnings": [],
        "sql_conversions": [],
    }


def unique_columns(columns: Any) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for column in columns:
        normalized = str(column).strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def build_source_rows(columns: list[str], limit: int) -> list[dict[str, Any]]:
    return [
        {column: preview_value_for_column(column, row_index) for column in columns}
        for row_index in range(limit)
    ]


def preview_value_for_column(column: str, row_index: int) -> Any:
    lower = column.lower()
    ordinal = row_index + 1
    if "timestamp" in lower or lower.endswith("_at"):
        return str(1_612_044_451_196 + row_index * 86_400_000)
    if any(token in lower for token in ("rating", "vote", "count", "qty", "amount", "price", "score")):
        return str(ordinal)
    if lower.startswith("is_") or lower.startswith("has_") or "verified" in lower:
        return "true" if row_index % 2 == 0 else "false"
    if "image" in lower or lower.endswith("json"):
        return '[{"small_image_url":"https://example.com/sample.jpg"}]'
    if lower.endswith("id") or lower.endswith("_id") or lower in {"asin", "parent_asin"}:
        return f"{column.upper()}_{ordinal:03d}"
    return f"{column}_sample_{ordinal}"


def create_preview_table(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    columns: list[str],
    rows: list[dict[str, Any]],
) -> None:
    column_sql = ", ".join(f"{quote_identifier(column)} VARCHAR" for column in columns)
    con.execute(f"CREATE TABLE {quote_identifier(table_name)} ({column_sql})")
    placeholders = ", ".join("?" for _ in columns)
    con.executemany(
        f"INSERT INTO {quote_identifier(table_name)} VALUES ({placeholders})",
        [[row.get(column) for column in columns] for row in rows],
    )


def quote_identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) + chr(34))}"'


def convert_spark_identifiers_to_duckdb(sql: str) -> str:
    return re.sub(r"`([^`]+)`", lambda match: quote_identifier(match.group(1)), sql)


def with_preview_limit(sql: str, limit: int) -> str:
    statement = sql.strip().rstrip(";")
    if re.search(r"\blimit\s+\d+\s*$", statement, re.IGNORECASE):
        return statement
    return f"SELECT * FROM ({statement}) AS xflow_preview LIMIT {limit}"


def row_to_dict(columns: list[str], row: tuple[Any, ...]) -> dict[str, Any]:
    return {column: serialize_value(value) for column, value in zip(columns, row, strict=False)}


def serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def project_source_rows(rows: list[dict[str, Any]], columns: list[str]) -> list[dict[str, Any]]:
    selected = [column for column in columns if column]
    return [
        {column: row.get(column) for column in selected}
        for row in rows
    ]


def infer_preview_type(rows: list[dict[str, Any]], column: str) -> str:
    values = [row.get(column) for row in rows if row.get(column) not in (None, "")]
    if not values:
        return "string"
    if all(str(value).lower() in {"true", "false"} for value in values):
        return "boolean"
    if all(re.fullmatch(r"-?\d+", str(value)) for value in values):
        return "integer"
    if all(re.fullmatch(r"-?\d+(\.\d+)?", str(value)) for value in values):
        return "double"
    return "string"
