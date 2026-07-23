from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.domain.audit import AuditTargetType
from app.models import ETLJobModel, ETLRunModel
from app.repositories import etl_repository
from app.repositories.audit_repository import safe_record_audit_event
from app.ports.catalog import CatalogWriterPort
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import QueryEngineTableRef
from app.schemas.common import ErrorCode
from app.schemas.etl import CatalogDataset, JobRowData, JobRunSummary
from app.schemas.trino import TrinoClientPage
from app.services.query_engine_registration_service import QueryEngineRegistrationService, build_query_engine_table
from app.services.materialization_projection import upsert_materialization_run
from app.services.trino_client import TrinoClient
from app.services.trino_query_run_service import TrinoQueryRunService, trino_stats, trino_status


TERMINAL_TRINO_STATUSES = {"succeeded", "failed", "cancelled"}


@dataclass(frozen=True)
class TrinoSqlJobCommandResult:
    dataset: CatalogDataset | None
    job: JobRowData
    run: JobRunSummary


class TrinoSqlJobService:
    """Execute a persisted SQL recipe as a versioned Trino Iceberg materialization."""

    def __init__(
        self,
        repository: SqlRepository,
        catalog_repository: CatalogWriterPort,
        runtime_settings: Settings | None = None,
        *,
        client: TrinoClient | None = None,
    ) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository
        self.settings = runtime_settings or settings
        self.client = client or TrinoClient(
            self.settings,
            username=self.settings.trino_materializer_username,
            password=self.settings.trino_materializer_password,
        )
        self.registration = QueryEngineRegistrationService(
            self.catalog_repository,
            client=self.client,
            runtime_settings=self.settings,
        )
        self.query_access = TrinoQueryRunService(
            self.repository,
            self.catalog_repository,
            runtime_settings=self.settings,
        )

    def submit(
        self,
        job: ETLJobModel,
        command: str,
        actor: ActorContext,
        *,
        run_id: str | None = None,
        auto_refresh_context: dict[str, Any] | None = None,
    ) -> TrinoSqlJobCommandResult:
        self._require_job(job)
        resolved_run_id = run_id or f"run_sql_{uuid4().hex[:16]}"
        job = self._lock_submission_job(job.id)
        self._require_submission_slot(
            job,
            resolved_run_id,
            auto_refresh_context,
        )
        run, payload, target = self._reserve_submission(
            job,
            actor,
            resolved_run_id,
            auto_refresh_context,
        )

        try:
            self._ensure_target_schema(target)
        except ApiError as exc:
            rejected_payload = {
                **payload,
                "error": {"code": str(exc.code), "message": exc.message},
                "status": "failed",
                "submissionOutcome": "rejected",
            }
            self._finalize(rejected_payload, "failed", exc.message)
            raise

        try:
            page = self.client.submit(str(payload["query"]))
        except ApiError as exc:
            self._persist_unknown_submission(job, run, payload, actor, exc)
            raise

        trino_run_status = self._persist_accepted_submission(job, run, payload, page)
        self._record(f"{command}_submitted", job, resolved_run_id, actor)

        if trino_run_status in TERMINAL_TRINO_STATUSES:
            return self._finalize(payload, trino_run_status, page.error.message if page.error else None)
        return self._result(job, run)

    def cancel(self, job: ETLJobModel, actor: ActorContext) -> TrinoSqlJobCommandResult:
        self._require_job(job)
        payload = self.repository.get_active_trino_job_run_payload(job.id)
        if payload is None:
            raise ApiError(
                ErrorCode.INVALID_JOB_STATE,
                "SQL Job has no active Trino run to cancel",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"jobId": job.id},
            )
        run_id = str(payload["runId"])
        next_uri = str(payload.get("trinoNextUri") or "").strip()
        if payload.get("submissionOutcome") == "pending" and not next_uri:
            raise ApiError(
                ErrorCode.CONFLICT,
                "Trino submission is still awaiting its coordinator response",
                status.HTTP_409_CONFLICT,
                {"jobId": job.id, "runId": run_id},
            )
        cancelled_payload = dict(payload)
        cancelled_payload.update({"status": "cancelled", "trinoNextUri": None})
        if not self.repository.cancel_trino_run_payload(cancelled_payload):
            persisted = self.repository.get_run_payload(run_id) or cancelled_payload
            return self._result_for_payload(persisted)
        if next_uri:
            try:
                self.client.cancel(next_uri)
            except ApiError:
                pass
        self._drop_unpublished_target(payload)
        result = self._finalize(cancelled_payload, "cancelled", "사용자가 실행을 취소했습니다.")
        self._record("cancelled", job, run_id, actor)
        return result

    def collect_claimed_run(self, run_id: str, worker_id: str, generation: int) -> JobRunSummary:
        payload = self._payload(run_id)
        persisted_status = str(payload.get("status") or "")
        if persisted_status in TERMINAL_TRINO_STATUSES and payload.get("finalized") is not True:
            return self._finalize(
                payload,
                persisted_status,
                str(dict_value(payload.get("error")).get("message") or "") or None,
            ).run
        pages_collected = 0
        while str(payload.get("status") or "") not in TERMINAL_TRINO_STATUSES:
            next_uri = str(payload.get("trinoNextUri") or "").strip()
            if not next_uri:
                break
            if not self.repository.renew_trino_collector_lease(
                run_id,
                worker_id,
                generation,
                self.settings.trino_collector_lease_seconds,
            ):
                return self._run_schema(run_id)
            page = self.client.fetch(next_uri)
            if not self.repository.renew_trino_collector_lease(
                run_id,
                worker_id,
                generation,
                self.settings.trino_collector_lease_seconds,
            ):
                return self._run_schema(run_id)
            run_status = trino_status(page)
            updated = dict(payload)
            updated.update({
                "error": error_payload(page),
                "rawStats": page.raw_stats,
                "status": run_status,
                "trinoNextUri": page.next_uri,
                "trinoQueryId": page.query_id or payload.get("trinoQueryId"),
                "updateCount": page.update_count if page.update_count is not None else payload.get("updateCount"),
            })
            if not self.repository.save_collector_run_payload(updated, worker_id=worker_id, generation=generation):
                return self._run_schema(run_id)
            self._apply_progress(updated, page, run_status)
            if run_status in TERMINAL_TRINO_STATUSES:
                return self._finalize(updated, run_status, page.error.message if page.error else None).run
            payload = self._payload(run_id)
            pages_collected += 1
            if pages_collected >= self.settings.trino_collector_pages_per_lease:
                self.repository.release_trino_collector_lease(run_id, worker_id, generation)
                return self._run_schema(run_id)

        self.repository.release_trino_collector_lease(run_id, worker_id, generation)
        return self._run_schema(run_id)

    def _apply_progress(self, payload: dict[str, Any], page: TrinoClientPage, run_status: str) -> None:
        run_id = str(payload["etlRunId"])
        job = etl_repository.get_job_for_update(self.repository.db, str(payload["jobId"]))
        run = etl_repository.get_run_model(self.repository.db, run_id)
        if job is None or run is None:
            return
        run.status = etl_run_status(run_status)
        run.airflow_state = run_status
        run.task_states = task_states(run_status, page)
        if self._auto_refresh_claim_matches(job, payload):
            job.status = "running"
            job.last_state = "Trino Iceberg materialization 실행 중"
            job.progress = progress_payload(page, run_status)
            job.dag_steps = dag_steps(run_status, page)
            job.dag_steps_by_run_id = {
                **(job.dag_steps_by_run_id or {}),
                run_id: job.dag_steps,
            }
            self.repository.db.add(job)
        self.repository.db.add(run)
        self.repository.db.commit()

    def _finalize(self, payload: dict[str, Any], run_status: str, error_message: str | None) -> TrinoSqlJobCommandResult:
        job = etl_repository.get_job_for_update(self.repository.db, str(payload["jobId"]))
        run = etl_repository.get_run_model(self.repository.db, str(payload["etlRunId"]))
        if job is None or run is None:
            raise ApiError(ErrorCode.NOT_FOUND, "SQL Job run state was not found", status.HTTP_404_NOT_FOUND)
        target = QueryEngineTableRef.model_validate(payload["target"])
        final_status = run_status
        auto_refresh_claim_matches = self._auto_refresh_claim_matches(job, payload)
        already_published = (
            not auto_refresh_claim_matches
            and run_status == "succeeded"
            and self._catalog_source_run_matches(payload)
        )
        if not auto_refresh_claim_matches and not already_published:
            final_status = "failed"
            error_message = "Revision refresh execution claim is no longer active."
        schema_rows: list[list[object]] = []
        if final_status == "succeeded" and not already_published:
            try:
                schema_rows = self.registration.describe_table(target)
            except Exception as exc:
                final_status = "failed"
                error_message = str(exc) or "TRINO_TABLE_VERIFICATION_FAILED"

        run.status = etl_run_status(final_status)
        run.ended_at = utc_now()
        run.duration = duration_label(run.started_at, run.ended_at)
        run.output_rows = str(int(payload.get("updateCount") or 0))
        run.failed_stage = "" if final_status == "succeeded" else ("실행 취소" if final_status == "cancelled" else "Catalog 등록 검증")
        run.error_summary = "" if final_status == "succeeded" else (error_message or "Trino SQL Job 실행 실패")
        run.airflow_state = final_status
        run.task_states = task_states(final_status, error=run.error_summary or None)
        if auto_refresh_claim_matches:
            self._apply_terminal_job_state(job, run, final_status, target)
            job.dag_steps = dag_steps(final_status, error=run.error_summary or None)
            job.dag_steps_by_run_id = {
                **(job.dag_steps_by_run_id or {}),
                run.run_id: job.dag_steps,
            }

        dataset: CatalogDataset | None = None
        if final_status == "succeeded":
            if auto_refresh_claim_matches:
                self._apply_auto_refresh_result(job, payload, succeeded=True)
                dataset_payload = self._catalog_payload(job, run, payload, target, schema_rows)
                self.repository.db.add(job)
                self.catalog_repository.save_dataset_payload(dataset_payload, commit=False)
            self.repository.db.add(run)
        else:
            if auto_refresh_claim_matches:
                self._apply_auto_refresh_result(job, payload, succeeded=False, error_message=run.error_summary)
            self._drop_unpublished_target(payload)
            self.repository.db.add(job)
            self.repository.db.add(run)

        final_payload = dict(payload)
        final_payload.update({
            "completedAt": run.ended_at,
            "error": {"code": "TRINO_SQL_JOB_FAILED", "message": run.error_summary} if run.error_summary else None,
            "finalized": True,
            "status": final_status,
            "trinoNextUri": None,
        })
        try:
            self.repository.save_run_payload(final_payload, commit=False)
            self.repository.db.commit()
        except Exception:
            self.repository.db.rollback()
            raise
        if final_status == "succeeded":
            dataset = etl_repository.get_dataset_schema_by_id(
                self.repository.db,
                str(payload["datasetId"]),
            )
        self._record(
            final_status,
            job,
            run.run_id,
            ActorContext(name="AskLake Collector", role="admin"),
            result="success" if final_status == "succeeded" else "failed",
            error_code="TRINO_SQL_JOB_FAILED" if final_status == "failed" else None,
        )
        return TrinoSqlJobCommandResult(
            dataset=dataset,
            job=etl_repository.job_to_schema(self.repository.db, job),
            run=etl_repository.run_to_schema(run),
        )

    @staticmethod
    def _apply_auto_refresh_result(
        job: ETLJobModel,
        payload: dict[str, Any],
        *,
        succeeded: bool,
        error_message: str | None = None,
    ) -> bool:
        context = payload.get("autoRefresh")
        if not isinstance(context, dict):
            return True
        if not TrinoSqlJobService._auto_refresh_claim_matches(job, payload):
            return False
        source_revision = int(context.get("sourceRevision") or 0)
        config = job.continuous_config if isinstance(job.continuous_config, dict) else {}
        state_value = config.get("revisionRefresh")
        state = dict(state_value) if isinstance(state_value, dict) else {}
        completed_state = {
            key: value
            for key, value in state.items()
            if key not in {"claimId", "claimedAt"}
        }
        job.continuous_config = {
            **config,
            "revisionRefresh": {
                **completed_state,
                "lastError": None if succeeded else (error_message or "Trino SQL Job 실행 실패"),
                "latestSourceRevision": max(int(state.get("latestSourceRevision") or 0), source_revision),
                "processingRunId": None,
                "processingSourceRevision": None,
                "publishedSourceRevision": max(int(state.get("publishedSourceRevision") or 0), source_revision) if succeeded else int(state.get("publishedSourceRevision") or 0),
                "sourceDatasetId": str(context.get("sourceDatasetId") or state.get("sourceDatasetId") or ""),
                "status": "dashboard_ready" if succeeded else "failed",
            },
        }
        return True

    @staticmethod
    def _mark_auto_refresh_submission_unknown(
        job: ETLJobModel,
        payload: dict[str, Any],
        error_message: str,
    ) -> None:
        context = payload.get("autoRefresh")
        if not isinstance(context, dict):
            return
        if not TrinoSqlJobService._auto_refresh_claim_matches(job, payload):
            return
        config = job.continuous_config if isinstance(job.continuous_config, dict) else {}
        state_value = config.get("revisionRefresh")
        state = dict(state_value) if isinstance(state_value, dict) else {}
        job.continuous_config = {
            **config,
            "revisionRefresh": {
                **state,
                "lastError": error_message,
                "status": "failed",
            },
        }

    def _catalog_source_run_matches(self, payload: dict[str, Any]) -> bool:
        dataset = self.catalog_repository.get_dataset_payload(str(payload["datasetId"]))
        return bool(
            dataset
            and str(dataset.get("sourceRunId") or "").strip()
            == str(payload.get("runId") or payload.get("etlRunId") or "").strip()
        )

    @staticmethod
    def _auto_refresh_claim_matches(job: ETLJobModel, payload: dict[str, Any]) -> bool:
        context = payload.get("autoRefresh")
        if not isinstance(context, dict):
            config = job.continuous_config if isinstance(job.continuous_config, dict) else {}
            state_value = config.get("revisionRefresh")
            state = dict(state_value) if isinstance(state_value, dict) else {}
            return int(state.get("processingSourceRevision") or 0) <= 0
        source_revision = int(context.get("sourceRevision") or 0)
        config = job.continuous_config if isinstance(job.continuous_config, dict) else {}
        state_value = config.get("revisionRefresh")
        state = dict(state_value) if isinstance(state_value, dict) else {}
        if source_revision <= 0 or int(state.get("processingSourceRevision") or 0) != source_revision:
            return False

        claim_id = str(context.get("claimId") or "").strip()
        state_claim_id = str(state.get("claimId") or "").strip()
        if state_claim_id and claim_id != state_claim_id:
            return False
        if claim_id and not state_claim_id:
            return False

        run_id = str(payload.get("runId") or payload.get("etlRunId") or "").strip()
        processing_run_id = str(state.get("processingRunId") or "").strip()
        if processing_run_id and run_id != processing_run_id:
            return False
        return True

    def _catalog_payload(
        self,
        job: ETLJobModel,
        run: ETLRunModel,
        payload: dict[str, Any],
        target: QueryEngineTableRef,
        schema_rows: list[list[object]],
    ) -> dict[str, Any]:
        recipe = self._recipe(job)
        target_info = dict_value(recipe.get("target"))
        dataset_id = str(payload["datasetId"])
        existing = self.catalog_repository.get_dataset_payload(dataset_id) or {}
        materialization_runs = upsert_materialization_run(
            existing.get("materializationRuns", []),
            {
                "createdAt": run.ended_at,
                "jobId": job.id,
                "materializationMode": "snapshot",
                "rowCount": int(payload.get("updateCount") or 0),
                "runId": run.run_id,
                "sourceKind": "sql",
                "sourceLabel": "Trino SQL Job full refresh",
                "status": "success",
                "storageFormat": "iceberg",
                "storageLocation": iceberg_uri(target),
                "storageSizeBytes": 0,
            },
        )
        schema = [
            [str(row[0]), str(row[1])]
            for row in schema_rows
            if len(row) >= 2 and str(row[0]).strip()
        ]
        return {
            **existing,
            "createdBy": existing.get("createdBy") or job.created_by or job.owner,
            "description": str(target_info.get("description") or job.target_description or ""),
            "downstream": existing.get("downstream") or ["SQL 분석", "대시보드"],
            "freshness": "latest",
            "id": dataset_id,
            "layer": str(target_info.get("layer") or job.target_layer or "GOLD"),
            "lastUpdated": run.ended_at,
            "materializationRuns": materialization_runs,
            "name": str(target_info.get("datasetName") or job.target),
            "nextRefresh": "Kafka revision 자동 반영" if isinstance((job.continuous_config or {}).get("revisionRefresh"), dict) else (job.next_run or "-"),
            "owner": job.owner,
            "permissionGrants": permission_grants_from_roles(job.owner, job.permission_roles, default_actions=["view", "query"]),
            "permissions": resource_permissions(actor=job.owner, can_query=True, can_run=True, can_manage=True, can_delete=True, can_share=True),
            "quality": "Trino Iceberg materialized",
            "queryEngineStatus": "available",
            "queryEngineTable": target.model_dump(by_alias=True, mode="json"),
            "rag": bool(job.rag),
            "rows": f"{int(payload.get('updateCount') or 0):,} rows",
            "sampleRows": [],
            "schema": schema,
            "size": "Trino managed",
            "source": f"Trino SQL Job · {job.id}",
            "producerJobId": job.id,
            "producerJobKind": job.job_kind or "trino_sql_materialization",
            "executionMode": "snapshot",
            "sourceKind": "sql",
            "relationMode": "static",
            "runtimeStatus": job.status,
            "sourceRunId": run.run_id,
            "status": "available",
            "storageFormat": "iceberg",
            "storageLocation": iceberg_uri(target),
            "storageSizeBytes": 0,
            "tags": string_list(target_info.get("tags")),
            "upstream": [str(recipe["baseDatasetId"]), *string_list(recipe.get("referenceDatasetIds"))],
        }

    def _apply_terminal_job_state(
        self,
        job: ETLJobModel,
        run: ETLRunModel,
        run_status: str,
        target: QueryEngineTableRef,
    ) -> None:
        job.status = terminal_job_status(run_status)
        job.last_run = run.ended_at if run.ended_at != "-" else run.started_at
        job.last_state = {
            "succeeded": "Iceberg Dataset 갱신 완료",
            "failed": "Trino SQL Job 실행 실패",
            "cancelled": "Trino SQL Job 실행 취소",
        }.get(run_status, "Trino SQL Job 실행 종료")
        job.progress = {
            "label": "완료" if run_status == "succeeded" else ("취소됨" if run_status == "cancelled" else "실패"),
            "value": 100,
        }
        runs = [run, *[item for item in etl_repository.list_runs_for_job(self.repository.db, job.id) if item.run_id != run.run_id]]
        successes = sum(item.status == "success" for item in runs)
        job.stats = {
            **(job.stats or {}),
            "currentStage": job.last_state,
            "inputRows": str(trino_stat_value(run.task_states, "processedRows") or "-"),
            "lastSuccess": run.ended_at if run_status == "succeeded" else str((job.stats or {}).get("lastSuccess") or "-"),
            "outputPath": iceberg_uri(target) if run_status == "succeeded" else str((job.stats or {}).get("outputPath") or "-"),
            "outputRows": run.output_rows,
            "successRate": f"{round((successes / len(runs)) * 100)}%" if runs else "-",
            "totalRuns": f"{len(runs)}회",
        }

    def _reserve_submission(
        self,
        job: ETLJobModel,
        actor: ActorContext,
        run_id: str,
        auto_refresh_context: dict[str, Any] | None,
    ) -> tuple[ETLRunModel, dict[str, Any], QueryEngineTableRef]:
        recipe = self._recipe(job)
        compiled_query, _ = self.query_access.compile_for_actor(
            base_dataset_id=str(recipe["baseDatasetId"]),
            reference_dataset_ids=string_list(recipe.get("referenceDatasetIds")),
            query=str(recipe["query"]),
            actor=actor,
            api_path=f"/api/etl/jobs/{job.id}/commands",
        )
        target_info = dict_value(recipe.get("target"))
        dataset_id = str(target_info.get("datasetId") or job.dataset_id or "").strip()
        dataset_name = str(target_info.get("datasetName") or job.target or "").strip()
        if not dataset_id or not dataset_name:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "SQL Job target Dataset is incomplete",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        target = build_query_engine_table(
            dataset_name,
            f"{dataset_id}:{run_id}",
            self.settings,
        ).model_copy(
            update={"partition_columns": string_list(target_info.get("partitionColumns"))}
        )
        started_at = utc_now()
        run = self._new_run(job, run_id, started_at, target)
        job.status = "running"
        job.last_run = started_at
        job.last_state = "Trino Iceberg materialization 제출 중"
        job.progress = {"label": "Trino 요청 제출 중", "value": 5}
        job.dag_steps = dag_steps("queued")
        job.dag_steps_by_run_id = {
            **(job.dag_steps_by_run_id or {}),
            run_id: job.dag_steps,
        }
        payload = {
            "autoRefresh": auto_refresh_context,
            "baseDatasetId": str(recipe["baseDatasetId"]),
            "compiledQuery": compiled_query,
            "datasetId": dataset_id,
            "engine": "trino-job-materialization",
            "error": None,
            "etlRunId": run_id,
            "finalized": False,
            "jobId": job.id,
            "query": build_versioned_ctas(target, compiled_query),
            "rawStats": {},
            "recipeQuery": str(recipe["query"]),
            "referenceDatasetIds": string_list(recipe.get("referenceDatasetIds")),
            "runId": run_id,
            "status": "queued",
            "submissionOutcome": "pending",
            "submittedAt": started_at,
            "submittedByName": actor.name,
            "submittedByUserId": actor.id,
            "target": target.model_dump(by_alias=True, mode="json"),
            "trinoNextUri": None,
            "trinoQueryId": None,
            "updateCount": None,
        }
        # This commit is the safety boundary before the external CTAS request.
        self.repository.db.add(job)
        self.repository.db.add(run)
        self.repository.save_run_payload(payload)
        return run, payload, target

    def _persist_unknown_submission(
        self,
        job: ETLJobModel,
        run: ETLRunModel,
        payload: dict[str, Any],
        actor: ActorContext,
        error: ApiError,
    ) -> None:
        run.status = "running"
        run.duration = "확인 필요"
        run.failed_stage = "Trino 제출 결과 확인"
        run.error_summary = (
            "Trino가 요청을 수락했는지 확인할 수 없어 자동 재실행을 중단했습니다. "
            f"{error.message}"
        )
        run.airflow_state = "unknown"
        run.task_states = task_states("running", error=run.error_summary)
        if self._auto_refresh_claim_matches(job, payload):
            job.status = "running"
            job.last_state = "Trino 제출 결과 확인 필요"
            job.progress = {"label": "중복 방지를 위해 재실행 중단", "value": 5}
            self._mark_auto_refresh_submission_unknown(job, payload, run.error_summary)
            job.dag_steps = dag_steps("running", error=run.error_summary)
            job.dag_steps_by_run_id = {
                **(job.dag_steps_by_run_id or {}),
                run.run_id: job.dag_steps,
            }
        unknown_payload = {
            **payload,
            "error": {
                "code": "TRINO_SUBMISSION_OUTCOME_UNKNOWN",
                "message": run.error_summary,
            },
            "status": "submission_unknown",
            "submissionOutcome": "unknown",
        }
        self.repository.db.add(job)
        self.repository.db.add(run)
        self.repository.save_run_payload(unknown_payload)
        self._record(
            "submit_unknown",
            job,
            run.run_id,
            actor,
            result="failed",
            error_code="TRINO_SUBMISSION_OUTCOME_UNKNOWN",
        )

    def _persist_accepted_submission(
        self,
        job: ETLJobModel,
        run: ETLRunModel,
        payload: dict[str, Any],
        page: TrinoClientPage,
    ) -> str:
        run_status = trino_status(page)
        run.status = etl_run_status(run_status)
        run.airflow_state = run_status
        run.task_states = task_states(run_status, page)
        job.status = "running" if run_status not in TERMINAL_TRINO_STATUSES else terminal_job_status(run_status)
        job.last_run = str(payload["submittedAt"])
        job.last_state = "Trino Iceberg materialization 실행 중"
        job.progress = progress_payload(page, run_status)
        job.dag_steps = dag_steps(run_status, page)
        job.dag_steps_by_run_id = {
            **(job.dag_steps_by_run_id or {}),
            run.run_id: job.dag_steps,
        }
        payload.update({
            "error": error_payload(page),
            "rawStats": page.raw_stats,
            "status": run_status,
            "submissionOutcome": "accepted",
            "trinoNextUri": page.next_uri,
            "trinoQueryId": page.query_id or None,
            "updateCount": page.update_count,
        })
        self.repository.db.add(job)
        self.repository.db.add(run)
        self.repository.save_run_payload(payload)
        return run_status

    def _new_run(self, job: ETLJobModel, run_id: str, started_at: str, target: QueryEngineTableRef) -> ETLRunModel:
        return ETLRunModel(
            run_id=run_id,
            job_id=job.id,
            status="queued",
            started_at=started_at,
            ended_at="-",
            duration="진행 중",
            input_rows="-",
            output_rows="-",
            output_path=iceberg_uri(target),
            failed_stage="",
            error_summary="",
            airflow_dag_id=None,
            airflow_dag_run_id=None,
            airflow_run_url=None,
            airflow_state="queued",
            task_states=task_states("queued"),
            last_synced_at=started_at,
            sync_error=None,
        )

    def _result(self, job: ETLJobModel, run: ETLRunModel) -> TrinoSqlJobCommandResult:
        return TrinoSqlJobCommandResult(
            dataset=etl_repository.get_dataset_schema_by_id(self.repository.db, job.dataset_id) if job.dataset_id else None,
            job=etl_repository.job_to_schema(self.repository.db, job),
            run=etl_repository.run_to_schema(run),
        )

    def _result_for_payload(self, payload: dict[str, Any]) -> TrinoSqlJobCommandResult:
        job = etl_repository.get_job(self.repository.db, str(payload["jobId"]))
        run = etl_repository.get_run_model(self.repository.db, str(payload["etlRunId"]))
        if job is None or run is None:
            raise ApiError(ErrorCode.NOT_FOUND, "SQL Job run state was not found", status.HTTP_404_NOT_FOUND)
        return self._result(job, run)

    def _run_schema(self, run_id: str) -> JobRunSummary:
        run = etl_repository.get_run_model(self.repository.db, run_id)
        if run is None:
            raise ApiError(ErrorCode.NOT_FOUND, "SQL Job run was not found", status.HTTP_404_NOT_FOUND)
        return etl_repository.run_to_schema(run)

    def _payload(self, run_id: str) -> dict[str, Any]:
        payload = self.repository.get_run_payload(run_id)
        if payload is None or payload.get("engine") != "trino-job-materialization":
            raise ApiError(ErrorCode.NOT_FOUND, "Trino SQL Job run was not found", status.HTTP_404_NOT_FOUND)
        return dict(payload)

    def _require_job(self, job: ETLJobModel) -> None:
        if not self.settings.trino_enabled:
            raise ApiError(ErrorCode.CONFLICT, "Trino query runtime is not enabled", status.HTTP_409_CONFLICT)
        if job.job_kind != "trino_sql_materialization":
            raise ApiError(ErrorCode.INVALID_JOB_STATE, "Job is not a Trino SQL Job", status.HTTP_422_UNPROCESSABLE_ENTITY)

    def _lock_submission_job(self, job_id: str) -> ETLJobModel:
        job = etl_repository.get_job_for_update(self.repository.db, job_id)
        if job is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "SQL Job was not found",
                status.HTTP_404_NOT_FOUND,
                {"jobId": job_id},
            )
        self.repository.db.refresh(job, with_for_update=True)
        return job

    def _require_submission_slot(
        self,
        job: ETLJobModel,
        run_id: str,
        auto_refresh_context: dict[str, Any] | None,
    ) -> None:
        unfinalized = self.repository.get_unfinalized_trino_job_run_payload(job.id)
        if unfinalized is not None:
            raise ApiError(
                ErrorCode.CONFLICT,
                "SQL Job has a Trino run whose publication is not finalized",
                status.HTTP_409_CONFLICT,
                {
                    "jobId": job.id,
                    "runId": unfinalized.get("runId"),
                    "status": unfinalized.get("status"),
                },
            )

        claim_probe = {
            "autoRefresh": auto_refresh_context,
            "runId": run_id,
        }
        if auto_refresh_context is not None:
            if self._auto_refresh_claim_matches(job, claim_probe):
                return
            raise ApiError(
                ErrorCode.CONFLICT,
                "Revision refresh execution claim is no longer active",
                status.HTTP_409_CONFLICT,
                {"jobId": job.id, "runId": run_id},
            )

        config = job.continuous_config if isinstance(job.continuous_config, dict) else {}
        state_value = config.get("revisionRefresh")
        state = dict(state_value) if isinstance(state_value, dict) else {}
        if int(state.get("processingSourceRevision") or 0) > 0:
            raise ApiError(
                ErrorCode.CONFLICT,
                "SQL Job has a revision refresh awaiting finalization",
                status.HTTP_409_CONFLICT,
                {
                    "jobId": job.id,
                    "runId": state.get("processingRunId"),
                    "sourceRevision": state.get("processingSourceRevision"),
                },
            )

    @staticmethod
    def _recipe(job: ETLJobModel) -> dict[str, Any]:
        recipe = dict_value(job.sql_recipe)
        if not recipe.get("baseDatasetId") or not recipe.get("query") or not isinstance(recipe.get("target"), dict):
            raise ApiError(ErrorCode.VALIDATION_ERROR, "Trino SQL Job recipe is incomplete", status.HTTP_422_UNPROCESSABLE_ENTITY)
        return recipe

    def _ensure_target_schema(self, target: QueryEngineTableRef) -> None:
        page = self.client.submit(
            f"CREATE SCHEMA IF NOT EXISTS {quote_identifier(target.catalog)}.{quote_identifier(target.schema_)}"
        )
        pages = 0
        while page.next_uri and page.error is None:
            if pages >= 20:
                raise ApiError(ErrorCode.BACKEND_TIMEOUT, "Trino schema bootstrap exceeded the page limit", status.HTTP_503_SERVICE_UNAVAILABLE)
            page = self.client.fetch(page.next_uri)
            pages += 1
        if page.error is not None:
            raise ApiError(ErrorCode.CONFLICT, "Unable to prepare the Trino materialization schema", status.HTTP_409_CONFLICT, {"code": page.error.code})

    def _drop_unpublished_target(self, payload: dict[str, Any]) -> None:
        try:
            target = QueryEngineTableRef.model_validate(payload["target"])
            page = self.client.submit(
                "DROP TABLE IF EXISTS " + ".".join(quote_identifier(value) for value in [target.catalog, target.schema_, target.table])
            )
            pages = 0
            while page.next_uri and page.error is None and pages < 20:
                page = self.client.fetch(page.next_uri)
                pages += 1
        except Exception:
            return

    def _record(
        self,
        event: str,
        job: ETLJobModel,
        run_id: str,
        actor: ActorContext,
        *,
        result: str = "success",
        error_code: str | None = None,
    ) -> None:
        safe_record_audit_event(
            self.repository.db,
            action=f"trino_sql_job.{event}",
            actor=actor,
            api_path=f"/api/etl/jobs/{job.id}/commands",
            http_method="POST",
            metadata={"errorCode": error_code, "runId": run_id},
            result=result,
            target_id=job.id,
            target_name=job.name,
            target_type=AuditTargetType.ETL_JOB,
        )


