import json
import os
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.etl import ETLJobModel
from app.repositories import etl_repository
from app.schemas.etl import CreatePipelineRequest, SchemaColumnDraft
from app.services import etl_service


def continuous_request() -> CreatePipelineRequest:
    return CreatePipelineRequest(
        id="continuous-contract",
        job_name="reviews_continuous",
        source_type="Stream / Kafka",
        source_label="Kafka reviews.continuous",
        source_config=[
            ("Broker / Endpoint", "redpanda:9092"),
            ("TOPIC / QUEUE NAME", "reviews.continuous"),
            ("Consumer Group ID", "asklake-continuous-contract"),
        ],
        schema_columns=[SchemaColumnDraft(source_name="event_id", target_name="event_id", type="String")],
        schedule_label="수동",
        target_dataset="reviews_continuous",
        target_layer="BRONZE",
        target_format="parquet",
        storage_path="s3a://asklake-output/reviews_continuous/bronze",
        owner="data-team-01",
        execution_mode="continuous",
    )


def continuous_job() -> ETLJobModel:
    request = continuous_request()
    return ETLJobModel(
        id="JOB-CONTINUOUS-CONTRACT",
        name=request.job_name,
        owner=request.owner,
        status="scheduled",
        tag="[생성]",
        source="Stream / Kafka / Kafka reviews.continuous",
        target=request.target_dataset,
        schedule=request.schedule_label,
        source_config=[list(item) for item in request.source_config],
        source_label=request.source_label,
        source_type=request.source_type,
        execution_mode="continuous",
        continuous_config=etl_service.continuous_config_from_request(request, "JOB-CONTINUOUS-CONTRACT"),
        schema_columns=[],
        schema_sample_rows=[],
        target_format=request.target_format,
        target_layer=request.target_layer,
        storage_path=request.storage_path,
        target_path=request.storage_path,
        transform_output_columns=[],
        transform_steps=[],
        quality_invalid_rows=[],
        quality_rules=[],
        last_run="생성 후 미실행",
        last_state="준비됨",
        next_run="-",
        stats={},
        dag_steps=[],
    )


