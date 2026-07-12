import unittest
from types import SimpleNamespace

from app.core.materialization import active_materialization_runs, has_bounded_source_window
from app.services.etl_service import spark_materialization_mode, spark_source_window_metadata


class MaterializationContractTests(unittest.TestCase):
    def test_new_snapshot_replaces_older_snapshot_and_deltas(self) -> None:
        runs = [
            {"runId": "delta-2", "status": "success", "materializationMode": "delta"},
            {"runId": "snapshot-2", "status": "success", "materializationMode": "snapshot"},
            {"runId": "delta-1", "status": "success", "materializationMode": "delta"},
            {"runId": "snapshot-1", "status": "success", "materializationMode": "snapshot"},
        ]

        self.assertEqual(
            [run["runId"] for run in active_materialization_runs(runs)],
            ["delta-2", "snapshot-2"],
        )

    def test_legacy_runs_are_safe_snapshots(self) -> None:
        runs = [
            {"runId": "legacy-2", "status": "success"},
            {"runId": "legacy-1", "status": "success"},
        ]

        self.assertEqual(
            [run["runId"] for run in active_materialization_runs(runs)],
            ["legacy-2"],
        )

    def test_delta_only_stream_keeps_all_successful_segments(self) -> None:
        runs = [
            {"runId": "delta-2", "status": "success", "materializationMode": "delta"},
            {"runId": "failed", "status": "failed", "materializationMode": "delta"},
            {"runId": "delta-1", "status": "success", "materializationMode": "delta"},
        ]

        self.assertEqual(
            [run["runId"] for run in active_materialization_runs(runs)],
            ["delta-2", "delta-1"],
        )

    def test_bounded_window_requires_version_and_upper_bound(self) -> None:
        self.assertTrue(has_bounded_source_window({
            "sourceWindow": {"contractVersion": 1, "upperBound": "2026-07-12T00:10:00Z"},
        }))
        self.assertFalse(has_bounded_source_window({"sourceWindow": {"upperBound": "2026-07-12T00:10:00Z"}}))

    def test_rebaseline_incremental_run_is_a_replacing_snapshot(self) -> None:
        result = {
            "sourceCollection": {
                "scope": "folder",
                "mode": "incremental",
                "incrementalBefore": "2026-07-12T00:10:00Z",
                "incrementalSince": None,
                "rebaseline": True,
                "windowContractVersion": 1,
            },
        }

        self.assertEqual(spark_materialization_mode(SimpleNamespace(), result), "snapshot")
        self.assertEqual(
            spark_source_window_metadata(result),
            {
                "sourceWindow": {
                    "contractVersion": 1,
                    "lowerBound": None,
                    "rebaseline": True,
                    "upperBound": "2026-07-12T00:10:00Z",
                },
            },
        )

    def test_follow_up_incremental_run_is_delta(self) -> None:
        result = {
            "sourceCollection": {
                "scope": "folder",
                "mode": "incremental",
                "incrementalBefore": "2026-07-12T00:20:00Z",
                "incrementalSince": "2026-07-12T00:10:00Z",
                "rebaseline": False,
                "windowContractVersion": 1,
            },
        }

        self.assertEqual(spark_materialization_mode(SimpleNamespace(), result), "delta")


if __name__ == "__main__":
    unittest.main()
