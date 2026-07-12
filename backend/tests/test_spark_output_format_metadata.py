import unittest
from types import SimpleNamespace

from app.services.etl_service import (
    dag_steps_from_spark_result,
    dataset_payload_from_spark_result,
    finalize_job_from_spark_result,
)


def make_job(target_format: str = "parquet") -> SimpleNamespace:
    return SimpleNamespace(
        created_by="owner@example.com",
        created_by_profile=None,
        id="JOB-FORMAT",
        index_columns=[],
        name="format_pipeline",
        next_run="-",
        owner="owner@example.com",
        partition=None,
        partition_columns=[],
        permission_roles=[],
        quality_rules=[],
        quality_score=None,
        quality_status=None,
        rag=False,
        schedule="manual",
        schema_columns=[],
        source="File / S3 / events.jsonl",
        source_label="events.jsonl",
        source_type="File / S3",
        stats={},
        target="events_gold",
        target_description=None,
        target_format=target_format,
        target_layer="GOLD",
        target_path=None,
        target_tags=[],
        transform_steps=[],
    )


class SparkOutputFormatMetadataTests(unittest.TestCase):
    def test_spark_result_format_drives_job_and_dag_labels(self) -> None:
        job = make_job(target_format="parquet")
        result = {
            "endedAt": "2026-07-11T12:00:00Z",
            "format": "csv",
            "outputPath": "s3a://asklake-output/events/run-1/",
            "status": "success",
        }

        finalize_job_from_spark_result(job, "run", result)
        steps = dag_steps_from_spark_result(
            job,
            "run",
            {"inputRows": "3", "outputPath": result["outputPath"], "outputRows": "3"},
            result,
        )

        write_step = next(step for step in steps if step["id"] == "write")
        self.assertIn("CSV", job.last_state)
        self.assertIn("CSV", write_step["title"])
        self.assertNotIn("Parquet", write_step["title"])

    def test_catalog_and_lineage_use_manifest_format_over_job_default(self) -> None:
        job = make_job(target_format="parquet")
        result = {
            "endedAt": "2026-07-11T12:00:00Z",
            "format": "json",
            "outputPath": "s3a://asklake-output/events/run-2/",
            "outputRows": 3,
            "runId": "run-2",
            "status": "success",
            "storageSizeBytes": 100,
        }

        payload = dataset_payload_from_spark_result(
            job,
            result,
            "ds_events_gold",
            [["event_id", "string"]],
            result["endedAt"],
        )

        target_node = next(node for node in payload["lineageGraph"]["datasets"] if node["id"] == "ds_events_gold")
        self.assertEqual(payload["storageFormat"], "json")
        self.assertEqual(payload["materializationRuns"][0]["storageFormat"], "json")
        self.assertEqual(target_node["engine"], "JSON")


if __name__ == "__main__":
    unittest.main()
