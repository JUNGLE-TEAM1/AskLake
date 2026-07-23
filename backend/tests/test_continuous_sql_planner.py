import json
import unittest

from app.schemas.continuous_sql import ContinuousSqlPlanRequest
from app.services.continuous_sql_planner import (
    CatalogRelation,
    ContinuousSqlPlanner,
    ContinuousSqlValidationError,
)


def relation(
    dataset_id: str,
    name: str,
    *,
    mode: str,
    schema: tuple[tuple[str, str], ...],
    unique_key_sets: tuple[tuple[str, ...], ...] = (),
    estimated_row_count: int | None = None,
) -> CatalogRelation:
    return CatalogRelation(
        dataset_id=dataset_id,
        dataset_name=name,
        identifiers=(name, f"asklake.{name}", f"iceberg.asklake.{name}"),
        mode=mode,
        query_engine_table={
            "catalog": "iceberg",
            "schema": "asklake",
            "table": name,
            "format": "iceberg",
        },
        schema=schema,
        schema_fingerprint=f"schema-{dataset_id}",
        snapshot_id="101" if mode == "static" else None,
        streaming_source=(
            {
                "broker": "redpanda:9092",
                "topic": "events",
                "consumerGroupId": "continuous-sql-tests",
            }
            if mode == "streaming"
            else None
        ),
        unique_key_sets=unique_key_sets,
        estimated_row_count=estimated_row_count,
    )


class ContinuousSqlPlannerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.planner = ContinuousSqlPlanner()
        self.stream = relation(
            "dataset-events",
            "events",
            mode="streaming",
            schema=(("event_id", "bigint"), ("user_id", "bigint"), ("amount", "double")),
        )
        self.users = relation(
            "dataset-users",
            "users",
            mode="static",
            schema=(("id", "bigint"), ("name", "string"), ("segment_id", "integer")),
            unique_key_sets=(("id",),),
        )
        self.segments = relation(
            "dataset-segments",
            "segments",
            mode="static",
            schema=(("id", "integer"), ("label", "string")),
            unique_key_sets=(("id",),),
        )

    def compile(self, sql: str, relations=None):
        return self.planner.compile(sql, relations or [self.stream, self.users])

    def assert_error(self, code: str, sql: str, relations=None) -> ContinuousSqlValidationError:
        with self.assertRaises(ContinuousSqlValidationError) as raised:
            self.compile(sql, relations)
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_compiles_stream_left_inner_and_left_static_joins_deterministically(self) -> None:
        sql = (
            "SELECT e.event_id, u.name AS user_name, s.label AS segment "
            "FROM iceberg.asklake.events e "
            "LEFT JOIN asklake.users u ON e.user_id = u.id "
            "JOIN segments s ON u.segment_id = s.id"
        )
        first = self.compile(sql, [self.stream, self.users, self.segments])
        second = self.compile(sql, [self.stream, self.users, self.segments])

        self.assertEqual(first.plan_hash, second.plan_hash)
        self.assertEqual(first.plan["planVersion"], "continuous-sql-v1")
        self.assertEqual([join["type"] for join in first.plan["joins"]], ["LEFT", "INNER"])
        self.assertEqual(first.plan["outputSchema"], [
            ["event_id", "long"],
            ["user_name", "string"],
            ["segment", "string"],
        ])
        self.assertIn("__asklake_relation_0", first.runtime_sql)
        self.assertIn("kafka_offset AS kafka_offset", first.runtime_sql)
        self.assertEqual(first.plan_hash, json.loads(json.dumps(first.plan))["planHash"])

    def test_quoted_identifier_alias_and_passthrough_cte_are_resolved(self) -> None:
        compiled = self.compile(
            'WITH stream_alias AS (SELECT * FROM "events") '
            'SELECT stream_alias.event_id, u.name AS user_name '
            'FROM stream_alias LEFT JOIN "users" AS u ON stream_alias.user_id = u.id'
        )

        self.assertIn("WITH stream_alias AS", compiled.runtime_sql)
        self.assertEqual(
            [item["datasetId"] for item in compiled.plan["relations"]],
            ["dataset-events", "dataset-users"],
        )

    def test_static_only_and_two_stream_relations_are_rejected(self) -> None:
        self.assert_error(
            "CONTINUOUS_SQL_STREAM_COUNT_INVALID",
            "SELECT u.id FROM users u JOIN segments s ON u.segment_id = s.id",
            [self.users, self.segments],
        )
        second_stream = relation(
            "dataset-events-2",
            "events_2",
            mode="streaming",
            schema=(("user_id", "bigint"),),
        )
        self.assert_error(
            "CONTINUOUS_SQL_STREAM_COUNT_INVALID",
            "SELECT e.event_id FROM events e JOIN events_2 x ON e.user_id = x.user_id",
            [self.stream, second_stream],
        )

    def test_streaming_relation_must_be_the_left_input(self) -> None:
        self.assert_error(
            "CONTINUOUS_SQL_STREAM_MUST_BE_LEFT",
            "SELECT u.id FROM users u JOIN events e ON u.id = e.user_id",
        )

    def test_only_inner_left_and_equality_predicates_are_supported(self) -> None:
        self.assert_error(
            "CONTINUOUS_SQL_JOIN_TYPE_UNSUPPORTED",
            "SELECT e.event_id FROM events e RIGHT JOIN users u ON e.user_id = u.id",
        )
        self.assert_error(
            "CONTINUOUS_SQL_JOIN_PREDICATE_UNSUPPORTED",
            "SELECT e.event_id FROM events e JOIN users u ON e.user_id > u.id",
        )
        self.assert_error(
            "CONTINUOUS_SQL_JOIN_PREDICATE_UNSUPPORTED",
            "SELECT e.event_id FROM events e JOIN users u ON e.user_id = u.id OR e.event_id = u.id",
        )

    def test_join_type_mismatch_and_missing_uniqueness_evidence_are_rejected(self) -> None:
        string_users = relation(
            "dataset-users-string",
            "users_string",
            mode="static",
            schema=(("id", "string"), ("name", "string")),
            unique_key_sets=(("id",),),
        )
        self.assert_error(
            "CONTINUOUS_SQL_JOIN_KEY_TYPE_MISMATCH",
            "SELECT e.event_id FROM events e JOIN users_string u ON e.user_id = u.id",
            [self.stream, string_users],
        )
        unverified = relation(
            "dataset-users-unverified",
            "users_unverified",
            mode="static",
            schema=(("id", "bigint"),),
        )
        self.assert_error(
            "CONTINUOUS_SQL_STATIC_KEY_NOT_UNIQUE",
            "SELECT e.event_id FROM events e JOIN users_unverified u ON e.user_id = u.id",
            [self.stream, unverified],
        )

    def test_stateful_unbounded_and_nondeterministic_constructs_have_stable_errors(self) -> None:
        cases = [
            ("CONTINUOUS_SQL_ORDER_BY_UNSUPPORTED", "SELECT e.event_id FROM events e JOIN users u ON e.user_id = u.id ORDER BY e.event_id"),
            ("CONTINUOUS_SQL_LIMIT_UNSUPPORTED", "SELECT e.event_id FROM events e JOIN users u ON e.user_id = u.id LIMIT 10"),
            ("CONTINUOUS_SQL_DISTINCT_UNSUPPORTED", "SELECT COUNT(DISTINCT e.event_id) AS events FROM events e JOIN users u ON e.user_id = u.id"),
            ("CONTINUOUS_SQL_NONDETERMINISTIC_FUNCTION", "SELECT RANDOM() AS value FROM events e JOIN users u ON e.user_id = u.id"),
        ]
        for code, sql in cases:
            with self.subTest(code=code):
                self.assert_error(code, sql)

    def test_supported_aggregate_deltas_compile_without_window_fallback(self) -> None:
        compiled = self.compile(
            "SELECT u.name AS membership, COUNT(*) AS events, "
            "COUNT_IF(e.amount > 0) AS purchases, SUM(e.amount) AS revenue, "
            "MIN(e.amount) AS minimum, MAX(e.amount) AS maximum, AVG(e.amount) AS average "
            "FROM events e JOIN users u ON e.user_id = u.id GROUP BY u.name"
        )

        self.assertTrue(compiled.plan["capabilities"]["aggregateDelta"])
        self.assertIn("MAX(e.kafka_offset) AS kafka_offset", compiled.runtime_sql)
        self.assertEqual(compiled.plan["outputSchema"][-1], ["average", "double"])

    def test_computed_projection_requires_alias_and_output_names_are_unique(self) -> None:
        self.assert_error(
            "CONTINUOUS_SQL_PROJECTION_ALIAS_REQUIRED",
            "SELECT e.amount + 1 FROM events e JOIN users u ON e.user_id = u.id",
        )

    def test_broadcast_hint_requires_bounded_catalog_statistics(self) -> None:
        small_users = relation(
            "dataset-users-small",
            "users_small",
            mode="static",
            schema=(("id", "bigint"), ("name", "string")),
            unique_key_sets=(("id",),),
            estimated_row_count=50,
        )
        large_users = relation(
            "dataset-users-large",
            "users_large",
            mode="static",
            schema=(("id", "bigint"), ("name", "string")),
            unique_key_sets=(("id",),),
            estimated_row_count=50_000,
        )
        empty_users = relation(
            "dataset-users-empty",
            "users_empty",
            mode="static",
            schema=(("id", "bigint"), ("name", "string")),
            unique_key_sets=(("id",),),
            estimated_row_count=0,
        )
        small = self.planner.compile(
            "SELECT e.event_id, u.name AS user_name FROM events e JOIN users_small u ON e.user_id = u.id",
            [self.stream, small_users],
            static_broadcast_max_rows=100,
            static_cache_max_rows=10_000,
        )
        large = self.planner.compile(
            "SELECT e.event_id, u.name AS user_name FROM events e JOIN users_large u ON e.user_id = u.id",
            [self.stream, large_users],
            static_broadcast_max_rows=100,
            static_cache_max_rows=10_000,
        )
        unknown = self.compile(
            "SELECT e.event_id, u.name AS user_name FROM events e JOIN users u ON e.user_id = u.id"
        )
        cache_disabled = self.planner.compile(
            "SELECT e.event_id, u.name AS user_name FROM events e JOIN users_empty u ON e.user_id = u.id",
            [self.stream, empty_users],
            static_cache_max_rows=0,
        )

        self.assertTrue(small.plan["relations"][1]["broadcastHint"])
        self.assertFalse(large.plan["relations"][1]["broadcastHint"])
        self.assertFalse(unknown.plan["relations"][1]["broadcastHint"])
        self.assertTrue(small.plan["relations"][1]["cacheHint"])
        self.assertFalse(large.plan["relations"][1]["cacheHint"])
        self.assertFalse(unknown.plan["relations"][1]["cacheHint"])
        self.assertFalse(cache_disabled.plan["relations"][1]["cacheHint"])
        self.assertEqual(small.plan["staticCacheMaxRows"], 10_000)
        self.assert_error(
            "CONTINUOUS_SQL_OUTPUT_COLUMN_DUPLICATE",
            "SELECT e.event_id, u.id AS event_id FROM events e JOIN users u ON e.user_id = u.id",
        )

    def test_continuous_sql_defaults_to_ten_second_bounded_trigger(self) -> None:
        request = ContinuousSqlPlanRequest(
            query="SELECT e.event_id, u.name AS user_name FROM events e JOIN users u ON e.user_id = u.id",
            relationDatasetIds=["dataset-events", "dataset-users"],
        )

        self.assertEqual(request.trigger_interval_seconds, 10)
        self.assertEqual(self.compile(request.query).plan["triggerIntervalSeconds"], 10)


if __name__ == "__main__":
    unittest.main()
