from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re

from sqlglot import exp, parse_one

from app.realtime.domain.source_boundary import SourceBoundary, serving_row_version
from app.realtime.sql.validator import RealtimeRelation, RealtimeSqlPlan
from app.services.clickhouse_client import (
    qualified_clickhouse_table,
    quote_clickhouse_identifier,
    quote_clickhouse_string,
    validate_clickhouse_identifier,
)


_PLACEHOLDER = re.compile(r"^__asklake_relation_(\d+)$")
_FACT_METADATA = {
    "kafka_topic",
    "kafka_partition",
    "kafka_offset",
    "kafka_timestamp",
    "event_key",
    "payload_hash",
    "ingested_at",
}


@dataclass(frozen=True)
class ClickHouseMaterialization:
    materialization_id: str
    source_fingerprint: str
    clickhouse_query_id: str
    insert_deduplication_token: str
    select_sql: str
    insert_sql: str
    row_version: int


class ClickHouseRealtimeCompiler:
    def compile(
        self,
        plan: RealtimeSqlPlan,
        *,
        boundary: SourceBoundary,
        serving_database: str,
        serving_table: str,
        serving_dataset_id: str,
        pipeline_version_id: str,
        pipeline_generation: int,
        correction_generation: int = 0,
        scope_id: str = "deployment",
    ) -> ClickHouseMaterialization:
        if plan.execution_mode != "realtime_incremental":
            raise ValueError("only realtime_incremental plans can be compiled")
        if scope_id != "deployment":
            raise ValueError("realtime materialization scope must be deployment")
        fact = next(item for item in plan.relations if item.role == "fact")
        if any(item.topic != fact.kafka_topic for item in boundary.partitions):
            raise ValueError("source boundary contains a topic outside the fact relation")

        source_fingerprint = boundary.fingerprint(pipeline_version_id)
        materialization_id = boundary.materialization_id(pipeline_version_id)
        query_id = "rtq_" + hashlib.sha256(
            f"{pipeline_version_id}|{source_fingerprint}".encode("utf-8")
        ).hexdigest()
        row_version = serving_row_version(
            pipeline_generation=pipeline_generation,
            correction_generation=correction_generation,
        )

        runtime = parse_one(plan.runtime_plan.runtime_sql, read="spark")
        if not isinstance(runtime, exp.Select):
            raise ValueError("validated realtime runtime SQL is not a SELECT")
        fact_alias = self._fact_alias(runtime)
        output_names = {name.casefold() for name, _type in plan.output_schema}
        for metadata in (
            "kafka_topic",
            "kafka_partition",
            "kafka_offset",
            "kafka_timestamp",
            "event_key",
            "payload_hash",
        ):
            if metadata not in output_names:
                runtime.select(exp.column(metadata, table=fact_alias).as_(metadata), append=True, copy=False)
        self._inject_temporal_predicates(runtime, plan, fact_alias)
        runtime_sql = runtime.sql(dialect="clickhouse", pretty=False)

        for index, relation in enumerate(plan.relations):
            if relation.role == "fact":
                replacement = self._fact_subquery(relation, boundary, scope_id)
            else:
                replacement = self._dimension_subquery(relation, scope_id)
            runtime_sql = self._replace_placeholder(runtime_sql, index, replacement)

        select_sql = self._serving_select(
            runtime_sql,
            plan=plan,
            scope_id=scope_id,
            serving_dataset_id=serving_dataset_id,
            pipeline_version_id=pipeline_version_id,
            materialization_id=materialization_id,
            source_fingerprint=source_fingerprint,
            correction_generation=correction_generation,
            row_version=row_version,
        )
        target = qualified_clickhouse_table(serving_database, serving_table)
        columns = (
            "scope_id", "serving_dataset_id", "pipeline_version_id", "serving_key",
            "event_time", "payload", "kafka_topic", "kafka_partition", "kafka_offset",
            "materialization_id", "source_fingerprint", "dimension_version_ids",
            "correction_generation", "is_deleted", "materialized_at", "row_version",
        )
        projection = ", ".join(quote_clickhouse_identifier(item) for item in columns)
        token = materialization_id
        insert_sql = (
            f"INSERT INTO {target} ({projection}) "
            f"SETTINGS insert_deduplication_token = {quote_clickhouse_string(token)} "
            f"{select_sql}"
        )
        return ClickHouseMaterialization(
            materialization_id=materialization_id,
            source_fingerprint=source_fingerprint,
            clickhouse_query_id=query_id,
            insert_deduplication_token=token,
            select_sql=select_sql,
            insert_sql=insert_sql,
            row_version=row_version,
        )

    @staticmethod
    def _fact_alias(runtime: exp.Select) -> str:
        from_expression = runtime.args.get("from_")
        table = from_expression.this if isinstance(from_expression, exp.From) else None
        if not isinstance(table, exp.Table):
            raise ValueError("realtime SQL fact relation is missing")
        return validate_clickhouse_identifier(str(table.alias_or_name))

    @staticmethod
    def _inject_temporal_predicates(runtime: exp.Select, plan: RealtimeSqlPlan, fact_alias: str) -> None:
        relations_by_placeholder = {
            f"__asklake_relation_{index}": relation
            for index, relation in enumerate(plan.relations)
        }
        for join in runtime.args.get("joins") or []:
            if not isinstance(join, exp.Join) or not isinstance(join.this, exp.Table):
                continue
            relation = relations_by_placeholder.get(str(join.this.name))
            if relation is None or relation.dimension_semantics != "temporal":
                continue
            alias = validate_clickhouse_identifier(str(join.this.alias_or_name))
            event_time = validate_clickhouse_identifier(plan.event_time_column)
            temporal = parse_one(
                f"{fact_alias}.{event_time} >= {alias}.__valid_from AND "
                f"({alias}.__valid_to IS NULL OR {fact_alias}.{event_time} < {alias}.__valid_to)",
                read="clickhouse",
            )
            current = join.args.get("on")
            if not isinstance(current, exp.Expression):
                raise ValueError("validated dimension JOIN has no predicate")
            join.set("on", exp.and_(current, temporal))

    @staticmethod
    def _replace_placeholder(sql: str, index: int, replacement: str) -> str:
        name = f"__asklake_relation_{index}"
        pattern = re.compile(rf"(?<![A-Za-z0-9_])[`\"]?{re.escape(name)}[`\"]?(?![A-Za-z0-9_])")
        updated, count = pattern.subn(f"({replacement})", sql)
        if count != 1:
            raise ValueError(f"runtime relation placeholder {name} was not resolved exactly once")
        return updated

    @staticmethod
    def _fact_subquery(relation: RealtimeRelation, boundary: SourceBoundary, scope_id: str) -> str:
        projections = [
            f"{quote_clickhouse_identifier(name)} AS {quote_clickhouse_identifier(name)}"
            if name in _FACT_METADATA
            else f"{_fact_value(relation, name, type_name)} AS {quote_clickhouse_identifier(name)}"
            for name, type_name in relation.schema
        ]
        for metadata in sorted(_FACT_METADATA):
            if metadata not in {name for name, _type in relation.schema}:
                projections.append(quote_clickhouse_identifier(metadata))
        ranges = [
            "(" + " AND ".join((
                f"kafka_topic = {quote_clickhouse_string(item.topic)}",
                f"kafka_partition = {item.partition}",
                f"kafka_offset > {item.from_offset_exclusive}",
                f"kafka_offset <= {item.to_offset_inclusive}",
            )) + ")"
            for item in boundary.partitions
        ]
        return (
            f"SELECT {', '.join(projections)} "
            f"FROM {qualified_clickhouse_table(relation.physical_database, relation.physical_table)} "
            f"WHERE scope_id = {quote_clickhouse_string(scope_id)} AND ({' OR '.join(ranges)})"
        )

    @staticmethod
    def _dimension_subquery(relation: RealtimeRelation, scope_id: str) -> str:
        projections = [
            f"{_json_value(name, type_name)} AS {quote_clickhouse_identifier(name)}"
            for name, type_name in relation.schema
        ]
        if relation.dimension_semantics == "temporal":
            projections.extend(("valid_from AS __valid_from", "valid_to AS __valid_to"))
        return (
            f"SELECT {', '.join(projections)} "
            f"FROM {qualified_clickhouse_table(relation.physical_database, relation.physical_table)} "
            f"WHERE scope_id = {quote_clickhouse_string(scope_id)} "
            f"AND dimension_dataset_id = {quote_clickhouse_string(relation.dataset_id)} "
            f"AND dimension_version_id = {quote_clickhouse_string(relation.dimension_version_id)}"
        )

    @staticmethod
    def _serving_select(
        runtime_sql: str,
        *,
        plan: RealtimeSqlPlan,
        scope_id: str,
        serving_dataset_id: str,
        pipeline_version_id: str,
        materialization_id: str,
        source_fingerprint: str,
        correction_generation: int,
        row_version: int,
    ) -> str:
        output_names = [validate_clickhouse_identifier(item[0]) for item in plan.output_schema]
        key_names = list(plan.business_key_columns) or ["event_key"]
        key_parts = [
            "if(isNull(q.{column}), '-1:', concat(toString(lengthUTF8(toString(q.{column}))), ':', toString(q.{column})))".format(
                column=quote_clickhouse_identifier(validate_clickhouse_identifier(name))
            )
            for name in key_names
        ]
        key_material = ", '|', ".join(key_parts)
        serving_prefix = quote_clickhouse_string(
            f"{scope_id}|{serving_dataset_id}|{pipeline_version_id}|"
        )
        tuple_values = ", ".join(
            f"q.{quote_clickhouse_identifier(name)}" for name in output_names
        )
        tuple_type = ", ".join(
            f"{quote_clickhouse_identifier(validate_clickhouse_identifier(name))} "
            f"{_nullable_clickhouse_type(type_name)}"
            for name, type_name in plan.output_schema
        )
        dimensions = [item for item in plan.relations if item.role == "dimension"]
        map_values = ", ".join(
            f"{quote_clickhouse_string(item.dataset_id)}, {quote_clickhouse_string(item.dimension_version_id)}"
            for item in dimensions
        )
        event_time = (
            f"q.{quote_clickhouse_identifier(validate_clickhouse_identifier(plan.event_time_column))}"
            if plan.event_time_column
            else "q.kafka_timestamp"
        )
        return (
            "SELECT "
            f"{quote_clickhouse_string(scope_id)} AS scope_id, "
            f"{quote_clickhouse_string(serving_dataset_id)} AS serving_dataset_id, "
            f"{quote_clickhouse_string(pipeline_version_id)} AS pipeline_version_id, "
            f"lower(hex(SHA256(concat({serving_prefix}, {key_material})))) AS serving_key, "
            f"{event_time} AS event_time, "
            f"toJSONString(CAST(tuple({tuple_values}) AS Tuple({tuple_type}))) AS payload, "
            "q.kafka_topic, q.kafka_partition, q.kafka_offset, "
            f"{quote_clickhouse_string(materialization_id)} AS materialization_id, "
            f"{quote_clickhouse_string(source_fingerprint)} AS source_fingerprint, "
            f"map({map_values}) AS dimension_version_ids, "
            f"toUInt32({correction_generation}) AS correction_generation, toUInt8(0) AS is_deleted, "
            f"now64(6) AS materialized_at, toUInt64({row_version}) AS row_version "
            f"FROM ({runtime_sql}) AS q"
        )


