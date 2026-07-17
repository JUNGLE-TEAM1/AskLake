from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.application.etl_job_commands import (
    EtlPipelineCreateHooks,
    EtlPipelineUpdateHooks,
    create_pipeline,
    update_pipeline,
)
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.etl import CreatePipelineRequest, JobRowData, UpdatePipelineRequest


def _create_request(*, execution_mode: str = "snapshot") -> CreatePipelineRequest:
    return CreatePipelineRequest(
        id="orders-pipeline",
        job_name="orders_pipeline",
        owner="data-owner",
        schedule_label="수동",
        source_config=[],
        source_label="orders",
        source_type="PostgreSQL",
        target_dataset="orders_raw",
        target_format="parquet",
        target_layer="RAW",
        execution_mode=execution_mode,
    )


def _update_request() -> UpdatePipelineRequest:
    return UpdatePipelineRequest(
        job_name="orders_pipeline",
        owner="data-owner",
        schedule_label="수동",
        target_dataset="orders_raw",
        target_format="parquet",
        target_layer="RAW",
    )


def _job_row(job_id: str = "JOB-ORDERS") -> JobRowData:
    return JobRowData(
        id=job_id,
        last_run="-",
        last_state="준비됨",
        name="orders_pipeline",
        next_run="-",
        owner="data-owner",
        schedule="수동",
        source="PostgreSQL / orders",
        status="scheduled",
        tag="[생성]",
        target="orders_raw",
    )


def _job_model(
    *,
    execution_mode: str = "snapshot",
    status: str = "scheduled",
) -> SimpleNamespace:
    return SimpleNamespace(
        dataset_id="ds_orders_raw",
        execution_mode=execution_mode,
        id="JOB-ORDERS",
        name="orders_pipeline",
        owner="data-owner",
        source_type="PostgreSQL",
        status=status,
    )


def _create_hooks() -> EtlPipelineCreateHooks:
    return EtlPipelineCreateHooks(
        apply_append_request_to_job=Mock(),
        apply_compiled_rules=Mock(),
        build_mapping_context=Mock(return_value=SimpleNamespace()),
        compile_pipeline_rules=Mock(return_value=SimpleNamespace()),
        continuous_runtime_from_job=Mock(return_value=SimpleNamespace(job_id="JOB-ORDERS")),
        identity_name=Mock(side_effect=lambda value: value or "data-owner"),
        identity_profile=Mock(side_effect=lambda name: {"name": name}),
        is_internal_data_lake_source=Mock(return_value=False),
        make_dataset_id=Mock(return_value="ds_orders_raw"),
        make_job_id=Mock(return_value="JOB-ORDERS"),
        map_create_request_to_job=Mock(),
        persist_permission_grants=Mock(side_effect=lambda _db, job, *_args: job),
        require_compiled_rules=Mock(),
        resolve_internal_data_lake_source=Mock(),
        validate_create_request=Mock(),
    )


def _update_hooks() -> EtlPipelineUpdateHooks:
    return EtlPipelineUpdateHooks(
        apply_compiled_rules=Mock(),
        apply_update_request=Mock(),
        compile_pipeline_rules=Mock(return_value=SimpleNamespace()),
        continuous_checkpoint_initialized=Mock(return_value=False),
        continuous_processing_contract_changed=Mock(return_value=False),
        has_successful_run=Mock(return_value=False),
        permission_grants_for_job=Mock(return_value=[]),
        persist_permission_grants=Mock(side_effect=lambda _db, job, *_args: job),
        require_compiled_rules=Mock(),
        require_governed_access=Mock(),
        require_permission=Mock(),
        target_identity_changed=Mock(return_value=False),
        validate_target_contract=Mock(),
        validate_update_request=Mock(),
        with_permissions=Mock(side_effect=lambda _db, job, _actor: job),
    )


