from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any, Iterable

from sqlglot import exp, parse
from sqlglot.errors import ParseError


PLAN_VERSION = "continuous-sql-v1"
RUNTIME_METADATA_COLUMNS = (
    "kafka_timestamp",
    "kafka_partition",
    "kafka_offset",
    "ingested_at",
)


class ContinuousSqlValidationError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class CatalogRelation:
    dataset_id: str
    dataset_name: str
    identifiers: tuple[str, ...]
    mode: str
    query_engine_table: dict[str, Any]
    schema: tuple[tuple[str, str], ...]
    schema_fingerprint: str
    snapshot_id: str | None
    streaming_source: dict[str, Any] | None
    unique_key_sets: tuple[tuple[str, ...], ...]
    estimated_row_count: int | None = None

    @property
    def schema_by_name(self) -> dict[str, tuple[str, str]]:
        return {
            normalize_identifier(name): (name, normalize_type(type_name))
            for name, type_name in self.schema
        }


@dataclass(frozen=True)
class CompiledContinuousSqlPlan:
    normalized_sql: str
    runtime_sql: str
    plan_hash: str
    plan: dict[str, Any]


@dataclass(frozen=True)
class _BoundRelation:
    alias: str
    relation: CatalogRelation
    runtime_view: str


DETERMINISTIC_FUNCTIONS = {
    "ABS",
    "CAST",
    "CASE",
    "CEIL",
    "CEILING",
    "COALESCE",
    "CONCAT",
    "DATE_ADD",
    "DATE_DIFF",
    "DATE_TRUNC",
    "FLOOR",
    "GREATEST",
    "IF",
    "LENGTH",
    "LEAST",
    "LOWER",
    "LTRIM",
    "NULLIF",
    "REGEXP_EXTRACT",
    "REGEXP_REPLACE",
    "REPLACE",
    "ROUND",
    "RTRIM",
    "SUBSTR",
    "SUBSTRING",
    "TRIM",
    "TRY_CAST",
    "UPPER",
}
NONDETERMINISTIC_FUNCTIONS = {
    "CURRENT_DATE",
    "CURRENT_TIME",
    "CURRENT_TIMESTAMP",
    "LOCALTIME",
    "LOCALTIMESTAMP",
    "NOW",
    "RAND",
    "RANDOM",
    "UUID",
}


