import re

from fastapi import status

from app.core.errors import ApiError
from app.schemas.catalog import QueryEngineTableRef
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoQueryRunResponse


def build_trino_materialization_statement(
    source_run: TrinoQueryRunResponse,
    target: QueryEngineTableRef,
    compiled_query: str,
) -> str:
    if source_run.status != "succeeded":
        raise ApiError(
            ErrorCode.CONFLICT,
            "Only succeeded Trino query runs can be materialized",
            status.HTTP_409_CONFLICT,
            {"runId": source_run.run_id, "status": source_run.status},
        )
    if not is_safe_table_name(target.table):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Materialized Iceberg table name is invalid",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if not compiled_query.strip():
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Trino materialization requires the compiled source query",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return (
        f"CREATE TABLE {quote_identifier(target.catalog)}.{quote_identifier(target.schema_)}.{quote_identifier(target.table)} "
        "WITH (format = 'PARQUET') AS "
        f"{compiled_query.rstrip(';')}"
    )


def is_safe_table_name(value: str) -> bool:
    return bool(re.fullmatch(r"[a-z][a-z0-9_]{0,126}", value))


def quote_identifier(value: str) -> str:
    return f'"{value.replace("\"", "\"\"")}"'
