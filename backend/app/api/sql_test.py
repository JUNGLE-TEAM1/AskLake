import re
from typing import Any

import duckdb
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlglot import exp, parse_one
from sqlglot.errors import ParseError

from app.api.catalog import get_catalog_service
from app.core.auth_context import ActorContext, get_actor_context
from app.services.catalog_service import CatalogService
from app.services.sql_service import validate_read_only_query

router = APIRouter(prefix="/sql", tags=["sql-test"])


class SqlTestSource(BaseModel):
    source_dataset_id: str
    source_name: str = ""
    columns: list[str] = Field(default_factory=list)
    column_types: dict[str, str] = Field(default_factory=dict)
    sample_rows: list[list[Any]] = Field(default_factory=list, max_length=100)


class SqlTestRequest(BaseModel):
    sources: list[SqlTestSource] = Field(default_factory=list)
    sql: str
    limit: int | None = Field(default=5, ge=1, le=100)


@router.post("/test")
def test_sql_transform(
    request: SqlTestRequest,
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    catalog_service: Annotated[CatalogService, Depends(get_catalog_service)],
) -> dict[str, Any]:
    limit = request.limit or 5
    if len(request.sources) != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="SQL transform preview requires exactly one source.",
        )

    source = request.sources[0]
    is_catalog_source = bool(source.source_dataset_id.strip()) and source.source_dataset_id != "asklake-draft-source"
    if is_catalog_source:
        dataset = catalog_service.get_dataset(source.source_dataset_id, actor)
        page = catalog_service.get_dataset_rows(
            source.source_dataset_id,
            actor,
            limit=min(max(limit * 10, 50), 100),
            offset=0,
        )
        columns = unique_columns(source.columns) or page.columns
        page_column_indexes = {name.casefold(): index for index, name in enumerate(page.columns)}
        unknown_columns = [column for column in columns if column.casefold() not in page_column_indexes]
        if unknown_columns:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown Catalog source columns: {', '.join(unknown_columns[:20])}",
            )
        column_types = {name.casefold(): type_name for name, type_name in dataset.schema_}
        source_rows = [
            {
                column: row[page_column_indexes[column.casefold()]]
                for column in columns
            }
            for row in page.rows
        ]
        dataset_name = dataset.name
        dataset_row_count = page.row_count
        preview_origin = "catalog"
    else:
        columns = unique_columns(source.columns)
        if not source.sample_rows:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The connected source did not provide actual sample rows.",
            )
        column_types = {name.casefold(): type_name for name, type_name in source.column_types.items()}
        source_rows = [
            {column: row[index] if index < len(row) else None for index, column in enumerate(columns)}
            for row in source.sample_rows
        ]
        dataset_name = source.source_name.strip() or "Connected source sample"
        dataset_row_count = len(source_rows)
        preview_origin = "source_sample"

    if not columns:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No source columns available.",
        )

    try:
        validated_sql = validate_read_only_query(request.sql)
        validate_transform_scope(validated_sql, columns)
        duckdb_sql = convert_spark_identifiers_to_duckdb(validated_sql)

        con = duckdb.connect(database=":memory:")
        try:
            create_preview_table(con, "input", columns, source_rows, column_types=column_types)
            preview_sql = with_preview_limit(duckdb_sql, limit)
            result = con.execute(preview_sql)
            result_columns = [description[0] for description in result.description or []]
            result_rows = [row_to_dict(result_columns, row) for row in result.fetchall()]
        finally:
            con.close()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    source_samples = [{
        "source_dataset_id": source.source_dataset_id,
        "source_name": dataset_name,
        "rows": project_source_rows(source_rows, columns),
    }]

    return {
        "valid": True,
        "schema": [
            {"name": column, "type": infer_preview_type(result_rows, column), "nullable": True}
            for column in result_columns
        ],
        "sample_rows": result_rows,
        "before_rows": source_rows,
        "source_samples": source_samples,
        "preview_origin": preview_origin,
        "dataset_row_count": dataset_row_count,
        "spark_warnings": [],
        "sql_conversions": [],
    }


# The FastAPI handler lives in a *_test.py module but is not itself a pytest test.
test_sql_transform.__test__ = False


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


def validate_transform_scope(sql: str, columns: list[str]) -> None:
    try:
        expression = parse_one(sql, read="spark")
    except ParseError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Spark SQL transform.",
        ) from exc
    if not isinstance(expression, (exp.Select, exp.Union, exp.Intersect, exp.Except)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="SQL transform preview accepts one read-only SELECT query.",
        )

    cte_names = {str(cte.alias_or_name).casefold() for cte in expression.find_all(exp.CTE)}
    allowed_relations = {"input", *cte_names}
    invalid_relations = sorted({
        table.sql(dialect="spark")
        for table in expression.find_all(exp.Table)
        if table.catalog or table.db or table.name.casefold() not in allowed_relations
    })
    if invalid_relations:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="SQL transform may reference only the selected Catalog input.",
        )

    allowed_columns = {column.casefold() for column in columns}
    aliases = {
        str(alias.alias).casefold()
        for alias in expression.find_all(exp.Alias)
        if alias.alias
    }
    unknown_columns = sorted({
        column.name
        for column in expression.find_all(exp.Column)
        if column.name != "*"
        and column.name.casefold() not in allowed_columns
        and column.name.casefold() not in aliases
    })
    if unknown_columns:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"SQL transform referenced unknown columns: {', '.join(unknown_columns[:20])}",
        )


def create_preview_table(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    columns: list[str],
    rows: list[dict[str, Any]],
    *,
    column_types: dict[str, str] | None = None,
) -> None:
    resolved_types = column_types or {}
    column_sql = ", ".join(
        f"{quote_identifier(column)} {duckdb_preview_type(resolved_types.get(column.casefold(), 'string'))}"
        for column in columns
    )
    con.execute(f"CREATE TABLE {quote_identifier(table_name)} ({column_sql})")
    if not rows:
        return
    placeholders = ", ".join("?" for _ in columns)
    con.executemany(
        f"INSERT INTO {quote_identifier(table_name)} VALUES ({placeholders})",
        [[preview_cell(row.get(column), resolved_types.get(column.casefold(), "string")) for column in columns] for row in rows],
    )


def duckdb_preview_type(type_name: str) -> str:
    normalized = str(type_name or "string").strip().lower()
    if any(token in normalized for token in ("tinyint", "smallint", "integer", "bigint", "long")):
        return "BIGINT"
    if any(token in normalized for token in ("double", "float", "decimal", "numeric", "real")):
        return "DOUBLE"
    if "bool" in normalized:
        return "BOOLEAN"
    if "timestamp" in normalized or "datetime" in normalized:
        return "TIMESTAMP"
    if normalized == "date":
        return "DATE"
    return "VARCHAR"


def preview_cell(value: Any, type_name: str) -> Any:
    if duckdb_preview_type(type_name) != "VARCHAR" and str(value or "").strip() == "":
        return None
    return value


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
