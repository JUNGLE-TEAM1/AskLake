from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.application.etl_job_projection import continuous_config_from_request
from app.core.errors import ApiError
from app.schemas.etl import CreatePipelineRequest, ReviewPipelineRequest, SchemaColumnDraft
from app.services import etl_service
from app.services.kafka_ingest_v2 import require_kafka_ingest_v2_ready


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


def runtime_settings(*, v2_enabled: bool) -> SimpleNamespace:
    return SimpleNamespace(
        asklake_continuous_control_plane="local",
        clickhouse_realtime_consumer_owner=(
            "kafka_connect_v2" if v2_enabled else "disabled"
        ),
        clickhouse_realtime_v2_enabled=v2_enabled,
        kafka_connect_sink_enabled=v2_enabled,
        kafka_continuous_v2_api_enabled=False,
        kafka_continuous_v2_owner_generation=None,
        kafka_continuous_v1_api_enabled=False,
        kafka_continuous_v1_owner_generation=None,
    )


class RealtimeV1OnlyProfileTests(unittest.TestCase):
    def test_v1_api_admission_assigns_exact_eks_owner_generation(self) -> None:
        configured = runtime_settings(v2_enabled=False)
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
        self.assertEqual(claim["consumerGroup"], "asklake-stream-job-events")
        self.assertEqual(claim["stateRevision"], 1)

    def test_new_continuous_job_persists_explicit_spark_v1_engine(self) -> None:
        with patch(
            "app.application.etl_job_projection.settings",
            runtime_settings(v2_enabled=False),
        ):
            config = continuous_config_from_request(
                continuous_request(), "JOB-EVENTS"
            )

        self.assertIsNotNone(config)
        self.assertEqual(config["runtimeEngine"], "spark_structured_streaming")
        self.assertEqual(config["runtimeGeneration"], 1)
        self.assertTrue(config["checkpointPath"].endswith("/_checkpoints/JOB-EVENTS"))

    def test_v2_engine_requires_the_complete_exact_owner_flag_set(self) -> None:
        with patch(
            "app.application.etl_job_projection.settings",
            runtime_settings(v2_enabled=True),
        ):
            config = continuous_config_from_request(
                continuous_request(), "JOB-EVENTS"
            )

        self.assertEqual(config["runtimeEngine"], "kafka_connect_clickhouse_v2")

    def test_existing_v2_job_fails_closed_in_v1_only_profile(self) -> None:
        existing_v2_job = SimpleNamespace(
            id="JOB-V2",
            execution_mode="continuous",
            continuous_config={
                "runtimeEngine": "kafka_connect_clickhouse_v2",
                "runtimeGeneration": 1,
            },
        )

        with self.assertRaises(ApiError) as raised:
            require_kafka_ingest_v2_ready(
                existing_v2_job,
                runtime_settings(v2_enabled=False),
            )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(
            raised.exception.details["runtimeEngine"],
            "kafka_connect_clickhouse_v2",
        )

    def test_live_review_reports_the_v1_only_processing_engine(self) -> None:
        request = ReviewPipelineRequest(
            id="events-review",
            job_name="events_pipeline",
            owner="data-owner",
            permission_summary="owner",
            retry_policy_summary="none",
            schedule_label="스케줄링 건너뛰기",
            schema_columns=[
                SchemaColumnDraft(
                    included=True,
                    nullable=True,
                    source_name="event_id",
                    target_name="event_id",
                    type="String",
                )
            ],
            source_config=[],
            source_connection_status="success",
            source_label="events",
            source_type="SQL Result",
            target_dataset="events_raw",
            target_format="jsonl",
            target_layer="RAW",
            execution_mode="continuous",
        )

        with patch.object(
            etl_service,
            "settings",
            runtime_settings(v2_enabled=False),
        ):
            review = etl_service.review_pipeline(request)

        processing = next(
            entry.value
            for entry in review.basic_information
            if entry.label == "처리 방식"
        )
        self.assertEqual(processing, "실시간 · Spark (기존 V1)")


if __name__ == "__main__":
    unittest.main()
