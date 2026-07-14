from datetime import UTC, datetime
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.etl import ETLJobModel
from app.repositories.dashboard_live_repository import (
    REPLAY_COMMIT_KIND,
    STREAM_COMMIT_KIND,
    DashboardLiveRepository,
    backfill_catalog_revision,
    normalize_kafka_source_ranges,
    recommended_dashboard_poll_ms,
)


class DashboardLiveRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        self.db = Session(self.engine)
        self.repository = DashboardLiveRepository(self.db)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def record_commit(self, run_id: str, *, dataset_id: str = "dataset-live"):
        return self.repository.record_dataset_commit(
            dataset_id=dataset_id,
            run_id=run_id,
            storage_location=f"s3a://asklake-output/live/_batches/{run_id}",
            storage_format="parquet",
            materialization_mode="delta",
            row_count=3,
            next_check_after_ms=5_000,
            committed_at=datetime(2026, 7, 14, 1, 2, 3, tzinfo=UTC),
        )

    def record_stream(
        self,
        run_id: str,
        source_ranges: list[dict[str, object]],
        *,
        storage_location: str | None = None,
        commit_kind: str = STREAM_COMMIT_KIND,
    ):
        return self.repository.record_dataset_commit(
            dataset_id="dataset-stream",
            run_id=run_id,
            storage_location=storage_location or f"s3a://asklake-output/live/_batches/{run_id}",
            storage_format="parquet",
            materialization_mode="delta",
            row_count=3,
            next_check_after_ms=5_000,
            source_ranges=source_ranges,
            commit_kind=commit_kind,
            manifest_location=(
                f"s3a://asklake-output/live/_manifests/{run_id}.json"
                if commit_kind == STREAM_COMMIT_KIND
                else f"s3a://asklake-output/live/_replay-manifests/{run_id}.json"
            ),
        )

    def test_same_run_is_idempotent_and_new_runs_increment_revision(self) -> None:
        first, first_created = self.record_commit("run-1")
        self.db.commit()

        repeated, repeated_created = self.record_commit("run-1")
        second, second_created = self.record_commit("run-2")
        self.db.commit()

        self.assertTrue(first_created)
        self.assertFalse(repeated_created)
        self.assertTrue(second_created)
        self.assertEqual(first.revision, 1)
        self.assertEqual(repeated.revision, 1)
        self.assertEqual(second.revision, 2)

        freshness = self.repository.get_freshness("dataset-live")
        self.assertIsNotNone(freshness)
        self.assertEqual(freshness.latest_revision, 2)
        self.assertEqual(freshness.latest_run_id, "run-2")
        self.assertEqual(
            [commit.run_id for commit in self.repository.list_commits("dataset-live")],
            ["run-1", "run-2"],
        )
        self.assertEqual(
            [commit.run_id for commit in self.repository.list_commits(
                "dataset-live",
                after_revision=1,
                through_revision=2,
            )],
            ["run-2"],
        )

    def test_rollback_does_not_publish_freshness_or_revision(self) -> None:
        with patch.object(self.db, "commit", side_effect=RuntimeError("commit failed")):
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                backfill_catalog_revision(
                    self.db,
                    dataset_id="dataset-rollback",
                    run_id="run-rollback",
                    storage_location="s3a://asklake-output/live/_batches/run-rollback",
                    storage_format="parquet",
                    materialization_mode="delta",
                    row_count=7,
                    next_check_after_ms=5_000,
                )

        with Session(self.engine) as verification_db:
            verification_repository = DashboardLiveRepository(verification_db)
            self.assertIsNone(verification_repository.get_freshness("dataset-rollback"))
            self.assertIsNone(verification_repository.commit_by_run_id("run-rollback"))

    def test_legacy_backfill_seeds_stream_partition_watermark(self) -> None:
        backfill_catalog_revision(
            self.db,
            dataset_id="dataset-stream",
            run_id="continuous:legacy:batch:1",
            storage_location="s3a://asklake-output/live/_batches/batch_id=1",
            storage_format="parquet",
            materialization_mode="snapshot",
            row_count=30,
            next_check_after_ms=5_000,
            source_ranges=[{
                "topic": "orders",
                "partition": 0,
                "startOffset": 0,
                "endOffset": 30,
            }],
        )

        cursor = self.repository.stream_partition_cursor("dataset-stream", "orders", 0)
        self.assertIsNotNone(cursor)
        self.assertEqual(cursor.next_offset, 30)
        with self.assertRaisesRegex(ValueError, "partition watermark"):
            self.record_stream(
                "stream-after-checkpoint-reset",
                [{"topic": "orders", "partition": 0, "startOffset": 0, "endOffset": 30}],
            )

    def test_stream_offsets_are_canonical_and_deduplicate_different_run_ids(self) -> None:
        ranges = [
            {"topic": "orders", "partition": 1, "startOffset": 20, "endOffset": 30},
            {"topic": "orders", "partition": 0, "startOffset": 10, "endOffset": 20},
        ]
        first, first_created = self.record_stream("stream-1", ranges)
        self.db.commit()

        repeated, repeated_created = self.record_stream("stream-2", list(reversed(ranges)))
        self.db.commit()

        self.assertTrue(first_created)
        self.assertFalse(repeated_created)
        self.assertEqual(repeated.run_id, first.run_id)
        self.assertEqual(repeated.revision, 1)
        self.assertEqual(
            repeated.source_ranges,
            normalize_kafka_source_ranges(ranges, required=True),
        )
        self.assertEqual(len(str(repeated.source_fingerprint)), 64)
        self.assertEqual(
            self.repository.get_freshness("dataset-stream").latest_revision,
            1,
        )

    def test_same_run_id_with_different_publication_metadata_is_rejected(self) -> None:
        ranges = [{"topic": "orders", "partition": 0, "startOffset": 0, "endOffset": 30}]
        self.record_stream("stream-conflict", ranges)
        self.db.commit()

        with self.assertRaisesRegex(ValueError, "run_id was reused"):
            self.record_stream(
                "stream-conflict",
                [{"topic": "orders", "partition": 0, "startOffset": 30, "endOffset": 60}],
            )

        self.assertEqual(self.repository.get_freshness("dataset-stream").latest_revision, 1)

    def test_partially_overlapping_stream_offsets_are_rejected(self) -> None:
        self.record_stream(
            "stream-overlap-1",
            [{"topic": "orders", "partition": 0, "startOffset": 0, "endOffset": 30}],
        )
        self.db.commit()

        with self.assertRaisesRegex(ValueError, "overlaps the committed partition watermark"):
            self.record_stream(
                "stream-overlap-2",
                [{"topic": "orders", "partition": 0, "startOffset": 20, "endOffset": 40}],
            )

        self.assertEqual(self.repository.get_freshness("dataset-stream").latest_revision, 1)
        cursor = self.repository.stream_partition_cursor("dataset-stream", "orders", 0)
        self.assertIsNotNone(cursor)
        self.assertEqual(cursor.next_offset, 30)

    def test_ordered_stream_offsets_advance_partition_watermark(self) -> None:
        first, _ = self.record_stream(
            "stream-ordered-1",
            [{"topic": "orders", "partition": 0, "startOffset": 0, "endOffset": 30}],
        )
        self.db.commit()
        second, _ = self.record_stream(
            "stream-ordered-2",
            [{"topic": "orders", "partition": 0, "startOffset": 30, "endOffset": 60}],
        )
        self.db.commit()

        cursor = self.repository.stream_partition_cursor("dataset-stream", "orders", 0)
        self.assertEqual(first.revision, 1)
        self.assertEqual(second.revision, 2)
        self.assertIsNotNone(cursor)
        self.assertEqual(cursor.next_offset, 60)
        self.assertEqual(cursor.updated_revision, 2)

    def test_stream_partition_cursor_payload_is_topic_scoped_and_sorted(self) -> None:
        self.repository.record_stream_progress(
            "dataset-stream",
            [
                {"topic": "returns", "partition": 0, "startOffset": 0, "endOffset": 7},
                {"topic": "orders", "partition": 1, "startOffset": 0, "endOffset": 20},
                {"topic": "orders", "partition": 0, "startOffset": 0, "endOffset": 10},
            ],
        )
        self.db.commit()

        self.assertEqual(
            self.repository.list_stream_partition_cursors(
                "dataset-stream",
                topic="orders",
            ),
            [
                {"topic": "orders", "partition": 0, "nextOffset": 10},
                {"topic": "orders", "partition": 1, "nextOffset": 20},
            ],
        )

    def test_zero_row_stream_progress_is_idempotent_and_blocks_partial_overlap(self) -> None:
        first_range = [
            {"topic": "orders", "partition": 0, "startOffset": 0, "endOffset": 30},
        ]
        self.assertTrue(
            self.repository.record_stream_progress("dataset-stream", first_range)
        )
        self.db.commit()

        self.assertFalse(
            self.repository.record_stream_progress("dataset-stream", first_range)
        )
        with self.assertRaisesRegex(ValueError, "partially overlaps"):
            self.repository.record_stream_progress(
                "dataset-stream",
                [{"topic": "orders", "partition": 0, "startOffset": 20, "endOffset": 40}],
            )
        self.db.rollback()

        self.assertTrue(
            self.repository.record_stream_progress(
                "dataset-stream",
                [{"topic": "orders", "partition": 0, "startOffset": 30, "endOffset": 60}],
            )
        )
        self.db.commit()
        cursor = self.repository.stream_partition_cursor("dataset-stream", "orders", 0)
        self.assertIsNotNone(cursor)
        self.assertEqual(cursor.next_offset, 60)
        self.assertEqual(cursor.updated_revision, 0)
        self.assertIsNone(self.repository.get_freshness("dataset-stream"))

    def test_verified_retry_fills_missing_legacy_manifest_once(self) -> None:
        ranges = [
            {"topic": "orders", "partition": 0, "startOffset": 0, "endOffset": 30},
        ]
        original, _created = self.record_stream("stream-upgrade", ranges)
        original.manifest_location = None
        original.source_fingerprint = None
        self.db.add(original)
        self.db.commit()

        recovered, created = self.record_stream("stream-upgrade", ranges)
        self.db.commit()

        self.assertFalse(created)
        self.assertEqual(
            recovered.manifest_location,
            "s3a://asklake-output/live/_manifests/stream-upgrade.json",
        )
        self.assertEqual(len(str(recovered.source_fingerprint)), 64)

    def test_replay_has_separate_offset_namespace_and_is_itself_idempotent(self) -> None:
        ranges = [{"topic": "orders", "partition": 0, "startOffset": 0, "endOffset": 30}]
        stream, _ = self.record_stream("stream-original", ranges)
        replay, replay_created = self.record_stream(
            "replay-1",
            ranges,
            commit_kind=REPLAY_COMMIT_KIND,
        )
        self.db.commit()

        repeated, repeated_created = self.record_stream(
            "replay-2",
            ranges,
            commit_kind=REPLAY_COMMIT_KIND,
        )
        self.db.commit()

        self.assertEqual(stream.revision, 1)
        self.assertTrue(replay_created)
        self.assertEqual(replay.revision, 2)
        self.assertFalse(repeated_created)
        self.assertEqual(repeated.run_id, replay.run_id)
        self.assertEqual(self.repository.get_freshness("dataset-stream").latest_revision, 2)

    def test_stream_commit_requires_manifest_and_valid_end_exclusive_offsets(self) -> None:
        with self.assertRaisesRegex(ValueError, "publication manifest"):
            self.repository.record_dataset_commit(
                dataset_id="dataset-stream",
                run_id="stream-no-manifest",
                storage_location="s3a://asklake-output/live/_batches/stream-no-manifest",
                storage_format="parquet",
                materialization_mode="delta",
                row_count=3,
                next_check_after_ms=5_000,
                source_ranges=[{"topic": "orders", "partition": 0, "startOffset": 0, "endOffset": 3}],
                commit_kind=STREAM_COMMIT_KIND,
            )
        with self.assertRaisesRegex(ValueError, "startOffset < endOffset"):
            self.record_stream(
                "stream-bad-range",
                [{"topic": "orders", "partition": 0, "startOffset": 3, "endOffset": 3}],
            )

    def test_recommended_poll_interval_is_bounded_and_has_stable_fallback(self) -> None:
        cases = {
            None: 15_000,
            "invalid": 15_000,
            -10: 1_000,
            0: 1_000,
            1: 1_000,
            2: 1_000,
            10: 5_000,
            11: 5_500,
            30: 15_000,
            120: 60_000,
            3_600: 60_000,
        }
        for trigger_interval, expected in cases.items():
            with self.subTest(trigger_interval=trigger_interval):
                self.assertEqual(
                    recommended_dashboard_poll_ms(trigger_interval),
                    expected,
                )

    def test_widget_result_upsert_keeps_one_latest_result_per_calculation_version(self) -> None:
        created = self.repository.save_widget_result(
            widget_id="widget-live",
            calculation_version="a" * 64,
            dataset_id="dataset-live",
            applied_revision=1,
            result_payload={"data": [{"value": 10}]},
            calculation_state={"sum": 10, "count": 1},
            calculation_mode="full",
        )
        self.db.commit()

        updated = self.repository.save_widget_result(
            widget_id="widget-live",
            calculation_version="a" * 64,
            dataset_id="dataset-live",
            applied_revision=2,
            result_payload={"data": [{"value": 25}]},
            calculation_state={"sum": 25, "count": 2},
            calculation_mode="incremental",
        )
        self.db.commit()

        stored = self.repository.get_widget_result("widget-live", "a" * 64)
        self.assertEqual(created.widget_id, updated.widget_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.applied_revision, 2)
        self.assertEqual(stored.result_payload, {"data": [{"value": 25}]})
        self.assertEqual(stored.calculation_state, {"sum": 25, "count": 2})
        self.assertEqual(stored.calculation_mode, "incremental")

    def test_continuous_job_lookup_accepts_the_existing_stream_kafka_source_type(self) -> None:
        ETLJobModel.__table__.create(bind=self.engine)
        job = ETLJobModel(
            id="JOB-LIVE",
            name="Live Kafka",
            owner="data-team-01",
            source="Stream / Kafka / commerce.events",
            target="commerce_events",
            schedule="스케줄링 건너뛰기",
            source_config=[],
            source_label="Kafka commerce.events",
            source_type="Stream / Kafka",
            execution_mode="continuous",
            continuous_config={"triggerIntervalSeconds": 30},
            schema_columns=[],
            schema_sample_rows=[],
            target_format="parquet",
            target_layer="BRONZE",
            transform_output_columns=[],
            transform_steps=[],
            quality_invalid_rows=[],
            quality_rules=[],
            last_run="-",
            last_state="ready",
            next_run="-",
            stats={},
            dag_steps=[],
            dataset_id="dataset-live-job",
        )
        self.db.add(job)
        self.db.commit()

        found = self.repository.continuous_job_by_dataset("dataset-live-job")

        self.assertIsNotNone(found)
        self.assertEqual(found.id, job.id)


if __name__ == "__main__":
    unittest.main()
