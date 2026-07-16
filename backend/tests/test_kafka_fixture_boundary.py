import unittest

from scripts.kafka_fixture_boundary import (
    KafkaFixtureBoundaryError,
    validate_kafka_fixture_boundary,
    validate_kafka_fixture_row_count,
)


class KafkaFixtureBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.environment = {
            "ASKLAKE_KAFKA_AUTH_MODE": "iam",
            "ASKLAKE_KAFKA_BROKER": "boot.example.kafka-serverless.ap-northeast-2.amazonaws.com:9098",
            "ASKLAKE_KAFKA_CONSUMER_GROUP": "asklake-eks-mvp-spark-v1",
            "ASKLAKE_KAFKA_EXPECTED_COUNT": "100",
            "ASKLAKE_KAFKA_FIXTURE_BATCH_ID": "fixture-batch-001",
            "ASKLAKE_KAFKA_TOPIC": "asklake.eks-mvp.fixture.v1",
        }
        self.boundary = {
            "checkpointPath": "s3a://output/eks-mvp/checkpoints/run-001",
            "consumerGroup": "asklake-eks-mvp-spark-v1",
            "expectedCount": 100,
            "fixtureBatchId": "fixture-batch-001",
            "kind": "kafka_snapshot",
            "outputPath": "s3a://output/eks-mvp/output/run-001",
            "snapshotId": "run-001",
            "topic": "asklake.eks-mvp.fixture.v1",
        }

    def validate(self, *, environment=None, boundary=None):
        return validate_kafka_fixture_boundary(
            environment=self.environment if environment is None else environment,
            source_boundary=self.boundary if boundary is None else boundary,
            source_format="kafka",
            source_path="asklake.eks-mvp.fixture.v1",
        )

    def test_accepts_isolated_iam_fixture_boundary_and_exact_count(self):
        validated = self.validate()
        validate_kafka_fixture_row_count(validated, 100)
        self.assertEqual(validated["fixtureBatchId"], "fixture-batch-001")
        self.assertEqual(validated["expectedCount"], 100)

    def test_rejects_wrong_port_auth_and_static_credentials(self):
        cases = (
            {**self.environment, "ASKLAKE_KAFKA_BROKER": "broker.example:9092"},
            {**self.environment, "ASKLAKE_KAFKA_AUTH_MODE": "plain"},
            {**self.environment, "AWS_ACCESS_KEY_ID": "forbidden"},
        )
        for environment in cases:
            with self.subTest(environment=environment):
                with self.assertRaises(KafkaFixtureBoundaryError):
                    self.validate(environment=environment)

    def test_rejects_runtime_and_manifest_identity_drift(self):
        for key, value in (
            ("topic", "continuous.topic"),
            ("consumerGroup", "continuous-group"),
            ("fixtureBatchId", "another-batch"),
        ):
            with self.subTest(key=key):
                with self.assertRaises(KafkaFixtureBoundaryError):
                    self.validate(boundary={**self.boundary, key: value})

    def test_rejects_fixture_identity_outside_the_eks_mvp_boundary(self):
        cases = (
            {**self.environment, "ASKLAKE_KAFKA_TOPIC": "continuous.topic"},
            {**self.environment, "ASKLAKE_KAFKA_CONSUMER_GROUP": "continuous-group"},
            {**self.environment, "ASKLAKE_KAFKA_EXPECTED_COUNT": "99"},
        )
        for environment in cases:
            with self.subTest(environment=environment):
                with self.assertRaises(KafkaFixtureBoundaryError):
                    self.validate(environment=environment)

    def test_rejects_missing_or_overlapping_output_and_checkpoint_paths(self):
        invalid_boundaries = (
            {**self.boundary, "checkpointPath": ""},
            {
                **self.boundary,
                "checkpointPath": "s3a://output/eks-mvp/output/run-001/checkpoint",
            },
            {**self.boundary, "outputPath": "s3a://output/continuous/run-001"},
            {**self.boundary, "checkpointPath": "s3a://output/checkpoints/run-001"},
        )
        for boundary in invalid_boundaries:
            with self.subTest(boundary=boundary):
                with self.assertRaises(KafkaFixtureBoundaryError):
                    self.validate(boundary=boundary)

    def test_rejects_count_mismatch_before_publication(self):
        validated = self.validate()
        with self.assertRaisesRegex(
            KafkaFixtureBoundaryError,
            "KAFKA_FIXTURE_EXPECTED_COUNT_MISMATCH.*expected=100 actual=99",
        ):
            validate_kafka_fixture_row_count(validated, 99)

    def test_non_kafka_source_has_no_fixture_boundary(self):
        self.assertIsNone(
            validate_kafka_fixture_boundary(
                environment={},
                source_boundary={},
                source_format="parquet",
                source_path="s3a://raw/input.parquet",
            )
        )

    def test_legacy_kafka_snapshot_without_fixture_marker_is_unchanged(self):
        self.assertIsNone(
            validate_kafka_fixture_boundary(
                environment={
                    "ASKLAKE_KAFKA_AUTH_MODE": "none",
                    "ASKLAKE_KAFKA_BROKER": "redpanda:9092",
                },
                source_boundary={
                    "kind": "kafka_snapshot",
                    "snapshotId": "legacy-snapshot-001",
                    "topic": "reviews",
                },
                source_format="kafka",
                source_path="reviews",
            )
        )


if __name__ == "__main__":
    unittest.main()
