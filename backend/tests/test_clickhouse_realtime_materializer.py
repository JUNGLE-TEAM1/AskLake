from __future__ import annotations

from pathlib import Path
import unittest

from app.realtime.application.materializer import RealtimeMaterializer
from app.realtime.domain.source_boundary import (
    PartitionBoundary,
    SourceBoundary,
    serving_key,
    serving_row_version,
)
from app.realtime.repositories.materialization_repository import MaterializationRepository
from app.realtime.sql.classifier import ExecutionSignals, classify_execution_mode
from app.realtime.sql.clickhouse_compiler import ClickHouseRealtimeCompiler
from app.realtime.sql.validator import RealtimeRelation, RealtimeSqlValidator
from app.services.clickhouse_client import ClickHouseRows
from app.services.continuous_sql_planner import ContinuousSqlValidationError


def relations(*, temporal: bool = False, dimension_count: int = 2):
    values = [RealtimeRelation(
        dataset_id="events",
        logical_name="events",
        role="fact",
        physical_database="asklake_realtime_v2",
        physical_table="raw_events_v2_current",
        schema=(
            ("event_id", "string"), ("event_time", "timestamp"),
            ("user_id", "string"), ("product_id", "string"),
            ("campaign_id", "string"), ("country_id", "string"),
            ("amount", "double"),
        ),
        kafka_topic="events.v2",
        estimated_row_count=1000,
    )]
    definitions = (
        ("users", (("id", "string"), ("region", "string"))),
        ("products", (("id", "string"), ("category", "string"))),
        ("campaigns", (("id", "string"), ("channel", "string"))),
        ("countries", (("id", "string"), ("continent", "string"))),
    )
    for index, (name, schema) in enumerate(definitions[:dimension_count]):
        semantics = "temporal" if temporal and index == 0 else "current"
        values.append(RealtimeRelation(
            dataset_id=name,
            logical_name=name,
            role="dimension",
            physical_database="asklake_realtime_v2",
            physical_table=(
                "dimension_temporal_v2_latest" if semantics == "temporal"
                else "dimension_current_v2_latest"
            ),
            schema=schema,
            unique_key_sets=(("id",),),
            estimated_row_count=100,
            dimension_version_id=f"{name}-v1",
            dimension_semantics=semantics,
        ))
    return tuple(values)


def two_join_sql() -> str:
    return (
        "SELECT e.event_id, e.event_time, e.amount, u.region, p.category "
        "FROM events e LEFT JOIN users u ON e.user_id = u.id "
        "INNER JOIN products p ON e.product_id = p.id"
    )


def plan(*, temporal: bool = False):
    return RealtimeSqlValidator().validate(
        two_join_sql(),
        relations(temporal=temporal),
        business_key_columns=("event_id",),
        event_time_column="event_time",
    )


class _Result:
    def __init__(self, rowcount=1):
        self.rowcount = rowcount


class _Session:
    def __init__(self, rowcounts=None):
        self.calls = []
        self.rowcounts = iter(rowcounts or [])

    def execute(self, statement, parameters):
        self.calls.append((str(statement), parameters))
        return _Result(next(self.rowcounts, 1))


class _Repository:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def call(**kwargs):
            self.calls.append((name, kwargs))
            return True
        return call


class _ClickHouse:
    def __init__(self, evidence):
        self.evidence = iter(evidence)
        self.executions = []

    def query(self, query, **kwargs):
        count, checksum = next(self.evidence)
        return ClickHouseRows(["row_count", "checksum"], [[count, checksum]])

    def execute(self, query, **kwargs):
        self.executions.append((query, kwargs))
        return ""


