from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Iterable, Literal

from sqlglot import exp

from app.realtime.domain.dimension import default_missing_policy
from app.realtime.sql.classifier import ExecutionMode, ExecutionSignals, classify_execution_mode
from app.services.continuous_sql_planner import (
    CatalogRelation,
    CompiledContinuousSqlPlan,
    ContinuousSqlPlanner,
    ContinuousSqlValidationError,
    parse_single_select,
)


RelationRole = Literal["fact", "dimension"]
DimensionSemantics = Literal["current", "temporal"]


@dataclass(frozen=True)
class RealtimeRelation:
    dataset_id: str
    logical_name: str
    role: RelationRole
    physical_database: str
    physical_table: str
    schema: tuple[tuple[str, str], ...]
    approved: bool = True
    unique_key_sets: tuple[tuple[str, ...], ...] = ()
    estimated_row_count: int | None = None
    kafka_topic: str | None = None
    dimension_version_id: str | None = None
    dimension_semantics: DimensionSemantics | None = None

    def __post_init__(self) -> None:
        if not self.dataset_id.strip() or not self.logical_name.strip() or not self.schema:
            raise ValueError("realtime relation identity and schema are required")
        if self.role == "fact" and not self.kafka_topic:
            raise ValueError("fact relation requires a Kafka topic")
        if self.role == "dimension" and (
            not self.dimension_version_id or self.dimension_semantics not in {"current", "temporal"}
        ):
            raise ValueError("dimension relation requires version and semantics")

    def planner_relation(self) -> CatalogRelation:
        schema_fingerprint = hashlib.sha256(repr(self.schema).encode("utf-8")).hexdigest()
        return CatalogRelation(
            dataset_id=self.dataset_id,
            dataset_name=self.logical_name,
            identifiers=(self.logical_name, self.dataset_id),
            mode="streaming" if self.role == "fact" else "static",
            query_engine_table={},
            schema=self.schema,
            schema_fingerprint=schema_fingerprint,
            snapshot_id=self.dimension_version_id,
            streaming_source={"topic": self.kafka_topic} if self.role == "fact" else None,
            unique_key_sets=self.unique_key_sets,
            estimated_row_count=self.estimated_row_count,
        )


@dataclass(frozen=True)
class RealtimeSqlPlan:
    normalized_sql: str
    sql_fingerprint: str
    execution_mode: ExecutionMode
    referenced_dataset_ids: tuple[str, ...]
    join_keys: tuple[dict[str, object], ...]
    missing_policies: tuple[dict[str, str], ...]
    output_schema: tuple[tuple[str, str], ...]
    business_key_columns: tuple[str, ...]
    event_time_column: str | None
    warnings: tuple[str, ...]
    estimated_cost: dict[str, int]
    runtime_plan: CompiledContinuousSqlPlan
    relations: tuple[RealtimeRelation, ...]


def _reject_physical_relations(parsed: exp.Expression) -> None:
    for table in parsed.find_all(exp.Table):
        if table.catalog or table.db:
            raise ContinuousSqlValidationError(
                "REALTIME_SQL_PHYSICAL_RELATION_FORBIDDEN",
                "Realtime SQL cannot reference physical catalogs or databases.",
                {"relation": table.sql()},
            )


def _approved_relations(relations: Iterable[RealtimeRelation]) -> tuple[RealtimeRelation, ...]:
    approved = tuple(relations)
    if not approved or any(not item.approved for item in approved):
        raise ContinuousSqlValidationError(
            "REALTIME_SQL_RELATION_NOT_APPROVED",
            "Every realtime SQL relation must be an approved Catalog Dataset.",
        )
    return approved


