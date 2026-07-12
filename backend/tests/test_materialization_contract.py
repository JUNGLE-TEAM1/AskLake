import unittest
from types import SimpleNamespace

from app.core.materialization import active_materialization_runs, has_bounded_source_window
from app.services.etl_service import spark_materialization_mode, spark_result_manifest, spark_source_window_metadata


class MaterializationContractTests(unittest.TestCase):
    def test_new_snapshot_replaces_older_snapshot_and_deltas(self) -> None:
        runs = [
            {"runId": "delta-2", "status": "success", "materializationMode": "delta"},
            {"runId": "snapshot-2", "status": "success", "materializationMode": "snapshot"},
            {"runId": "delta-1", "status": "success", "materializationMode": "delta"},
            {"runId": "snapshot-1", "status": "success", "materializationMode": "snapshot"},
        ]

        self.assertEqual([run["runId"] for run in active_materialization_runs(runs)], ["delta-2", "snapshot-2"])

    def test_bounded_window_requires_version_and_upper_bound(self) -> None:
        self.assertTrue(has_bounded_source_window({
            "sourceWindow": {"contractVersion": 1, "upperBound": "2026-07-12T00:10:00Z"},
        }))
        self.assertFalse(has_bounded_source_window({
            "sourceWindow": {"upperBound": "2026-07-12T00:10:00Z"},
        }))

    def test_rebaseline_incremental_run_is_replacing_snapshot(self) -> None:
        result = {
            "sourceCollection": {
                "scope": "folder",
                "mode": "incremental",
                "incrementalBefore": "2026-07-12T00:10:00Z",
                "incrementalSince": None,
                "objectKeys": ["reviews/a.jsonl"],
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
                    "objectKeys": ["reviews/a.jsonl"],
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
                "objectKeys": ["reviews/b.jsonl"],
                "rebaseline": False,
                "windowContractVersion": 1,
            },
        }

        self.assertEqual(spark_materialization_mode(SimpleNamespace(), result), "delta")

    def test_airflow_manifest_preserves_incremental_source_contract(self) -> None:
        result = {
            "runId": "run-2",
            "status": "success",
            "outputPath": "/tmp/output/run-2",
            "sourceCollection": {
                "scope": "folder",
                "mode": "incremental",
                "incrementalBefore": "2026-07-12T00:20:00Z",
                "incrementalSince": "2026-07-12T00:10:00Z",
                "objectKeys": ["reviews/b.jsonl"],
                "rebaseline": False,
                "windowContractVersion": 1,
            },
        }

        manifest = spark_result_manifest(result, "run-2")

        self.assertEqual(manifest["sourceCollection"], result["sourceCollection"])
        self.assertEqual(spark_materialization_mode(SimpleNamespace(), manifest), "delta")
        self.assertEqual(spark_source_window_metadata(manifest)["sourceWindow"]["objectKeys"], ["reviews/b.jsonl"])


if __name__ == "__main__":
    unittest.main()
