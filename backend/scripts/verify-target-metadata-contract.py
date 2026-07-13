import os

from app.models.etl import ETLJobModel
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.etl import CreatePipelineRequest
from app.services.etl_service import (
    dataset_from_spark_result,
    job_payload_for_spark,
    normalize_optional_text,
    normalize_spark_output_storage_path,
    normalize_string_list,
    normalize_target_tags,
    validate_catalog_output_identity,
)


def main() -> None:
    request = CreatePipelineRequest.model_validate({
        "id": "target-metadata-contract",
        "jobName": "target_metadata_contract_pipeline",
        "owner": "data-team",
        "permissionSummary": "Data Team / internal",
        "permissionRoles": [{"access": ["조회"], "checked": True, "name": "Data Team"}],
        "qualityInvalidRows": [],
        "qualityRules": [],
        "qualityScore": 100,
        "qualityStatus": "pass",
        "rag": False,
        "retryPolicy": {
            "backoffMultiplier": 2,
            "backoffStrategy": "exponential",
            "failureAction": "retry_then_fail",
            "initialRetryDelayMinutes": 1,
            "maxRetries": 0,
            "maxRetryDelayMinutes": 30,
            "retryIntervalMinutes": 1,
            "timeoutMinutes": 60,
        },
        "retryPolicySummary": "재시도 없음",
        "runLimitSummary": "60분 제한",
        "ruleSummary": "target metadata contract",
        "scheduleLabel": "manual",
        "schemaColumns": [
            {"included": True, "nullable": False, "sourceName": "event_date", "targetName": "event_date", "type": "String"},
            {"included": True, "nullable": False, "sourceName": "amount", "targetName": "amount", "type": "Float"},
        ],
        "schemaSampleRows": [["2026-07-09", "42.5"]],
        "schemaSummary": "2 columns",
        "sourceConfig": [["Source", "contract"]],
        "sourceLabel": "contract source",
        "sourceType": "REST API",
        "storageType": "Local",
        "partition": "event_date",
        "partitionColumns": ["event_date", "event_date", " "],
        "indexColumns": ["amount", " "],
        "compression": "Snappy",
        "storagePath": "",
        "targetDataset": "target_metadata_contract",
        "targetDescription": "사용자 입력 Target 설명",
        "targetTags": ["gold", "#review", "gold"],
        "targetFormat": "Parquet",
        "targetLayer": "GOLD",
        "transformOutputColumns": [["event_date", "string"], ["amount", "double"]],
        "transformSteps": [],
    })

    assert request.target_description == "사용자 입력 Target 설명"
    assert request.target_tags == ["gold", "#review", "gold"]
    assert request.partition_columns == ["event_date", "event_date", " "]

    job = ETLJobModel(
        id="JOB-TARGET-META",
        name=request.job_name,
        owner=request.owner,
        status="scheduled",
        tag="[생성]",
        source=f"{request.source_type} / {request.source_label}",
        target=request.target_dataset,
        schedule=request.schedule_label,
        source_config=[[key, value] for key, value in request.source_config],
        source_label=request.source_label,
        source_type=request.source_type,
        schema_columns=[column.model_dump(mode="json", by_alias=True) for column in request.schema_columns],
        schema_sample_rows=request.schema_sample_rows,
        permission_roles=request.permission_roles,
        storage_type=request.storage_type,
        partition=request.partition,
        partition_columns=normalize_string_list(request.partition_columns),
        index_columns=normalize_string_list(request.index_columns),
        compression=request.compression,
        storage_path=request.storage_path,
        target_description=normalize_optional_text(request.target_description),
        target_tags=normalize_target_tags(request.target_tags),
        target_format=request.target_format,
        target_layer=request.target_layer,
        rag=request.rag,
        transform_output_columns=[[key, value] for key, value in request.transform_output_columns],
        transform_steps=[step.model_dump(mode="json", by_alias=True) for step in request.transform_steps],
        quality_invalid_rows=request.quality_invalid_rows,
        quality_rules=[rule.model_dump(mode="json", by_alias=True) for rule in request.quality_rules],
        quality_score=request.quality_score,
        quality_status=request.quality_status,
        last_run="생성 후 미실행",
        last_state="-",
        next_run="-",
        stats={},
        dag_steps=[],
        dataset_id="ds_target_metadata_contract",
    )

    assert job.partition_columns == ["event_date"]
    assert job.index_columns == ["amount"]
    assert job.target_tags == ["#gold", "#review"]

    spark_payload = job_payload_for_spark(job)
    assert spark_payload["targetDescription"] == "사용자 입력 Target 설명"
    assert spark_payload["targetTags"] == ["#gold", "#review"]
    assert spark_payload["partition"] == "event_date"
    assert spark_payload["partitionColumns"] == ["event_date"]
    assert spark_payload["indexColumns"] == ["amount"]
    assert spark_payload["compression"] == "Snappy"
    assert spark_payload["datasetId"] == "ds_target_metadata_contract"

    dataset = dataset_from_spark_result(
        job,
        {
            "endedAt": "2026-07-09T00:00:00Z",
            "outputPath": "-",
            "outputRows": "1",
            "runId": "run_target_metadata_contract",
            "schema": [{"name": "event_date", "type": "string"}, {"name": "amount", "type": "double"}],
            "status": "success",
        },
    )
    payload = dataset.payload

    assert dataset.description == "사용자 입력 Target 설명"
    assert dataset.tags == ["#gold", "#review"]
    assert payload["description"] == "사용자 입력 Target 설명"
    assert payload["tags"] == ["#gold", "#review"]
    assert payload["partition"] == "event_date"
    assert payload["partitionColumns"] == ["event_date"]
    assert payload["indexColumns"] == ["amount"]

    response = CatalogDatasetResponse.model_validate(payload).model_dump(by_alias=True)
    assert response["partition"] == "event_date"
    assert response["partitionColumns"] == ["event_date"]
    assert response["indexColumns"] == ["amount"]

    storage_environment_names = (
        "ASKLAKE_SPARK_OUTPUT_BUCKET",
        "ASKLAKE_STORAGE_BASE_PREFIX",
        "ASKLAKE_STORAGE_ENVIRONMENT",
    )
    previous_storage_environment = {
        name: os.environ.get(name)
        for name in storage_environment_names
    }
    try:
        os.environ["ASKLAKE_SPARK_OUTPUT_BUCKET"] = "asklake-dev-output-123-apne2"
        os.environ["ASKLAKE_STORAGE_BASE_PREFIX"] = "asklake"
        os.environ["ASKLAKE_STORAGE_ENVIRONMENT"] = "staging"
        job.storage_path = "s3a://asklake-output/products/gold/"
        assert normalize_spark_output_storage_path(job.storage_path) == "s3a://asklake-dev-output-123-apne2/products/gold"
        validate_catalog_output_identity(
            job,
            "run_target_metadata_contract",
            "s3a://asklake-dev-output-123-apne2/products/gold/run_target_metadata_contract",
        )
        job.storage_path = "s3a://custom-output/team data/매출+원본/"
        validate_catalog_output_identity(
            job,
            "run_target_metadata_contract",
            "s3a://custom-output/team%20data/%EB%A7%A4%EC%B6%9C%2B%EC%9B%90%EB%B3%B8/run_target_metadata_contract",
        )
        job.storage_path = None
        auto_output = (
            "s3a://asklake-dev-output-123-apne2/asklake/staging/datasets/"
            "ds_target_metadata_contract/gold/run_target_metadata_contract"
        )
        validate_catalog_output_identity(job, "run_target_metadata_contract", auto_output)
        try:
            validate_catalog_output_identity(
                job,
                "run_target_metadata_contract",
                auto_output.replace("ds_target_metadata_contract", "ds_wrong"),
            )
        except Exception as error:
            assert getattr(error, "code", None) == "CATALOG_RECONCILIATION_FAILED"
        else:
            raise AssertionError("Auto Storage Layout output identity mismatch must fail")
    finally:
        for name, value in previous_storage_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    print("verify-target-metadata-contract: ok")


if __name__ == "__main__":
    main()
