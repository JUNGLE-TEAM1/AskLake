from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel
from app.repositories import etl_repository
from app.schemas.etl import CreatePipelineRequest
from app.services.airflow_client import AirflowDagRun, AirflowTaskInstance
from app.services.etl_service import (
    create_pipeline,
    inspect_spark_output,
    reconcile_airflow_catalog,
    sync_airflow_run,
)


def main() -> None:
    suffix = uuid4().hex[:10]
    job_id = None
    dataset_id = None
    db = SessionLocal()
    try:
        with TemporaryDirectory(prefix="asklake-phase3-") as output_root:
            created = create_pipeline(db, pipeline_request(suffix, output_root))
            job_id = created.job.id
            job = etl_repository.get_job(db, job_id)
            assert job is not None
            dataset_id = job.dataset_id
            assert dataset_id

            first_run_id = f"run_catalog_{suffix}_1"
            first_output = write_parquet_fixture(output_root, first_run_id, b"PAR1-first-output")
            add_run(db, job_id, first_run_id, first_output, output_rows=2)

            first = reconcile_airflow_catalog(db, job_id=job_id, run_id=first_run_id)
            assert first.status == "success"
            assert first.dataset.id == dataset_id
            assert first.dataset.source_run_id == first_run_id
            assert first.dataset.storage_location == first_output
            assert first.dataset.storage_format == "parquet"
            assert (first.dataset.storage_size_bytes or 0) > 0
            assert len(first.dataset.materialization_runs) == 1
            assert len((first.dataset.lineage_graph or {}).get("datasets") or []) == 3
            assert first.dataset.sample_rows == []

            repeated = reconcile_airflow_catalog(db, job_id=job_id, run_id=first_run_id)
            assert len(repeated.dataset.materialization_runs) == 1
            assert repeated.dataset.materialization_runs[0]["runId"] == first_run_id

            second_run_id = f"run_catalog_{suffix}_2"
            second_output = write_parquet_fixture(output_root, second_run_id, b"PAR1-second-output-longer")
            add_run(db, job_id, second_run_id, second_output, output_rows=3)
            second = reconcile_airflow_catalog(db, job_id=job_id, run_id=second_run_id)
            assert second.dataset.id == dataset_id
            assert len(second.dataset.materialization_runs) == 2
            assert {item["runId"] for item in second.dataset.materialization_runs} == {first_run_id, second_run_id}
            assert second.dataset.source_run_id == second_run_id
            assert second.dataset.rows == "3행"
            assert all(item["materializationMode"] == "snapshot" for item in second.dataset.materialization_runs)

            not_ready_run_id = f"run_catalog_{suffix}_not_ready"
            add_run(db, job_id, not_ready_run_id, None, spark_status=None)
            assert_api_error(
                lambda: reconcile_airflow_catalog(db, job_id=job_id, run_id=not_ready_run_id),
                "SPARK_RESULT_NOT_READY",
                409,
            )

            mismatch_run_id = f"run_catalog_{suffix}_mismatch"
            mismatch_output = write_parquet_fixture(output_root, mismatch_run_id, b"PAR1-mismatch")
            add_run(
                db,
                job_id,
                mismatch_run_id,
                mismatch_output,
                airflow_dag_run_id="different-airflow-run",
            )
            assert_api_error(
                lambda: reconcile_airflow_catalog(db, job_id=job_id, run_id=mismatch_run_id),
                "AIRFLOW_RUN_MISMATCH",
                409,
            )

            missing_run_id = f"run_catalog_{suffix}_missing"
            missing_output = str(Path(output_root) / missing_run_id)
            add_run(db, job_id, missing_run_id, missing_output)
            assert_api_error(
                lambda: reconcile_airflow_catalog(db, job_id=job_id, run_id=missing_run_id),
                "CATALOG_RECONCILIATION_FAILED",
                500,
            )
            failed_run = etl_repository.get_run_model(db, missing_run_id)
            assert failed_run is not None
            assert (failed_run.task_states or {}).get("catalogResult", {}).get("status") == "failed"
            assert len(etl_repository.get_dataset_schema_by_id(db, dataset_id).materialization_runs) == 2

            transaction_run_id = f"run_catalog_{suffix}_transaction"
            transaction_output = write_parquet_fixture(output_root, transaction_run_id, b"PAR1-transaction")
            add_run(db, job_id, transaction_run_id, transaction_output)
            with patch(
                "app.services.etl_service.etl_repository.save_command_result",
                side_effect=RuntimeError("injected Catalog transaction failure"),
            ):
                assert_api_error(
                    lambda: reconcile_airflow_catalog(db, job_id=job_id, run_id=transaction_run_id),
                    "CATALOG_RECONCILIATION_FAILED",
                    500,
                )
            transaction_run = etl_repository.get_run_model(db, transaction_run_id)
            assert transaction_run is not None
            assert (transaction_run.task_states or {}).get("catalogResult", {}).get("status") == "failed"
            assert len(etl_repository.get_dataset_schema_by_id(db, dataset_id).materialization_runs) == 2
            sync_airflow_run(db, job, transaction_run, FailedCatalogAirflowClient())
            assert transaction_run.failed_stage == "Catalog reconciliation"
            assert "injected Catalog transaction failure" in transaction_run.error_summary
            assert (transaction_run.task_states or {}).get("sparkResult", {}).get("status") == "success"
            assert (transaction_run.task_states or {}).get("catalogResult", {}).get("status") == "failed"

            sync_airflow_run(db, job, transaction_run, SuccessfulAirflowClient())
            assert transaction_run.status == "failed"
            assert transaction_run.failed_stage == "Catalog reconciliation"
            assert "injected Catalog transaction failure" in transaction_run.error_summary

            missing_catalog_run_id = f"run_catalog_{suffix}_missing_catalog"
            missing_catalog_output = write_parquet_fixture(
                output_root,
                missing_catalog_run_id,
                b"PAR1-missing-catalog",
            )
            add_run(db, job_id, missing_catalog_run_id, missing_catalog_output)
            missing_catalog_run = etl_repository.get_run_model(db, missing_catalog_run_id)
            assert missing_catalog_run is not None
            sync_airflow_run(db, job, missing_catalog_run, SuccessfulAirflowClient())
            assert missing_catalog_run.status == "failed"
            assert missing_catalog_run.failed_stage == "Catalog reconciliation"
            assert missing_catalog_run.error_summary == "Airflow completed without a successful Catalog reconciliation."

            stale_sync_run_id = f"run_catalog_{suffix}_stale_sync"
            add_run(db, job_id, stale_sync_run_id, None, spark_status=None)
            stale_sync_run = etl_repository.get_run_model(db, stale_sync_run_id)
            assert stale_sync_run is not None
            writer_db = SessionLocal()
            try:
                writer_run = etl_repository.get_run_model(writer_db, stale_sync_run_id)
                assert writer_run is not None
                writer_run.task_states = {
                    "sparkResult": {
                        "error": "quality rule failed",
                        "failedStage": "Quality",
                        "runId": stale_sync_run_id,
                        "status": "failed",
                    },
                }
                writer_db.commit()
            finally:
                writer_db.close()

            assert (stale_sync_run.task_states or {}).get("sparkResult") is None
            sync_airflow_run(db, job, stale_sync_run, FailedSparkAirflowClient())
            db.commit()
            db.expire_all()
            refreshed_sync_run = etl_repository.get_run_model(db, stale_sync_run_id)
            assert refreshed_sync_run is not None
            assert (refreshed_sync_run.task_states or {}).get("sparkResult", {}).get("status") == "failed"
            assert refreshed_sync_run.failed_stage == "Quality"
            assert refreshed_sync_run.error_summary == "quality rule failed"

            assert_fake_s3_inspection()
            print("verify-airflow-catalog-reconciliation: ok")
    finally:
        db.rollback()
        if job_id:
            db.query(CatalogDatasetModel).filter(CatalogDatasetModel.id == dataset_id).delete(synchronize_session=False)
            db.query(ETLRunModel).filter(ETLRunModel.job_id == job_id).delete(synchronize_session=False)
            db.query(ETLJobModel).filter(ETLJobModel.id == job_id).delete(synchronize_session=False)
            db.commit()
        db.close()


