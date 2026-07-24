from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from sqlalchemy.exc import IntegrityError

from app.application.airflow_execution import (
    AirflowCatalogReconciliationHooks,
    AirflowSparkExecutionHooks,
    execute_airflow_spark_run,
    commit_airflow_catalog_reconciliation,
    reconcile_airflow_catalog,
)
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.etl import CatalogDataset


class FakeSession:
    def __init__(self) -> None:
        self.added: list[object] = []
        self.commits = 0
        self.rollbacks = 0

    def add(self, value: object) -> None:
        self.added.append(value)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


def spark_hooks(
    runner: Mock,
    *,
    lease_active: bool = False,
    preparer: Mock | None = None,
) -> AirflowSparkExecutionHooks:
    return AirflowSparkExecutionHooks(
        compact_storage_text=lambda value, **_kwargs: str(value),
        execution_owner_id="backend-process-1",
        format_duration_ms=lambda value: f"{value}ms",
        format_rows=lambda value: f"{value} rows",
        iso_now=lambda: "2026-07-17T00:00:00Z",
        make_attempt_id=lambda run_id: f"attempt:{run_id}",
        prepare_spark_job=preparer or Mock(return_value={"detached": True}),
        run_prepared_spark_job=runner,
        spark_error_summary=lambda result: str(result.get("error") or "spark failed"),
        spark_execution_lease_is_active=lambda _value: lease_active,
        spark_failed_stage=lambda result: str(result.get("failedStage") or "Spark"),
        spark_result_manifest=lambda result, run_id: {**result, "runId": run_id},
    )


def catalog_error(message: str, details: dict | None = None) -> ApiError:
    return ApiError("CATALOG_RECONCILIATION_FAILED", message, 500, details)


def catalog_hooks(
    *,
    dataset_builder: Mock | None = None,
    inspect_output: Mock | None = None,
    verify_iceberg: Mock | None = None,
) -> AirflowCatalogReconciliationHooks:
    return AirflowCatalogReconciliationHooks(
        catalog_reconciliation_error=catalog_error,
        compact_storage_text=lambda value, **_kwargs: str(value),
        dataset_from_spark_result=dataset_builder or Mock(return_value=SimpleNamespace(id="ds_orders")),
        inspect_spark_output=inspect_output or Mock(return_value={"parquetObjectCount": 2, "storageSizeBytes": 40}),
        is_kafka_job=lambda _job: False,
        iso_now=lambda: "2026-07-17T00:00:00Z",
        optional_string=lambda value: str(value).strip() if value else None,
        parse_count_value=lambda value: int(value or 0),
        validate_catalog_output_identity=Mock(),
        verify_spark_iceberg_result=verify_iceberg or Mock(),
    )


def catalog_dataset() -> CatalogDataset:
    return CatalogDataset.model_validate({
        "id": "ds_orders",
        "name": "orders",
        "description": "orders",
        "owner": "data-team",
        "layer": "GOLD",
        "status": "available",
        "freshness": "latest",
        "source": "orders pipeline",
        "rows": "2 rows",
        "size": "40B",
        "quality": "passed",
        "lastUpdated": "2026-07-17T00:00:00Z",
        "nextRefresh": "manual",
        "rag": False,
        "tags": [],
        "schema": [],
        "sampleRows": [],
        "upstream": [],
        "downstream": [],
    })


