"""FastAPI-side EMR Serverless Run cancellation and result projection checks."""

import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app.core.errors import ApiError
from app.models import ETLRunModel
from app.services import etl_service


original_environment = dict(os.environ)
original_list_runs = etl_service.etl_repository.list_run_models_for_job
original_recover = etl_service.recover_spark_submission
original_refresh = etl_service.etl_repository.refresh_run_for_update

try:
    with TemporaryDirectory(prefix="asklake-emr-fastapi-") as temporary_dir:
        os.environ["ASKLAKE_SPARK_REPORT_DIR"] = temporary_dir
        os.environ["ASKLAKE_SPARK_RUNTIME"] = "emr-serverless"

        job = SimpleNamespace(id="job-phase-3")
        run = ETLRunModel(
            run_id="run-phase-3",
            job_id=job.id,
            status="running",
            started_at="2026-07-14T00:00:00+00:00",
            ended_at="-",
            duration="실행 중",
            input_rows="0",
            output_rows="0",
            output_path="-",
            failed_stage="-",
            error_summary="-",
            task_states={"sparkExecution": {"attemptId": "attempt-1", "status": "running"}},
        )
        etl_service.etl_repository.list_run_models_for_job = lambda *_args: [run]
        etl_service.etl_repository.refresh_run_for_update = lambda *_args: None

        canceled_run, processing = etl_service.cancel_active_spark_run(object(), job)
        assert canceled_run is run
        assert canceled_run.status == "canceled"
        assert processing["runtime"] == "emr-serverless"
        cancellation = canceled_run.task_states["runtimeCancellation"]
        assert cancellation["status"] == "requested"
        assert cancellation["controlStatePersisted"] is False
        assert "stateFile" not in cancellation
        assert etl_service.airflow_run_cancellation_requested(canceled_run)

        state_file = etl_service.spark_runtime_submission_state_file(run.run_id, "emr-serverless")
        cancel_file = Path(f"{state_file}.cancel-requested")
        assert cancel_file.exists()
        assert json.loads(cancel_file.read_text(encoding="utf-8"))["runId"] == run.run_id

        run.status = "running"
        run.ended_at = "-"
        state_file.write_text("{}\n", encoding="utf-8")
        recovery_calls = []
        etl_service.recover_spark_submission = lambda runtime, state: (
            recovery_calls.append((runtime, state))
            or {"applicationId": "00fakeapplication", "canceled": True, "jobRunId": "jr-phase-3"}
        )
        canceled_run, processing = etl_service.cancel_active_spark_run(object(), job)
        assert processing["runtimeCancellation"]["status"] == "canceled"
        assert processing["runtimeCancellation"]["controlStatePersisted"] is True
        assert recovery_calls == [("emr-serverless", state_file)]

        etl_service.recover_spark_submission = lambda *_args: {
            "applicationId": "00fakeapplication",
            "canceled": False,
            "jobRunId": "jr-phase-3",
            "state": "SUCCESS",
        }
        run.status = "running"
        try:
            etl_service.cancel_active_spark_run(object(), job)
            raise AssertionError("A terminal EMR Job Run must reject cancellation.")
        except ApiError as error:
            assert error.status_code == 409

        manifest = etl_service.spark_result_manifest({
            "runId": run.run_id,
            "runtime": {"id": "emr-serverless", "jobRunId": "jr-phase-3"},
            "runtimeJobId": "jr-phase-3",
            "runtimeLogReference": {"provider": "s3", "uri": "s3://logs/example/"},
            "status": "success",
        }, run.run_id)
        assert manifest["runtime"]["id"] == "emr-serverless"
        assert manifest["runtimeJobId"] == "jr-phase-3"
        assert manifest["runtimeLogReference"]["provider"] == "s3"

    print("EMR Serverless FastAPI contract verified: cancel guard, runtime cancellation, and result projection.")
finally:
    os.environ.clear()
    os.environ.update(original_environment)
    etl_service.etl_repository.list_run_models_for_job = original_list_runs
    etl_service.recover_spark_submission = original_recover
    etl_service.etl_repository.refresh_run_for_update = original_refresh