def pipeline_request(suffix: str, output_root: str) -> CreatePipelineRequest:
    return CreatePipelineRequest.model_validate({
        "id": f"airflow-catalog-{suffix}",
        "jobName": f"airflow_catalog_{suffix}",
        "owner": "data-team",
        "permissionRoles": [],
        "permissionSummary": "data-team",
        "qualityInvalidRows": [],
        "qualityRules": [],
        "qualityScore": 100,
        "qualityStatus": "pass",
        "rag": False,
        "retryPolicySummary": "재시도 없음",
        "runLimitSummary": "60분 제한",
        "ruleSummary": "Phase 3 reconciliation contract",
        "scheduleLabel": "manual",
        "schemaColumns": [
            {"included": True, "nullable": False, "sourceName": "customer_id", "targetName": "customer_id", "type": "String"},
            {"included": True, "nullable": False, "sourceName": "amount", "targetName": "amount", "type": "Float"},
        ],
        "schemaSampleRows": [["C-001", "42.5"]],
        "schemaSummary": "2 columns",
        "sourceConfig": [["Endpoint", "sample://inline"]],
        "sourceLabel": "inline sample rows",
        "sourceType": "REST API",
        "storagePath": output_root,
        "storageType": "Local",
        "targetDataset": f"airflow_catalog_{suffix}",
        "targetDescription": "Phase 3 catalog reconciliation fixture",
        "targetFormat": "Parquet",
        "targetLayer": "GOLD",
        "targetTags": ["phase3"],
        "transformOutputColumns": [["customer_id", "string"], ["amount", "double"]],
        "transformSteps": [],
    })