class RealtimeSqlValidator:
    def validate(
        self,
        query: str,
        relations: Iterable[RealtimeRelation],
        *,
        business_key_columns: Iterable[str] = (),
        event_time_column: str | None = None,
        signals: ExecutionSignals | None = None,
        dimension_row_limit: int = 5_000_000,
    ) -> RealtimeSqlPlan:
        relation_list = _approved_relations(relations)
        parsed = parse_single_select(query)
        _reject_physical_relations(parsed)
        mode = classify_execution_mode(signals or ExecutionSignals())
        if mode != "realtime_incremental":
            raise ContinuousSqlValidationError(
                "REALTIME_SQL_EXECUTION_MODE_UNSUPPORTED",
                "This query requires a non-incremental execution mode.",
                {"executionMode": mode},
            )

        compiled = ContinuousSqlPlanner().compile(
            query,
            [item.planner_relation() for item in relation_list],
            static_cache_max_rows=dimension_row_limit,
        )
        plan_relations = list(compiled.plan["relations"])
        relation_by_id = {item.dataset_id: item for item in relation_list}
        used_relations = tuple(relation_by_id[str(item["datasetId"])] for item in plan_relations)
        facts = [item for item in used_relations if item.role == "fact"]
        dimensions = [item for item in used_relations if item.role == "dimension"]
        if len(facts) != 1 or not 1 <= len(dimensions) <= 3:
            raise ContinuousSqlValidationError(
                "REALTIME_SQL_RELATION_COUNT_INVALID",
                "Realtime incremental SQL requires one fact and one to three dimensions.",
                {"factCount": len(facts), "dimensionCount": len(dimensions)},
            )
        if plan_relations[0]["datasetId"] != facts[0].dataset_id:
            raise ContinuousSqlValidationError(
                "REALTIME_SQL_FACT_MUST_BE_LEFT",
                "The approved fact Dataset must be the left-most relation.",
            )

        output_schema = tuple((str(item[0]), str(item[1])) for item in compiled.plan["outputSchema"])
        output_names = {name.casefold() for name, _type in output_schema}
        business_keys = tuple(str(item).strip() for item in business_key_columns if str(item).strip())
        missing_business_keys = [item for item in business_keys if item.casefold() not in output_names]
        if missing_business_keys:
            raise ContinuousSqlValidationError(
                "REALTIME_SQL_BUSINESS_KEY_UNKNOWN",
                "Business key columns must be projected by realtime SQL.",
                {"columns": missing_business_keys},
            )
        if event_time_column and event_time_column.casefold() not in output_names:
            raise ContinuousSqlValidationError(
                "REALTIME_SQL_EVENT_TIME_UNKNOWN",
                "The configured event-time column must be projected by realtime SQL.",
                {"column": event_time_column},
            )
        if any(item.dimension_semantics == "temporal" for item in dimensions):
            fact_columns = {name.casefold() for name, _type in facts[0].schema}
            if not event_time_column or event_time_column.casefold() not in fact_columns:
                raise ContinuousSqlValidationError(
                    "REALTIME_SQL_TEMPORAL_EVENT_TIME_REQUIRED",
                    "Temporal dimension JOIN requires a projected fact event-time column.",
                )

        joins = tuple(dict(item) for item in compiled.plan["joins"])
        missing_policies = tuple({
            "dimensionDatasetId": str(item["rightDatasetId"]),
            "joinType": str(item["type"]),
            "missingPolicy": default_missing_policy(str(item["type"])),
        } for item in joins)
        dimension_rows = sum(max(0, item.estimated_row_count or 0) for item in dimensions)
        source_rate = 0
        if facts[0].estimated_row_count is not None:
            source_rate = max(0, facts[0].estimated_row_count)
        fingerprint = hashlib.sha256(compiled.normalized_sql.encode("utf-8")).hexdigest()
        return RealtimeSqlPlan(
            normalized_sql=compiled.normalized_sql,
            sql_fingerprint=fingerprint,
            execution_mode=mode,
            referenced_dataset_ids=tuple(item.dataset_id for item in used_relations),
            join_keys=joins,
            missing_policies=missing_policies,
            output_schema=output_schema,
            business_key_columns=business_keys,
            event_time_column=event_time_column,
            warnings=(),
            estimated_cost={
                "sourceRowsPerSecond": source_rate,
                "dimensionRows": dimension_rows,
                "estimatedP95Ms": min(5_000, 50 + len(dimensions) * 150),
            },
            runtime_plan=compiled,
            relations=used_relations,
        )