class ContinuousSqlPlanner:
    def compile(
        self,
        query: str,
        relations: Iterable[CatalogRelation],
        *,
        static_binding_policy: str = "PINNED_AT_START",
        trigger_interval_seconds: int = 30,
        static_broadcast_max_rows: int = 100_000,
        max_output_rows_per_input: int = 10,
    ) -> CompiledContinuousSqlPlan:
        relation_list = list(relations)
        relation_index = build_relation_index(relation_list)
        expression = parse_single_select(query)
        self._validate_query_shape(expression)
        cte_relations = self._resolve_ctes(expression, relation_index)

        base_table = select_base_table(expression)
        base = bind_table(base_table, relation_index, cte_relations, relation_list)
        bound_relations = [base]
        alias_map = {normalize_identifier(base.alias): base}
        joins = list(expression.args.get("joins") or [])
        if not joins:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_STATIC_RELATION_REQUIRED",
                "Continuous SQL requires at least one static JOIN relation.",
            )

        for join in joins:
            if not isinstance(join, exp.Join) or join.parent is not expression:
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_NESTED_JOIN_UNSUPPORTED",
                    "Nested JOINs are not supported in Continuous SQL V1.",
                )
            if not isinstance(join.this, exp.Table):
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_RELATION_UNSUPPORTED",
                    "JOIN targets must be Catalog relations.",
                )
            bound = bind_table(join.this, relation_index, cte_relations, relation_list)
            alias_key = normalize_identifier(bound.alias)
            if alias_key in alias_map:
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_ALIAS_AMBIGUOUS",
                    "Every Continuous SQL relation must use a distinct alias.",
                    {"alias": bound.alias},
                )
            alias_map[alias_key] = bound
            bound_relations.append(bound)

        streaming = [item for item in bound_relations if item.relation.mode == "streaming"]
        static = [item for item in bound_relations if item.relation.mode == "static"]
        if len(streaming) != 1:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_STREAM_COUNT_INVALID",
                "Continuous SQL V1 requires exactly one streaming relation.",
                {"streamingRelationCount": len(streaming)},
            )
        if not static:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_STATIC_RELATION_REQUIRED",
                "Continuous SQL V1 requires at least one static relation.",
            )
        if base.relation.mode != "streaming":
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_STREAM_MUST_BE_LEFT",
                "The streaming relation must be the logical left input.",
                {"leftDatasetId": base.relation.dataset_id},
            )

        referenced_columns: dict[str, set[str]] = {
            normalize_identifier(item.alias): set() for item in bound_relations
        }
        compiled_joins: list[dict[str, Any]] = []
        left_aliases = {normalize_identifier(base.alias)}
        for join, right in zip(joins, bound_relations[1:], strict=True):
            if right.relation.mode != "static":
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_STREAM_STREAM_JOIN_UNSUPPORTED",
                    "Stream-stream JOIN is not supported in Continuous SQL V1.",
                    {"datasetId": right.relation.dataset_id},
                )
            join_type = normalize_join_type(join)
            right_alias = normalize_identifier(right.alias)
            predicates = equality_predicates(join)
            right_keys: list[str] = []
            compiled_keys: list[dict[str, str]] = []
            for predicate in predicates:
                left_column, right_column = orient_join_key(
                    predicate,
                    alias_map,
                    left_aliases,
                    right_alias,
                )
                left_owner, left_name, left_type = resolve_column(left_column, alias_map)
                right_owner, right_name, right_type = resolve_column(right_column, alias_map)
                if left_owner not in left_aliases or right_owner != right_alias:
                    raise ContinuousSqlValidationError(
                        "CONTINUOUS_SQL_JOIN_KEY_ORIENTATION_INVALID",
                        "JOIN equality keys must connect the left input to the current static relation.",
                    )
                if not compatible_join_types(left_type, right_type):
                    raise ContinuousSqlValidationError(
                        "CONTINUOUS_SQL_JOIN_KEY_TYPE_MISMATCH",
                        "JOIN equality key types are incompatible.",
                        {
                            "leftColumn": left_name,
                            "leftType": left_type,
                            "rightColumn": right_name,
                            "rightType": right_type,
                        },
                    )
                referenced_columns[left_owner].add(left_name)
                referenced_columns[right_owner].add(right_name)
                right_keys.append(normalize_identifier(right_name))
                compiled_keys.append({
                    "leftAlias": alias_map[left_owner].alias,
                    "leftColumn": left_name,
                    "rightAlias": right.alias,
                    "rightColumn": right_name,
                })
            require_unique_static_key(right, right_keys)
            compiled_joins.append({
                "type": join_type,
                "rightAlias": right.alias,
                "rightDatasetId": right.relation.dataset_id,
                "keys": compiled_keys,
            })
            left_aliases.add(right_alias)

        self._validate_all_columns(expression, alias_map, referenced_columns)
        output_schema = compile_output_schema(expression, alias_map, referenced_columns)
        runtime_sql = runtime_sql_for(expression, relation_index, cte_relations, relation_list)
        normalized_sql = expression.sql(dialect="trino", normalize=True, pretty=False)
        bindings = [
            relation_binding_payload(
                item,
                referenced_columns[normalize_identifier(item.alias)],
                static_broadcast_max_rows=max(0, int(static_broadcast_max_rows)),
            )
            for item in bound_relations
        ]
        plan_without_hash = {
            "planVersion": PLAN_VERSION,
            "normalizedSql": normalized_sql,
            "runtimeSql": runtime_sql,
            "staticBindingPolicy": static_binding_policy,
            "triggerIntervalSeconds": int(trigger_interval_seconds),
            "maxOutputRowsPerInput": max(1, int(max_output_rows_per_input)),
            "staticBroadcastMaxRows": max(0, int(static_broadcast_max_rows)),
            "relations": bindings,
            "joins": compiled_joins,
            "outputSchema": output_schema,
            "streamingSource": streaming[0].relation.streaming_source,
            "outputMode": "append",
            "capabilities": {
                "streamRelationCount": 1,
                "staticRelationCount": len(static),
                "stateful": False,
                "watermarkRequired": False,
            },
        }
        plan_hash = canonical_hash(plan_without_hash)
        plan = {**plan_without_hash, "planHash": plan_hash}
        return CompiledContinuousSqlPlan(
            normalized_sql=normalized_sql,
            runtime_sql=runtime_sql,
            plan_hash=plan_hash,
            plan=plan,
        )

    def _validate_query_shape(self, expression: exp.Select) -> None:
        forbidden_args = {
            "distinct": "CONTINUOUS_SQL_DISTINCT_UNSUPPORTED",
            "group": "CONTINUOUS_SQL_AGGREGATION_UNSUPPORTED",
            "having": "CONTINUOUS_SQL_AGGREGATION_UNSUPPORTED",
            "order": "CONTINUOUS_SQL_ORDER_BY_UNSUPPORTED",
            "limit": "CONTINUOUS_SQL_LIMIT_UNSUPPORTED",
            "offset": "CONTINUOUS_SQL_LIMIT_UNSUPPORTED",
            "qualify": "CONTINUOUS_SQL_WINDOW_UNSUPPORTED",
        }
        for argument, code in forbidden_args.items():
            if expression.args.get(argument) is not None:
                raise ContinuousSqlValidationError(
                    code,
                    f"{argument.upper()} is not supported in Continuous SQL V1.",
                )
        if next(expression.find_all(exp.Subquery), None) is not None:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_SUBQUERY_UNSUPPORTED",
                "Subqueries are not supported in Continuous SQL V1.",
            )
        if next(expression.find_all(exp.Window), None) is not None:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_WINDOW_UNSUPPORTED",
                "Window expressions require a separate stateful capability.",
            )
        if next(expression.find_all(exp.AggFunc), None) is not None:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_AGGREGATION_UNSUPPORTED",
                "Aggregations require a separate stateful capability.",
            )
        for function in expression.find_all(exp.Func):
            if isinstance(function, exp.Connector):
                continue
            name = function_name(function)
            if name in NONDETERMINISTIC_FUNCTIONS:
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_NONDETERMINISTIC_FUNCTION",
                    "Nondeterministic functions are not supported in Continuous SQL V1.",
                    {"function": name},
                )
            if name and name not in DETERMINISTIC_FUNCTIONS:
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_FUNCTION_UNSUPPORTED",
                    "SQL function is outside the Continuous SQL V1 allowlist.",
                    {"function": name},
                )

    def _resolve_ctes(
        self,
        expression: exp.Select,
        relation_index: dict[str, list[CatalogRelation]],
    ) -> dict[str, CatalogRelation]:
        resolved: dict[str, CatalogRelation] = {}
        with_expression = expression.args.get("with_")
        if with_expression is None:
            return resolved
        if bool(with_expression.args.get("recursive")):
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_RECURSIVE_CTE_UNSUPPORTED",
                "Recursive CTEs are not supported in Continuous SQL V1.",
            )
        for cte in with_expression.expressions:
            if not isinstance(cte, exp.CTE) or not isinstance(cte.this, exp.Select):
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_CTE_UNSUPPORTED",
                    "Continuous SQL CTEs must be simple relation pass-through SELECTs.",
                )
            select = cte.this
            if any(select.args.get(key) is not None for key in (
                "joins", "where", "group", "having", "order", "limit", "distinct", "with_",
            )):
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_CTE_UNSUPPORTED",
                    "Continuous SQL CTEs may only alias a single Catalog relation.",
                    {"cte": cte.alias_or_name},
                )
            if not select.expressions or any(not is_star_projection(item) for item in select.expressions):
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_CTE_UNSUPPORTED",
                    "Continuous SQL CTEs must use SELECT * from one Catalog relation.",
                    {"cte": cte.alias_or_name},
                )
            table = select_base_table(select)
            relation = resolve_catalog_table(table, relation_index)
            resolved[normalize_identifier(cte.alias_or_name)] = relation
        return resolved

    def _validate_all_columns(
        self,
        expression: exp.Select,
        alias_map: dict[str, _BoundRelation],
        referenced_columns: dict[str, set[str]],
    ) -> None:
        for column in expression.find_all(exp.Column):
            if isinstance(column.this, exp.Star):
                continue
            owner, name, _type_name = resolve_column(column, alias_map)
            referenced_columns[owner].add(name)