def add_run(
    db,
    job_id: str,
    run_id: str,
    output_path: str | None,
    *,
    airflow_dag_run_id: str | None = None,
    output_rows: int = 2,
    spark_status: str | None = "success",
) -> None:
    task_states = {}
    if spark_status is not None:
        task_states["sparkResult"] = {
            "endedAt": "2026-07-10T12:00:01Z",
            "inputRows": output_rows,
            "outputPath": output_path,
            "outputRows": output_rows,
            "quality": {"score": 100, "status": "pass", "summary": "품질 통과"},
            "runId": run_id,
            "schema": [
                {"name": "customer_id", "nullable": False, "type": "string"},
                {"name": "amount", "nullable": False, "type": "double"},
            ],
            "startedAt": "2026-07-10T12:00:00Z",
            "status": spark_status,
        }
    db.add(ETLRunModel(
        airflow_dag_id="asklake_etl_job",
        airflow_dag_run_id=airflow_dag_run_id or run_id,
        airflow_state="running",
        duration="1초",
        ended_at="2026-07-10T12:00:01Z",
        error_summary="-",
        failed_stage="-",
        input_rows=f"{output_rows} rows",
        job_id=job_id,
        output_path=output_path,
        output_rows=f"{output_rows} rows",
        run_id=run_id,
        started_at="2026-07-10T12:00:00Z",
        status="running",
        task_states=task_states,
    ))
    db.commit()


def write_parquet_fixture(output_root: str, run_id: str, content: bytes) -> str:
    output_path = Path(output_root) / run_id
    output_path.mkdir(parents=True, exist_ok=True)
    (output_path / "part-00000.snappy.parquet").write_bytes(content)
    (output_path / "_SUCCESS").write_bytes(b"")
    return str(output_path)


def assert_api_error(call, code: str, status_code: int) -> None:
    try:
        call()
    except ApiError as exc:
        assert str(exc.code) == code, (exc.code, exc.message)
        assert exc.status_code == status_code, (exc.status_code, exc.message)
        return
    raise AssertionError(f"Expected ApiError: {code}")


def assert_fake_s3_inspection() -> None:
    client = FakeS3Client()
    evidence = inspect_spark_output("s3a://asklake-output/customer/gold/run_123", s3_client=client)
    assert evidence == {"parquetObjectCount": 2, "storageSizeBytes": 30}
    assert client.requests == [
        {"Bucket": "asklake-output", "Prefix": "customer/gold/run_123/"},
        {"Bucket": "asklake-output", "Prefix": "customer/gold/run_123/", "ContinuationToken": "next"},
    ]


class FakeS3Client:
    def __init__(self) -> None:
        self.requests: list[dict] = []

    def list_objects_v2(self, **request):
        self.requests.append(request)
        if "ContinuationToken" not in request:
            return {
                "Contents": [
                    {"Key": f"{request['Prefix']}part-00000.parquet", "Size": 10},
                    {"Key": f"{request['Prefix']}_SUCCESS", "Size": 0},
                ],
                "IsTruncated": True,
                "NextContinuationToken": "next",
            }
        return {
            "Contents": [{"Key": f"{request['Prefix']}part-00001.parquet", "Size": 20}],
            "IsTruncated": False,
        }


class FailedCatalogAirflowClient:
    def get_dag_run(self, run_id: str) -> AirflowDagRun:
        return AirflowDagRun.from_payload({
            "dag_id": "asklake_etl_job",
            "dag_run_id": run_id,
            "state": "failed",
        })

    def list_task_instances(self, run_id: str) -> list[AirflowTaskInstance]:
        return [AirflowTaskInstance.from_payload({
            "dag_id": "asklake_etl_job",
            "dag_run_id": run_id,
            "state": "failed",
            "task_id": "publish_run_result",
        })]

    def dag_run_url(self, run_id: str) -> str:
        return f"http://airflow.local/dags/asklake_etl_job/runs/{run_id}"


class SuccessfulAirflowClient:
    def get_dag_run(self, run_id: str) -> AirflowDagRun:
        return AirflowDagRun.from_payload({
            "dag_id": "asklake_etl_job",
            "dag_run_id": run_id,
            "state": "success",
        })

    def list_task_instances(self, run_id: str) -> list[AirflowTaskInstance]:
        return [AirflowTaskInstance.from_payload({
            "dag_id": "asklake_etl_job",
            "dag_run_id": run_id,
            "state": "success",
            "task_id": "publish_run_result",
        })]

    def dag_run_url(self, run_id: str) -> str:
        return f"http://airflow.local/dags/asklake_etl_job/runs/{run_id}"


class FailedSparkAirflowClient:
    def get_dag_run(self, run_id: str) -> AirflowDagRun:
        return AirflowDagRun.from_payload({
            "dag_id": "asklake_etl_job",
            "dag_run_id": run_id,
            "state": "failed",
        })

    def list_task_instances(self, run_id: str) -> list[AirflowTaskInstance]:
        return [AirflowTaskInstance.from_payload({
            "dag_id": "asklake_etl_job",
            "dag_run_id": run_id,
            "state": "failed",
            "task_id": "spark_process_write",
        })]

    def dag_run_url(self, run_id: str) -> str:
        return f"http://airflow.local/dags/asklake_etl_job/runs/{run_id}"


if __name__ == "__main__":
    main()