def _json_value(column: str, type_name: str) -> str:
    identifier = validate_clickhouse_identifier(column)
    path = quote_clickhouse_string(identifier)
    raw = f"JSONExtractString(payload, {path})"
    normalized = str(type_name).strip().casefold()
    if normalized in {"byte", "short", "int", "integer", "long", "bigint"}:
        return f"toInt64OrNull({raw})"
    if normalized in {"float", "double", "decimal", "number"}:
        return f"toFloat64OrNull({raw})"
    if normalized in {"boolean", "bool"}:
        return f"toUInt8OrNull({raw})"
    if normalized in {"timestamp", "datetime", "date"}:
        return f"parseDateTime64BestEffortOrNull({raw}, 3)"
    return raw


def _fact_value(relation: RealtimeRelation, column: str, type_name: str) -> str:
    parsing = relation.record_parsing or {}
    if parsing.get("enabled") is not True:
        return _json_value(column, type_name)
    if parsing.get("delimiterKind", "whitespace") != "whitespace":
        raise ValueError("realtime fact parsing supports only whitespace records")
    delimiter = str(parsing.get("delimiterPattern") or r"\s+")
    if delimiter != r"\s+":
        raise ValueError("realtime fact parsing requires the \\s+ delimiter")
    columns = [item for item in parsing.get("columns", []) if isinstance(item, dict)]
    positions = {
        str(item.get("name") or "").casefold(): int(item.get("position", -1)) + 1
        for item in columns
    }
    position = positions.get(column.casefold())
    if position is None or position <= 0:
        raise ValueError(f"realtime fact parsing column is missing: {column}")
    expected = int(parsing.get("expectedFieldCount") or 0)
    if expected <= 0 or len(columns) != expected:
        raise ValueError("realtime fact parsing contract is invalid")
    fields = f"splitByRegexp({quote_clickhouse_string(delimiter)}, trimBoth(payload))"
    raw = f"if(length({fields}) = {expected}, {fields}[{position}], NULL)"
    return _cast_raw_value(raw, type_name)


def _cast_raw_value(raw: str, type_name: str) -> str:
    normalized = str(type_name).strip().casefold()
    if normalized in {"byte", "short", "int", "integer", "long", "bigint"}:
        return f"toInt64OrNull({raw})"
    if normalized in {"float", "double", "decimal", "number"}:
        return f"toFloat64OrNull({raw})"
    if normalized in {"boolean", "bool"}:
        return f"toUInt8OrNull({raw})"
    if normalized in {"timestamp", "datetime", "date"}:
        return f"parseDateTime64BestEffortOrNull({raw}, 3)"
    return raw


def _nullable_clickhouse_type(type_name: str) -> str:
    normalized = str(type_name).strip().casefold()
    if normalized in {"byte", "short", "int", "integer", "long", "bigint"}:
        return "Nullable(Int64)"
    if normalized in {"float", "double", "decimal", "number"}:
        return "Nullable(Float64)"
    if normalized in {"boolean", "bool"}:
        return "Nullable(UInt8)"
    if normalized in {"timestamp", "datetime", "date"}:
        return "Nullable(DateTime64(3, 'UTC'))"
    return "Nullable(String)"
