import base64
import binascii
from datetime import datetime, timedelta, timezone
import hmac
import hashlib
import json
from typing import Iterable
from uuid import uuid4

from fastapi import status

from app.core.auth_context import ActorContext, can, require_permission
from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.trino import (
    SubmitTrinoQueryRunRequest,
    TrinoClientPage,
    TrinoQueryRunError,
    TrinoQueryRunHistoryItem,
    TrinoQueryRunHistoryResult,
    TrinoQueryRunHistoryStats,
    TrinoQueryRunListResponse,
    TrinoQueryRunResponse,
    TrinoQueryRunResult,
    TrinoQueryRunResultPage,
    TrinoQueryRunStats,
    TrinoQueryEstimate,
    TrinoQueryEstimateRequest,
)
from app.services.governance_enforcement import require_governed_access
from app.services.resource_permission_service import dataset_with_persisted_permission_grants
from app.services.trino_client import TrinoClient
from app.services.trino_result_storage import TrinoResultStorage
from app.services.trino_query_estimate import build_query_estimate, parse_plan_estimated_bytes, require_estimate_confirmation
from app.services.trino_sql_compiler import compile_trino_read_query


class CollectorLeaseLost(RuntimeError):
    pass


class TrinoQueryRunService:
    """Canonical Query Run foundation. API routing switches to this in Phase 3."""

    def __init__(
        self,
        repository: SqlRepository,
        catalog_repository: CatalogRepository,
        client: TrinoClient | None = None,
        result_storage: TrinoResultStorage | None = None,
        runtime_settings: Settings | None = None,
    ) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository
        self.settings = runtime_settings or settings
        self.client = client or TrinoClient(self.settings)
        self.result_storage = result_storage or TrinoResultStorage(self.settings)

    def submit(self, request: SubmitTrinoQueryRunRequest, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        if not self.settings.trino_enabled:
            raise ApiError(
                ErrorCode.CONFLICT,
                "Trino query runtime is not enabled",
                status.HTTP_409_CONFLICT,
                {"setting": "TRINO_ENABLED"},
            )

        actor_context = actor or ActorContext()
        actor_key = actor_context.id or actor_context.name
        context_datasets = self._resolve_context(request)
        self._require_query_access(context_datasets, actor_context, request.query)
        compiled_query, _ = compile_trino_read_query(request.query, context_datasets)
        estimate = self._build_query_estimate(
            actor=actor_context,
            context_datasets=context_datasets,
            compiled_query=compiled_query,
            query=request.query,
        )
        require_estimate_confirmation(
            actor=actor_context,
            confirmation_token=request.confirmation_token,
            context_datasets=context_datasets,
            query=request.query,
            runtime_settings=self.settings,
            estimate=estimate,
        )
        request_fingerprint = trino_request_fingerprint(request)
        reserved = build_reserved_run_response(request, actor_context, self.settings.trino_result_retention_seconds)
        reservation_payload = reserved.model_dump(by_alias=True, exclude_none=True, mode="json")
        reservation_payload["resultPageSize"] = normalized_result_page_size(request.result_page_size)
        reservation = self.repository.reserve_trino_submission(
            reservation_payload,
            actor_key=actor_key,
            client_request_id=request.client_request_id,
            request_fingerprint=request_fingerprint,
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

        try:
            page = self.client.submit(compiled_query)
        except ApiError as exc:
            failed = reserved.model_copy(update={
                "completed_at": current_utc_timestamp(),
                "error": TrinoQueryRunError(code=exc.code, message=exc.message),
                "status": "failed",
            })
            self._save_response(failed, compiled_query=compiled_query, trino_next_uri=None)
            raise
        response = build_run_response(
            request,
            page,
            actor_context,
            self.settings.trino_result_retention_seconds,
            run_id=reserved.run_id,
            submitted_at=reserved.submitted_at,
        )
        try:
            response = self._finalize_result_storage(self._store_result_page(response, page))
        except ApiError as exc:
            self._cancel_after_result_persistence_failure(page.next_uri)
            failed = self._result_persistence_failed(response)
            self._save_response(failed, compiled_query=compiled_query, trino_next_uri=page.next_uri)
            safe_record_audit_event(
                self.repository.db,
                action="query_run.result.persist.failed",
                actor=actor_context,
                api_path="/api/query/runs",
                http_method="POST",
                metadata={"runId": failed.run_id, "trinoQueryId": failed.trino_query_id, "cause": str(exc.code)},
                result="failed",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                target_id=request.base_dataset_id,
                target_name=context_datasets[0].name,
                target_type="dataset",
            )
            raise ApiError(
                ErrorCode.RESULT_PERSISTENCE_FAILED,
                "Query started but its result could not be persisted",
                status.HTTP_503_SERVICE_UNAVAILABLE,
                {"runId": failed.run_id},
            ) from exc
        self._save_response(response, compiled_query=compiled_query, trino_next_uri=page.next_uri)
        safe_record_audit_event(
            self.repository.db,
            action="query_run.submit",
            actor=actor_context,
            api_path="/api/query/runs",
            http_method="POST",
            metadata={"runId": response.run_id, "trinoQueryId": response.trino_query_id},
            result="success" if response.status != "failed" else "failed",
            status_code=status.HTTP_202_ACCEPTED,
            target_id=request.base_dataset_id,
            target_name=context_datasets[0].name,
            target_type="dataset",
        )
        return response

    def estimate(self, request: TrinoQueryEstimateRequest, actor: ActorContext | None = None) -> TrinoQueryEstimate:
        if not self.settings.trino_enabled:
            raise ApiError(
                ErrorCode.CONFLICT,
                "Trino query runtime is not enabled",
                status.HTTP_409_CONFLICT,
                {"setting": "TRINO_ENABLED"},
            )
        actor_context = actor or ActorContext()
        context_datasets = self._resolve_context(
            SubmitTrinoQueryRunRequest(
                baseDatasetId=request.base_dataset_id,
                query=request.query,
                referenceDatasetIds=request.reference_dataset_ids,
            ),
        )
        self._require_query_access(context_datasets, actor_context, request.query)
        compiled_query, _ = compile_trino_read_query(request.query, context_datasets)
        return self._build_query_estimate(
            actor=actor_context,
            context_datasets=context_datasets,
            compiled_query=compiled_query,
            query=request.query,
        )

    def list_for_actor(self, actor: ActorContext | None = None, *, limit: int = 20) -> TrinoQueryRunListResponse:
        """Return only runs submitted by the current principal; opening a run still rechecks dataset access."""
        actor_context = actor or ActorContext()
        items = [
            to_history_item(TrinoQueryRunResponse.model_validate(payload))
            for payload in self.repository.list_trino_run_payloads(
                actor_id=actor_context.id,
                actor_name=actor_context.name,
                limit=limit,
            )
        ]
        safe_record_audit_event(
            self.repository.db,
            action="query_run.history.view",
            actor=actor_context,
            api_path="/api/query/runs",
            http_method="GET",
            metadata={"count": len(items)},
            target_id=actor_context.id or actor_context.name,
            target_type="query_run",
        )
        return TrinoQueryRunListResponse(items=items)

    def _build_query_estimate(
        self,
        *,
        actor: ActorContext,
        context_datasets: list[CatalogDatasetResponse],
        compiled_query: str,
        query: str,
    ) -> TrinoQueryEstimate:
        try:
            plan_estimated_bytes = parse_plan_estimated_bytes(self.client.explain(compiled_query))
            plan_unavailable = False
        except ApiError:
            plan_estimated_bytes = None
            plan_unavailable = True
        return build_query_estimate(
            actor=actor,
            context_datasets=context_datasets,
            query=query,
            runtime_settings=self.settings,
            plan_estimated_bytes=plan_estimated_bytes,
            plan_unavailable=plan_unavailable,
        )

    def get(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        response = TrinoQueryRunResponse.model_validate(self._get_payload(run_id))
        self._require_access_for_response(response, actor or ActorContext(), operation="view")
        return response

    def refresh(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        """Read persisted collector state; browser polling never consumes Trino pages."""
        return self.get(run_id, actor)

    def collect_claimed_run(self, run_id: str, worker_id: str, generation: int) -> TrinoQueryRunResponse:
        """Consume durable continuation URLs while this worker owns the lease."""
        payload = self._get_payload(run_id)
        response = TrinoQueryRunResponse.model_validate(payload)
        pages_collected = 0

        while response.status not in {"succeeded", "failed", "cancelled"}:
            next_uri = str(payload.get("trinoNextUri") or "").strip()
            if not next_uri:
                break
            if not self.repository.renew_trino_collector_lease(
                run_id,
                worker_id,
                generation,
                self.settings.trino_collector_lease_seconds,
            ):
                return response

            page = self.client.fetch(next_uri)
            if not self.repository.renew_trino_collector_lease(
                run_id,
                worker_id,
                generation,
                self.settings.trino_collector_lease_seconds,
            ):
                return TrinoQueryRunResponse.model_validate(self._get_payload(run_id))
            updated = apply_trino_page(response, page)
            try:
                updated = self._finalize_result_storage(
                    self._store_result_page(
                        updated,
                        page,
                        source_next_uri=next_uri,
                        worker_id=worker_id,
                        generation=generation,
                    ),
                )
            except CollectorLeaseLost:
                return TrinoQueryRunResponse.model_validate(self._get_payload(run_id))
            except ApiError:
                self._cancel_after_result_persistence_failure(page.next_uri)
                updated = self._result_persistence_failed(updated)

            if not self._save_collector_response(
                updated,
                compiled_query=str(payload.get("compiledQuery") or ""),
                trino_next_uri=page.next_uri,
                worker_id=worker_id,
                generation=generation,
            ):
                return TrinoQueryRunResponse.model_validate(self._get_payload(run_id))
            if updated.status in {"succeeded", "failed", "cancelled"}:
                self._record_terminal_audit(updated, ActorContext(name="AskLake Collector", role="admin"))
                return updated

            response = updated
            payload = self._get_payload(run_id)
            pages_collected += 1
            if pages_collected >= self.settings.trino_collector_pages_per_lease:
                self.repository.release_trino_collector_lease(run_id, worker_id, generation)
                return response

        self.repository.release_trino_collector_lease(run_id, worker_id, generation)
        return response

    def cancel(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        payload = self._get_payload(run_id)
        response = TrinoQueryRunResponse.model_validate(payload)
        actor_context = actor or ActorContext()
        self._require_access_for_response(response, actor_context, operation="cancel")
        next_uri = str(payload.get("trinoNextUri") or "").strip()
        if response.status in {"succeeded", "failed", "cancelled"} or not next_uri:
            return response

        cancelled = response.model_copy(update={
            "completed_at": current_utc_timestamp(),
            "result": None,
            "status": "cancelled",
        })
        cancelled_payload = cancelled.model_dump(by_alias=True, exclude_none=True, mode="json")
        cancelled_payload["compiledQuery"] = payload.get("compiledQuery")
        cancelled_payload["trinoNextUri"] = None
        if not self.repository.cancel_trino_run_payload(cancelled_payload):
            return TrinoQueryRunResponse.model_validate(self._get_payload(run_id))
        try:
            self.client.cancel(next_uri)
        except ApiError:
            # The collector is fenced already; Trino may finish independently after a cancel race.
            pass
        self._delete_partial_result_pages(run_id)
        safe_record_audit_event(
            self.repository.db,
            action="query_run.cancel",
            actor=actor_context,
            api_path=f"/api/query/runs/{run_id}/cancel",
            http_method="POST",
            metadata={"runId": run_id, "trinoQueryId": response.trino_query_id},
            result="success",
            status_code=status.HTTP_200_OK,
            target_id=response.base_dataset_id,
            target_type="query_run",
        )
        return cancelled

    def get_result_page(
        self,
        run_id: str,
        cursor: str | None,
        actor: ActorContext | None = None,
    ) -> TrinoQueryRunResultPage:
        response = TrinoQueryRunResponse.model_validate(self._get_payload(run_id))
        self._require_access_for_response(response, actor or ActorContext(), operation="view")
        self._require_result_retention(response)
        payload = self._get_payload(run_id)
        retention_expires_at = response.result.retention_expires_at if response.result else None
        page_index, row_offset = decode_cursor_position(
            cursor,
            run_id=run_id,
            retention_expires_at=retention_expires_at,
            secret=self.settings.trino_result_cursor_secret,
        )
        page = self.repository.get_result_page(run_id, page_index)
        if page is None:
            if response.status in {"queued", "running"}:
                raise ApiError(
                    ErrorCode.RESULT_PAGE_NOT_READY,
                    "Query result page is still being collected",
                    status.HTTP_409_CONFLICT,
                )
            raise ApiError(ErrorCode.NOT_FOUND, "Query result page not found", status.HTTP_404_NOT_FOUND)
        safe_record_audit_event(
            self.repository.db,
            action="query_run.result.view",
            actor=actor or ActorContext(),
            api_path=f"/api/query/runs/{run_id}/results",
            http_method="GET",
            metadata={"pageIndex": page_index, "rowOffset": row_offset, "trinoQueryId": response.trino_query_id},
            target_id=run_id,
            target_type="query_run",
        )
        if page.storage_backend == "minio" and page.object_key:
            columns, rows = self.result_storage.read_page(
                object_key=page.object_key,
                expected_checksum=page.checksum,
            )
        else:
            columns = page.columns
            rows = page.rows
        result_page_size = normalized_result_page_size(payload.get("resultPageSize"))
        visible_rows = rows[row_offset:row_offset + result_page_size]
        next_page = self.repository.get_result_page(run_id, page_index + 1)
        if row_offset + len(visible_rows) < len(rows):
            next_position = (page_index, row_offset + len(visible_rows))
        elif next_page is not None:
            next_position = (page_index + 1, 0)
        else:
            next_position = None
        return TrinoQueryRunResultPage(
            columns=columns,
            next_cursor=encode_cursor(
                next_position[0],
                run_id=run_id,
                retention_expires_at=retention_expires_at,
                secret=self.settings.trino_result_cursor_secret,
                row_offset=next_position[1],
            ) if next_position else None,
            page_size=len(visible_rows),
            rows=visible_rows,
            run_id=run_id,
        )

    def _resolve_context(self, request: SubmitTrinoQueryRunRequest) -> list[CatalogDatasetResponse]:
        base_dataset = self._get_dataset(request.base_dataset_id, label="Base dataset")
        reference_ids = unique_values(request.reference_dataset_ids)
        return [
            base_dataset,
            *(self._get_dataset(dataset_id, label="Reference dataset") for dataset_id in reference_ids),
        ]

    def _get_dataset(self, dataset_id: str, *, label: str) -> CatalogDatasetResponse:
        payload = self.catalog_repository.get_dataset_payload(dataset_id)
        if payload is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                f"{label} not found",
                status.HTTP_404_NOT_FOUND,
                {"datasetId": dataset_id},
            )
        return dataset_with_persisted_permission_grants(
            self.catalog_repository.db,
            CatalogDatasetResponse.model_validate(payload),
        )

    def _require_query_access(
        self,
        datasets: Iterable[CatalogDatasetResponse],
        actor: ActorContext,
        query: str,
        *,
        api_path: str = "/api/query/runs",
        http_method: str = "POST",
    ) -> None:
        for dataset in datasets:
            require_governed_access(
                self.repository.db,
                actor,
                action="query",
                api_path=api_path,
                http_method=http_method,
                metadata={"owner": dataset.owner, **query_audit_metadata(query)},
                resource_id=dataset.id,
                resource_name=dataset.name,
                resource_type="dataset",
            )
            try:
                require_permission(
                    actor,
                    "query",
                    owner=dataset.owner,
                    grants=dataset.permission_grants,
                    resource_label="dataset",
                )
            except ApiError as exc:
                safe_record_audit_event(
                    self.repository.db,
                    action="dataset.query.forbidden",
                    actor=actor,
                    api_path=api_path,
                    http_method=http_method,
                    metadata={"owner": dataset.owner, **query_audit_metadata(query)},
                    result="forbidden",
                    status_code=exc.status_code,
                    target_id=dataset.id,
                    target_name=dataset.name,
                    target_type="dataset",
                )
                raise

    def require_query_access_for_run(
        self,
        response: TrinoQueryRunResponse,
        actor: ActorContext,
        *,
        api_path: str,
        http_method: str,
    ) -> list[CatalogDatasetResponse]:
        context_datasets = [
            self._get_dataset(response.base_dataset_id, label="Base dataset"),
            *(self._get_dataset(dataset_id, label="Reference dataset") for dataset_id in response.reference_dataset_ids),
        ]
        self._require_query_access(
            context_datasets,
            actor,
            response.query,
            api_path=api_path,
            http_method=http_method,
        )
        return context_datasets

    def _require_access_for_response(self, response: TrinoQueryRunResponse, actor: ActorContext, *, operation: str) -> None:
        context_datasets = self.require_query_access_for_run(
            response,
            actor,
            api_path=f"/api/query/runs/{response.run_id}",
            http_method="POST" if operation == "cancel" else "GET",
        )
        is_submitter = is_run_submitter(response.submitted_by_user_id, response.submitted_by_name, actor)
        can_manage = can(
            actor,
            "manage",
            owner=context_datasets[0].owner,
            grants=[grant.model_dump(by_alias=True) for grant in context_datasets[0].permission_grants],
        )
        if actor.is_admin or is_submitter or (operation == "cancel" and can_manage):
            return
        safe_record_audit_event(
            self.repository.db,
            action=f"query_run.{operation}.forbidden",
            actor=actor,
            api_path=f"/api/query/runs/{response.run_id}",
            http_method="POST" if operation == "cancel" else "GET",
            metadata={"trinoQueryId": response.trino_query_id},
            result="forbidden",
            status_code=status.HTTP_403_FORBIDDEN,
            target_id=response.run_id,
            target_type="query_run",
        )
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Only the submitting user can view this query run",
            status.HTTP_403_FORBIDDEN,
        )

    def _store_result_page(
        self,
        response: TrinoQueryRunResponse,
        page: TrinoClientPage,
        *,
        source_next_uri: str | None = None,
        worker_id: str | None = None,
        generation: int | None = None,
    ) -> TrinoQueryRunResponse:
        if source_next_uri and self.repository.get_result_page_by_source_uri(response.run_id, source_next_uri):
            return self._with_result_manifest(response, page.columns, next_uri=page.next_uri)
        page_count = self.repository.count_result_pages(response.run_id)
        # Trino often sends a terminal metadata-only page. Keep one empty page
        # for a genuinely empty result set, but never add a trailing blank page.
        if not page.rows and (response.status != "succeeded" or page_count > 0):
            return response
        columns = page.columns or (response.result.columns if response.result else [])
        stored_page = self.result_storage.write_page(
            run_id=response.run_id,
            page_index=page_count,
            columns=columns,
            rows=page.rows,
            attempt_id=f"g{generation}" if worker_id is not None and generation is not None else None,
        )
        if worker_id is not None and generation is not None and source_next_uri:
            outcome = self.repository.save_result_page_metadata_if_owned(
                run_id=response.run_id,
                worker_id=worker_id,
                generation=generation,
                page_index=page_count,
                columns=stored_page.columns,
                object_key=stored_page.object_key,
                row_count=stored_page.row_count,
                compressed_bytes=stored_page.compressed_bytes,
                checksum=stored_page.checksum,
                source_next_uri=source_next_uri,
            )
            if outcome != "saved":
                self.result_storage.delete_object(stored_page.object_key, suppress_errors=True)
            if outcome == "fenced":
                raise CollectorLeaseLost(response.run_id)
        else:
            self.repository.save_result_page_metadata(
                run_id=response.run_id,
                page_index=page_count,
                columns=stored_page.columns,
                object_key=stored_page.object_key,
                row_count=stored_page.row_count,
                compressed_bytes=stored_page.compressed_bytes,
                checksum=stored_page.checksum,
                source_next_uri=source_next_uri,
            )
        return self._with_result_manifest(response, columns, next_uri=page.next_uri)

    def _with_result_manifest(
        self,
        response: TrinoQueryRunResponse,
        columns: list[str],
        *,
        next_uri: str | None,
    ) -> TrinoQueryRunResponse:
        result = response.result or TrinoQueryRunResult()
        page_count = self.repository.count_result_pages(response.run_id)
        total_bytes = self.repository.total_result_bytes(response.run_id)
        return response.model_copy(update={
            "result": result.model_copy(update={
                "available_page_count": page_count,
                "byte_size": total_bytes,
                "columns": columns or result.columns,
                "page_count": page_count,
                "row_count": self.repository.total_result_rows(response.run_id),
                "storage": "minio",
                "storage_status": "available" if response.status == "succeeded" and not next_uri else "collecting",
            }),
        })

    def _finalize_result_storage(self, response: TrinoQueryRunResponse) -> TrinoQueryRunResponse:
        if response.status != "succeeded" or response.result is None:
            return response
        return response.model_copy(update={
            "result": response.result.model_copy(update={"storage_status": "available"}),
        })

    def _result_persistence_failed(self, response: TrinoQueryRunResponse) -> TrinoQueryRunResponse:
        result = response.result or TrinoQueryRunResult()
        return response.model_copy(update={
            "completed_at": current_utc_timestamp(),
            "error": TrinoQueryRunError(
                code=ErrorCode.RESULT_PERSISTENCE_FAILED,
                message="Query result persistence failed",
            ),
            "result": result.model_copy(update={"storage_status": "unavailable"}),
            "status": "failed",
        })

    def _save_response(self, response: TrinoQueryRunResponse, *, compiled_query: str, trino_next_uri: str | None) -> None:
        payload = self._response_payload(response, compiled_query=compiled_query, trino_next_uri=trino_next_uri)
        self.repository.save_run_payload(payload)

    def _save_collector_response(
        self,
        response: TrinoQueryRunResponse,
        *,
        compiled_query: str,
        trino_next_uri: str | None,
        worker_id: str,
        generation: int,
    ) -> bool:
        payload = self._response_payload(response, compiled_query=compiled_query, trino_next_uri=trino_next_uri)
        return self.repository.save_collector_run_payload(payload, worker_id=worker_id, generation=generation)

    def _response_payload(
        self,
        response: TrinoQueryRunResponse,
        *,
        compiled_query: str,
        trino_next_uri: str | None,
    ) -> dict[str, object]:
        existing = self.repository.get_run_payload(response.run_id) or {}
        payload: dict[str, object] = response.model_dump(by_alias=True, exclude_none=True, mode="json")
        payload["compiledQuery"] = compiled_query
        payload["trinoNextUri"] = trino_next_uri
        for key in ("actorKey", "clientRequestId", "requestFingerprint", "resultPageSize"):
            if key in existing:
                payload[key] = existing[key]
        return payload

    def _cancel_after_result_persistence_failure(self, next_uri: str | None) -> None:
        if not next_uri:
            return
        try:
            self.client.cancel(next_uri)
        except ApiError:
            # Preserve the primary persistence failure even if Trino cancellation also fails.
            return

    def _delete_partial_result_pages(self, run_id: str) -> None:
        for page in self.repository.list_result_pages(run_id):
            if page.storage_backend == "minio" and page.object_key:
                self.result_storage.delete_object(page.object_key)
        self.repository.delete_result_pages(run_id)

    def _record_terminal_audit(self, response: TrinoQueryRunResponse, actor: ActorContext) -> None:
        safe_record_audit_event(
            self.repository.db,
            action=f"query_run.{response.status}",
            actor=actor,
            api_path=f"/api/query/runs/{response.run_id}",
            http_method="GET",
            metadata={"trinoQueryId": response.trino_query_id, "stats": response.stats.model_dump(by_alias=True) if response.stats else {}},
            result="success" if response.status == "succeeded" else "failed",
            target_id=response.run_id,
            target_type="query_run",
        )

    def _require_result_retention(self, response: TrinoQueryRunResponse) -> None:
        expires_at = response.result.retention_expires_at if response.result else None
        if not expires_at:
            return
        try:
            expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError:
            return
        if expiry <= datetime.now(timezone.utc):
            raise ApiError(
                ErrorCode.RESULT_EXPIRED,
                "Query result retention has expired",
                status.HTTP_410_GONE,
            )

    def _get_payload(self, run_id: str) -> dict[str, object]:
        payload = self.repository.get_run_payload(run_id)
        if payload is None or payload.get("engine") != "trino":
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "Trino query run not found",
                status.HTTP_404_NOT_FOUND,
                {"runId": run_id},
            )
        return payload


def to_history_item(response: TrinoQueryRunResponse) -> TrinoQueryRunHistoryItem:
    result = response.result
    return TrinoQueryRunHistoryItem(
        base_dataset_id=response.base_dataset_id,
        completed_at=response.completed_at,
        query=response.query,
        result=TrinoQueryRunHistoryResult(
            row_count=result.row_count,
            storage_status=result.storage_status,
        ) if result else None,
        run_id=response.run_id,
        stats=TrinoQueryRunHistoryStats(processed_bytes=response.stats.processed_bytes) if response.stats else None,
        status=response.status,
        submitted_at=response.submitted_at,
    )


def build_run_response(
    request: SubmitTrinoQueryRunRequest,
    page: TrinoClientPage,
    actor: ActorContext,
    retention_seconds: int,
    *,
    run_id: str | None = None,
    submitted_at: str | None = None,
) -> TrinoQueryRunResponse:
    submitted_at = submitted_at or current_utc_timestamp()
    response = TrinoQueryRunResponse(
        base_dataset_id=request.base_dataset_id,
        error=page.error,
        query=request.query,
        reference_dataset_ids=unique_values(request.reference_dataset_ids),
        result=TrinoQueryRunResult(
            columns=page.columns,
            retention_expires_at=(datetime.now(timezone.utc) + timedelta(seconds=retention_seconds)).isoformat(),
        ),
        run_id=run_id or f"trino_{uuid4().hex[:12]}",
        stats=trino_stats(page.raw_stats),
        status=trino_status(page),
        submitted_at=submitted_at,
        submitted_by_name=actor.name,
        submitted_by_user_id=actor.id,
        trino_query_id=page.query_id or None,
    )
    return apply_terminal_timestamps(response)


def build_reserved_run_response(
    request: SubmitTrinoQueryRunRequest,
    actor: ActorContext,
    retention_seconds: int,
) -> TrinoQueryRunResponse:
    return TrinoQueryRunResponse(
        base_dataset_id=request.base_dataset_id,
        query=request.query,
        reference_dataset_ids=unique_values(request.reference_dataset_ids),
        result=TrinoQueryRunResult(
            retention_expires_at=(datetime.now(timezone.utc) + timedelta(seconds=retention_seconds)).isoformat(),
            storage_status="collecting",
        ),
        run_id=f"trino_{uuid4().hex[:12]}",
        status="queued",
        submitted_at=current_utc_timestamp(),
        submitted_by_name=actor.name,
        submitted_by_user_id=actor.id,
    )


def apply_trino_page(response: TrinoQueryRunResponse, page: TrinoClientPage) -> TrinoQueryRunResponse:
    result = response.result or TrinoQueryRunResult()
    if page.columns:
        result = result.model_copy(update={"columns": page.columns})
    updated = response.model_copy(update={
        "error": page.error,
        "result": result,
        "stats": trino_stats(page.raw_stats),
        "status": trino_status(page),
        "trino_query_id": page.query_id or response.trino_query_id,
    })
    return apply_terminal_timestamps(updated)


def apply_terminal_timestamps(response: TrinoQueryRunResponse) -> TrinoQueryRunResponse:
    updates: dict[str, str] = {}
    if response.status == "running" and response.started_at is None:
        updates["started_at"] = current_utc_timestamp()
    if response.status in {"succeeded", "failed", "cancelled"} and response.completed_at is None:
        updates["completed_at"] = current_utc_timestamp()
    return response.model_copy(update=updates) if updates else response


def trino_status(page: TrinoClientPage) -> str:
    if page.error is not None:
        return "failed"
    state = (page.state or "").upper()
    if state == "FINISHED" and not page.next_uri:
        return "succeeded"
    if state in {"CANCELED", "CANCELLED"}:
        return "cancelled"
    if state in {"QUEUED", "PLANNING", "STARTING"}:
        return "queued"
    return "running"


def trino_stats(raw_stats: dict[str, object]) -> TrinoQueryRunStats | None:
    if not raw_stats:
        return None
    return TrinoQueryRunStats(
        cpu_ms=int_or_none(raw_stats.get("cpuTimeMillis")),
        elapsed_ms=int_or_none(raw_stats.get("elapsedTimeMillis")),
        peak_memory_bytes=int_or_none(raw_stats.get("peakMemoryBytes")),
        processed_bytes=int_or_none(raw_stats.get("processedBytes")),
        processed_rows=int_or_none(raw_stats.get("processedRows")),
        queued_ms=int_or_none(raw_stats.get("queuedTimeMillis")),
    )


def int_or_none(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def query_audit_metadata(query: str) -> dict[str, object]:
    normalized = " ".join(query.split())
    return {
        "queryHash": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
        "queryLength": len(query),
    }


def unique_values(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = str(value).strip()
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def is_run_submitter(submitted_by_user_id: str | None, submitted_by_name: str | None, actor: ActorContext) -> bool:
    if submitted_by_user_id:
        return bool(actor.id and actor.id == submitted_by_user_id)
    return bool(submitted_by_name and actor.name == submitted_by_name)


def trino_request_fingerprint(request: SubmitTrinoQueryRunRequest) -> str:
    canonical = json.dumps({
        "baseDatasetId": request.base_dataset_id,
        "query": request.query.replace("\r\n", "\n").strip(),
        "referenceDatasetIds": sorted(unique_values(request.reference_dataset_ids)),
        "resultPageSize": normalized_result_page_size(request.result_page_size),
    }, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalized_result_page_size(value: object) -> int:
    try:
        page_size = int(value or 100)
    except (TypeError, ValueError):
        page_size = 100
    return max(1, min(page_size, 1_000))


def decode_cursor(
    cursor: str | None,
    *,
    run_id: str,
    retention_expires_at: str | None,
    secret: str,
) -> int:
    return decode_cursor_position(
        cursor,
        run_id=run_id,
        retention_expires_at=retention_expires_at,
        secret=secret,
    )[0]


def decode_cursor_position(
    cursor: str | None,
    *,
    run_id: str,
    retention_expires_at: str | None,
    secret: str,
) -> tuple[int, int]:
    if cursor is None:
        return 0, 0
    try:
        payload_encoded, signature = cursor.split(".", maxsplit=1)
        expected_signature = sign_cursor(payload_encoded, secret)
        if not hmac.compare_digest(signature, expected_signature):
            raise ValueError("invalid signature")
        payload = json.loads(base64.urlsafe_b64decode(pad_base64(payload_encoded)).decode("utf-8"))
        page_index = int(payload["pageIndex"])
        row_offset = int(payload.get("rowOffset") or 0)
        expires_at = str(payload["expiresAt"])
    except (AttributeError, KeyError, TypeError, ValueError, UnicodeDecodeError, binascii.Error, json.JSONDecodeError) as exc:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Invalid query result cursor", status.HTTP_422_UNPROCESSABLE_ENTITY) from exc
    if payload.get("version") != 1 or payload.get("runId") != run_id or page_index < 0 or row_offset < 0:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Invalid query result cursor", status.HTTP_422_UNPROCESSABLE_ENTITY)
    if not retention_expires_at or expires_at != retention_expires_at:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Query result cursor does not match this run", status.HTTP_422_UNPROCESSABLE_ENTITY)
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Invalid query result cursor", status.HTTP_422_UNPROCESSABLE_ENTITY) from exc
    if expiry <= datetime.now(timezone.utc):
        raise ApiError(ErrorCode.RESULT_EXPIRED, "Query result cursor has expired", status.HTTP_410_GONE)
    return page_index, row_offset


def encode_cursor(
    page_index: int,
    *,
    run_id: str,
    retention_expires_at: str | None,
    secret: str,
    row_offset: int = 0,
) -> str:
    if page_index < 0 or row_offset < 0 or not retention_expires_at:
        raise ApiError(ErrorCode.RESULT_EXPIRED, "Query result is unavailable", status.HTTP_410_GONE)
    payload = json.dumps({
        "expiresAt": retention_expires_at,
        "pageIndex": page_index,
        "rowOffset": row_offset,
        "runId": run_id,
        "version": 1,
    }, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"{payload_encoded}.{sign_cursor(payload_encoded, secret)}"


def sign_cursor(payload_encoded: str, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload_encoded.encode("ascii"), hashlib.sha256).hexdigest()


def pad_base64(value: str) -> str:
    return value + "=" * (-len(value) % 4)


def current_utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()
