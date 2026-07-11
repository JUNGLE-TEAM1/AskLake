from collections.abc import Iterable

from fastapi import status
from sqlglot import exp, parse
from sqlglot.errors import ParseError

from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.services.sql_service import build_dataset_context_map, normalize_sql_identifier


def compile_trino_read_query(
    query: str,
    datasets: Iterable[CatalogDatasetResponse],
) -> tuple[str, list[CatalogDatasetResponse]]:
    if not query.strip():
        raise ApiError(ErrorCode.SQL_SYNTAX_ERROR, "SQL query cannot be empty", status.HTTP_422_UNPROCESSABLE_ENTITY)
    try:
        expressions = parse(query, read="trino")
    except ParseError as exc:
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "SQL query could not be parsed",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        ) from exc
    if len(expressions) != 1 or expressions[0] is None:
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "Only a single SQL statement is allowed",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    expression = expressions[0]
    if not isinstance(expression, (exp.Select, exp.Union, exp.Intersect, exp.Except)):
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Only read-only SELECT queries are allowed",
            status.HTTP_403_FORBIDDEN,
        )

    context_datasets = list(datasets)
    dataset_by_table_name = build_dataset_context_map(context_datasets)
    cte_names = {normalize_sql_identifier(cte.alias_or_name) for cte in expression.find_all(exp.CTE)}
    referenced_datasets: list[CatalogDatasetResponse] = []
    referenced_ids: set[str] = set()

    for table in expression.find_all(exp.Table):
        if not isinstance(table.this, exp.Identifier):
            raise ApiError(
                ErrorCode.FORBIDDEN,
                "SQL table functions are not allowed",
                status.HTTP_403_FORBIDDEN,
            )
        raw_name = table.name
        if not raw_name:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "SQL relation could not be resolved",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if not table.db and not table.catalog and normalize_sql_identifier(raw_name) in cte_names:
            continue
        if table.db or table.catalog:
            raise ApiError(
                ErrorCode.FORBIDDEN,
                "Physical catalog and schema references are not allowed",
                status.HTTP_403_FORBIDDEN,
            )

        dataset = dataset_by_table_name.get(normalize_sql_identifier(raw_name))
        if dataset is None:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "SQL references tables outside the selected dataset context",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"table": raw_name},
            )
        mapping = dataset.query_engine_table
        if dataset.query_engine_status != "available" or mapping is None:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Dataset is not available in the Trino query engine",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {
                    "datasetId": dataset.id,
                    "datasetName": dataset.name,
                    "queryEngineStatus": dataset.query_engine_status,
                },
            )
        table.set("this", exp.to_identifier(mapping.table, quoted=True))
        table.set("db", exp.to_identifier(mapping.schema_, quoted=True))
        table.set("catalog", exp.to_identifier(mapping.catalog, quoted=True))
        if dataset.id not in referenced_ids:
            referenced_datasets.append(dataset)
            referenced_ids.add(dataset.id)

    return expression.sql(dialect="trino"), referenced_datasets
