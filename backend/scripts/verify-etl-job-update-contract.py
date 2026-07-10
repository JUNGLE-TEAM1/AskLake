import sys
from pathlib import Path
from types import SimpleNamespace

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models.etl import ETLJobModel
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.repositories import etl_repository
from app.schemas.etl import UpdatePipelineRequest
from app.services import etl_service


def request_payload() -> dict:
    return {
        "jobName": "reviews_snapshot_pipeline",
        "schemaColumns": [{
            "included": True,
            "nullable": False,
            "sourceName": "event_id",
            "targetName": "event_id",
            "type": "String",
        }],
        "schemaSampleRows": [["review-001"]],
        "schemaSummary": "1개 필드",
        "ruleSummary": "필수값 검사 1개",
        "transformOutputColumns": [["event_id", "string"]],
        "transformSteps": [],
        "qualityInvalidRows": [],
        "qualityRules": [],
        "qualityStatus": "pass",
        "scheduleLabel": "스케줄링 건너뛰기",
        "permissionSummary": "Data Engineer Group · 조직 내부",
        "storageType": "S3",
        "storagePath": "s3a://asklake-output/reviews_manual_snapshot/bronze/",
        "targetDataset": "reviews_manual_snapshot",
        "targetDatabase": "asklake",
        "targetLayer": "BRONZE",
        "targetFormat": "jsonl",
        "owner": "data-team-01",
    }


def main() -> None:
    request = UpdatePipelineRequest.model_validate(request_payload())
    etl_service.validate_update_request(request)

    try:
        UpdatePipelineRequest.model_validate({**request_payload(), "sourceConfig": [["Broker / Endpoint", "other:9092"]]})
    except ValidationError:
        pass
    else:
        raise AssertionError("UpdatePipelineRequest must reject sourceConfig")

    job = ETLJobModel(
        id="JOB-EDIT-UPDATE",
        name="old_name",
        owner="old-owner",
        status="scheduled",
        tag="[생성]",
        source="Stream / Kafka / reviews.manual.snapshot",
        target="reviews_manual_snapshot",
        schedule="스케줄링 건너뛰기",
        source_config=[["Broker / Endpoint", "redpanda:9092"]],
        source_label="Kafka reviews.manual.snapshot",
        source_type="Stream / Kafka",
        schema_columns=[],
        schema_sample_rows=[],
        target_format="jsonl",
        target_layer="BRONZE",
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

    etl_service.apply_update_request(job, request, False)
    assert job.source_config == [["Broker / Endpoint", "redpanda:9092"]]
    assert job.source_label == "Kafka reviews.manual.snapshot"
    assert job.source_type == "Stream / Kafka"
    assert job.permission_summary == "Data Engineer Group · 조직 내부"
    assert job.target_database == "asklake"
    assert job.last_state == "설정 수정됨"
    assert not etl_service.target_identity_changed(job, request)

    changed_target = UpdatePipelineRequest.model_validate({**request_payload(), "targetDataset": "reviews_snapshot_v2"})
    assert etl_service.target_identity_changed(job, changed_target)

    original_get_job = etl_repository.get_job
    original_list_runs_for_job = etl_repository.list_runs_for_job
    original_permission_grants = etl_service.permission_grants_for_resource
    etl_repository.get_job = lambda _db, _job_id: job
    etl_service.permission_grants_for_resource = lambda *_args, **_kwargs: []
    try:
        etl_repository.list_runs_for_job = lambda _db, _job_id: [SimpleNamespace(status="success")]
        try:
            etl_service.update_pipeline(None, job.id, changed_target, ActorContext(name="admin", role="admin"))
        except ApiError as error:
            assert error.status_code == 422
        else:
            raise AssertionError("Successful jobs must reject target identity changes")

        etl_repository.list_runs_for_job = lambda _db, _job_id: []
        job.status = "running"
        try:
            etl_service.update_pipeline(None, job.id, request, ActorContext(name="admin", role="admin"))
        except ApiError as error:
            assert error.status_code == 409
        else:
            raise AssertionError("Running jobs must reject updates")
    finally:
        etl_repository.get_job = original_get_job
        etl_repository.list_runs_for_job = original_list_runs_for_job
        etl_service.permission_grants_for_resource = original_permission_grants

    print("verify-etl-job-update-contract: ok")


if __name__ == "__main__":
    main()