class AirflowSparkExecutionCommandTests(unittest.TestCase):
    def test_successful_manifest_is_reused_without_running_spark(self) -> None:
        db = FakeSession()
        job = SimpleNamespace(id="JOB-1")
        existing = {"runId": "RUN-1", "status": "success"}
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={"sparkResult": existing},
        )
        runner = Mock()

        with (
            patch("app.application.airflow_execution.etl_repository.get_job_for_update", return_value=job),
            patch("app.application.airflow_execution.etl_repository.get_run_model", return_value=run),
            patch("app.application.airflow_execution.etl_repository.refresh_run_for_update"),
        ):
            result = execute_airflow_spark_run(
                db,
                job_id="JOB-1",
                run_id="RUN-1",
                command="run",
                hooks=spark_hooks(runner),
            )

        self.assertIs(result, existing)
        self.assertEqual(db.rollbacks, 1)
        self.assertEqual(db.commits, 0)
        runner.assert_not_called()

    def test_active_execution_lease_is_rejected_before_runner_call(self) -> None:
        db = FakeSession()
        job = SimpleNamespace(id="JOB-1")
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={"sparkExecution": {"attemptId": "active", "status": "running"}},
        )
        runner = Mock()

        with (
            patch("app.application.airflow_execution.etl_repository.get_job_for_update", return_value=job),
            patch("app.application.airflow_execution.etl_repository.get_run_model", return_value=run),
            patch("app.application.airflow_execution.etl_repository.refresh_run_for_update"),
            self.assertRaises(ApiError) as context,
        ):
            execute_airflow_spark_run(
                db,
                job_id="JOB-1",
                run_id="RUN-1",
                command="run",
                hooks=spark_hooks(runner, lease_active=True),
            )

        self.assertEqual(str(context.exception.code), "SPARK_RUN_ALREADY_EXECUTING")
        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(db.rollbacks, 1)
        runner.assert_not_called()

    def test_success_claims_then_finalizes_the_same_attempt(self) -> None:
        db = FakeSession()
        job = SimpleNamespace(id="JOB-1", target_path=None)
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            duration="-",
            ended_at="-",
            error_summary="-",
            failed_stage="-",
            input_rows="-",
            job_id="JOB-1",
            output_path="-",
            output_rows="-",
            task_states={},
        )
        runner = Mock(return_value={
            "durationMs": 25,
            "endedAt": "2026-07-17T00:00:01Z",
            "inputRows": 3,
            "outputPath": "s3://lake/orders/RUN-1",
            "outputRows": 2,
            "status": "success",
        })

        with (
            patch("app.application.airflow_execution.etl_repository.get_job_for_update", side_effect=[job, job]),
            patch("app.application.airflow_execution.etl_repository.get_job", return_value=job),
            patch("app.application.airflow_execution.etl_repository.get_run_model", side_effect=[run, run]),
            patch("app.application.airflow_execution.etl_repository.refresh_run_for_update"),
        ):
            result = execute_airflow_spark_run(
                db,
                job_id="JOB-1",
                run_id="RUN-1",
                command="run",
                hooks=spark_hooks(runner),
            )

        self.assertEqual(result["status"], "success")
        self.assertEqual(db.commits, 3)
        self.assertEqual(run.task_states["sparkExecution"]["attemptId"], "attempt:RUN-1")
        self.assertEqual(run.task_states["sparkExecution"]["ownerId"], "backend-process-1")
        self.assertEqual(run.task_states["sparkExecution"]["status"], "success")
        self.assertEqual(run.task_states["sparkResult"]["runId"], "RUN-1")
        self.assertEqual(job.target_path, "s3://lake/orders/RUN-1")

    def test_runner_error_marks_only_the_owned_attempt_failed(self) -> None:
        db = FakeSession()
        job = SimpleNamespace(id="JOB-1", target_path=None)
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={},
        )
        runner = Mock(side_effect=RuntimeError("spark unavailable"))

        with (
            patch("app.application.airflow_execution.etl_repository.get_job_for_update", side_effect=[job, job]),
            patch("app.application.airflow_execution.etl_repository.get_job", return_value=job),
            patch("app.application.airflow_execution.etl_repository.get_run_model", side_effect=[run, run]),
            patch("app.application.airflow_execution.etl_repository.refresh_run_for_update"),
            self.assertRaisesRegex(RuntimeError, "spark unavailable"),
        ):
            execute_airflow_spark_run(
                db,
                job_id="JOB-1",
                run_id="RUN-1",
                command="run",
                hooks=spark_hooks(runner),
            )

        self.assertEqual(db.commits, 3)
        self.assertEqual(run.task_states["sparkExecution"]["status"], "failed")
        self.assertEqual(run.task_states["sparkExecution"]["error"], "spark unavailable")
        self.assertNotIn("sparkResult", run.task_states)

    def test_runner_timeout_releases_preparation_transaction_and_marks_attempt_failed(self) -> None:
        db = FakeSession()
        job = SimpleNamespace(id="JOB-1", target_path=None)
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={},
        )

        def timeout_after_release(_prepared: object) -> dict[str, object]:
            self.assertEqual(db.commits, 2)
            raise TimeoutError("spark wait timed out")

        runner = Mock(side_effect=timeout_after_release)
        with (
            patch("app.application.airflow_execution.etl_repository.get_job_for_update", side_effect=[job, job]),
            patch("app.application.airflow_execution.etl_repository.get_job", return_value=job),
            patch("app.application.airflow_execution.etl_repository.get_run_model", side_effect=[run, run]),
            patch("app.application.airflow_execution.etl_repository.refresh_run_for_update"),
            self.assertRaisesRegex(TimeoutError, "spark wait timed out"),
        ):
            execute_airflow_spark_run(
                db,
                job_id="JOB-1",
                run_id="RUN-1",
                command="run",
                hooks=spark_hooks(runner),
            )

        self.assertEqual(db.commits, 3)
        self.assertEqual(db.rollbacks, 1)
        self.assertEqual(run.task_states["sparkExecution"]["status"], "failed")
        self.assertEqual(run.task_states["sparkExecution"]["error"], "spark wait timed out")
        self.assertNotIn("sparkResult", run.task_states)

    def test_invalid_spark_result_marks_only_the_owned_attempt_failed(self) -> None:
        db = FakeSession()
        job = SimpleNamespace(id="JOB-1", target_path=None)
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={},
        )
        hooks = replace(
            spark_hooks(Mock(return_value={"status": "success"})),
            spark_result_manifest=Mock(side_effect=ValueError("invalid spark manifest")),
        )

        with (
            patch("app.application.airflow_execution.etl_repository.get_job_for_update", side_effect=[job, job]),
            patch("app.application.airflow_execution.etl_repository.get_job", return_value=job),
            patch("app.application.airflow_execution.etl_repository.get_run_model", side_effect=[run, run]),
            patch("app.application.airflow_execution.etl_repository.refresh_run_for_update"),
            self.assertRaisesRegex(ValueError, "invalid spark manifest"),
        ):
            execute_airflow_spark_run(
                db,
                job_id="JOB-1",
                run_id="RUN-1",
                command="run",
                hooks=hooks,
            )

        self.assertEqual(db.commits, 3)
        self.assertEqual(run.task_states["sparkExecution"]["status"], "failed")
        self.assertEqual(run.task_states["sparkExecution"]["error"], "invalid spark manifest")
        self.assertNotIn("sparkResult", run.task_states)

    def test_changed_execution_lease_rejects_stale_finalization(self) -> None:
        db = FakeSession()
        job = SimpleNamespace(id="JOB-1", target_path=None)
        claimed_run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={},
        )
        replacement_run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={"sparkExecution": {"attemptId": "attempt:replacement", "status": "running"}},
        )
        runner = Mock(return_value={"runId": "RUN-1", "status": "success"})

        with (
            patch("app.application.airflow_execution.etl_repository.get_job_for_update", side_effect=[job, job]),
            patch("app.application.airflow_execution.etl_repository.get_job", return_value=job),
            patch(
                "app.application.airflow_execution.etl_repository.get_run_model",
                side_effect=[claimed_run, replacement_run],
            ),
            patch("app.application.airflow_execution.etl_repository.refresh_run_for_update"),
            self.assertRaises(ApiError) as context,
        ):
            execute_airflow_spark_run(
                db,
                job_id="JOB-1",
                run_id="RUN-1",
                command="run",
                hooks=spark_hooks(runner),
            )

        self.assertEqual(context.exception.code, ErrorCode.INVALID_JOB_STATE)
        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(db.commits, 2)
        self.assertEqual(db.rollbacks, 1)
        self.assertNotIn("sparkResult", replacement_run.task_states)

    def test_database_transaction_is_released_before_external_spark_wait(self) -> None:
        db = FakeSession()
        job = SimpleNamespace(id="JOB-1", target_path=None)
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            duration="-",
            ended_at="-",
            error_summary="-",
            failed_stage="-",
            input_rows="-",
            job_id="JOB-1",
            output_path="-",
            output_rows="-",
            task_states={},
        )
        prepared = {"detached": True}
        preparer = Mock(return_value=prepared)

        def assert_connection_released(value: object) -> dict[str, object]:
            self.assertIs(value, prepared)
            self.assertEqual(db.commits, 2)
            return {"runId": "RUN-1", "status": "success"}

        runner = Mock(side_effect=assert_connection_released)
        with (
            patch("app.application.airflow_execution.etl_repository.get_job_for_update", side_effect=[job, job]),
            patch("app.application.airflow_execution.etl_repository.get_job", return_value=job),
            patch("app.application.airflow_execution.etl_repository.get_run_model", side_effect=[run, run]),
            patch("app.application.airflow_execution.etl_repository.refresh_run_for_update"),
        ):
            execute_airflow_spark_run(
                db,
                job_id="JOB-1",
                run_id="RUN-1",
                command="run",
                hooks=spark_hooks(runner, preparer=preparer),
            )

        preparer.assert_called_once_with(db, job, "run", "RUN-1")
        runner.assert_called_once_with(prepared)