class EtlPipelineCreateCommandTests(unittest.TestCase):
    def test_new_snapshot_preserves_validation_mapping_and_permission_sequence(self) -> None:
        db = object()
        request = _create_request()
        hooks = _create_hooks()
        job_model = _job_model()
        saved_job = _job_row()

        with (
            patch("app.application.etl_job_commands.etl_repository.get_job_by_target", return_value=None),
            patch("app.application.etl_job_commands.etl_repository.create_job", return_value=saved_job) as create_job,
            patch("app.application.etl_job_commands.etl_repository.save_kafka_continuous_runtime") as save_runtime,
            patch("app.application.etl_job_commands.etl_repository.get_job_schema") as get_schema,
        ):
            hooks.map_create_request_to_job.return_value = job_model
            response = create_pipeline(db, request, ActorContext(name="creator"), hooks=hooks)

        hooks.compile_pipeline_rules.assert_called_once_with(request)
        hooks.require_compiled_rules.assert_called_once()
        hooks.apply_compiled_rules.assert_called_once()
        hooks.validate_create_request.assert_called_once_with(request)
        hooks.make_dataset_id.assert_called_once_with(request.target_dataset)
        hooks.make_job_id.assert_called_once_with(request.id)
        hooks.map_create_request_to_job.assert_called_once()
        create_job.assert_called_once_with(db, job_model)
        save_runtime.assert_not_called()
        get_schema.assert_not_called()
        self.assertEqual(response.job.id, saved_job.id)
        self.assertEqual(response.catalog_target["id"], "ds_orders_raw")

    def test_existing_snapshot_appends_to_persisted_identity(self) -> None:
        db = object()
        request = _create_request()
        hooks = _create_hooks()
        existing_job = _job_model()
        saved_job = _job_row()

        with (
            patch(
                "app.application.etl_job_commands.etl_repository.get_job_by_target",
                return_value=existing_job,
            ),
            patch("app.application.etl_job_commands.etl_repository.save_job", return_value=saved_job) as save_job,
            patch("app.application.etl_job_commands.etl_repository.create_job") as create_job,
        ):
            response = create_pipeline(db, request, ActorContext(name="creator"), hooks=hooks)

        hooks.make_dataset_id.assert_not_called()
        hooks.make_job_id.assert_not_called()
        hooks.apply_append_request_to_job.assert_called_once()
        save_job.assert_called_once_with(db, existing_job)
        create_job.assert_not_called()
        self.assertEqual(response.catalog_target["id"], existing_job.dataset_id)

    def test_new_continuous_job_persists_runtime_then_rehydrates_schema(self) -> None:
        db = object()
        request = _create_request(execution_mode="continuous")
        hooks = _create_hooks()
        job_model = _job_model(execution_mode="continuous")
        saved_job = _job_row()
        hydrated_job = _job_row("JOB-HYDRATED")

        with (
            patch("app.application.etl_job_commands.etl_repository.get_job_by_target", return_value=None),
            patch("app.application.etl_job_commands.etl_repository.create_job", return_value=saved_job),
            patch("app.application.etl_job_commands.etl_repository.save_kafka_continuous_runtime") as save_runtime,
            patch(
                "app.application.etl_job_commands.etl_repository.get_job_schema",
                return_value=hydrated_job,
            ) as get_schema,
        ):
            hooks.map_create_request_to_job.return_value = job_model
            response = create_pipeline(db, request, ActorContext(name="creator"), hooks=hooks)

        runtime = hooks.continuous_runtime_from_job.return_value
        save_runtime.assert_called_once_with(db, runtime)
        get_schema.assert_called_once_with(db, "JOB-ORDERS")
        self.assertEqual(response.job.id, hydrated_job.id)

    def test_existing_target_preserves_execution_mode_conflicts(self) -> None:
        db = object()
        hooks = _create_hooks()
        cases = [
            (_job_model(execution_mode="snapshot"), "continuous", "Kafka execution mode cannot change"),
            (_job_model(execution_mode="continuous"), "continuous", "Continuous Job configuration is immutable"),
        ]

        for existing_job, execution_mode, message in cases:
            with self.subTest(message=message):
                request = _create_request(execution_mode=execution_mode)
                with patch(
                    "app.application.etl_job_commands.etl_repository.get_job_by_target",
                    return_value=existing_job,
                ):
                    with self.assertRaises(ApiError) as raised:
                        create_pipeline(db, request, ActorContext(name="creator"), hooks=hooks)

                self.assertEqual(raised.exception.status_code, 409)
                self.assertIn(message, raised.exception.message)