def parse_single_select(query: str) -> exp.Select:
    if not str(query or "").strip():
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_EMPTY",
            "Continuous SQL query cannot be empty.",
        )
    try:
        statements = parse(query, read="trino")
    except ParseError as exc:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_PARSE_ERROR",
            "Continuous SQL could not be parsed.",
        ) from exc
    if len(statements) != 1 or not isinstance(statements[0], exp.Select):
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_STATEMENT_UNSUPPORTED",
            "Continuous SQL accepts one read-only SELECT statement.",
        )
    return statements[0]


def build_relation_index(relations: list[CatalogRelation]) -> dict[str, list[CatalogRelation]]:
    index: dict[str, list[CatalogRelation]] = {}
    for relation in relations:
        for identifier in relation.identifiers:
            normalized = normalize_identifier(identifier)
            if normalized:
                index.setdefault(normalized, []).append(relation)
    return index


def resolve_catalog_table(
    table: exp.Table,
    relation_index: dict[str, list[CatalogRelation]],
) -> CatalogRelation:
    if not isinstance(table.this, exp.Identifier):
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_TABLE_FUNCTION_UNSUPPORTED",
            "Table functions are not supported in Continuous SQL V1.",
        )
    parts = [part for part in (table.catalog, table.db, table.name) if part]
    identifier = normalize_identifier(".".join(parts))
    candidates = relation_index.get(identifier, [])
    if not candidates and len(parts) > 1:
        candidates = relation_index.get(normalize_identifier(table.name), [])
    unique = {candidate.dataset_id: candidate for candidate in candidates}
    if not unique:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_RELATION_UNKNOWN",
            "SQL relation is not present in the authorized Catalog context.",
            {"relation": ".".join(parts) or table.sql()},
        )
    if len(unique) > 1:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_RELATION_AMBIGUOUS",
            "SQL relation resolves to more than one Catalog Dataset.",
            {"relation": ".".join(parts), "datasetIds": sorted(unique)},
        )
    return next(iter(unique.values()))