def main() -> None:
    request = continuous_request()
    config = etl_service.continuous_config_from_request(request, "JOB-CONTINUOUS-CONTRACT")
    assert config == {
        "initialOffsetPolicy": "earliest",
        "triggerIntervalSeconds": 30,
        "maxOffsetsPerTrigger": 10000,
        "checkpointPath": "s3a://asklake-output/reviews_continuous/bronze/_checkpoints/JOB-CONTINUOUS-CONTRACT",
    }

    job = continuous_job()
    runtime = etl_service.continuous_runtime_from_job(job)
    assert runtime.topic == "reviews.continuous"
    assert runtime.consumer_group_id == "asklake-continuous-contract"
    assert runtime.status == "stopped"

    original_get = etl_repository.get_kafka_continuous_runtime
    original_find = etl_repository.find_conflicting_kafka_continuous_runtime
    original_snapshot_find = etl_repository.find_conflicting_kafka_snapshot
    original_list_runs = etl_repository.list_runs_for_job
    original_save = etl_repository.save_kafka_continuous_command
    original_permissions = etl_service.with_job_permissions
    original_worker = etl_service.run_kafka_continuous_worker
    original_status = etl_service.continuous_worker_status
    original_dataset_get = etl_repository.get_dataset_by_id
    original_dataset_save = etl_repository.save_dataset
    try:
        etl_repository.get_kafka_continuous_runtime = lambda _db, _job_id: runtime
        etl_repository.find_conflicting_kafka_continuous_runtime = lambda _db, **_kwargs: None
        etl_repository.find_conflicting_kafka_snapshot = lambda _db, **_kwargs: None
        etl_repository.list_runs_for_job = lambda _db, _job_id: []
        etl_repository.save_kafka_continuous_command = lambda _db, saved_job, _runtime: etl_repository.job_to_schema(None, saved_job)
        etl_service.with_job_permissions = lambda _db, job_schema, _actor: job_schema
        etl_service.run_kafka_continuous_worker = lambda _job, _runtime, action: {"action": action, "containerState": "starting"}

        response = etl_service.command_kafka_continuous_job(None, job, "startContinuous", ActorContext())
        assert response.action == "etl.continuous.start_requested"
        assert response.processing_result["controlPlaneOnly"] is False
        assert response.processing_result["runtimeStatus"] == "starting"
        assert response.processing_result["worker"] == "spark_structured_streaming"
        assert job.status == "running"
        assert runtime.status == "starting"

        try:
            etl_service.command_kafka_continuous_job(None, job, "startContinuous", ActorContext())
        except ApiError as exc:
            assert exc.status_code == 409
        else:
            raise AssertionError("Starting an active continuous Job must conflict.")

        runtime.status = "stopped"
        job.status = "stopped"
        etl_repository.find_conflicting_kafka_snapshot = lambda _db, **_kwargs: type("Snapshot", (), {"job_id": "JOB-SNAPSHOT", "snapshot_id": "snapshot-conflict"})()
        try:
            etl_service.command_kafka_continuous_job(None, job, "startContinuous", ActorContext())
        except ApiError as exc:
            assert exc.status_code == 409
            assert exc.details["activeSnapshotId"] == "snapshot-conflict"
        else:
            raise AssertionError("Starting against an active Snapshot must conflict.")

        etl_repository.find_conflicting_kafka_continuous_runtime = lambda _db, **_kwargs: runtime
        try:
            etl_service.kafka_request_with_durable_snapshot(None, {
                "broker": runtime.broker,
                "consumerGroupId": runtime.consumer_group_id,
                "timeoutMs": 1000,
                "topic": runtime.topic,
            }, "JOB-SNAPSHOT")
        except ApiError as exc:
            assert exc.status_code == 409
            assert exc.details["activeJobId"] == runtime.job_id
        else:
            raise AssertionError("Starting a Snapshot against an active Continuous worker must conflict.")
        etl_repository.find_conflicting_kafka_continuous_runtime = lambda _db, **_kwargs: None

        captured_dataset = {}
        etl_repository.get_dataset_by_id = lambda _db, _dataset_id: None
        etl_repository.save_dataset = lambda _db, dataset: captured_dataset.setdefault("dataset", dataset)
        etl_service.materialize_continuous_batch(None, job, runtime, {
            "lastBatchId": "7",
            "lastBatchStoredCount": 2,
            "lastBatchWritten": True,
        })
        assert captured_dataset["dataset"].payload["materializationRuns"][0]["sourceKind"] == "kafka_continuous"
        assert captured_dataset["dataset"].payload["storageLocation"].endswith("/_batches")

        with tempfile.TemporaryDirectory() as report_dir:
            previous_report_dir = os.environ.get("ASKLAKE_SPARK_REPORT_DIR")
            os.environ["ASKLAKE_SPARK_REPORT_DIR"] = report_dir
            report_path = etl_service.continuous_runtime_report_path(job.id)
            report_path.write_text(json.dumps({
                "status": "running",
                "heartbeatAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "consumedCount": 2,
                "storedCount": 2,
                "quarantinedCount": 0,
                "failedCount": 0,
            }), encoding="utf-8")
            runtime.status = "pausing"
            runtime.failed_count = 0
            etl_service.continuous_worker_status = lambda _job, _runtime: {"containerState": "exited", "exitCode": 143}
            etl_service.refresh_kafka_continuous_runtime(None, job)
            assert runtime.status == "paused"
            assert runtime.failed_count == 0

            runtime.status = "stopping"
            etl_service.refresh_kafka_continuous_runtime(None, job)
            assert runtime.status == "stopped"

            runtime.status = "running"
            job.status = "running"
            heartbeat = (datetime.now(UTC) - timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
            report_path.write_text(json.dumps({
                "status": "running",
                "heartbeatAt": heartbeat,
                "consumedCount": 2,
                "storedCount": 2,
                "quarantinedCount": 0,
                "failedCount": 0,
            }), encoding="utf-8")
            etl_service.continuous_worker_status = lambda _job, _runtime: {"containerState": "running"}
            etl_service.refresh_kafka_continuous_runtime(None, job)
            assert runtime.status == "failed"
            assert "heartbeat expired" in runtime.last_error
            if previous_report_dir is None:
                os.environ.pop("ASKLAKE_SPARK_REPORT_DIR", None)
            else:
                os.environ["ASKLAKE_SPARK_REPORT_DIR"] = previous_report_dir
    finally:
        etl_repository.get_kafka_continuous_runtime = original_get
        etl_repository.find_conflicting_kafka_continuous_runtime = original_find
        etl_repository.find_conflicting_kafka_snapshot = original_snapshot_find
        etl_repository.list_runs_for_job = original_list_runs
        etl_repository.save_kafka_continuous_command = original_save
        etl_service.with_job_permissions = original_permissions
        etl_service.run_kafka_continuous_worker = original_worker
        etl_service.continuous_worker_status = original_status
        etl_repository.get_dataset_by_id = original_dataset_get
        etl_repository.save_dataset = original_dataset_save

    print("verify-kafka-continuous-contract: ok")


if __name__ == "__main__":
    main()
