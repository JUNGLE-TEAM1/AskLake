import unittest

from app.services.catalog_service import recalculate_dataset_payload_from_runs


class CatalogMaterializationRunTests(unittest.TestCase):
    def test_recalculate_promotes_latest_remaining_storage_pointer(self) -> None:
        payload = {
            "lastUpdated": "2026-07-12T02:00:00Z",
            "materializationRuns": [
                {
                    "createdAt": "2026-07-12T01:00:00Z",
                    "rowCount": 3,
                    "runId": "run-old",
                    "status": "success",
                    "storageFormat": "csv",
                    "storageLocation": "s3a://asklake-output/run-old/",
                    "storageSizeBytes": 30,
                },
            ],
            "storageFormat": "json",
            "storageLocation": "s3a://asklake-output/deleted-run/",
        }

        result = recalculate_dataset_payload_from_runs(payload)

        self.assertEqual(result["sourceRunId"], "run-old")
        self.assertEqual(result["storageFormat"], "csv")
        self.assertEqual(result["storageLocation"], "s3a://asklake-output/run-old/")
        self.assertEqual(result["rows"], "3 rows")

    def test_recalculate_clears_storage_pointer_when_no_runs_remain(self) -> None:
        result = recalculate_dataset_payload_from_runs({
            "materializationRuns": [],
            "storageFormat": "parquet",
            "storageLocation": "s3a://asklake-output/deleted-run/",
        })

        self.assertIsNone(result["sourceRunId"])
        self.assertIsNone(result["storageFormat"])
        self.assertIsNone(result["storageLocation"])
        self.assertEqual(result["rows"], "0 rows")

    def test_recalculate_uses_latest_snapshot_and_newer_deltas_only(self) -> None:
        result = recalculate_dataset_payload_from_runs({
            "materializationRuns": [
                {
                    "createdAt": "2026-07-12T03:00:00Z",
                    "materializationMode": "delta",
                    "rowCount": 2,
                    "runId": "delta-new",
                    "status": "success",
                    "storageFormat": "parquet",
                    "storageLocation": "s3a://asklake-output/delta-new/",
                    "storageSizeBytes": 20,
                },
                {
                    "createdAt": "2026-07-12T02:00:00Z",
                    "materializationMode": "snapshot",
                    "rowCount": 10,
                    "runId": "snapshot-new",
                    "status": "success",
                    "storageFormat": "parquet",
                    "storageLocation": "s3a://asklake-output/snapshot-new/",
                    "storageSizeBytes": 100,
                },
                {
                    "createdAt": "2026-07-12T01:00:00Z",
                    "materializationMode": "snapshot",
                    "rowCount": 50,
                    "runId": "snapshot-old",
                    "status": "success",
                    "storageFormat": "parquet",
                    "storageLocation": "s3a://asklake-output/snapshot-old/",
                    "storageSizeBytes": 500,
                },
            ],
        })

        self.assertEqual(result["rows"], "12 rows")
        self.assertEqual(result["size"], "120B")
        self.assertEqual(result["sourceRunId"], "delta-new")
        self.assertEqual(result["storageLocation"], "s3a://asklake-output/delta-new/")


if __name__ == "__main__":
    unittest.main()
