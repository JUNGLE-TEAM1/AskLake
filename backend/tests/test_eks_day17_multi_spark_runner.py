import json
import unittest

from scripts.run_eks_day17_multi_spark import (
    CandidateFact,
    DEFAULT_GROUP,
    DEFAULT_TABLE,
    REQUIRED_SCALE_SLOTS,
    candidate_job_values,
    evaluate_preflight,
    replace_source_field,
)


def passing_facts(batch_id: str = "private-fixture-batch") -> list[CandidateFact]:
    return [
        CandidateFact(
            alias=alias,
            batch_id=batch_id,
            consumer_group=group,
            dataset_id=f"private-dataset-{index}",
            execution_mode="snapshot",
            expected_count=100,
            job_id=f"private-job-{index}",
            target_table=table,
            topic="asklake.eks-mvp.fixture.v1",
        )
        for index, (alias, group, table) in enumerate(REQUIRED_SCALE_SLOTS, start=1)
    ]


def passing_slots() -> list[tuple[str, str]]:
    return [
        (DEFAULT_GROUP, DEFAULT_TABLE),
        *((group, table) for _, group, table in REQUIRED_SCALE_SLOTS),
    ]


class Day17MultiSparkRunnerTests(unittest.TestCase):
    def evaluate(self, **overrides):
        values = {
            "active_run_counts": {
                group: 0 for _, group, _ in REQUIRED_SCALE_SLOTS
            },
            "airflow_configured": True,
            "backend_multi_slot_available": True,
            "configured_slots": passing_slots(),
            "continuous_runtime_count": 0,
            "continuous_session_count": 0,
            "facts": passing_facts(),
            "spark_application_list_readable": True,
        }
        values.update(overrides)
        return evaluate_preflight(**values)

    def test_exact_three_isolated_candidates_pass(self):
        result = self.evaluate()

        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["counts"]["scaleSlots"], 3)
        self.assertEqual(result["counts"]["candidateJobs"], 3)
        self.assertEqual(result["isolation"]["consumerGroups"], 3)
        self.assertEqual(result["isolation"]["icebergTables"], 3)
        self.assertEqual(result["isolation"]["datasets"], 3)
        self.assertEqual(result["blockers"], [])

    def test_missing_runtime_and_candidates_fail_closed(self):
        result = self.evaluate(
            backend_multi_slot_available=False,
            configured_slots=[],
            facts=[],
            spark_application_list_readable=False,
        )

        self.assertEqual(result["status"], "blocked")
        self.assertIn("Backend multi-slot runtime unavailable", result["blockers"])
        self.assertIn("scale slots not configured", result["blockers"])
        self.assertIn("candidate jobs missing", result["blockers"])
        self.assertIn("SparkApplication RBAC unavailable", result["blockers"])

    def test_batch_or_target_drift_blocks_submission(self):
        facts = passing_facts()
        facts[1] = CandidateFact(
            **{
                **facts[1].__dict__,
                "batch_id": "different-private-batch",
                "target_table": "wrong_private_table",
            }
        )

        result = self.evaluate(facts=facts)

        self.assertEqual(result["status"], "blocked")
        self.assertFalse(result["checks"]["fixtureBatchShared"])
        self.assertFalse(result["checks"]["icebergTablesUnique"])
        self.assertIn("candidate fixture boundary invalid", result["blockers"])

    def test_active_slot_blocks_submission(self):
        active = {group: 0 for _, group, _ in REQUIRED_SCALE_SLOTS}
        active[REQUIRED_SCALE_SLOTS[0][1]] = 1

        result = self.evaluate(active_run_counts=active)

        self.assertEqual(result["status"], "blocked")
        self.assertFalse(result["checks"]["fixtureSlotsIdle"])
        self.assertIn("fixture scale slot active", result["blockers"])

    def test_sanitized_preflight_contains_no_private_identifiers(self):
        result = self.evaluate()
        serialized = json.dumps(result, sort_keys=True)

        for fact in passing_facts():
            self.assertNotIn(fact.job_id, serialized)
            self.assertNotIn(fact.dataset_id, serialized)
            self.assertNotIn(fact.batch_id, serialized)
            self.assertNotIn(fact.consumer_group, serialized)
            self.assertNotIn(fact.target_table, serialized)

    def test_candidate_clone_uses_unique_identity_and_exact_slot(self):
        class Column:
            def __init__(self, key):
                self.key = key

        class Table:
            columns = [
                Column("id"),
                Column("name"),
                Column("source_config"),
                Column("iceberg_target"),
                Column("dataset_id"),
                Column("target"),
                Column("storage_path"),
                Column("target_path"),
                Column("created_at"),
                Column("updated_at"),
            ]

        class Template:
            __table__ = Table()
            id = "template-job"
            name = "template"
            source_config = [
                ["TOPIC / QUEUE NAME", "asklake.eks-mvp.fixture.v1"],
                ["CONSUMER GROUP ID", DEFAULT_GROUP],
            ]
            iceberg_target = {
                "catalog": "iceberg",
                "namespace": "asklake",
                "table": DEFAULT_TABLE,
                "tableUri": "iceberg://iceberg/asklake/eks_mvp_fixture",
                "writeMode": "replace",
                "partitionColumns": [],
            }
            dataset_id = "template-dataset"
            target = "template-target"
            storage_path = "template-storage"
            target_path = "template-target-path"

        _, group, table = REQUIRED_SCALE_SLOTS[0]
        values = candidate_job_values(
            Template(),
            index=1,
            consumer_group=group,
            iceberg_table=table,
            nonce="abc123",
        )

        self.assertNotEqual(values["id"], "template-job")
        self.assertNotEqual(values["dataset_id"], "template-dataset")
        self.assertEqual(
            values["source_config"][1],
            ["CONSUMER GROUP ID", group],
        )
        self.assertEqual(values["iceberg_target"]["table"], table)
        self.assertTrue(values["iceberg_target"]["tableUri"].endswith(table))

    def test_replace_source_field_fails_closed_when_group_is_missing(self):
        with self.assertRaises(RuntimeError):
            replace_source_field(
                [["TOPIC / QUEUE NAME", "asklake.eks-mvp.fixture.v1"]],
                {"CONSUMER GROUP ID", "Consumer Group ID"},
                REQUIRED_SCALE_SLOTS[0][1],
            )


if __name__ == "__main__":
    unittest.main()
