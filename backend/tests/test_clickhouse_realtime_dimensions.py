from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
import unittest

from app.realtime.application.dimension_publish_worker import DimensionPublishWorker
from app.realtime.domain.dimension import DimensionRow, build_dimension_plan, default_missing_policy
from app.realtime.domain.late_repair import plan_late_repair
from app.realtime.domain.source_position import SourcePosition
from app.realtime.repositories.dimension_repository import DimensionRepository


NOW = datetime(2026, 7, 18, 12, tzinfo=UTC)


class _Result:
    def __init__(self, rowcount: int = 1) -> None:
        self.rowcount = rowcount


class _Session:
    def __init__(self, rowcounts: list[int] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.rowcounts = iter(rowcounts or [])

    def execute(self, statement, parameters):
        self.calls.append((str(statement), parameters))
        return _Result(next(self.rowcounts, 1))


class _ClickHouse:
    def __init__(self) -> None:
        self.call = None

    def insert_json_rows(self, database, table, columns, rows):
        materialized = list(rows)
        self.call = (database, table, tuple(columns), materialized)
        return len(materialized)


class ClickHouseRealtimeDimensionTests(unittest.TestCase):
    def test_current_plan_is_unique_and_checksum_is_stable(self) -> None:
        first = DimensionRow("user-2", {"region": "seoul"}, row_version=2)
        second = DimensionRow("user-1", {"region": "busan"})

        forward = build_dimension_plan(semantics="current", rows=[first, second])
        reverse = build_dimension_plan(semantics="current", rows=[second, first])

        self.assertEqual(forward.checksum, reverse.checksum)
        self.assertEqual(tuple(row.key for row in forward.rows), ("user-1", "user-2"))
        with self.assertRaisesRegex(ValueError, "must be unique"):
            build_dimension_plan(semantics="current", rows=[first, first])

    def test_temporal_plan_accepts_adjacent_but_rejects_overlapping_ranges(self) -> None:
        adjacent = [
            DimensionRow("user-1", {"region": "a"}, NOW, NOW + timedelta(hours=1)),
            DimensionRow("user-1", {"region": "b"}, NOW + timedelta(hours=1), None),
        ]
        self.assertEqual(build_dimension_plan(semantics="temporal", rows=adjacent).row_count, 2)

        overlapping = [
            adjacent[0],
            DimensionRow("user-1", {"region": "b"}, NOW + timedelta(minutes=59), None),
        ]
        with self.assertRaisesRegex(ValueError, "overlap"):
            build_dimension_plan(semantics="temporal", rows=overlapping)

    def test_join_defaults_and_late_repair_are_deterministic(self) -> None:
        self.assertEqual(default_missing_policy("inner"), "hold_and_repair")
        self.assertEqual(default_missing_policy("LEFT"), "publish_null_then_correct")

        initial = plan_late_repair(
            policy="publish_null_then_correct",
            first_seen_at=NOW,
            now=NOW,
            retry_count=0,
            current_correction_generation=4,
        )
        capped = plan_late_repair(
            policy="hold_and_repair",
            first_seen_at=NOW,
            now=NOW + timedelta(hours=1),
            retry_count=10,
        )
        expired = plan_late_repair(
            policy="hold_and_repair",
            first_seen_at=NOW,
            now=NOW + timedelta(hours=24),
            retry_count=1,
        )

        self.assertTrue(initial.publish_null)
        self.assertEqual(initial.correction_generation, 5)
        self.assertEqual(initial.next_retry_at, NOW + timedelta(seconds=1))
        self.assertEqual(capped.next_retry_at, NOW + timedelta(hours=1, minutes=10))
        self.assertEqual(expired.status, "expired")
        self.assertIsNone(expired.next_retry_at)

    def test_publisher_inserts_validated_rows_with_deployment_scope(self) -> None:
        clickhouse = _ClickHouse()
        worker = DimensionPublishWorker(clickhouse)  # type: ignore[arg-type]

        evidence = worker.publish(
            database="asklake_realtime_v2",
            dataset_id="users",
            version_id="users-v1",
            semantics="current",
            rows=[DimensionRow("user-1", {"region": "seoul"})],
        )

        self.assertEqual(evidence.row_count, 1)
        self.assertEqual(evidence.physical_table, "dimension_current_v2")
        self.assertEqual(clickhouse.call[2][0], "scope_id")
        self.assertEqual(clickhouse.call[3][0][0], "deployment")
        with self.assertRaisesRegex(ValueError, "scope"):
            worker.publish(
                database="asklake_realtime_v2",
                scope_id="tenant-a",
                dataset_id="users",
                version_id="users-v1",
                semantics="current",
                rows=[],
            )

    def test_activation_is_atomic_and_stale_target_fails(self) -> None:
        success = _Session([1, 1, 1])
        DimensionRepository(success).activate(
            dimension_version_id="users-v2",
            scope_id="deployment",
            dataset_id="users",
            row_count=3,
            checksum="a" * 64,
        )
        self.assertEqual(len(success.calls), 3)
        self.assertIn("FOR UPDATE", success.calls[0][0])
        self.assertIn("status = 'retired'", success.calls[1][0])
        self.assertIn("physical_database IS NOT NULL", success.calls[2][0])

        stale = _Session([1, 1, 0])
        with self.assertRaisesRegex(ValueError, "stale"):
            DimensionRepository(stale).activate(
                dimension_version_id="users-v2",
                scope_id="deployment",
                dataset_id="users",
                row_count=3,
                checksum="a" * 64,
            )

    def test_unmatched_lifecycle_uses_source_position_identity(self) -> None:
        session = _Session()
        repository = DimensionRepository(session)
        position = SourcePosition("events", 2, 41)

        repository.schedule_unmatched(
            pipeline_version_id="pipeline-v1",
            serving_key="b" * 64,
            position=position,
            missing_policy="hold_and_repair",
            dimension_dataset_id="users",
            missing_keys={"user_id": "u-1"},
            raw_payload_hash="c" * 64,
            next_retry_at=NOW,
            correction_generation=0,
        )
        self.assertTrue(repository.reschedule_unmatched(
            pipeline_version_id="pipeline-v1",
            position=position,
            dimension_dataset_id="users",
            next_retry_at=NOW + timedelta(seconds=2),
            correction_generation=0,
        ))
        self.assertTrue(repository.mark_terminal(
            pipeline_version_id="pipeline-v1",
            position=position,
            dimension_dataset_id="users",
            status="quarantined",
        ))

        expected_hash = position.digest()
        self.assertTrue(all(call[1]["source_position_hash"] == expected_hash for call in session.calls))
        self.assertIn("retry_count = retry_count + 1", session.calls[1][0])
        with self.assertRaisesRegex(ValueError, "invalid"):
            repository.mark_terminal(
                pipeline_version_id="pipeline-v1",
                position=position,
                dimension_dataset_id="users",
                status="resolved",  # type: ignore[arg-type]
            )

    def test_clickhouse_ddl_has_versioned_current_and_temporal_contracts(self) -> None:
        ddl = (Path(__file__).parents[2] / "deploy/clickhouse-v2/initdb/03-dimensions.sql").read_text()
        for fragment in (
            "dimension_current_v2",
            "dimension_current_v2_latest",
            "dimension_temporal_v2",
            "dimension_temporal_v2_latest",
            "scope_id LowCardinality(String)",
            "ReplicatedReplacingMergeTree",
            "valid_temporal_interval",
            "argMax(d.payload",
        ):
            self.assertIn(fragment, ddl)


if __name__ == "__main__":
    unittest.main()
