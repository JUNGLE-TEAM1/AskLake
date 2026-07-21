from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.application.etl_job_projection import continuous_config_from_request
from app.domain.realtime_job_engine import selected_realtime_job_engine
from app.schemas.etl import CreatePipelineRequest, ReviewPipelineRequest, SchemaColumnDraft
from app.services import etl_service


def continuous_request() -> CreatePipelineRequest:
    return CreatePipelineRequest(
        id="events-pipeline",
        job_name="events_pipeline",
        owner="data-owner",
        schedule_label="실시간",
        source_config=[],
        source_label="events",
        source_type="Stream / Kafka",
        target_dataset="events_raw",
        target_format="jsonl",
        target_layer="RAW",
        execution_mode="continuous",
    )


def runtime_settings() -> SimpleNamespace:
    return SimpleNamespace(
        asklake_continuous_control_plane="local",
        kafka_continuous_v1_api_enabled=False,
        kafka_continuous_v1_owner_generation=None,
    )


class RealtimeV1OnlyProfileTests(unittest.TestCase):
    def test_engine_selection_defaults_to_spark_v1(self) -> None:
        self.assertEqual(selected_realtime_job_engine(object()), "spark_structured_streaming")

    def test_explicit_ec2_v2_profile_selects_clickhouse_without_changing_eks_default(self) -> None:
        configured = SimpleNamespace(
            clickhouse_realtime_v2_enabled=True,
            kafka_connect_sink_enabled=True,
            clickhouse_realtime_consumer_owner="kafka_connect_v2",
        )

        self.assertEqual(
            selected_realtime_job_engine(configured),
            "kafka_connect_clickhouse_v2",
        )

    def test_v1_api_admission_assigns_exact_eks_owner_generation(self) -> None:
        configured = runtime_settings()
        configured.kafka_continuous_v1_api_enabled = True
        configured.kafka_continuous_v1_owner_generation = "v1-only-contract-g1"
        job = SimpleNamespace(
            id="JOB-EVENTS",
            source_config=[
                ["Broker / Endpoint", "broker.example:9098"],
                ["TOPIC / QUEUE NAME", "asklake.events"],
                ["Consumer Group ID", "asklake-stream-job-events"],
            ],
            continuous_config={
                "runtimeEngine": "spark_structured_streaming",
                "checkpointPath": "s3a://lake/events/_checkpoints/JOB-EVENTS",
            },
            storage_path="s3a://lake/events",
            target_path=None,
            target="events",
        )
        with patch("app.application.etl_job_projection.settings", configured):
            runtime = etl_service.continuous_runtime_from_job(job)
        claim = runtime.metrics["ownerClaim"]
        self.assertEqual(claim["owner"], "eks-continuous-worker-v1")
        self.assertEqual(claim["generation"], "v1-only-contract-g1")
        self.assertEqual(claim["topic"], "asklake.events")

    def test_new_continuous_job_persists_explicit_spark_v1_engine(self) -> None:
        with patch("app.application.etl_job_projection.settings", runtime_settings()):
            config = continuous_config_from_request(continuous_request(), "JOB-EVENTS")
        self.assertIsNotNone(config)
        self.assertEqual(config["runtimeEngine"], "spark_structured_streaming")
        self.assertEqual(config["runtimeGeneration"], 1)

    def test_live_review_reports_spark(self) -> None:
        request = ReviewPipelineRequest(
            id="events-review",
            job_name="events_pipeline",
            owner="data-owner",
            permission_summary="owner",
            retry_policy_summary="none",
            schedule_label="스케줄링 건너뛰기",
            schema_columns=[SchemaColumnDraft(
                included=True,
                nullable=True,
                source_name="event_id",
                target_name="event_id",
                type="String",
            )],
            source_config=[],
            source_connection_status="success",
            source_label="events",
            source_type="SQL Result",
            target_dataset="events_raw",
            target_format="jsonl",
            target_layer="RAW",
            execution_mode="continuous",
        )
        review = etl_service.review_pipeline(request)
        processing = next(entry.value for entry in review.basic_information if entry.label == "처리 방식")
        self.assertEqual(processing, "실시간 · Spark")


if __name__ == "__main__":
    unittest.main()
