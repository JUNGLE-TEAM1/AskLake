from __future__ import annotations

from datetime import UTC, datetime
import hashlib
import json
import logging
from typing import Any
from uuid import uuid4

from fastapi import status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, require_permission
from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.models.continuous_sql import (
    ContinuousSqlCommandModel,
    ContinuousSqlDependencyModel,
    ContinuousSqlIncrementalBindingModel,
    ContinuousSqlJobModel,
    ContinuousSqlRunModel,
)
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.continuous_sql_repository import (
    ContinuousSqlRepository,
    batch_to_schema,
    job_to_schema,
    jobs_to_schema,
)
from app.repositories.dashboard_live_repository import (
    DashboardLiveRepository,
    backfill_catalog_revision,
)
from app.schemas.common import ErrorCode
from app.schemas.continuous_sql import (
    ContinuousSqlBatch,
    ClickHouseWriterTarget,
    ContinuousSqlCommandRequest,
    ContinuousSqlCommandResponse,
    ContinuousSqlCreateRequest,
    ContinuousSqlDependencyBinding,
    ContinuousSqlJob,
    ContinuousSqlJobList,
    ContinuousSqlPlanRequest,
    ContinuousSqlPlanResponse,
    ContinuousSqlRelationBinding,
    continuous_sql_serving_mode,
)
from app.services.continuous_sql_catalog import ContinuousSqlCatalogResolver
from app.services.clickhouse_continuous_publication import (
    ClickHouseContinuousSqlPublicationService,
)
from app.services.continuous_sql_gateway import (
    ContinuousSqlWorkerGateway,
    RoutedContinuousSqlWorkerGateway,
)
from app.services.continuous_sql_planner import (
    ContinuousSqlPlanner,
    ContinuousSqlValidationError,
    compatible_join_types,
    normalize_identifier,
    normalize_type,
)
from app.services.continuous_sql_publication import (
    ContinuousSqlPublicationError,
    ContinuousSqlPublicationService,
)
from app.schemas.iceberg import IcebergWriterTarget
from app.services.iceberg_writer_service import IcebergWriterService, build_iceberg_writer_target


logger = logging.getLogger(__name__)


