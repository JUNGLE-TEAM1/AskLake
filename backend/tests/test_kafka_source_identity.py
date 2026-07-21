import unittest
from unittest.mock import patch

from app.domain.kafka_source_identity import (
    KafkaSourceBoundaryError,
    managed_consumer_group,
    managed_kafka_source_config,
    validate_managed_kafka_source,
)
from app.schemas.etl import CreatePipelineRequest
from app.services import etl_service


IAM_ENV = {
    "ASKLAKE_KAFKA_AUTH_MODE": "iam",
    "ASKLAKE_KAFKA_BROKER": "boot.example.amazonaws.com:9098",
    "ASKLAKE_KAFKA_ALLOWED_TOPIC_PREFIXES": "asklake.",
}


class KafkaSourceIdentityTests(unittest.TestCase):
    def test_etl_facade_preserves_s3_source_config(self) -> None:
        source_config = [["Bucket", "raw"], ["Prefix", "events/"]]
        request = CreatePipelineRequest(
            id="s3-pipeline",
            job_name="s3_pipeline",
            owner="data-owner",
            schedule_label="수동",
            source_config=source_config,
            source_label="events",
            source_type="File / S3",
            target_dataset="events_raw",
            target_format="parquet",
            target_layer="RAW",
        )

        context = etl_service.pipeline_create_mapping_context(
            request,
            dataset_id="ds_events_raw",
            job_id="JOB-S3",
            created_by="data-owner",
            created_by_profile={"name": "data-owner"},
        )

        self.assertEqual(context.source_config, source_config)

    def test_etl_facade_applies_managed_kafka_source_identity(self) -> None:
        request = CreatePipelineRequest(
            id="events-pipeline",
            job_name="events_pipeline",
            owner="data-owner",
            schedule_label="실시간",
            source_config=[
                ["Broker / Endpoint", "boot.example.amazonaws.com:9098"],
                ["TOPIC / QUEUE NAME", "asklake.events"],
                ["CONSUMER GROUP ID", "client-controlled"],
            ],
            source_label="events",
            source_type="Stream / Kafka",
            target_dataset="events_raw",
            target_format="parquet",
            target_layer="RAW",
            execution_mode="continuous",
        )

        with patch.dict("os.environ", IAM_ENV, clear=False):
            context = etl_service.pipeline_create_mapping_context(
                request,
                dataset_id="ds_events_raw",
                job_id="JOB-EVENTS",
                created_by="data-owner",
                created_by_profile={"name": "data-owner"},
            )

        self.assertIn(["CONSUMER GROUP ID", "asklake-stream-job-events"], context.source_config)
        self.assertIn(["__Kafka Consumer Group Owner", "server:job-id"], context.source_config)
        self.assertNotIn(["CONSUMER GROUP ID", "client-controlled"], context.source_config)

    def test_job_id_owns_distinct_batch_and_stream_groups(self) -> None:
        self.assertEqual(managed_consumer_group("JOB-A82C7ABB", "snapshot"), "asklake-batch-job-a82c7abb")
        self.assertEqual(managed_consumer_group("JOB-A82C7ABB", "continuous"), "asklake-stream-job-a82c7abb")

    def test_iam_mode_replaces_client_group_with_server_owned_group(self) -> None:
        actual = managed_kafka_source_config(
            "Stream / Kafka",
            [
                ["Broker / Endpoint", "boot.example.amazonaws.com:9098"],
                ["TOPIC / QUEUE NAME", "asklake.events"],
                ["CONSUMER GROUP ID", "client-controlled"],
            ],
            execution_mode="continuous",
            job_id="JOB-1234",
            environment=IAM_ENV,
        )
        self.assertIn(["CONSUMER GROUP ID", "asklake-stream-job-1234"], actual)
        self.assertIn(["__Kafka Consumer Group Owner", "server:job-id"], actual)
        self.assertNotIn(["CONSUMER GROUP ID", "client-controlled"], actual)

    def test_iam_mode_rejects_broker_and_topic_outside_deployment_boundary(self) -> None:
        with self.assertRaisesRegex(KafkaSourceBoundaryError, "broker must match"):
            validate_managed_kafka_source(
                "Stream / Kafka",
                [["Broker / Endpoint", "other:9098"], ["TOPIC / QUEUE NAME", "asklake.events"]],
                environment=IAM_ENV,
            )
        with self.assertRaisesRegex(KafkaSourceBoundaryError, "outside the topic namespace"):
            validate_managed_kafka_source(
                "Stream / Kafka",
                [["Broker / Endpoint", "boot.example.amazonaws.com:9098"], ["TOPIC / QUEUE NAME", "foreign.events"]],
                environment=IAM_ENV,
            )

    def test_plaintext_mode_preserves_local_consumer_group(self) -> None:
        source = [["CONSUMER GROUP ID", "local-group"]]
        self.assertEqual(
            managed_kafka_source_config(
                "Stream / Kafka",
                source,
                execution_mode="snapshot",
                job_id="JOB-LOCAL",
                environment={"ASKLAKE_KAFKA_AUTH_MODE": "none"},
            ),
            source,
        )


if __name__ == "__main__":
    unittest.main()