def select_base_table(expression: exp.Select) -> exp.Table:
    from_expression = expression.args.get("from_")
    source = from_expression.this if isinstance(from_expression, exp.From) else None
    if not isinstance(source, exp.Table):
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_RELATION_UNSUPPORTED",
            "Continuous SQL FROM must reference a Catalog relation.",
        )
    return source


def bind_table(
    table: exp.Table,
    relation_index: dict[str, list[CatalogRelation]],
    cte_relations: dict[str, CatalogRelation],
    relation_order: list[CatalogRelation],
) -> _BoundRelation:
    cte_relation = None
    if not table.catalog and not table.db:
        cte_relation = cte_relations.get(normalize_identifier(table.name))
    relation = cte_relation or resolve_catalog_table(table, relation_index)
    alias = str(table.alias_or_name or relation.dataset_name).strip()
    runtime_view = f"__asklake_relation_{relation_order.index(relation)}"
    return _BoundRelation(alias=alias, relation=relation, runtime_view=runtime_view)


def normalize_join_type(join: exp.Join) -> str:
    side = str(join.args.get("side") or "").strip().upper()
    kind = str(join.args.get("kind") or "").strip().upper()
    method = str(join.args.get("method") or "").strip().upper()
    if method or kind == "CROSS" or side in {"RIGHT", "FULL"}:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_JOIN_TYPE_UNSUPPORTED",
            "Continuous SQL V1 supports only INNER and LEFT equality JOINs.",
            {"side": side or None, "kind": kind or None, "method": method or None},
        )
    if side == "LEFT" and kind in {"", "OUTER"}:
        return "LEFT"
    if not side and kind in {"", "INNER"}:
        return "INNER"
    raise ContinuousSqlValidationError(
        "CONTINUOUS_SQL_JOIN_TYPE_UNSUPPORTED",
        "Continuous SQL V1 supports only INNER and LEFT equality JOINs.",
        {"side": side or None, "kind": kind or None},
    )