class ContinuousSqlService:
    def __init__(
        self,
        db: Session,
        *,
        runtime_settings: Settings | None = None,
        gateway: ContinuousSqlWorkerGateway | None = None,
        publication_service: ContinuousSqlPublicationService | None = None,
        clickhouse_publication_service: ClickHouseContinuousSqlPublicationService | None = None,
    ) -> None:
        self.db = db
        self.settings = runtime_settings or settings
        self.repository = ContinuousSqlRepository(db)
        self.catalog_repository = CatalogRepository(db)
        self.catalog_resolver = ContinuousSqlCatalogResolver(
            db,
            allow_clickhouse_streaming=(
                self.settings.clickhouse_realtime_v2_enabled
                and self.settings.kafka_connect_sink_enabled
                and self.settings.clickhouse_realtime_consumer_owner == "kafka_connect_v2"
            ),
        )
        self.planner = ContinuousSqlPlanner()
        self.gateway = gateway or RoutedContinuousSqlWorkerGateway(self.settings)
        self.publication_service = publication_service or ContinuousSqlPublicationService(db)
        self.clickhouse_publication_service = (
            clickhouse_publication_service
            or ClickHouseContinuousSqlPublicationService(db)
        )

    def validate(
        self,
        request: ContinuousSqlPlanRequest,
        actor: ActorContext,
    ) -> ContinuousSqlPlanResponse:
        self._require_enabled()
        return self._compile(request, actor, api_path="/api/query/continuous-jobs/validate")

    def create(
        self,
        request: ContinuousSqlCreateRequest,
        actor: ActorContext,
    ) -> ContinuousSqlJob:
        self._require_enabled()
        if request.output.serving_mode != self.settings.continuous_sql_serving_mode:
            raise ApiError(
                "CONTINUOUS_SQL_SERVING_MODE_DISABLED",
                "The requested Continuous SQL serving mode is disabled for this deployment.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {
                    "configuredServingMode": self.settings.continuous_sql_serving_mode,
                    "requestedServingMode": request.output.serving_mode,
                },
            )
        if request.output.serving_mode == "clickhouse":
            self._require_clickhouse_enabled()
            if request.static_binding_policy != "PINNED_AT_START":
                raise ApiError(
                    "CONTINUOUS_SQL_CLICKHOUSE_STATIC_BINDING_UNSUPPORTED",
                    "ClickHouse Continuous SQL currently requires PINNED_AT_START static bindings.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    {"staticBindingPolicy": request.static_binding_policy},
                )
        request_fingerprint = canonical_hash(
            request.model_dump(mode="json", by_alias=True, exclude={"client_request_id"})
        )
        if request.client_request_id:
            existing_request = self.repository.job_by_client_request(actor.name, request.client_request_id)
            if existing_request is not None:
                if existing_request.request_fingerprint != request_fingerprint:
                    raise ApiError(
                        ErrorCode.CONFLICT,
                        "clientRequestId was already used for a different Continuous SQL Job.",
                        status.HTTP_409_CONFLICT,
                        {"clientRequestId": request.client_request_id},
                    )
                return self._job_schema(existing_request)

        if self.repository.job_by_output_dataset(request.output.dataset_id) is not None:
            raise ApiError(
                ErrorCode.CONFLICT,
                "Continuous SQL output Dataset is already owned by another Job.",
                status.HTTP_409_CONFLICT,
                {"datasetId": request.output.dataset_id},
            )
        existing_output = self.catalog_repository.get_dataset_payload(request.output.dataset_id)
        if existing_output is not None and request.baseline_dataset_id is None:
            raise ApiError(
                ErrorCode.CONFLICT,
                "Continuous SQL output Dataset already exists in Catalog.",
                status.HTTP_409_CONFLICT,
                {"datasetId": request.output.dataset_id},
            )
        if request.baseline_dataset_id is not None and existing_output is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "The Trino baseline Dataset does not exist in Catalog.",
                status.HTTP_404_NOT_FOUND,
                {"datasetId": request.baseline_dataset_id},
            )

        compiled = self._compile(request, actor, api_path="/api/query/continuous-jobs")
        job_id = f"csql_{uuid4().hex}"
        incremental_binding: ContinuousSqlIncrementalBindingModel | None = None
        if request.baseline_dataset_id is not None:
            (
                output_target,
                output_storage_path,
                checkpoint_path,
                incremental_binding,
            ) = self._resolve_incremental_baseline(
                request,
                compiled.compiled_plan,
                job_id,
            )
        else:
            output_target, output_storage_path, checkpoint_path = self._resolve_create_output(
                request,
                job_id,
            )
        compiled_plan = compiled_plan_with_serving_mode(
            compiled.compiled_plan,
            request.output.serving_mode,
            job_id=job_id,
            max_offsets_per_trigger=self.settings.continuous_sql_micro_batch_max_rows,
        )
        job = ContinuousSqlJobModel(
            id=job_id,
            name=request.name.strip(),
            owner=actor.name,
            created_by=actor.name,
            client_request_id=request.client_request_id,
            request_fingerprint=request_fingerprint,
            original_sql=request.query,
            normalized_sql=compiled.normalized_sql,
            plan_version=compiled.plan_version,
            plan_hash=str(compiled_plan["planHash"]),
            compiled_plan=compiled_plan,
            relation_bindings=[
                item.model_dump(mode="json", by_alias=True)
                for item in compiled.relations
            ],
            static_binding_policy=request.static_binding_policy,
            trigger_interval_seconds=request.trigger_interval_seconds,
            checkpoint_path=checkpoint_path,
            output_dataset_id=request.output.dataset_id,
            output_dataset_name=request.output.dataset_name,
            output_layer=request.output.layer,
            output_storage_path=output_storage_path,
            output_target=output_target.model_dump(mode="json", by_alias=True),
            desired_state="stopped",
            observed_state="stopped",
            generation=0,
        )
        try:
            self.repository.add_job(job)
            self.repository.replace_dependencies(
                job.id,
                [
                    ContinuousSqlDependencyModel(
                        sql_job_id=job.id,
                        input_dataset_id=item.input_dataset_id,
                        child_job_id=item.child_job_id,
                        input_type=item.input_type,
                        execution_policy=item.execution_policy,
                        required=item.required,
                    )
                    for item in compiled.dependency_bindings
                ],
            )
            if incremental_binding is not None:
                self.repository.add_incremental_binding(incremental_binding)
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise ApiError(
                ErrorCode.CONFLICT,
                "Continuous SQL Job identity already exists.",
                status.HTTP_409_CONFLICT,
            ) from exc
        return self._job_schema(job)

    def _resolve_create_output(
        self,
        request: ContinuousSqlCreateRequest,
        job_id: str,
    ) -> tuple[Any, str, str]:
        if request.output.serving_mode == "clickhouse":
            if request.output.clickhouse_target is None:
                raise RuntimeError("Validated ClickHouse output target is missing")
            output_target = request.output.clickhouse_target
            if (
                self.settings.clickhouse_realtime_v2_enabled
                and self.settings.kafka_connect_sink_enabled
                and self.settings.clickhouse_realtime_consumer_owner == "kafka_connect_v2"
            ):
                output_target = ClickHouseWriterTarget(
                    database=self.settings.clickhouse_v2_database,
                    table="serving_events_v2",
                )
            output_storage_path = request.output.storage_path or output_target.table_uri
            checkpoint_path = request.checkpoint_path or (
                f"{output_target.table_uri}/_consumer/{job_id}"
            )
        else:
            output_target = request.output.iceberg_target or build_iceberg_writer_target(
                request.output.dataset_name,
                request.output.dataset_id,
                write_mode="append",
                runtime_settings=self.settings,
            )
            output_storage_path = request.output.storage_path or (
                f"s3a://{self.settings.asklake_spark_output_bucket}/"
                f"continuous-sql/{output_target.table}"
            )
            checkpoint_path = request.checkpoint_path or (
                f"{output_storage_path}/_checkpoints/{job_id}"
            )
            output_storage_path = _spark_object_storage_path(output_storage_path)
            checkpoint_path = _spark_object_storage_path(checkpoint_path)
        return output_target, output_storage_path, checkpoint_path

    def _resolve_incremental_baseline(
        self,
        request: ContinuousSqlCreateRequest,
        compiled_plan: dict[str, Any],
        job_id: str,
    ) -> tuple[
        IcebergWriterTarget,
        str,
        str,
        ContinuousSqlIncrementalBindingModel,
    ]:
        dataset_id = str(request.baseline_dataset_id or "").strip()
        payload = self.catalog_repository.get_dataset_payload(dataset_id) or {}
        mapping = payload.get("queryEngineTable")
        if (
            str(payload.get("queryEngineStatus") or "").strip().lower() != "available"
            or str(payload.get("storageFormat") or "").strip().lower() != "iceberg"
            or not isinstance(mapping, dict)
        ):
            raise ApiError(
                "CONTINUOUS_SQL_BASELINE_NOT_ICEBERG",
                "The Trino baseline must be an available Iceberg Dataset.",
                status.HTTP_409_CONFLICT,
                {"datasetId": dataset_id},
            )
        output_schema = [
            str(item[0]).strip().casefold()
            for item in compiled_plan.get("outputSchema") or []
            if isinstance(item, (list, tuple)) and len(item) >= 2
        ]
        baseline_schema = {
            str(item[0]).strip().casefold()
            for item in payload.get("schema") or []
            if isinstance(item, (list, tuple)) and len(item) >= 2
        }
        missing = [column for column in output_schema if column not in baseline_schema]
        if missing:
            raise ApiError(
                "CONTINUOUS_SQL_BASELINE_SCHEMA_MISMATCH",
                "The Trino baseline is missing Continuous SQL output columns.",
                status.HTTP_409_CONFLICT,
                {"datasetId": dataset_id, "missingColumns": missing},
            )
        target = IcebergWriterTarget(
            catalog=str(mapping.get("catalog") or "iceberg"),
            namespace=str(mapping.get("schema") or mapping.get("namespace") or ""),
            table=str(mapping.get("table") or ""),
            write_mode="append",
            partition_columns=list(dict.fromkeys([
                *list(mapping.get("partitionColumns") or []),
                "_asklake_run_id",
            ])),
        )
        writer = IcebergWriterService()
        writer.prepare_continuous_append_target(target)
        baseline_snapshot_id, _committed_at, warehouse_location = writer.current_snapshot(target)
        storage_path = str(
            request.output.storage_path
            or warehouse_location
            or payload.get("storageLocation")
        ).strip().rstrip("/")
        if not storage_path.startswith(("s3://", "s3a://")):
            raise ApiError(
                "CONTINUOUS_SQL_BASELINE_STORAGE_INVALID",
                "The Trino baseline does not expose an S3 Iceberg warehouse location.",
                status.HTTP_409_CONFLICT,
                {"datasetId": dataset_id},
            )
        storage_path = _spark_object_storage_path(storage_path)
        checkpoint_path = _spark_object_storage_path(
            request.checkpoint_path or f"{storage_path}/_checkpoints/{job_id}"
        )

        live = DashboardLiveRepository(self.db)
        baseline_freshness = live.get_freshness(dataset_id)
        if baseline_freshness is None:
            baseline_commit = backfill_catalog_revision(
                self.db,
                dataset_id=dataset_id,
                run_id=f"continuous-sql-baseline:{job_id}:{baseline_snapshot_id}",
                storage_location=warehouse_location,
                storage_format="iceberg",
                materialization_mode="snapshot",
                row_count=_catalog_row_count(payload.get("rows")),
                next_check_after_ms=max(
                    1_000,
                    min(60_000, int(request.trigger_interval_seconds) * 500),
                ),
            )
            baseline_revision = int(baseline_commit.revision)
        else:
            baseline_revision = int(baseline_freshness.latest_revision or 0)

        source_relation = next(
            (
                item
                for item in compiled_plan.get("relations") or []
                if isinstance(item, dict) and item.get("mode") == "streaming"
            ),
            None,
        )
        if not isinstance(source_relation, dict):
            raise ApiError(
                "CONTINUOUS_SQL_SOURCE_BINDING_MISSING",
                "Continuous SQL did not resolve one streaming source Dataset.",
                status.HTTP_409_CONFLICT,
            )
        source_dataset_id = str(source_relation.get("datasetId") or "").strip()
        source_freshness = live.get_freshness(source_dataset_id)
        source_revision = int(source_freshness.latest_revision or 0) if source_freshness else 0
        source_commits = live.list_commits(
            source_dataset_id,
            after_revision=max(-1, source_revision - 1),
            through_revision=source_revision if source_revision > 0 else None,
        )
        source_commit = source_commits[-1] if source_commits else None
        source = source_relation.get("streamingSource") or {}
        next_offsets = live.list_stream_partition_cursors(
            source_dataset_id,
            topic=str(source.get("topic") or "") or None,
        )
        static_snapshots = [
            {
                "datasetId": str(item.get("datasetId") or ""),
                "schemaFingerprint": str(item.get("schemaFingerprint") or ""),
                "snapshotId": str(item.get("snapshotId") or ""),
            }
            for item in compiled_plan.get("relations") or []
            if isinstance(item, dict) and item.get("mode") == "static"
        ]
        return (
            target,
            storage_path,
            checkpoint_path,
            ContinuousSqlIncrementalBindingModel(
                job_id=job_id,
                source_dataset_id=source_dataset_id,
                baseline_dataset_id=dataset_id,
                baseline_snapshot_id=baseline_snapshot_id,
                baseline_revision=baseline_revision,
                source_revision=source_revision,
                source_run_id=str(source_commit.run_id) if source_commit is not None else None,
                source_fingerprint=(
                    str(source_commit.source_fingerprint)
                    if source_commit is not None and source_commit.source_fingerprint
                    else None
                ),
                source_ranges=(
                    list(source_commit.source_ranges or []) if source_commit is not None else []
                ),
                static_snapshots=static_snapshots,
                next_offsets=next_offsets,
                output_revision=baseline_revision,
                status="ready",
            ),
        )

    def list(self, actor: ActorContext) -> ContinuousSqlJobList:
        jobs = self.repository.list_jobs(owner=None if actor.is_admin else actor.name)
        return ContinuousSqlJobList(jobs=jobs_to_schema(jobs, self.repository))

    def get(
        self,
        job_id: str,
        actor: ActorContext,
        *,
        reconcile: bool = True,
    ) -> ContinuousSqlJob:
        job = self._require_job(job_id, actor)
        if reconcile and job.observed_state in {
            "starting", "running", "pausing", "stopping", "recovering",
        }:
            job = self.reconcile(job)
        return self._job_schema(job)

    def command(
        self,
        job_id: str,
        request: ContinuousSqlCommandRequest,
        actor: ActorContext,
    ) -> ContinuousSqlCommandResponse:
        if request.command in {"start", "resume", "recover"}:
            self._require_enabled()
        job = self._require_job(job_id, actor, for_update=True)
        if request.command in {"start", "resume", "recover"}:
            if continuous_sql_serving_mode(job) == "clickhouse":
                self._require_clickhouse_enabled()
            self._require_relation_access(job, actor)
        fingerprint = canonical_hash({"command": request.command})
        existing_command = self.repository.get_command(job.id, request.command_id)
        if existing_command is not None:
            if existing_command.request_fingerprint != fingerprint:
                raise ApiError(
                    ErrorCode.CONFLICT,
                    "commandId was already used for a different command.",
                    status.HTTP_409_CONFLICT,
                    {"commandId": request.command_id},
                )
            return ContinuousSqlCommandResponse(
                command=request.command,
                command_id=request.command_id,
                idempotent_replay=True,
                job=self._job_schema(job),
            )

        previous_run = self.repository.get_run(job.active_run_id) if job.active_run_id else None
        run, external_action = self._transition_command(job, previous_run, request.command)

        command = ContinuousSqlCommandModel(
            id=f"{job.id}:{request.command_id}",
            job_id=job.id,
            command_id=request.command_id,
            command=request.command,
            request_fingerprint=fingerprint,
            status="accepted",
        )
        self.repository.add_command(command)
        self.db.add(job)
        if run is not None:
            self.db.add(run)
        self.db.commit()

        try:
            worker_result: dict[str, Any] = {}
            if external_action == "recover":
                self.gateway.manage(job, previous_run, "terminate")
                worker_result = self.gateway.manage(
                    job, run, "start", self._worker_start_options(job)
                )
            elif external_action is not None:
                worker_result = self.gateway.manage(
                    job,
                    run,
                    external_action,
                    self._worker_start_options(job) if external_action == "start" else None,
                )
            self._complete_command(job.id, run.run_id if run else None, command.id, request.command, worker_result)
        except ApiError as exc:
            self._fail_command(job.id, run.run_id if run else None, command.id, exc)
            raise

        refreshed = self.repository.get_job(job.id)
        if refreshed is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Continuous SQL Job disappeared.", status.HTTP_404_NOT_FOUND)
        return ContinuousSqlCommandResponse(
            command=request.command,
            command_id=request.command_id,
            job=self._job_schema(refreshed),
        )

    def _transition_command(
        self,
        job: ContinuousSqlJobModel,
        previous_run: ContinuousSqlRunModel | None,
        command: str,
    ) -> tuple[ContinuousSqlRunModel | None, str | None]:
        run = previous_run
        external_action: str | None = None
        if command == "start":
            if job.desired_state != "stopped" or job.observed_state not in {"stopped", "failed"}:
                self._invalid_transition(job, command)
            run = self._new_run(job, observed_state="starting")
            external_action = "start"
        elif command == "recover":
            if job.desired_state != "running" or job.observed_state not in {"failed", "stopped"}:
                self._invalid_transition(job, command)
            run = self._new_run(job, observed_state="recovering")
            external_action = "recover"
        elif command == "pause":
            if job.desired_state == "paused" and job.observed_state in {"paused", "pausing"}:
                external_action = None
            elif job.desired_state != "running" or job.observed_state not in {"starting", "running", "recovering"}:
                self._invalid_transition(job, command)
            else:
                job.desired_state = "paused"
                job.observed_state = "pausing"
                if run is not None:
                    run.status = "pausing"
                external_action = "pause"
        elif command == "resume":
            if job.desired_state != "paused" or job.observed_state not in {"paused", "failed"} or run is None:
                self._invalid_transition(job, command)
            job.desired_state = "running"
            job.observed_state = "starting"
            run.status = "starting"
            run.ended_at = None
            run.last_error_code = None
            run.last_error_message = None
            external_action = "start"
        elif command == "stop":
            if job.desired_state == "stopped" and job.observed_state == "stopped":
                external_action = None
            else:
                job.desired_state = "stopped"
                job.observed_state = "stopping"
                if run is not None:
                    run.status = "stopping"
                external_action = "stop"
        else:  # Pydantic prevents this, but keep the transition boundary explicit.
            self._invalid_transition(job, command)
        return run, external_action

    def list_batches(
        self,
        job_id: str,
        actor: ActorContext,
        *,
        limit: int = 100,
    ) -> list[ContinuousSqlBatch]:
        self._require_job(job_id, actor)
        return [batch_to_schema(item) for item in self.repository.list_batches(job_id, limit=limit)]

    def reconcile(self, job: ContinuousSqlJobModel) -> ContinuousSqlJobModel:
        run = self.repository.get_run(job.active_run_id) if job.active_run_id else None
        try:
            worker = self.gateway.manage(job, run, "status")
        except ApiError as exc:
            job.last_error_code = str(exc.code)
            job.last_error_message = exc.message
            self.db.add(job)
            self.db.commit()
            return job
        report = worker.get("report") if isinstance(worker.get("report"), dict) else None
        container_state = str(worker.get("containerState") or "unknown")
        job.worker_id = str(worker.get("containerId") or worker.get("workerAttemptId") or "") or job.worker_id
        if run is not None and job.worker_id:
            run.worker_id = job.worker_id

        if report is not None and run is not None:
            identity_error = worker_identity_error(job, run, report)
            if identity_error:
                job.observed_state = "failed"
                job.last_error_code = identity_error
                job.last_error_message = "A stale or mismatched Continuous SQL worker report was rejected."
                run.status = "failed"
                run.last_error_code = identity_error
                run.last_error_message = job.last_error_message
            else:
                self._apply_worker_report(job, run, report)
                self._reconcile_publications(job, run, report)
        elif (
            continuous_sql_serving_mode(job) == "clickhouse"
            and container_state == "running"
            and run is not None
        ):
            if job.desired_state == "running":
                job.observed_state = "running"
                run.status = "running"
            try:
                self.clickhouse_publication_service.reconcile_progress(job, run, worker)
                job.last_error_code = None
                job.last_error_message = None
                run.last_error_code = None
                run.last_error_message = None
            except ValueError as exc:
                job.last_error_code = "CLICKHOUSE_PUBLICATION_INVALID"
                job.last_error_message = str(exc)[:2000]
                run.last_error_code = job.last_error_code
                run.last_error_message = job.last_error_message
        elif (
            continuous_sql_serving_mode(job) == "clickhouse"
            and container_state == "starting"
            and run is not None
        ):
            if job.desired_state == "running":
                job.observed_state = "starting"
                run.status = "starting"
            job.last_error_code = None
            job.last_error_message = None
            run.last_error_code = None
            run.last_error_message = None
        elif (
            continuous_sql_serving_mode(job) == "clickhouse"
            and container_state == "failed"
            and run is not None
        ):
            job.observed_state = "failed"
            job.last_error_code = str(
                worker.get("lastErrorCode") or "CLICKHOUSE_CONTINUOUS_SQL_FAILED"
            )
            job.last_error_message = str(
                worker.get("lastErrorMessage") or "ClickHouse Continuous SQL worker failed."
            )[:2000]
            run.status = "failed"
            run.last_error_code = job.last_error_code
            run.last_error_message = job.last_error_message
        elif container_state in {"exited", "missing", "not_running"}:
            if job.desired_state == "paused":
                job.observed_state = "paused"
                if run is not None:
                    run.status = "paused"
            elif job.desired_state == "stopped":
                job.observed_state = "stopped"
                if run is not None:
                    run.status = "stopped"
                    run.ended_at = run.ended_at or utc_now()
            elif job.desired_state == "running":
                job.observed_state = "failed"
                job.last_error_code = "CONTINUOUS_SQL_WORKER_MISSING"
                job.last_error_message = "Continuous SQL worker is not running."
                if run is not None:
                    run.status = "failed"
                    run.last_error_code = job.last_error_code
                    run.last_error_message = job.last_error_message

        self.db.add(job)
        if run is not None:
            self.db.add(run)
        self.db.commit()
        return job

    def _compile(
        self,
        request: ContinuousSqlPlanRequest,
        actor: ActorContext,
        *,
        api_path: str,
    ) -> ContinuousSqlPlanResponse:
        if (
            request.static_binding_policy == "LATEST_PER_BATCH"
            and not self.settings.latest_static_per_batch_enabled
        ):
            raise ApiError(
                "CONTINUOUS_SQL_LATEST_PER_BATCH_DISABLED",
                "LATEST_PER_BATCH requires LATEST_STATIC_PER_BATCH_ENABLED=true.",
                status.HTTP_409_CONFLICT,
            )
        try:
            relations = self.catalog_resolver.resolve_authorized(
                request.relation_dataset_ids,
                actor,
                api_path=api_path,
            )
            compiled = self.planner.compile(
                request.query,
                relations,
                static_binding_policy=request.static_binding_policy,
                trigger_interval_seconds=request.trigger_interval_seconds,
                static_broadcast_max_rows=self.settings.continuous_sql_static_broadcast_max_rows,
                static_cache_max_rows=self.settings.continuous_sql_static_cache_max_rows,
                static_pruning_max_keys=self.settings.continuous_sql_static_pruning_max_keys,
                max_output_rows_per_input=self.settings.continuous_sql_max_output_rows_per_input,
            )
        except ContinuousSqlValidationError as exc:
            raise ApiError(
                exc.code,
                exc.message,
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                exc.details,
            ) from exc
        plan = compiled.plan
        return ContinuousSqlPlanResponse(
            normalized_sql=compiled.normalized_sql,
            plan_version=str(plan["planVersion"]),
            plan_hash=compiled.plan_hash,
            runtime_sql=compiled.runtime_sql,
            relations=[ContinuousSqlRelationBinding.model_validate(item) for item in plan["relations"]],
            dependency_bindings=self._dependency_bindings(relations),
            joins=list(plan["joins"]),
            output_schema=list(plan["outputSchema"]),
            static_binding_policy=request.static_binding_policy,
            warnings=list(plan.get("warnings") or []),
            compiled_plan=plan,
        )

    @staticmethod
    def _dependency_bindings(
        relations: list[Any],
    ) -> list[ContinuousSqlDependencyBinding]:
        return [
            ContinuousSqlDependencyBinding(
                input_dataset_id=relation.dataset_id,
                child_job_id=relation.producer_job_id,
                input_type=(
                    "realtime"
                    if relation.mode == "streaming"
                    else "batch"
                    if relation.producer_job_id
                    else "static"
                ),
                execution_policy=(
                    "run_on_tree_start"
                    if relation.producer_job_id
                    else "reuse_snapshot"
                ),
                required=True,
            )
            for relation in relations
        ]

    def _new_run(
        self,
        job: ContinuousSqlJobModel,
        *,
        observed_state: str,
    ) -> ContinuousSqlRunModel:
        try:
            bindings = self._resolve_run_bindings(job)
        except ContinuousSqlValidationError as exc:
            raise ApiError(exc.code, exc.message, status.HTTP_409_CONFLICT, exc.details) from exc
        generation = int(job.generation or 0) + 1
        fencing_token = uuid4().hex
        run_id = f"csqlrun_{job.id}_{generation}_{uuid4().hex[:12]}"
        run = ContinuousSqlRunModel(
            run_id=run_id,
            job_id=job.id,
            generation=generation,
            fencing_token=fencing_token,
            plan_hash=job.plan_hash,
            status=observed_state,
            static_bindings=bindings,
            checkpoint_path=job.checkpoint_path,
            started_at=utc_now(),
        )
        self.repository.add_run(run)
        job.generation = generation
        job.fencing_token = fencing_token
        job.active_run_id = run_id
        job.desired_state = "running"
        job.observed_state = observed_state
        job.last_error_code = None
        job.last_error_message = None
        return run

    def _resolve_run_bindings(self, job: ContinuousSqlJobModel) -> list[dict[str, Any]]:
        legacy_direct_consumer = not self.repository.list_dependencies(job.id)
        incremental = self.repository.get_incremental_binding(job.id)
        pinned_by_dataset = {
            str(item.get("datasetId") or ""): item
            for item in (incremental.static_snapshots if incremental is not None else [])
            if isinstance(item, dict)
        }
        bindings: list[dict[str, Any]] = []
        for persisted in job.relation_bindings or []:
            if not isinstance(persisted, dict):
                continue
            dataset_id = str(persisted.get("datasetId") or "")
            current = self.catalog_resolver.resolve_current(
                dataset_id,
                legacy_binding=persisted if legacy_direct_consumer else None,
            )
            if current.mode != str(persisted.get("mode") or ""):
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_RELATION_MODE_CHANGED",
                    "A bound relation changed between streaming and static mode.",
                    {"datasetId": dataset_id},
                )
            expected_schema = {
                normalize_identifier(item[0]): normalize_type(item[1])
                for item in persisted.get("schema") or []
                if isinstance(item, (list, tuple)) and len(item) >= 2
            }
            current_schema = {
                normalize_identifier(name): normalize_type(type_name)
                for name, type_name in current.schema
            }
            for column in persisted.get("referencedColumns") or []:
                key = normalize_identifier(column)
                if (
                    key not in expected_schema
                    or key not in current_schema
                    or not compatible_join_types(expected_schema[key], current_schema[key])
                ):
                    raise ContinuousSqlValidationError(
                        "CONTINUOUS_SQL_SCHEMA_INCOMPATIBLE",
                        "A referenced relation column changed incompatibly after planning.",
                        {"datasetId": dataset_id, "column": column},
                    )
            if current.mode == "static":
                pinned = pinned_by_dataset.get(dataset_id)
                if pinned is not None:
                    if not str(pinned.get("snapshotId") or "").strip():
                        raise ContinuousSqlValidationError(
                            "CONTINUOUS_SQL_STATIC_SNAPSHOT_MISSING",
                            "The incremental binding has no pinned static snapshot.",
                            {"datasetId": dataset_id},
                        )
                    bindings.append(dict(pinned))
                    continue
                if not current.snapshot_id:
                    raise ContinuousSqlValidationError(
                        "CONTINUOUS_SQL_STATIC_SNAPSHOT_MISSING",
                        "A static relation has no committed snapshot at run start.",
                        {"datasetId": dataset_id},
                    )
                bindings.append({
                    "datasetId": dataset_id,
                    "schemaFingerprint": current.schema_fingerprint,
                    "snapshotId": current.snapshot_id,
                })
        return bindings

    def _worker_start_options(self, job: ContinuousSqlJobModel) -> dict[str, Any]:
        binding = self.repository.get_incremental_binding(job.id)
        options: dict[str, Any] = {
            "maxOffsetsPerTrigger": int(self.settings.continuous_sql_micro_batch_max_rows),
        }
        if binding is None:
            return options
        next_offsets = list(binding.next_offsets or [])
        options["streamPartitionCursors"] = next_offsets
        starting_offsets: dict[str, dict[str, int]] = {}
        for item in next_offsets:
            if not isinstance(item, dict):
                continue
            topic = str(item.get("topic") or "").strip()
            if not topic:
                continue
            try:
                partition = str(int(item.get("partition")))
                next_offset = int(item.get("nextOffset"))
            except (TypeError, ValueError):
                continue
            starting_offsets.setdefault(topic, {})[partition] = next_offset
        if starting_offsets:
            options["initialOffsetPolicy"] = json.dumps(
                starting_offsets,
                sort_keys=True,
                separators=(",", ":"),
            )
        return options

    def _require_relation_access(
        self,
        job: ContinuousSqlJobModel,
        actor: ActorContext,
    ) -> None:
        dataset_ids = [
            str(item.get("datasetId") or "").strip()
            for item in job.relation_bindings or []
            if isinstance(item, dict) and str(item.get("datasetId") or "").strip()
        ]
        self.catalog_resolver.resolve_authorized(
            dataset_ids,
            actor,
            api_path=f"/api/query/continuous-jobs/{job.id}/commands",
        )

    def _complete_command(
        self,
        job_id: str,
        run_id: str | None,
        command_record_id: str,
        command_name: str,
        worker: dict[str, Any],
    ) -> None:
        job = self.repository.lock_job(job_id)
        if job is None:
            return
        run = self.repository.get_run(run_id) if run_id else None
        container_state = str(worker.get("containerState") or "")
        worker_id = str(worker.get("containerId") or worker.get("workerAttemptId") or "") or None
        if command_name in {"start", "resume", "recover"}:
            if container_state == "failed":
                job.observed_state = "failed"
                job.last_error_code = str(
                    worker.get("lastErrorCode") or "CLICKHOUSE_CONTINUOUS_SQL_FAILED"
                )
                job.last_error_message = str(
                    worker.get("lastErrorMessage") or "ClickHouse Continuous SQL worker failed."
                )[:2000]
            else:
                job.observed_state = "running" if container_state == "running" else "starting"
                job.last_error_code = None
                job.last_error_message = None
            if run is not None:
                run.status = job.observed_state
                run.last_error_code = job.last_error_code
                run.last_error_message = job.last_error_message
        elif command_name == "pause":
            job.observed_state = "paused" if container_state in {"exited", "not_running"} else "pausing"
            if run is not None:
                run.status = job.observed_state
        elif command_name == "stop":
            job.observed_state = "stopped" if container_state in {"exited", "not_running", "missing"} else "stopping"
            if run is not None:
                run.status = job.observed_state
                if job.observed_state == "stopped":
                    run.ended_at = utc_now()
        if worker_id:
            job.worker_id = worker_id
            if run is not None:
                run.worker_id = worker_id
        command = self.db.get(ContinuousSqlCommandModel, command_record_id)
        if command is not None:
            command.status = "failed" if container_state == "failed" else "completed"
            command.result = {
                "containerState": container_state or None,
                "code": job.last_error_code if container_state == "failed" else None,
                "message": job.last_error_message if container_state == "failed" else None,
                "workerId": worker_id,
            }
            self.db.add(command)
        self.db.add(job)
        if run is not None:
            self.db.add(run)
        self.db.commit()

    def _fail_command(
        self,
        job_id: str,
        run_id: str | None,
        command_record_id: str,
        error: ApiError,
    ) -> None:
        job = self.repository.lock_job(job_id)
        if job is None:
            return
        run = self.repository.get_run(run_id) if run_id else None
        job.observed_state = "failed"
        job.last_error_code = str(error.code)
        job.last_error_message = error.message
        if run is not None:
            run.status = "failed"
            run.last_error_code = str(error.code)
            run.last_error_message = error.message
        command = self.db.get(ContinuousSqlCommandModel, command_record_id)
        if command is not None:
            command.status = "failed"
            command.result = {"code": str(error.code), "message": error.message}
            self.db.add(command)
        self.db.add(job)
        if run is not None:
            self.db.add(run)
        self.db.commit()

    def _apply_worker_report(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        report: dict[str, Any],
    ) -> None:
        report_status = str(report.get("status") or "").strip().casefold()
        if report_status in {"starting", "running", "paused", "stopped", "failed"}:
            if report_status == "running" and job.desired_state == "paused":
                job.observed_state = "pausing"
                run.status = "pausing"
            elif report_status == "running" and job.desired_state == "stopped":
                job.observed_state = "stopping"
                run.status = "stopping"
            else:
                job.observed_state = report_status
                run.status = report_status
        if report_status == "failed":
            job.last_error_code = "CONTINUOUS_SQL_EXECUTE_FAILED"
            job.last_error_message = str(report.get("lastError") or "Continuous SQL worker failed.")[:2000]
            run.last_error_code = job.last_error_code
            run.last_error_message = job.last_error_message
        elif report_status in {"starting", "running"}:
            job.last_error_code = None
            job.last_error_message = None
            run.last_error_code = None
            run.last_error_message = None
        if report_status in {"paused", "stopped"}:
            run.ended_at = run.ended_at or utc_now()

    def _reconcile_publications(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        report: dict[str, Any],
    ) -> None:
        publications = sorted(
            [item for item in report.get("publishedBatches") or [] if isinstance(item, dict)],
            key=lambda item: int(item.get("batchId") or 0),
        )
        acknowledged: int | None = None
        for publication in publications:
            try:
                batch = self.publication_service.reconcile_manifest(job, run, publication)
            except (ContinuousSqlPublicationError, ValueError) as exc:
                code = getattr(exc, "code", "CONTINUOUS_SQL_PUBLICATION_INVALID")
                job.last_error_code = str(code)
                job.last_error_message = str(exc)[:2000]
                break
            if batch.stage != "dashboard_ready":
                job.last_error_code = batch.last_error_code or "CONTINUOUS_SQL_PUBLICATION_PENDING"
                job.last_error_message = batch.last_error_message or "Continuous SQL publication is waiting for Catalog queryability."
                break
            acknowledged = int(batch.batch_id)
        if acknowledged is not None:
            try:
                self.gateway.manage(job, run, "ack", {"batchId": acknowledged})
            except ApiError as exc:
                job.last_error_code = str(exc.code)
                job.last_error_message = "Publication succeeded but worker ACK will be retried."

    def _require_enabled(self) -> None:
        if self.settings.continuous_sql_join_enabled:
            return
        raise ApiError(
            "CONTINUOUS_SQL_DISABLED",
            "Continuous SQL JOIN is disabled.",
            status.HTTP_409_CONFLICT,
            {"setting": "CONTINUOUS_SQL_JOIN_ENABLED"},
        )

    def _require_clickhouse_enabled(self) -> None:
        if self.settings.clickhouse_continuous_join_enabled or (
            self.settings.clickhouse_realtime_v2_enabled
            and self.settings.kafka_connect_sink_enabled
            and self.settings.clickhouse_realtime_consumer_owner == "kafka_connect_v2"
        ):
            return
        raise ApiError(
            "CLICKHOUSE_CONTINUOUS_SQL_DISABLED",
            "ClickHouse Continuous SQL serving is disabled.",
            status.HTTP_409_CONFLICT,
            {
                "settings": [
                    "CLICKHOUSE_CONTINUOUS_JOIN_ENABLED",
                    "CLICKHOUSE_REALTIME_V2_ENABLED",
                    "KAFKA_CONNECT_SINK_ENABLED",
                    "CLICKHOUSE_REALTIME_CONSUMER_OWNER",
                ]
            },
        )

    def _require_job(
        self,
        job_id: str,
        actor: ActorContext,
        *,
        for_update: bool = False,
    ) -> ContinuousSqlJobModel:
        job = self.repository.lock_job(job_id) if for_update else self.repository.get_job(job_id)
        if job is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "Continuous SQL Job not found.",
                status.HTTP_404_NOT_FOUND,
                {"jobId": job_id},
            )
        require_permission(actor, "manage" if for_update else "view", owner=job.owner, resource_label="Continuous SQL Job")
        return job

    def _job_schema(self, job: ContinuousSqlJobModel) -> ContinuousSqlJob:
        run = self.repository.get_run(job.active_run_id) if job.active_run_id else None
        return job_to_schema(
            job,
            run,
            self.repository.get_incremental_binding(job.id),
            self.repository.list_dependencies(job.id),
        )

    @staticmethod
    def _invalid_transition(job: ContinuousSqlJobModel, command: str) -> None:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous SQL command is invalid for the current desired/observed state.",
            status.HTTP_409_CONFLICT,
            {
                "command": command,
                "desiredState": job.desired_state,
                "observedState": job.observed_state,
            },
        )