class ClickHouseRealtimeMaterializerTests(unittest.TestCase):
    def test_source_boundary_and_row_identities_are_order_independent(self) -> None:
        first = SourceBoundary.build([
            PartitionBoundary("events.v2", 1, 3, 8),
            PartitionBoundary("events.v2", 0, -1, 4),
        ])
        second = SourceBoundary.build(reversed(first.partitions))

        self.assertEqual(first.fingerprint("pipeline-v1"), second.fingerprint("pipeline-v1"))
        self.assertEqual(first.materialization_id("pipeline-v1"), second.materialization_id("pipeline-v1"))
        self.assertEqual(serving_row_version(pipeline_generation=7, correction_generation=2), (7 << 32) | 2)
        self.assertEqual(
            serving_key(
                scope_id="deployment", dataset_id="joined", pipeline_version_id="pipeline-v1",
                business_key_values=("event-1",),
            ),
            serving_key(
                scope_id="deployment", dataset_id="joined", pipeline_version_id="pipeline-v1",
                business_key_values=("event-1",),
            ),
        )

    def test_classifier_rejects_cost_and_routes_stateful_work(self) -> None:
        self.assertEqual(classify_execution_mode(ExecutionSignals()), "realtime_incremental")
        self.assertEqual(classify_execution_mode(ExecutionSignals(
            right_side_requires_immediate_history=True,
        )), "near_realtime_refresh")
        self.assertEqual(classify_execution_mode(ExecutionSignals(
            event_time_retraction_required=True,
        )), "streaming_required")
        self.assertEqual(classify_execution_mode(ExecutionSignals(
            estimated_cost_exceeds_limit=True,
        )), "rejected")

    def test_validator_accepts_bounded_three_way_join_and_rejects_unsafe_shapes(self) -> None:
        validated = plan()
        self.assertEqual(validated.execution_mode, "realtime_incremental")
        self.assertEqual(len(validated.join_keys), 2)
        self.assertEqual(
            tuple(item["missingPolicy"] for item in validated.missing_policies),
            ("publish_null_then_correct", "hold_and_repair"),
        )

        with self.assertRaisesRegex(ContinuousSqlValidationError, "one to three"):
            RealtimeSqlValidator().validate(
                "SELECT e.event_id FROM events e "
                "JOIN users u ON e.user_id = u.id "
                "JOIN products p ON e.product_id = p.id "
                "JOIN campaigns c ON e.campaign_id = c.id "
                "JOIN countries n ON e.country_id = n.id",
                relations(dimension_count=4),
            )
        with self.assertRaisesRegex(ContinuousSqlValidationError, "physical"):
            RealtimeSqlValidator().validate(
                two_join_sql().replace("events e", "system.events e"),
                relations(),
            )
        with self.assertRaises(ContinuousSqlValidationError):
            RealtimeSqlValidator().validate(two_join_sql() + "; SELECT 1", relations())

    def test_compiler_pins_boundary_dimensions_and_temporal_range(self) -> None:
        boundary = SourceBoundary.build([
            PartitionBoundary("events.v2", 0, 9, 20),
            PartitionBoundary("events.v2", 1, 4, 7),
        ])
        compiler = ClickHouseRealtimeCompiler()
        current = compiler.compile(
            plan(), boundary=boundary,
            serving_database="asklake_realtime_v2", serving_table="serving_events_v2",
            serving_dataset_id="joined", pipeline_version_id="pipeline-v1", pipeline_generation=3,
        )
        temporal = compiler.compile(
            plan(temporal=True), boundary=boundary,
            serving_database="asklake_realtime_v2", serving_table="serving_events_v2",
            serving_dataset_id="joined", pipeline_version_id="pipeline-v1", pipeline_generation=3,
        )

        for fragment in (
            "kafka_offset > 9", "kafka_offset <= 20", "users-v1",
            "products-v1", "insert_deduplication_token", "dimension_version_ids",
        ):
            self.assertIn(fragment, current.insert_sql)
        self.assertIn("__valid_from", temporal.insert_sql)
        self.assertIn("__valid_to", temporal.insert_sql)
        self.assertEqual(current.row_version, 3 << 32)
        self.assertEqual(current.materialization_id, compiler.compile(
            plan(), boundary=boundary,
            serving_database="asklake_realtime_v2", serving_table="serving_events_v2",
            serving_dataset_id="joined", pipeline_version_id="pipeline-v1", pipeline_generation=3,
        ).materialization_id)

    def test_repository_checkpoint_cas_is_partition_sorted_and_stale_fails(self) -> None:
        boundary = SourceBoundary.build([
            PartitionBoundary("events.v2", 1, 3, 4),
            PartitionBoundary("events.v2", 0, 1, 2),
        ])
        success = _Session([1, 1])
        MaterializationRepository(success).advance_checkpoints(
            pipeline_version_id="pipeline-v1", boundary=boundary, lease_generation=4,
        )
        self.assertEqual([call[1]["partition"] for call in success.calls], [0, 1])
        self.assertTrue(all("last_contiguously_received_offset >=" in call[0] for call in success.calls))

        stale = _Session([1, 0])
        with self.assertRaisesRegex(ValueError, "stale checkpoint"):
            MaterializationRepository(stale).advance_checkpoints(
                pipeline_version_id="pipeline-v1", boundary=boundary, lease_generation=4,
            )

    def test_materializer_reconciles_clickhouse_success_without_second_insert(self) -> None:
        boundary = SourceBoundary.build([PartitionBoundary("events.v2", 0, -1, 2)])
        compiled = ClickHouseRealtimeCompiler().compile(
            plan(), boundary=boundary,
            serving_database="asklake_realtime_v2", serving_table="serving_events_v2",
            serving_dataset_id="joined", pipeline_version_id="pipeline-v1", pipeline_generation=1,
        )
        clickhouse = _ClickHouse([(2, "checksum-2")])
        repository = _Repository()
        result = RealtimeMaterializer(clickhouse, repository).run(  # type: ignore[arg-type]
            compiled,
            pipeline_version_id="pipeline-v1",
            boundary=boundary,
            dimension_version_ids={"users": "users-v1", "products": "products-v1"},
            lease_generation=1,
            serving_database="asklake_realtime_v2",
        )

        self.assertTrue(result.reconciled)
        self.assertEqual(clickhouse.executions, [])
        self.assertEqual([name for name, _kwargs in repository.calls], [
            "reserve", "mark_running", "mark_reconciling", "mark_materialized",
        ])

    def test_materializer_inserts_with_stable_query_id_then_commits_evidence(self) -> None:
        boundary = SourceBoundary.build([PartitionBoundary("events.v2", 0, -1, 2)])
        compiled = ClickHouseRealtimeCompiler().compile(
            plan(), boundary=boundary,
            serving_database="asklake_realtime_v2", serving_table="serving_events_v2",
            serving_dataset_id="joined", pipeline_version_id="pipeline-v1", pipeline_generation=1,
        )
        clickhouse = _ClickHouse([(0, "empty"), (1, "checksum-1")])
        repository = _Repository()
        result = RealtimeMaterializer(clickhouse, repository).run(  # type: ignore[arg-type]
            compiled,
            pipeline_version_id="pipeline-v1",
            boundary=boundary,
            dimension_version_ids={"users": "users-v1", "products": "products-v1"},
            lease_generation=1,
            serving_database="asklake_realtime_v2",
        )

        self.assertFalse(result.reconciled)
        self.assertEqual(result.target_row_count, 1)
        self.assertEqual(clickhouse.executions[0][1]["query_id"], compiled.clickhouse_query_id)

    def test_serving_ddl_exposes_canonical_current_view(self) -> None:
        ddl = (Path(__file__).parents[2] / "deploy/clickhouse-v2/initdb/04-serving.sql").read_text()
        for fragment in (
            "serving_events_v2", "serving_current_v2", "ReplicatedReplacingMergeTree",
            "FINAL", "source_fingerprint", "dimension_version_ids", "row_version",
        ):
            self.assertIn(fragment, ddl)


if __name__ == "__main__":
    unittest.main()
