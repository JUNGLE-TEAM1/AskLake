from __future__ import annotations

import unittest

from app.main import app
from app.core.compatibility import (
    CompatibilityPath,
    compatibility_path_counts,
    record_compatibility_path,
    record_legacy_runtime_error_projection,
    reset_compatibility_path_counts_for_test,
)
from app.domain.continuous_runtime import runtime_contract_projection
from app.schemas.etl import JobRowData, KafkaContinuousSession


class BackwardCompatibilityContractTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_compatibility_path_counts_for_test()

    def test_old_job_payload_hydrates_with_additive_defaults(self) -> None:
        job = JobRowData.model_validate({
            "id": "legacy-job",
            "lastRun": "-",
            "lastState": "생성 후 미실행",
            "name": "Legacy Job",
            "nextRun": "-",
            "owner": "data-team",
            "schedule": "수동 실행",
            "source": "Apache Kafka",
            "status": "stopped",
            "tag": "#legacy",
            "target": "legacy_events",
        })
        self.assertEqual(job.execution_mode, "snapshot")
        self.assertEqual(job.rule_contract_version, "1.0")
        self.assertEqual(job.rules, [])
        self.assertEqual(job.permission_grants, [])

    def test_iceberg_target_keeps_legacy_openapi_component_name(self) -> None:
        schemas = app.openapi()["components"]["schemas"]
        self.assertIn("IcebergWriterTarget", schemas)
        self.assertNotIn("IcebergWriterTarget-Input", schemas)
        self.assertNotIn("IcebergWriterTarget-Output", schemas)

    def test_old_continuous_session_payload_hydrates_with_additive_defaults(self) -> None:
        session = KafkaContinuousSession.model_validate({
            "checkpointPath": "s3a://output/checkpoints/job-1",
            "jobId": "job-1",
            "sessionId": "session-1",
            "startedAt": "2026-07-01T00:00:00Z",
            "status": "stopped",
        })
        self.assertIsNone(session.worker_attempt_id)
        self.assertEqual(session.consumed_count, 0)
        self.assertEqual(session.dag_steps, [])

    def test_legacy_runtime_error_is_projected_and_observable(self) -> None:
        with self.assertLogs("asklake.compatibility", level="WARNING") as logs:
            record_legacy_runtime_error_projection(
                {},
                "checkpoint fingerprint mismatch",
                public_status="failed",
            )
            projection = runtime_contract_projection(
                {},
                public_status="failed",
                legacy_error="checkpoint fingerprint mismatch",
            )
        self.assertEqual(projection["errorDetail"]["stage"], "checkpoint")
        self.assertEqual(
            compatibility_path_counts()[CompatibilityPath.CONTINUOUS_LEGACY_ERROR.value],
            1,
        )
        self.assertIn("compatibility_path_used", logs.output[0])

    def test_standard_compatibility_counter_uses_stable_path_ids(self) -> None:
        with self.assertLogs("asklake.compatibility", level="WARNING"):
            first = record_compatibility_path(
                CompatibilityPath.SQL_DUCKDB_ENGINE,
                reason="fixture",
                context={"datasetId": "dataset-1"},
            )
            second = record_compatibility_path(
                CompatibilityPath.SQL_DUCKDB_ENGINE,
                reason="fixture",
            )
        self.assertEqual((first, second), (1, 2))
        self.assertEqual(
            compatibility_path_counts()[CompatibilityPath.SQL_DUCKDB_ENGINE.value],
            2,
        )

    def test_structured_runtime_error_does_not_activate_legacy_projection(self) -> None:
        record_legacy_runtime_error_projection(
            {"runtimeContract": {"lastError": {"code": "execution_failed"}}},
            "old mirror text",
            public_status="failed",
        )
        self.assertNotIn(
            CompatibilityPath.CONTINUOUS_LEGACY_ERROR.value,
            compatibility_path_counts(),
        )


if __name__ == "__main__":
    unittest.main()
