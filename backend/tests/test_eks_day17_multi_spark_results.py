import json
import unittest

from scripts.verify_eks_day17_multi_spark_results import (
    ALIASES,
    build_sanitized_report,
    receipt_identities,
    sanitized_failure,
)


PRIVATE_VALUES = {
    "consumerGroup": ["private-group-a", "private-group-b", "private-group-c"],
    "icebergTable": ["private-table-a", "private-table-b", "private-table-c"],
    "outputPath": ["private-output-a", "private-output-b", "private-output-c"],
    "checkpointPath": [
        "private-checkpoint-a",
        "private-checkpoint-b",
        "private-checkpoint-c",
    ],
    "snapshotId": ["private-snapshot-a", "private-snapshot-b", "private-snapshot-c"],
    "datasetId": ["private-dataset-a", "private-dataset-b", "private-dataset-c"],
    "airflowRunId": ["private-airflow-a", "private-airflow-b", "private-airflow-c"],
}


def passing_records():
    return [
        {
            "alias": alias,
            "generation": 2,
            "checks": {
                "statusesSuccess": True,
                "sourceBoundaryConsistent": True,
                "mskSparkCountsExact": True,
                "identityChainConsistent": True,
                "queryEngineVerified": True,
                "trinoExactSnapshotRows": True,
                "physicalDataPresent": True,
                "materializationExactlyOnce": True,
            },
            "counts": {
                "expectedRows": 100,
                "sparkInputRows": 100,
                "sparkOutputRows": 100,
                "trinoVerifiedRows": 100,
                "dataFiles": 1,
                "storageSizeBytes": 1024,
                "materializations": 1,
            },
            "private": {
                key: values[index]
                for key, values in PRIVATE_VALUES.items()
            },
        }
        for index, alias in enumerate(ALIASES)
    ]


def passing_receipt():
    return {
        "status": "submitted",
        "privateIdentity": [
            {
                "alias": alias,
                "jobId": f"private-job-{index}",
                "runId": f"private-run-{index}",
                "datasetId": f"private-dataset-{index}",
                "consumerGroup": f"private-group-{index}",
                "icebergTable": f"private-table-{index}",
                "outputPath": f"private-output-{index}",
                "checkpointPath": f"private-checkpoint-{index}",
                "fixtureBatchId": "private-batch",
                "expectedCount": 100,
            }
            for index, alias in enumerate(ALIASES, start=1)
        ],
    }


class Day17MultiSparkResultTests(unittest.TestCase):
    def test_three_complete_isolated_runs_pass(self):
        report = build_sanitized_report(passing_records())

        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["counts"]["runs"], 3)
        self.assertEqual(report["counts"]["expectedRows"], 300)
        self.assertEqual(report["counts"]["trinoVerifiedRows"], 300)
        self.assertEqual(report["counts"]["dataFiles"], 3)
        self.assertEqual(report["counts"]["materializations"], 3)
        self.assertTrue(all(report["checks"].values()))

    def test_duplicate_snapshot_or_dataset_fails_isolation(self):
        records = passing_records()
        records[2]["private"]["snapshotId"] = records[0]["private"]["snapshotId"]
        records[1]["private"]["datasetId"] = records[0]["private"]["datasetId"]

        report = build_sanitized_report(records)

        self.assertEqual(report["status"], "failed")
        self.assertFalse(report["checks"]["snapshotsUnique"])
        self.assertFalse(report["checks"]["datasetsUnique"])

    def test_count_or_materialization_mismatch_fails(self):
        records = passing_records()
        records[0]["checks"]["mskSparkCountsExact"] = False
        records[0]["counts"]["sparkOutputRows"] = 99
        records[1]["checks"]["materializationExactlyOnce"] = False
        records[1]["counts"]["materializations"] = 2

        report = build_sanitized_report(records)

        self.assertEqual(report["status"], "failed")
        self.assertFalse(report["checks"]["allMskSparkCountsExact"])
        self.assertFalse(report["checks"]["allMaterializationsExactlyOnce"])

    def test_report_and_failure_are_sanitized(self):
        report = build_sanitized_report(passing_records())
        serialized = json.dumps(report, sort_keys=True)

        for values in PRIVATE_VALUES.values():
            for value in values:
                self.assertNotIn(value, serialized)
        self.assertNotIn("private", serialized)
        self.assertEqual(
            sanitized_failure(RuntimeError("private-run-a")),
            {
                "contractVersion": "1.0",
                "mode": "read-only",
                "status": "blocked",
                "errorType": "RuntimeError",
            },
        )

    def test_receipt_requires_exact_aliases_and_count(self):
        identities = receipt_identities(passing_receipt())
        self.assertEqual([item["alias"] for item in identities], list(ALIASES))

        invalid = passing_receipt()
        invalid["privateIdentity"][1]["expectedCount"] = 99
        with self.assertRaises(RuntimeError):
            receipt_identities(invalid)


if __name__ == "__main__":
    unittest.main()