def equality_predicates(join: exp.Join) -> list[exp.EQ]:
    if join.args.get("using") is not None:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_JOIN_USING_UNSUPPORTED",
            "Continuous SQL JOIN keys must use explicit equality predicates.",
        )
    on = join.args.get("on")
    if on is None:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_JOIN_KEY_REQUIRED",
            "Continuous SQL JOIN requires an ON equality key.",
        )
    predicates: list[exp.Expression] = []

    def flatten(node: exp.Expression) -> None:
        if isinstance(node, exp.And):
            flatten(node.this)
            flatten(node.expression)
        else:
            predicates.append(node)

    flatten(on)
    if not predicates or any(
        not isinstance(predicate, exp.EQ)
        or not isinstance(predicate.this, exp.Column)
        or not isinstance(predicate.expression, exp.Column)
        for predicate in predicates
    ):
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_JOIN_PREDICATE_UNSUPPORTED",
            "Continuous SQL JOIN predicates must be column equality keys combined with AND.",
        )
    return [predicate for predicate in predicates if isinstance(predicate, exp.EQ)]


def orient_join_key(
    predicate: exp.EQ,
    alias_map: dict[str, _BoundRelation],
    left_aliases: set[str],
    right_alias: str,
) -> tuple[exp.Column, exp.Column]:
    first = predicate.this
    second = predicate.expression
    assert isinstance(first, exp.Column) and isinstance(second, exp.Column)
    first_owner, _first_name, _first_type = resolve_column(first, alias_map)
    second_owner, _second_name, _second_type = resolve_column(second, alias_map)
    if first_owner in left_aliases and second_owner == right_alias:
        return first, second
    if second_owner in left_aliases and first_owner == right_alias:
        return second, first
    raise ContinuousSqlValidationError(
        "CONTINUOUS_SQL_JOIN_KEY_ORIENTATION_INVALID",
        "JOIN keys must connect the accumulated left input to the current static relation.",
    )


def resolve_column(
    column: exp.Column,
    alias_map: dict[str, _BoundRelation],
) -> tuple[str, str, str]:
    column_name = str(column.name or "").strip()
    if not column_name:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_COLUMN_UNKNOWN",
            "SQL column could not be resolved.",
        )
    normalized_name = normalize_identifier(column_name)
    if column.table:
        owner = normalize_identifier(column.table)
        bound = alias_map.get(owner)
        if bound is None:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_ALIAS_UNKNOWN",
                "SQL column references an unknown relation alias.",
                {"alias": column.table, "column": column_name},
            )
        schema_item = bound.relation.schema_by_name.get(normalized_name)
        if schema_item is None:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_COLUMN_UNKNOWN",
                "SQL column is not present in the Catalog schema.",
                {"alias": bound.alias, "column": column_name},
            )
        return owner, schema_item[0], schema_item[1]

    candidates: list[tuple[str, str, str]] = []
    for owner, bound in alias_map.items():
        schema_item = bound.relation.schema_by_name.get(normalized_name)
        if schema_item is not None:
            candidates.append((owner, schema_item[0], schema_item[1]))
    if len(candidates) != 1:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_COLUMN_AMBIGUOUS" if candidates else "CONTINUOUS_SQL_COLUMN_UNKNOWN",
            "Unqualified SQL column must resolve to exactly one relation.",
            {"column": column_name, "candidateAliases": [alias_map[item[0]].alias for item in candidates]},
        )
    return candidates[0]


def require_unique_static_key(bound: _BoundRelation, right_keys: list[str]) -> None:
    key_set = set(right_keys)
    if any(set(unique_set).issubset(key_set) for unique_set in bound.relation.unique_key_sets):
        return
    raise ContinuousSqlValidationError(
        "CONTINUOUS_SQL_STATIC_KEY_NOT_UNIQUE",
        "Static JOIN keys must have Catalog uniqueness evidence.",
        {
            "datasetId": bound.relation.dataset_id,
            "joinColumns": sorted(key_set),
            "uniqueKeySets": [list(item) for item in bound.relation.unique_key_sets],
        },
    )


