"""Validation, estimation, reservation, and first-page submission for Query Runs."""

from dataclasses import dataclass

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.trino import (
    SubmitTrinoQueryRunRequest,
    TrinoClientPage,
    TrinoQueryEstimate,
    TrinoQueryEstimateRequest,
    TrinoQueryRunError,
    TrinoQueryRunEstimate,
    TrinoQueryRunResponse,
    TrinoQueryValidationRequest,
    TrinoQueryValidationResponse,
)
from app.services.trino_client import TrinoClient
from app.services.trino_query_access import TrinoQueryAccessService
from app.services.trino_query_estimate import (
    build_query_estimate,
    estimate_iceberg_scan_bytes,
    parse_plan_estimated_bytes,
    require_estimate_confirmation,
)
from app.services.trino_query_preview import execution_query_for_mode
from app.services.trino_query_results import TrinoQueryResultService
from app.services.trino_query_run_state import (
    build_reserved_run_response,
    build_run_response,
    normalized_result_page_size,
    query_run_estimate_snapshot,
    trino_request_fingerprint,
)
from app.services.trino_query_result_manifest import current_utc_timestamp
from app.services.trino_query_run_store import TrinoQueryRunStore
from app.services.trino_sql_compiler import compile_trino_read_query


@dataclass(frozen=True)
class PreparedSubmission:
    actor: ActorContext
    compiled_query: str
    context_datasets: list[CatalogDatasetResponse]
    estimate: TrinoQueryEstimate
    estimate_snapshot: TrinoQueryRunEstimate
    reserved: TrinoQueryRunResponse