class EtlPipelineUpdateCommandTests(unittest.TestCase):
    def test_update_preserves_authorization_validation_save_and_projection(self) -> None:
        db = object()
        request = _update_request()
        hooks = _update_hooks()
        job = _job_model()
        saved_job = _job_row()

        with (
            patch("app.application.etl_job_commands.etl_repository.get_job", return_value=job),
            patch("app.application.etl_job_commands.etl_repository.get_kafka_continuous_runtime") as get_runtime,
            patch("app.application.etl_job_commands.etl_repository.save_job", return_value=saved_job) as save_job,
        ):
            response = update_pipeline(db, job.id, request, ActorContext(name="editor"), hooks=hooks)

        hooks.require_governed_access.assert_called_once()
        hooks.permission_grants_for_job.assert_called_once_with(db, job)
        hooks.require_permission.assert_called_once()
        hooks.compile_pipeline_rules.assert_called_once_with(
            request,
            execution_mode="snapshot",
            source_type="PostgreSQL",
        )
        hooks.validate_target_contract.assert_called_once()
        get_runtime.assert_not_called()
        hooks.apply_update_request.assert_called_once_with(job, request, False)
        save_job.assert_called_once_with(db, job)
        hooks.persist_permission_grants.assert_called_once()
        hooks.with_permissions.assert_called_once()
        self.assertEqual(response.id, saved_job.id)

    def test_update_preserves_not_found_and_mutability_failures(self) -> None:
        db = object()
        request = _update_request()
        missing_hooks = _update_hooks()
        with patch("app.application.etl_job_commands.etl_repository.get_job", return_value=None):
            with self.assertRaises(ApiError) as missing:
                update_pipeline(db, "MISSING", request, ActorContext(name="editor"), hooks=missing_hooks)
        self.assertEqual(missing.exception.status_code, 404)
        missing_hooks.require_governed_access.assert_not_called()

        cases = [
            (_job_model(execution_mode="continuous"), SimpleNamespace(status="running"), True, False, False, 409, "CONTINUOUS_IMMUTABLE_CONFIG_ACTIVE"),
            (_job_model(status="running"), None, False, False, False, 409, ErrorCode.CONFLICT),
            (_job_model(execution_mode="continuous"), SimpleNamespace(status="stopped"), True, True, False, 409, "CONTINUOUS_CHECKPOINT_CONTRACT_IMMUTABLE"),
            (_job_model(), None, False, False, True, 422, ErrorCode.VALIDATION_ERROR),
        ]
        for job, runtime, changed, checkpoint, target_locked, http_status, code in cases:
            with self.subTest(code=code):
                hooks = _update_hooks()
                hooks.continuous_processing_contract_changed.return_value = changed
                hooks.continuous_checkpoint_initialized.return_value = checkpoint
                hooks.target_identity_changed.return_value = target_locked
                hooks.has_successful_run.return_value = target_locked
                with (
                    patch("app.application.etl_job_commands.etl_repository.get_job", return_value=job),
                    patch(
                        "app.application.etl_job_commands.etl_repository.get_kafka_continuous_runtime",
                        return_value=runtime,
                    ),
                    patch("app.application.etl_job_commands.etl_repository.save_job") as save_job,
                ):
                    with self.assertRaises(ApiError) as raised:
                        update_pipeline(db, job.id, request, ActorContext(name="editor"), hooks=hooks)
                self.assertEqual(raised.exception.status_code, http_status)
                self.assertEqual(raised.exception.code, code)
                hooks.apply_update_request.assert_not_called()
                save_job.assert_not_called()


if __name__ == "__main__":
    unittest.main()