def compile_output_schema(
    expression: exp.Select,
    alias_map: dict[str, _BoundRelation],
    referenced_columns: dict[str, set[str]],
) -> list[list[str]]:
    output: list[list[str]] = []
    for projection in expression.expressions:
        if is_star_projection(projection):
            star_owner = normalize_identifier(projection.table) if isinstance(projection, exp.Column) else ""
            sources = [alias_map[star_owner]] if star_owner else list(alias_map.values())
            for bound in sources:
                for name, type_name in bound.relation.schema:
                    referenced_columns[normalize_identifier(bound.alias)].add(name)
                    output.append([name, runtime_type(type_name)])
            continue
        output_name = str(projection.alias_or_name or "").strip()
        base_expression = projection.this if isinstance(projection, exp.Alias) else projection
        if not output_name or (
            not isinstance(projection, (exp.Alias, exp.Column))
            and normalize_identifier(output_name) == normalize_identifier(projection.sql())
        ):
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_PROJECTION_ALIAS_REQUIRED",
                "Computed Continuous SQL projections require an explicit alias.",
                {"expression": projection.sql(dialect="trino")},
            )
        output.append([output_name, infer_expression_type(base_expression, alias_map)])
    normalized_names = [normalize_identifier(item[0]) for item in output]
    duplicates = sorted({name for name in normalized_names if normalized_names.count(name) > 1})
    if duplicates:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_OUTPUT_COLUMN_DUPLICATE",
            "Continuous SQL output columns must be unique.",
            {"columns": duplicates},
        )
    reserved = sorted(
        name for name in normalized_names
        if name in {normalize_identifier(item) for item in RUNTIME_METADATA_COLUMNS}
    )
    if reserved:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_OUTPUT_COLUMN_RESERVED",
            "Continuous SQL output aliases cannot use worker lineage column names.",
            {"columns": reserved},
        )
    if not output:
        raise ContinuousSqlValidationError(
            "CONTINUOUS_SQL_OUTPUT_EMPTY",
            "Continuous SQL must project at least one output column.",
        )
    return output


def infer_expression_type(
    expression: exp.Expression,
    alias_map: dict[str, _BoundRelation],
) -> str:
    if isinstance(expression, exp.Column):
        return runtime_type(resolve_column(expression, alias_map)[2])
    if isinstance(expression, exp.Cast):
        target = expression.args.get("to")
        return runtime_type(target.sql() if target is not None else "string")
    if isinstance(expression, exp.Boolean):
        return "boolean"
    if isinstance(expression, exp.Literal):
        if expression.is_int:
            return "long"
        if expression.is_number:
            return "double"
        return "string"
    if isinstance(expression, (exp.Add, exp.Sub, exp.Mul, exp.Div, exp.Mod)):
        child_types = [
            infer_expression_type(child, alias_map)
            for child in (expression.this, expression.expression)
            if isinstance(child, exp.Expression)
        ]
        return "double" if "double" in child_types else "long"
    if isinstance(expression, (exp.EQ, exp.NEQ, exp.GT, exp.GTE, exp.LT, exp.LTE, exp.And, exp.Or, exp.Not, exp.Is)):
        return "boolean"
    if isinstance(expression, exp.Case):
        values = [item.args.get("true") for item in expression.args.get("ifs") or []]
        values.append(expression.args.get("default"))
        inferred = [
            infer_expression_type(item, alias_map)
            for item in values
            if isinstance(item, exp.Expression)
        ]
        return inferred[0] if inferred and len(set(inferred)) == 1 else "string"
    if isinstance(expression, exp.Func):
        name = function_name(expression)
        if name in {"ABS", "CEIL", "CEILING", "FLOOR", "ROUND"}:
            return "double"
        if name == "LENGTH":
            return "long"
        return "string"
    return "string"


