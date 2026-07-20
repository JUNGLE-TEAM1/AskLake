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
from app.schemas.common import ErrorCode
from app.schemas.continuous_sql import (
    ContinuousSqlBatch,
    ContinuousSqlCommandRequest,
    ContinuousSqlCommandResponse,
    ContinuousSqlCreateRequest,
    ContinuousSqlJob,
    ContinuousSqlJobList,
    ContinuousSqlPlanRequest,
    ContinuousSqlPlanResponse,
    ContinuousSqlRelationBinding,
)
from app.services.continuous_sql_catalog import ContinuousSqlCatalogResolver
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


logger = logging.getLogger(__name__)


class ContinuousSqlService:
    def __init__(
        self,
        db: Session,
        *,
        runtime_settings: Settings | None = None,
        gateway: ContinuousSqlWorkerGateway | None = None,
        publication_service: ContinuousSqlPublicationService | None = None,
    ) -> None:
        self.db = db
        self.settings = runtime_settings or settings
        self.repository = ContinuousSqlRepository(db)
        self.catalog_repository = CatalogRepository(db)
        self.catalog_resolver = ContinuousSqlCatalogResolver(db)
        self.planner = ContinuousSqlPlanner()
        self.gateway = gateway or RoutedContinuousSqlWorkerGateway(self.settings)
        self.publication_service = publication_service or ContinuousSqlPublicationService(db)

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
        if self.catalog_repository.get_dataset_payload(request.output.dataset_id) is not None:
            raise ApiError(
                ErrorCode.CONFLICT,
                "Continuous SQL output Dataset already exists in Catalog.",
                status.HTTP_409_CONFLICT,
                {"datasetId": request.output.dataset_id},
            )

        compiled = self._compile(request, actor, api_path="/api/query/continuous-jobs")
        job_id = f"csql_{uuid4().hex}"
        output_target, output_storage_path, checkpoint_path = self._resolve_create_output(
            request,
            job_id,
        )
        compiled_plan = {
            **compiled.compiled_plan,
            "servingMode": request.output.serving_mode,
        }
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
            plan_hash=compiled.plan_hash,
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
        if request.output.iceberg_target is None or request.output.storage_path is None:
            raise RuntimeError("Validated Iceberg output target is missing")
        output_target = request.output.iceberg_target
        output_storage_path = request.output.storage_path
        checkpoint_path = request.checkpoint_path or (
            f"{request.output.storage_path}/_checkpoints/{job_id}"
        )
        return output_target, output_storage_path, checkpoint_path

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
                worker_result = self.gateway.manage(job, run, "start")
            elif external_action is not None:
                worker_result = self.gateway.manage(job, run, external_action)
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
            joins=list(plan["joins"]),
            output_schema=list(plan["outputSchema"]),
            static_binding_policy=request.static_binding_policy,
            warnings=list(plan.get("warnings") or []),
            compiled_plan=plan,
        )

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
        bindings: list[dict[str, Any]] = []
        for persisted in job.relation_bindings or []:
            if not isinstance(persisted, dict):
                continue
            dataset_id = str(persisted.get("datasetId") or "")
            current = self.catalog_resolver.resolve_current(dataset_id)
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
                    worker.get("lastErrorMessage") or "Continuous SQL worker failed."
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
        return job_to_schema(job, run)

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
