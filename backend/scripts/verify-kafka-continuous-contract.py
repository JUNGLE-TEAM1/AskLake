import sys
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
    original_list_runs = etl_repository.list_runs_for_job
    original_save = etl_repository.save_kafka_continuous_command
    original_permissions = etl_service.with_job_permissions
    original_worker = etl_service.run_kafka_continuous_worker
    try:
        etl_repository.get_kafka_continuous_runtime = lambda _db, _job_id: runtime
        etl_repository.find_conflicting_kafka_continuous_runtime = lambda _db, **_kwargs: None
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
    finally:
        etl_repository.get_kafka_continuous_runtime = original_get
        etl_repository.find_conflicting_kafka_continuous_runtime = original_find
        etl_repository.list_runs_for_job = original_list_runs
        etl_repository.save_kafka_continuous_command = original_save
        etl_service.with_job_permissions = original_permissions
        etl_service.run_kafka_continuous_worker = original_worker

    print("verify-kafka-continuous-contract: ok")


if __name__ == "__main__":
    main()