class TrinoQuerySubmissionService:
    def __init__(
        self,
        repository: SqlRepository,
        settings: Settings,
        client: TrinoClient,
        access: TrinoQueryAccessService,
        results: TrinoQueryResultService,
        run_store: TrinoQueryRunStore,
    ) -> None:
        self.repository = repository
        self.settings = settings
        self.client = client
        self.access = access
        self.results = results
        self.run_store = run_store

    def submit(
        self,
        request: SubmitTrinoQueryRunRequest,
        actor: ActorContext | None = None,
    ) -> TrinoQueryRunResponse:
        self._require_enabled()
        prepared = self._prepare_submission(request, actor or ActorContext())
        existing = self._reserve_submission(request, prepared)
        if existing is not None:
            return existing
        page = self._submit_page(request, prepared)
        response = build_run_response(
            request,
            page,
            prepared.actor,
            self.settings.trino_result_retention_seconds,
            estimate=prepared.estimate_snapshot,
            run_id=prepared.reserved.run_id,
            submitted_at=prepared.reserved.submitted_at,
        )
        response = self._persist_first_page(response, page, prepared)
        self.run_store.save(response, compiled_query=prepared.compiled_query, trino_next_uri=page.next_uri)
        self._record_submission(response, request, prepared)
        return response

    def estimate(
        self,
        request: TrinoQueryEstimateRequest,
        actor: ActorContext | None = None,
    ) -> TrinoQueryEstimate:
        self._require_enabled()
        actor_context = actor or ActorContext()
        context_datasets = self.access.resolve_context(SubmitTrinoQueryRunRequest(
            baseDatasetId=request.base_dataset_id,
            query=request.query,
            referenceDatasetIds=request.reference_dataset_ids,
        ))
        self.access.require_query_access(context_datasets, actor_context, request.query)
        compiled_query, _ = compile_trino_read_query(request.query, context_datasets)
        return self.build_query_estimate(
            actor=actor_context,
            context_datasets=context_datasets,
            compiled_query=compiled_query,
            query=request.query,
        )

    def validate(
        self,
        request: TrinoQueryValidationRequest,
        actor: ActorContext | None = None,
    ) -> TrinoQueryValidationResponse:
        compiled_query, referenced_datasets = self.compile_for_actor(
            base_dataset_id=request.base_dataset_id,
            reference_dataset_ids=request.reference_dataset_ids,
            query=request.query,
            actor=actor or ActorContext(),
            api_path="/api/query/validate",
        )
        return TrinoQueryValidationResponse(
            normalized_query=compiled_query,
            referenced_dataset_ids=[dataset.id for dataset in referenced_datasets],
        )

    def compile_for_actor(
        self,
        *,
        base_dataset_id: str,
        reference_dataset_ids: list[str],
        query: str,
        actor: ActorContext,
        api_path: str,
        http_method: str = "POST",
    ) -> tuple[str, list[CatalogDatasetResponse]]:
        context_datasets = self.access.resolve_context(SubmitTrinoQueryRunRequest(
            baseDatasetId=base_dataset_id,
            query=query,
            referenceDatasetIds=reference_dataset_ids,
        ))
        self.access.require_query_access(
            context_datasets,
            actor,
            query,
            api_path=api_path,
            http_method=http_method,
        )
        return compile_trino_read_query(query, context_datasets)

    def build_query_estimate(
        self,
        *,
        actor: ActorContext,
        context_datasets: list[CatalogDatasetResponse],
        compiled_query: str,
        query: str,
    ) -> TrinoQueryEstimate:
        try:
            iceberg_estimated_bytes = estimate_iceberg_scan_bytes(
                client=self.client,
                context_datasets=context_datasets,
                query=query,
            )
        except ApiError:
            iceberg_estimated_bytes = None
        if iceberg_estimated_bytes is None:
            try:
                plan_estimated_bytes = parse_plan_estimated_bytes(self.client.explain(compiled_query))
                plan_unavailable = False
            except ApiError:
                plan_estimated_bytes = None
                plan_unavailable = True
        else:
            plan_estimated_bytes = None
            plan_unavailable = False
        return build_query_estimate(
            actor=actor,
            context_datasets=context_datasets,
            query=query,
            runtime_settings=self.settings,
            iceberg_estimated_bytes=iceberg_estimated_bytes,
            plan_estimated_bytes=plan_estimated_bytes,
            plan_unavailable=plan_unavailable,
        )

    def _prepare_submission(
        self,
        request: SubmitTrinoQueryRunRequest,
        actor: ActorContext,
    ) -> PreparedSubmission:
        context_datasets = self.access.resolve_context(request)
        self.access.require_query_access(context_datasets, actor, request.query)
        compiled_query, _ = compile_trino_read_query(request.query, context_datasets)
        estimate = self.build_query_estimate(
            actor=actor,
            context_datasets=context_datasets,
            compiled_query=compiled_query,
            query=request.query,
        )
        require_estimate_confirmation(
            actor=actor,
            confirmation_token=request.confirmation_token,
            context_datasets=context_datasets,
            query=request.query,
            runtime_settings=self.settings,
            estimate=estimate,
        )
        estimate_snapshot = query_run_estimate_snapshot(estimate)
        return PreparedSubmission(
            actor=actor,
            compiled_query=compiled_query,
            context_datasets=context_datasets,
            estimate=estimate,
            estimate_snapshot=estimate_snapshot,
            reserved=build_reserved_run_response(
                request,
                actor,
                self.settings.trino_result_retention_seconds,
                estimate=estimate_snapshot,
            ),
        )

    def _reserve_submission(
        self,
        request: SubmitTrinoQueryRunRequest,
        prepared: PreparedSubmission,
    ) -> TrinoQueryRunResponse | None:
        payload = prepared.reserved.model_dump(by_alias=True, exclude_none=True, mode="json")
        payload["resultPageSize"] = normalized_result_page_size(request.result_page_size)
        reservation = self.repository.reserve_trino_submission(
            payload,
            actor_key=prepared.actor.id or prepared.actor.name,
            client_request_id=request.client_request_id,
            request_fingerprint=trino_request_fingerprint(request),
            max_active_runs=self.settings.trino_max_concurrent_runs_per_user,
        )
        if reservation.outcome == "existing" and reservation.payload is not None:
            return TrinoQueryRunResponse.model_validate(reservation.payload)
        if reservation.outcome == "conflict":
            raise ApiError(
                ErrorCode.CONFLICT,
                "clientRequestId was already used for a different query request",
                status.HTTP_409_CONFLICT,
                {"clientRequestId": request.client_request_id},
            )
        if reservation.outcome == "limit":
            raise ApiError(
                ErrorCode.CONFLICT,
                "Concurrent query run limit reached",
                status.HTTP_429_TOO_MANY_REQUESTS,
                {"limit": self.settings.trino_max_concurrent_runs_per_user},
            )
        return None

    def _submit_page(
        self,
        request: SubmitTrinoQueryRunRequest,
        prepared: PreparedSubmission,
    ) -> TrinoClientPage:
        try:
            return self.client.submit(execution_query_for_mode(
                prepared.compiled_query,
                request.mode,
                request.preview_limit,
            ))
        except ApiError as exc:
            failed = prepared.reserved.model_copy(update={
                "completed_at": current_utc_timestamp(),
                "error": TrinoQueryRunError(code=exc.code, message=exc.message),
                "status": "failed",
            })
            self.run_store.save(failed, compiled_query=prepared.compiled_query, trino_next_uri=None)
            raise

    def _persist_first_page(
        self,
        response: TrinoQueryRunResponse,
        page: TrinoClientPage,
        prepared: PreparedSubmission,
    ) -> TrinoQueryRunResponse:
        try:
            return self.results.finalize_storage(self.results.store_page(response, page))
        except ApiError as exc:
            self.results.cancel_after_persistence_failure(page.next_uri)
            failed = self.results.persistence_failed(response)
            self.run_store.save(failed, compiled_query=prepared.compiled_query, trino_next_uri=page.next_uri)
            self._record_persistence_failure(failed, prepared, exc)
            raise ApiError(
                ErrorCode.RESULT_PERSISTENCE_FAILED,
                "Query started but its result could not be persisted",
                status.HTTP_503_SERVICE_UNAVAILABLE,
                {"runId": failed.run_id},
            ) from exc

    def _record_persistence_failure(
        self,
        failed: TrinoQueryRunResponse,
        prepared: PreparedSubmission,
        error: ApiError,
    ) -> None:
        safe_record_audit_event(
            self.repository.db,
            action="query_run.result.persist.failed",
            actor=prepared.actor,
            api_path="/api/query/runs",
            http_method="POST",
            metadata={"runId": failed.run_id, "trinoQueryId": failed.trino_query_id, "cause": str(error.code)},
            result="failed",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            target_id=failed.base_dataset_id,
            target_name=prepared.context_datasets[0].name,
            target_type="dataset",
        )

    def _record_submission(
        self,
        response: TrinoQueryRunResponse,
        request: SubmitTrinoQueryRunRequest,
        prepared: PreparedSubmission,
    ) -> None:
        safe_record_audit_event(
            self.repository.db,
            action="query_run.submit",
            actor=prepared.actor,
            api_path="/api/query/runs",
            http_method="POST",
            metadata={"runId": response.run_id, "trinoQueryId": response.trino_query_id},
            result="success" if response.status != "failed" else "failed",
            status_code=status.HTTP_202_ACCEPTED,
            target_id=request.base_dataset_id,
            target_name=prepared.context_datasets[0].name,
            target_type="dataset",
        )

    def _require_enabled(self) -> None:
        if self.settings.trino_enabled:
            return
        raise ApiError(
            ErrorCode.CONFLICT,
            "Trino query runtime is not enabled",
            status.HTTP_409_CONFLICT,
            {"setting": "TRINO_ENABLED"},
        )