def build_versioned_ctas(target: QueryEngineTableRef, compiled_query: str) -> str:
    properties = ["format = 'PARQUET'"]
    if target.partition_columns:
        values = ", ".join(f"'{column.replace(chr(39), chr(39) * 2)}'" for column in target.partition_columns)
        properties.append(f"partitioning = ARRAY[{values}]")
    qualified_target = ".".join(quote_identifier(value) for value in [target.catalog, target.schema_, target.table])
    return f"CREATE TABLE {qualified_target} WITH ({', '.join(properties)}) AS {compiled_query.rstrip(';')}"


def task_states(status_value: str, page: TrinoClientPage | None = None, *, error: str | None = None) -> dict[str, Any]:
    stats = trino_stats(page.raw_stats) if page else None
    terminal = status_value in TERMINAL_TRINO_STATUSES
    succeeded = status_value == "succeeded"
    return {
        "error": error,
        "materialize": "success" if succeeded else ("failed" if terminal else "running"),
        "processedBytes": stats.processed_bytes if stats else None,
        "processedRows": stats.processed_rows if stats else None,
        "progressPercentage": stats.progress_percentage if stats else (100 if terminal else None),
        "register": "success" if succeeded else ("blocked" if terminal else "pending"),
        "validate": "success",
    }


def dag_steps(status_value: str, page: TrinoClientPage | None = None, *, error: str | None = None) -> list[dict[str, Any]]:
    states = task_states(status_value, page, error=error)
    return [
        {"id": "validate", "title": "1. SQL recipe 검증", "meta": "실행 시 권한과 Trino SQL 재검증", "status": states["validate"]},
        {"id": "materialize", "title": "2. Iceberg table 생성", "meta": "versioned CTAS · full refresh", "note": error, "status": states["materialize"]},
        {"id": "register", "title": "3. Catalog mapping 교체", "meta": "DESCRIBE 검증 후 공개", "status": states["register"]},
    ]


