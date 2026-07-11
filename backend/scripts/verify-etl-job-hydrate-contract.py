import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models.etl import ETLJobModel
from app.repositories import etl_repository


def main() -> None:
    job = ETLJobModel(
            id="JOB-EDIT-HYDRATE",
            name="reviews_snapshot_pipeline",
            owner="data-team-01",
            status="scheduled",
            tag="[생성]",
            source="Stream / Kafka / reviews.manual.snapshot",
            target="reviews_manual_snapshot",
            schedule="스케줄링 건너뛰기",
            source_config=[
                ["BROKER / ENDPOINT", "redpanda:9092"],
                ["TOPIC / QUEUE NAME", "reviews.manual.snapshot"],
                ["CONSUMER GROUP ID", "asklake-manual-snapshot-01"],
            ],
            source_label="Kafka reviews.manual.snapshot",
            source_type="Stream / Kafka",
            schema_columns=[{
                "included": True,
                "nullable": False,
                "sourceName": "event_id",
                "targetName": "event_id",
                "type": "String",
            }],
            schema_fingerprint="event_id:String:required",
            schema_sample_rows=[["review-001"]],
            schema_summary="Kafka snapshot 기준 1개 필드 추론",
            rule_summary="필수값 검사 1개",
            permission_summary="Data Engineer Group · 조직 내부 · 승인 검토",
            permission_roles=[{"access": ["조회"], "checked": True, "name": "Data Engineer Group"}],
            storage_type="S3",
            partition="created_at",
            partition_columns=["created_at"],
            index_columns=["event_id"],
            compression="Snappy",
            storage_path="s3a://asklake-output/reviews_manual_snapshot/bronze/",
            target_path="s3a://asklake-output/reviews_manual_snapshot/bronze/",
            target_database="asklake",
            target_description="Kafka snapshot direct target 데이터셋",
            target_tags=["#review", "#bronze"],
            target_format="jsonl",
            target_layer="BRONZE",
            rag=False,
            transform_output_columns=[["event_id", "string"]],
            transform_steps=[],
            quality_invalid_rows=[],
            quality_rules=[],
            quality_status="pass",
            last_run="생성 후 미실행",
            last_state="준비됨",
            next_run="-",
            stats={},
            dag_steps=[],
    )

    original_list_runs_for_job = etl_repository.list_runs_for_job
    etl_repository.list_runs_for_job = lambda _db, _job_id: []
    try:
        response = etl_repository.job_to_schema(None, job).model_dump(by_alias=True)
    finally:
        etl_repository.list_runs_for_job = original_list_runs_for_job

    assert response["sourceConfig"][0][1] == "redpanda:9092"
    assert response["schemaColumns"][0]["targetName"] == "event_id"
    assert response["schemaFingerprint"] == "event_id:String:required"
    assert response["schemaSampleRows"] == [["review-001"]]
    assert response["schemaSummary"] == "Kafka snapshot 기준 1개 필드 추론"
    assert response["ruleSummary"] == "필수값 검사 1개"
    assert response["permissionSummary"] == "Data Engineer Group · 조직 내부 · 승인 검토"
    assert response["targetDatabase"] == "asklake"
    assert response["targetDescription"] == "Kafka snapshot direct target 데이터셋"
    assert response["targetTags"] == ["#review", "#bronze"]
    assert response["partitionColumns"] == ["created_at"]
    assert response["indexColumns"] == ["event_id"]

    print("verify-etl-job-hydrate-contract: ok")


if __name__ == "__main__":
    main()
