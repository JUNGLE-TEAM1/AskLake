import unittest
from types import SimpleNamespace

from app.core.materialization import (
    SOURCE_WINDOW_CONTRACT_VERSION,
    active_materialization_runs,
    has_bounded_source_window,
    materialization_source_object_inventory,
    materialization_mode,
    source_window_contract_version,
)
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

    def test_legacy_kafka_run_remains_delta_until_explicit_snapshot(self) -> None:
        legacy_runs = [
            {"runId": "kafka-new", "status": "success", "sourceKind": "kafka"},
            {"runId": "etl-base", "status": "success"},
        ]

        self.assertEqual(materialization_mode(legacy_runs[0]), "delta")
        self.assertEqual(
            [run["runId"] for run in active_materialization_runs(legacy_runs)],
            ["kafka-new", "etl-base"],
        )
        self.assertEqual(materialization_mode({
            "materializationMode": "snapshot",
            "sourceKind": "kafka",
        }), "snapshot")

    def test_invalid_explicit_mode_is_snapshot_even_for_kafka(self) -> None:
        self.assertEqual(materialization_mode({
            "materializationMode": "unexpected",
            "sourceKind": "kafka",
        }), "snapshot")
        self.assertEqual(
            spark_materialization_mode(SimpleNamespace(), {
                "materializationMode": "unexpected",
                "sourceKind": "kafka",
            }),
            "snapshot",
        )

    def test_materialization_mode_uses_first_nonblank_compatible_alias(self) -> None:
        self.assertEqual(materialization_mode({
            "materializationMode": " ",
            "materialization_mode": "delta",
            "sourceKind": "etl",
        }), "delta")
        self.assertEqual(materialization_mode({
            "materializationMode": " ",
            "spark_materialization_mode": "snapshot",
            "sourceKind": "kafka",
        }), "snapshot")

    def test_bounded_window_requires_version_and_upper_bound(self) -> None:
        self.assertTrue(has_bounded_source_window({
            "sourceWindow": {"contractVersion": 1, "upperBound": "2026-07-12T00:10:00Z"},
        }))
        self.assertFalse(has_bounded_source_window({
            "sourceWindow": {"upperBound": "2026-07-12T00:10:00Z"},
        }))
        self.assertTrue(has_bounded_source_window({
            "sourceWindow": {"contractVersion": 2, "upperBound": "2026-07-12T00:10:00Z"},
        }))
        self.assertFalse(has_bounded_source_window({
            "sourceWindow": {"contractVersion": 3, "upperBound": "2026-07-12T00:10:00Z"},
        }))

    def test_rebaseline_incremental_run_is_replacing_snapshot(self) -> None:
        result = {
            "sourceCollection": {
                "scope": "folder",
                "mode": "incremental",
                "incrementalBefore": "2026-07-12T00:10:00Z",
                "incrementalSince": None,
                "objectKeys": ["reviews/a.jsonl"],
                "objectInventory": [{
                    "key": "reviews/a.jsonl",
                    "eTag": "etag-a",
                    "versionId": "version-a",
                    "lastModified": "2026-07-12T00:05:00.000Z",
                    "size": 12,
                }],
                "rebaseline": True,
                "windowContractVersion": SOURCE_WINDOW_CONTRACT_VERSION,
            },
        }

        self.assertEqual(spark_materialization_mode(SimpleNamespace(), result), "snapshot")
        self.assertEqual(
            spark_source_window_metadata(result),
            {
                "sourceWindow": {
                    "contractVersion": SOURCE_WINDOW_CONTRACT_VERSION,
                    "lowerBound": None,
                    "objectKeys": ["reviews/a.jsonl"],
                    "objectInventory": [{
                        "key": "reviews/a.jsonl",
                        "eTag": "etag-a",
                        "versionId": "version-a",
                        "lastModified": "2026-07-12T00:05:00.000Z",
                        "size": 12,
                    }],
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
                "objectInventory": [{
                    "key": "reviews/b.jsonl",
                    "eTag": "etag-b",
                    "versionId": None,
                    "lastModified": "2026-07-12T00:15:00.000Z",
                    "size": 9,
                }],
                "rebaseline": False,
                "windowContractVersion": SOURCE_WINDOW_CONTRACT_VERSION,
            },
        }

        self.assertEqual(spark_materialization_mode(SimpleNamespace(), result), "delta")

    def test_v2_materialization_window_exposes_identity_metadata_to_sibling_contracts(self) -> None:
        run = {
            "sourceWindow": {
                "contractVersion": SOURCE_WINDOW_CONTRACT_VERSION,
                "objectInventory": [{
                    "key": "reviews/a.jsonl",
                    "eTag": "etag-a",
                    "versionId": None,
                    "lastModified": "2026-07-12T00:05:00.000Z",
                    "size": 12,
                }],
                "objectKeys": ["reviews/a.jsonl"],
                "upperBound": "2026-07-12T00:10:00Z",
            },
        }

        self.assertEqual(source_window_contract_version(run), SOURCE_WINDOW_CONTRACT_VERSION)
        self.assertEqual(
            materialization_source_object_inventory(run),
            run["sourceWindow"]["objectInventory"],
        )
        self.assertEqual(materialization_source_object_inventory({
            "sourceWindow": {"contractVersion": 2, "objectInventory": [], "upperBound": "2026-07-12T00:10:00Z"},
        }), [])

    def test_materialization_inventory_rejects_partially_malformed_metadata(self) -> None:
        run = {
            "sourceWindow": {
                "contractVersion": SOURCE_WINDOW_CONTRACT_VERSION,
                "objectInventory": [{"key": "reviews/a.jsonl"}, "not-an-object"],
                "upperBound": "2026-07-12T00:10:00Z",
            },
        }

        self.assertIsNone(materialization_source_object_inventory(run))

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
                "objectInventory": [{
                    "key": "reviews/b.jsonl",
                    "eTag": "etag-b",
                    "versionId": None,
                    "lastModified": "2026-07-12T00:15:00.000Z",
                    "size": 9,
                }],
                "rebaseline": False,
                "windowContractVersion": SOURCE_WINDOW_CONTRACT_VERSION,
            },
        }

        manifest = spark_result_manifest(result, "run-2")

        self.assertEqual(manifest["sourceCollection"], result["sourceCollection"])
        self.assertEqual(spark_materialization_mode(SimpleNamespace(), manifest), "delta")
        self.assertEqual(spark_source_window_metadata(manifest)["sourceWindow"]["objectKeys"], ["reviews/b.jsonl"])
        self.assertEqual(
            spark_source_window_metadata(manifest)["sourceWindow"]["objectInventory"],
            result["sourceCollection"]["objectInventory"],
        )


if __name__ == "__main__":
    unittest.main()