def progress_payload(page: TrinoClientPage, status_value: str) -> dict[str, Any]:
    stats = trino_stats(page.raw_stats)
    value = stats.progress_percentage if stats and stats.progress_percentage is not None else (100 if status_value in TERMINAL_TRINO_STATUSES else 10)
    return {"label": "Iceberg table 생성 중", "value": max(0, min(100, round(value)))}


def error_payload(page: TrinoClientPage) -> dict[str, str] | None:
    return page.error.model_dump(by_alias=True) if page.error else None


def etl_run_status(status_value: str) -> str:
    return {
        "queued": "queued",
        "running": "running",
        "succeeded": "success",
        "failed": "failed",
        "cancelled": "canceled",
    }.get(status_value, "failed")


def terminal_job_status(status_value: str) -> str:
    return {"succeeded": "scheduled", "failed": "failed", "cancelled": "canceled"}.get(status_value, "running")


def iceberg_uri(target: QueryEngineTableRef) -> str:
    return f"iceberg://{target.catalog}/{target.schema_}/{target.table}"


def quote_identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def duration_label(started_at: str, ended_at: str) -> str:
    try:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        end = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
    except ValueError:
        return "-"
    elapsed = max(0, round((end - start).total_seconds()))
    return f"{elapsed // 60}m {elapsed % 60}s" if elapsed >= 60 else f"{elapsed}s"


def dict_value(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def string_list(value: object) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def trino_stat_value(task_state_payload: dict[str, Any] | None, key: str) -> object | None:
    return task_state_payload.get(key) if isinstance(task_state_payload, dict) else None