class AirflowCatalogReconciliationCommandTests(unittest.TestCase):
    def test_unsuccessful_spark_result_is_not_published(self) -> None:
        db = FakeSession()
        job = SimpleNamespace(dataset_id="ds_orders", id="JOB-1", iceberg_target=None, target="orders")
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={"sparkResult": {"runId": "RUN-1", "status": "failed"}},
        )
        hooks = catalog_hooks()

        with (
            patch("app.application.airflow_execution.etl_repository.get_job", return_value=job),
            patch("app.application.airflow_execution.etl_repository.get_run_model", return_value=run),
            self.assertRaises(ApiError) as context,
        ):
            reconcile_airflow_catalog(db, job_id="JOB-1", run_id="RUN-1", hooks=hooks)

        self.assertEqual(str(context.exception.code), "SPARK_RESULT_NOT_READY")
        hooks.inspect_spark_output.assert_not_called()

    def test_existing_catalog_result_is_returned_idempotently(self) -> None:
        db = FakeSession()
        dataset = catalog_dataset()
        job = SimpleNamespace(dataset_id="ds_orders", id="JOB-1", iceberg_target=None, target="orders")
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={
                "catalogResult": {
                    "datasetId": "ds_orders",
                    "reconciledAt": "2026-07-16T00:00:00Z",
                    "runId": "RUN-1",
                    "status": "success",
                },
            },
        )
        hooks = catalog_hooks()

        with (
            patch("app.application.airflow_execution.etl_repository.get_job", return_value=job),
            patch("app.application.airflow_execution.etl_repository.get_run_model", return_value=run),
            patch("app.application.airflow_execution.etl_repository.get_dataset_schema_by_id", return_value=dataset),
        ):
            response = reconcile_airflow_catalog(db, job_id="JOB-1", run_id="RUN-1", hooks=hooks)

        self.assertEqual(response.dataset.id, "ds_orders")
        self.assertEqual(response.reconciled_at, "2026-07-16T00:00:00Z")
        hooks.inspect_spark_output.assert_not_called()

    def test_verified_output_and_catalog_result_commit_together(self) -> None:
        db = FakeSession()
        dataset = catalog_dataset()
        job = SimpleNamespace(dataset_id="ds_orders", id="JOB-1", iceberg_target=None, target="orders")
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={
                "sparkResult": {
                    "outputPath": "s3://lake/orders/RUN-1",
                    "runId": "RUN-1",
                    "status": "success",
                },
            },
        )
        hooks = catalog_hooks()

        with (
            patch("app.application.airflow_execution.etl_repository.get_job", side_effect=[job, job]),
            patch("app.application.airflow_execution.etl_repository.get_run_model", side_effect=[run, run]),
            patch("app.application.airflow_execution.etl_repository.get_dataset_by_id_for_update", return_value=None),
            patch("app.application.airflow_execution.etl_repository.get_dataset_by_name", return_value=None),
            patch(
                "app.application.airflow_execution.etl_repository.save_command_result",
                return_value=(job, run, dataset),
            ),
        ):
            response = reconcile_airflow_catalog(db, job_id="JOB-1", run_id="RUN-1", hooks=hooks)

        self.assertEqual(response.dataset.id, "ds_orders")
        self.assertEqual(run.task_states["catalogResult"]["status"], "success")
        self.assertEqual(run.task_states["catalogResult"]["parquetObjectCount"], 2)
        hooks.validate_catalog_output_identity.assert_called_once_with(
            job,
            "RUN-1",
            "s3://lake/orders/RUN-1",
        )

    def test_catalog_transaction_failure_preserves_spark_evidence(self) -> None:
        db = FakeSession()
        job = SimpleNamespace(dataset_id="ds_orders", id="JOB-1", iceberg_target=None, target="orders")
        spark_result = {
            "outputPath": "s3://lake/orders/RUN-1",
            "runId": "RUN-1",
            "status": "success",
        }
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            error_summary="-",
            failed_stage="-",
            job_id="JOB-1",
            task_states={"sparkResult": spark_result},
        )
        hooks = catalog_hooks()

        with (
            patch("app.application.airflow_execution.etl_repository.get_job", side_effect=[job, job]),
            patch("app.application.airflow_execution.etl_repository.get_run_model", side_effect=[run, run, run]),
            patch("app.application.airflow_execution.etl_repository.get_dataset_by_id_for_update", return_value=None),
            patch("app.application.airflow_execution.etl_repository.get_dataset_by_name", return_value=None),
            patch(
                "app.application.airflow_execution.etl_repository.save_command_result",
                side_effect=RuntimeError("catalog transaction failed"),
            ),
            self.assertRaises(ApiError) as context,
        ):
            reconcile_airflow_catalog(db, job_id="JOB-1", run_id="RUN-1", hooks=hooks)

        self.assertEqual(str(context.exception.code), "CATALOG_RECONCILIATION_FAILED")
        self.assertEqual(run.task_states["sparkResult"]["runId"], spark_result["runId"])
        self.assertEqual(run.task_states["sparkResult"]["status"], "success")
        self.assertEqual(run.task_states["catalogResult"]["status"], "failed")
        self.assertEqual(run.failed_stage, "Catalog reconciliation")
        self.assertIn("catalog transaction failed", run.error_summary)
        self.assertGreaterEqual(db.rollbacks, 1)
        self.assertEqual(db.commits, 1)

    def test_first_dataset_insert_conflict_reloads_and_retries_once(self) -> None:
        db = FakeSession()
        dataset = catalog_dataset()
        job = SimpleNamespace(dataset_id="ds_orders", id="JOB-1", target="orders")
        run = SimpleNamespace(
            airflow_dag_run_id="RUN-1",
            job_id="JOB-1",
            task_states={"sparkResult": {"runId": "RUN-1", "status": "success"}},
        )
        hooks = catalog_hooks()
        conflict = IntegrityError("INSERT catalog_datasets", {}, RuntimeError("duplicate"))

        with (
            patch("app.application.airflow_execution.etl_repository.get_job", side_effect=[job, job]),
            patch("app.application.airflow_execution.etl_repository.get_run_model", side_effect=[run, run]),
            patch("app.application.airflow_execution.etl_repository.get_dataset_by_id_for_update", return_value=None),
            patch("app.application.airflow_execution.etl_repository.get_dataset_by_name", return_value=None),
            patch(
                "app.application.airflow_execution.etl_repository.save_command_result",
                side_effect=[conflict, (job, run, dataset)],
            ) as save_result,
        ):
            response = commit_airflow_catalog_reconciliation(
                db,
                job_id="JOB-1",
                run_id="RUN-1",
                result={"outputPath": "s3://lake/orders/RUN-1", "runId": "RUN-1", "status": "success"},
                retry_on_create_conflict=True,
                hooks=hooks,
            )

        self.assertEqual(response.dataset.id, "ds_orders")
        self.assertEqual(save_result.call_count, 2)
        self.assertEqual(db.rollbacks, 1)


if __name__ == "__main__":
    unittest.main()