def _spark_object_storage_path(value: str) -> str:
    normalized = str(value or "").strip().rstrip("/")
    if normalized.casefold().startswith("s3://"):
        return f"s3a://{normalized[5:]}"
    return normalized


def _catalog_row_count(value: Any) -> int:
    digits = "".join(character for character in str(value or "") if character.isdigit())
    return int(digits or 0)


def worker_identity_error(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel,
    report: dict[str, Any],
) -> str | None:
    expected_fence = hashlib.sha256(run.fencing_token.encode("utf-8")).hexdigest()
    try:
        generation = int(report.get("continuousSqlRunGeneration"))
    except (TypeError, ValueError):
        return "CONTINUOUS_SQL_WORKER_IDENTITY_MISSING"
    if str(report.get("continuousSqlPlanHash") or "") != job.plan_hash:
        return "CONTINUOUS_SQL_WORKER_PLAN_MISMATCH"
    if generation != run.generation:
        return "CONTINUOUS_SQL_WORKER_GENERATION_STALE"
    if str(report.get("continuousSqlFencingTokenHash") or "") != expected_fence:
        return "CONTINUOUS_SQL_WORKER_FENCED"
    return None


def canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def compiled_plan_with_serving_mode(
    compiled_plan: dict[str, Any],
    serving_mode: str,
    *,
    job_id: str | None = None,
    max_offsets_per_trigger: int | None = None,
) -> dict[str, Any]:
    plan_without_hash = {
        key: value for key, value in compiled_plan.items() if key != "planHash"
    }
    plan_without_hash["servingMode"] = serving_mode
    streaming_source = plan_without_hash.get("streamingSource")
    if isinstance(streaming_source, dict):
        streaming_source = dict(streaming_source)
        if job_id:
            streaming_source["consumerGroupId"] = f"asklake-continuous-sql-{job_id}"
        if max_offsets_per_trigger is not None:
            streaming_source["maxOffsetsPerTrigger"] = max(
                1,
                int(max_offsets_per_trigger),
            )
        plan_without_hash["streamingSource"] = streaming_source
    return {
        **plan_without_hash,
        "planHash": canonical_hash(plan_without_hash),
    }


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def sync_active_continuous_sql_jobs() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as discovery_db:
        job_ids = [job.id for job in ContinuousSqlRepository(discovery_db).list_active_jobs()]
    for job_id in job_ids:
        with SessionLocal() as db:
            try:
                service = ContinuousSqlService(db)
                job = service.repository.get_job(job_id)
                if job is not None:
                    service.reconcile(job)
            except Exception:  # Keep other long-running Jobs reconcilable.
                logger.exception("Continuous SQL reconciliation failed for job_id=%s", job_id)
