from datetime import UTC, datetime
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.etl import ETLJobModel
from app.repositories.dashboard_live_repository import (
    DashboardLiveRepository,
    backfill_catalog_revision,
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

    def test_recommended_poll_interval_is_bounded_and_has_stable_fallback(self) -> None:
        cases = {
            None: 15_000,
            "invalid": 15_000,
            -10: 5_000,
            0: 5_000,
            1: 5_000,
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
