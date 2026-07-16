from uuid import uuid4

from fastapi import status
from sqlglot import exp, parse_one
from sqlglot.errors import ParseError

from app.core.errors import ApiError
from app.schemas.ai_generation import AiSqlGenerationRequest, AiSqlGenerationResponse
from app.schemas.common import ErrorCode
from app.services.ai_gateway_client import AiGatewayClient
from app.services.sql_service import validate_read_only_query


class AiGenerationService:
    def generate_sql(self, request: AiSqlGenerationRequest) -> AiSqlGenerationResponse:
        result = AiGatewayClient().generate_etl_transform(
            request_id=str(uuid4()),
            question=request.question.strip(),
            prompt_type=request.prompt_type,
            metadata=request.metadata,
            context=request.context or "",
            engine=request.engine,
        )
        sql = str(result.get("sql") or "").strip()
        if not sql:
            raise ApiError(
                ErrorCode.SQL_SYNTAX_ERROR,
                "AI gateway did not return a SQL suggestion",
                status.HTTP_502_BAD_GATEWAY,
            )
        sql = _validate_generated_transform(sql, request)
        return AiSqlGenerationResponse(
            sql=sql,
            schema_context=str(result.get("schemaContext") or result.get("schema_context") or ""),
            model=str(result.get("model") or "") or None,
        )


def _validate_generated_transform(sql: str, request: AiSqlGenerationRequest) -> str:
    normalized_sql = sql.strip().removesuffix(";").strip()
    dialect = "spark" if request.engine.strip().lower() in {"spark", "spark_sql", "pyspark"} else "trino"
    is_select = normalized_sql.lower().startswith(("select", "with"))

    if request.prompt_type == "sql_transform" or is_select:
        statement = validate_read_only_query(normalized_sql)
        expression = _parse_generated_sql(statement, dialect)
        if not isinstance(expression, (exp.Select, exp.Union, exp.Intersect, exp.Except)):
            _invalid_gateway_sql("AI gateway must return one read-only SELECT transform")
        _validate_transform_relations(expression)
        _validate_transform_columns(expression, _metadata_columns(request.metadata))
        return statement

    wrapped = f"SELECT {normalized_sql} FROM input"
    expression = _parse_generated_sql(wrapped, dialect)
    if not isinstance(expression, exp.Select) or len(expression.expressions) != 1:
        _invalid_gateway_sql("AI gateway must return one scalar SQL expression")
    _validate_transform_relations(expression)
    _validate_transform_columns(expression, _metadata_columns(request.metadata))
    return normalized_sql


def _parse_generated_sql(sql: str, dialect: str) -> exp.Expression:
    try:
        expression = parse_one(sql, read=dialect)
    except ParseError as exc:
        raise ApiError(
            ErrorCode.SQL_SYNTAX_ERROR,
            "AI gateway returned invalid transform SQL",
            status.HTTP_502_BAD_GATEWAY,
        ) from exc
    if expression is None:
        _invalid_gateway_sql("AI gateway returned invalid transform SQL")
    return expression


def _validate_transform_relations(expression: exp.Expression) -> None:
    cte_names = {str(cte.alias_or_name).casefold() for cte in expression.find_all(exp.CTE)}
    allowed_relations = {"input", *cte_names}
    for table in expression.find_all(exp.Table):
        if table.catalog or table.db or table.name.casefold() not in allowed_relations:
            _invalid_gateway_sql("AI gateway referenced a relation outside the ETL input")


def _validate_transform_columns(expression: exp.Expression, allowed_columns: set[str]) -> None:
    if not allowed_columns:
        return
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
        _invalid_gateway_sql(
            "AI gateway referenced columns outside the supplied ETL metadata",
            {"columns": unknown_columns[:20]},
        )


def _metadata_columns(metadata: dict[str, object]) -> set[str]:
    names: set[str] = set()
    for key in ("column", "column_name", "columnName", "field", "field_name", "fieldName"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            names.add(value.strip().casefold())
    for key in ("columns", "fields", "schema"):
        values = metadata.get(key)
        if not isinstance(values, list):
            continue
        for value in values:
            if isinstance(value, str) and value.strip():
                names.add(value.strip().casefold())
            elif isinstance(value, dict):
                name = value.get("name") or value.get("field") or value.get("column")
                if isinstance(name, str) and name.strip():
                    names.add(name.strip().casefold())
    return names


def _invalid_gateway_sql(message: str, details: dict[str, object] | None = None) -> None:
    raise ApiError(
        ErrorCode.SQL_SYNTAX_ERROR,
        message,
        status.HTTP_502_BAD_GATEWAY,
        details,
    )