def runtime_sql_for(
    expression: exp.Select,
    relation_index: dict[str, list[CatalogRelation]],
    cte_relations: dict[str, CatalogRelation],
    relation_order: list[CatalogRelation],
) -> str:
    runtime = expression.copy()
    cte_names = set(cte_relations)
    for table in runtime.find_all(exp.Table):
        if not table.catalog and not table.db and normalize_identifier(table.name) in cte_names:
            continue
        relation = resolve_catalog_table(table, relation_index)
        table.set("this", exp.to_identifier(
            f"__asklake_relation_{relation_order.index(relation)}",
            quoted=True,
        ))
        table.set("db", None)
        table.set("catalog", None)
    stream_alias = str(select_base_table(runtime).alias_or_name or "").strip()
    for column_name in RUNTIME_METADATA_COLUMNS:
        runtime.select(
            exp.column(column_name, table=stream_alias or None).as_(column_name),
            append=True,
            copy=False,
        )
    return runtime.sql(dialect="spark", normalize=True, pretty=False)


def relation_binding_payload(
    bound: _BoundRelation,
    referenced: set[str],
    *,
    static_broadcast_max_rows: int,
) -> dict[str, Any]:
    relation = bound.relation
    broadcast_hint = bool(
        relation.mode == "static"
        and relation.estimated_row_count is not None
        and relation.estimated_row_count <= static_broadcast_max_rows
    )
    return {
        "alias": bound.alias,
        "runtimeView": bound.runtime_view,
        "datasetId": relation.dataset_id,
        "datasetName": relation.dataset_name,
        "mode": relation.mode,
        "queryEngineTable": relation.query_engine_table,
        "schema": [list(item) for item in relation.schema],
        "schemaFingerprint": relation.schema_fingerprint,
        "snapshotId": relation.snapshot_id,
        "streamingSource": relation.streaming_source,
        "uniqueKeySets": [list(item) for item in relation.unique_key_sets],
        "estimatedRowCount": relation.estimated_row_count,
        "broadcastHint": broadcast_hint,
        "referencedColumns": sorted(referenced, key=normalize_identifier),
    }


def normalize_identifier(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().strip('"`')).casefold()


def normalize_type(value: str) -> str:
    normalized = re.sub(r"\s+", "", str(value or "string").strip().casefold())
    aliases = {
        "int": "integer",
        "int32": "integer",
        "int64": "bigint",
        "long": "bigint",
        "float": "double",
        "float32": "double",
        "float64": "double",
        "bool": "boolean",
        "varchar": "string",
        "text": "string",
        "datetime": "timestamp",
    }
    if normalized.startswith("varchar(") or normalized.startswith("char("):
        return "string"
    if normalized.startswith("decimal("):
        return "decimal"
    return aliases.get(normalized, normalized)


def runtime_type(value: str) -> str:
    normalized = normalize_type(value)
    if normalized in {"tinyint", "smallint", "integer", "bigint"}:
        return "long"
    if normalized in {"real", "double", "decimal", "numeric"}:
        return "double"
    if normalized in {"boolean"}:
        return "boolean"
    if normalized in {"timestamp", "timestampwithtimezone", "date"}:
        return "timestamp"
    return "string"


def compatible_join_types(left: str, right: str) -> bool:
    left_normalized = normalize_type(left)
    right_normalized = normalize_type(right)
    if left_normalized == right_normalized:
        return True
    integral = {"tinyint", "smallint", "integer", "bigint"}
    numeric = integral | {"real", "double", "decimal", "numeric"}
    return left_normalized in numeric and right_normalized in numeric


def function_name(function: exp.Func) -> str:
    try:
        return str(function.sql_name() or "").strip().upper()
    except (AttributeError, TypeError):
        return str(function.key or "").strip().upper()


def is_star_projection(expression: exp.Expression) -> bool:
    return isinstance(expression, exp.Star) or (
        isinstance(expression, exp.Column) and isinstance(expression.this, exp.Star)
    )


def canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def schema_fingerprint(schema: Iterable[tuple[str, str]]) -> str:
    return canonical_hash([
        [str(name), normalize_type(type_name)]
        for name, type_name in schema
    ])
