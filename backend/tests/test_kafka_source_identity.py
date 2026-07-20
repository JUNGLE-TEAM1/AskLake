import unittest

from app.domain.kafka_source_identity import (
    KafkaSourceBoundaryError,
    managed_consumer_group,
    managed_kafka_source_config,
    validate_managed_kafka_source,
)


IAM_ENV = {
    "ASKLAKE_KAFKA_AUTH_MODE": "iam",
    "ASKLAKE_KAFKA_BROKER": "boot.example.amazonaws.com:9098",
    "ASKLAKE_KAFKA_ALLOWED_TOPIC_PREFIXES": "asklake.",
}


class KafkaSourceIdentityTests(unittest.TestCase):
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
