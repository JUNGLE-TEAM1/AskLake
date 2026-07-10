from datetime import datetime, timedelta, timezone
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
    TrinoQueryRunResponse,
    TrinoQueryRunResult,
    TrinoQueryRunResultPage,
    TrinoQueryRunStats,
)
from app.services.governance_enforcement import require_governed_access
from app.services.resource_permission_service import dataset_with_persisted_permission_grants
from app.services.trino_client import TrinoClient
from app.services.trino_sql_compiler import compile_trino_read_query


class TrinoQueryRunService:
    """Canonical Query Run foundation. API routing switches to this in Phase 3."""

    def __init__(
        self,
        repository: SqlRepository,
        catalog_repository: CatalogRepository,
        client: TrinoClient | None = None,
        runtime_settings: Settings | None = None,
    ) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository
        self.settings = runtime_settings or settings
        self.client = client or TrinoClient(self.settings)

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
        if self.repository.count_active_trino_runs_for_actor(actor_key) >= self.settings.trino_max_concurrent_runs_per_user:
            raise ApiError(
                ErrorCode.CONFLICT,
                "Concurrent query run limit reached",
                status.HTTP_429_TOO_MANY_REQUESTS,
                {"limit": self.settings.trino_max_concurrent_runs_per_user},
            )
        context_datasets = self._resolve_context(request)
        self._require_query_access(context_datasets, actor_context, request.query)
        compiled_query, _ = compile_trino_read_query(request.query, context_datasets)
        page = self.client.submit(compiled_query)
        response = build_run_response(request, page, actor_context, self.settings.trino_result_retention_seconds)
        response = self._store_result_page(response, page)
        payload = response.model_dump(by_alias=True, exclude_none=True, mode="json")
        payload["compiledQuery"] = compiled_query
        payload["trinoNextUri"] = page.next_uri
        self.repository.save_run_payload(payload)
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

    def get(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        response = TrinoQueryRunResponse.model_validate(self._get_payload(run_id))
        self._require_access_for_response(response, actor or ActorContext(), operation="view")
        self._require_result_retention(response)
        return response

    def refresh(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        payload = self._get_payload(run_id)
        response = TrinoQueryRunResponse.model_validate(payload)
        self._require_access_for_response(response, actor or ActorContext(), operation="view")
        next_uri = str(payload.get("trinoNextUri") or "").strip()
        if response.status in {"succeeded", "failed", "cancelled"} or not next_uri:
            return response

        page = self.client.fetch(next_uri)
        updated = apply_trino_page(response, page)
        updated = self._store_result_page(updated, page)
        updated_payload = updated.model_dump(by_alias=True, exclude_none=True, mode="json")
        updated_payload["compiledQuery"] = payload.get("compiledQuery")
        updated_payload["trinoNextUri"] = page.next_uri
        self.repository.save_run_payload(updated_payload)
        if updated.status in {"succeeded", "failed", "cancelled"} and updated.status != response.status:
            self._record_terminal_audit(updated, actor or ActorContext())
        return updated

    def cancel(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        payload = self._get_payload(run_id)
        response = TrinoQueryRunResponse.model_validate(payload)
        actor_context = actor or ActorContext()
        self._require_access_for_response(response, actor_context, operation="cancel")
        next_uri = str(payload.get("trinoNextUri") or "").strip()
        if response.status in {"succeeded", "failed", "cancelled"} or not next_uri:
            return response

        self.client.cancel(next_uri)
        cancelled = response.model_copy(update={
            "completed_at": current_utc_timestamp(),
            "status": "cancelled",
        })
        cancelled_payload = cancelled.model_dump(by_alias=True, exclude_none=True, mode="json")
        cancelled_payload["compiledQuery"] = payload.get("compiledQuery")
        self.repository.save_run_payload(cancelled_payload)
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
        page_index = decode_cursor(cursor)
        page = self.repository.get_result_page(run_id, page_index)
        if page is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Query result page not found", status.HTTP_404_NOT_FOUND)
        next_page = self.repository.get_result_page(run_id, page_index + 1)
        safe_record_audit_event(
            self.repository.db,
            action="query_run.result.view",
            actor=actor or ActorContext(),
            api_path=f"/api/query/runs/{run_id}/results",
            http_method="GET",
            metadata={"pageIndex": page_index, "trinoQueryId": response.trino_query_id},
            target_id=run_id,
            target_type="query_run",
        )
        return TrinoQueryRunResultPage(
            columns=page.columns,
            next_cursor=encode_cursor(page_index + 1) if next_page else None,
            page_size=len(page.rows),
            rows=page.rows,
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
    ) -> None:
        for dataset in datasets:
            require_governed_access(
                self.repository.db,
                actor,
                action="query",
                api_path="/api/query/runs",
                http_method="POST",
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
                    api_path="/api/query/runs",
                    http_method="POST",
                    metadata={"owner": dataset.owner, **query_audit_metadata(query)},
                    result="forbidden",
                    status_code=exc.status_code,
                    target_id=dataset.id,
                    target_name=dataset.name,
                    target_type="dataset",
                )
                raise

    def _require_access_for_response(self, response: TrinoQueryRunResponse, actor: ActorContext, *, operation: str) -> None:
        context_datasets = [
            self._get_dataset(response.base_dataset_id, label="Base dataset"),
            *(self._get_dataset(dataset_id, label="Reference dataset") for dataset_id in response.reference_dataset_ids),
        ]
        self._require_query_access(context_datasets, actor, response.query)
        is_submitter = (
            (response.submitted_by_user_id and actor.id == response.submitted_by_user_id)
            or actor.name == response.submitted_by_name
        )
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

    def _store_result_page(self, response: TrinoQueryRunResponse, page: TrinoClientPage) -> TrinoQueryRunResponse:
        if not page.rows:
            return response
        page_count = self.repository.count_result_pages(response.run_id)
        page_bytes = len(json.dumps(page.rows, ensure_ascii=False, default=str).encode("utf-8"))
        total_bytes = self.repository.total_result_bytes(response.run_id) + page_bytes
        if page_count >= self.settings.trino_max_result_pages or total_bytes > self.settings.trino_max_result_bytes:
            if page.next_uri:
                self.client.cancel(page.next_uri)
            raise ApiError(
                ErrorCode.BACKEND_TIMEOUT,
                "Query result exceeded the configured storage limit",
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )
        columns = page.columns or (response.result.columns if response.result else [])
        self.repository.save_result_page(
            run_id=response.run_id,
            page_index=page_count,
            columns=columns,
            rows=page.rows,
            byte_size=page_bytes,
        )
        result = response.result or TrinoQueryRunResult()
        return response.model_copy(update={
            "result": result.model_copy(update={"columns": columns, "row_count": (result.row_count or 0) + len(page.rows)}),
        })

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
                ErrorCode.NOT_FOUND,
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


def build_run_response(
    request: SubmitTrinoQueryRunRequest,
    page: TrinoClientPage,
    actor: ActorContext,
    retention_seconds: int,
) -> TrinoQueryRunResponse:
    submitted_at = current_utc_timestamp()
    response = TrinoQueryRunResponse(
        base_dataset_id=request.base_dataset_id,
        error=page.error,
        query=request.query,
        reference_dataset_ids=unique_values(request.reference_dataset_ids),
        result=TrinoQueryRunResult(
            columns=page.columns,
            retention_expires_at=(datetime.now(timezone.utc) + timedelta(seconds=retention_seconds)).isoformat(),
        ) if page.columns else None,
        run_id=f"trino_{uuid4().hex[:12]}",
        stats=trino_stats(page.raw_stats),
        status=trino_status(page),
        submitted_at=submitted_at,
        submitted_by_name=actor.name,
        submitted_by_user_id=actor.id,
        trino_query_id=page.query_id or None,
    )
    return apply_terminal_timestamps(response)


def apply_trino_page(response: TrinoQueryRunResponse, page: TrinoClientPage) -> TrinoQueryRunResponse:
    result = response.result or TrinoQueryRunResult()
    if page.columns:
        result = result.model_copy(update={"columns": page.columns})
    updated = response.model_copy(update={
        "error": page.error,
        "result": result if result.columns else None,
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


def decode_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    if not cursor.startswith("page:"):
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Invalid query result cursor", status.HTTP_422_UNPROCESSABLE_ENTITY)
    try:
        page_index = int(cursor.removeprefix("page:"))
    except ValueError as exc:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Invalid query result cursor", status.HTTP_422_UNPROCESSABLE_ENTITY) from exc
    if page_index < 0:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Invalid query result cursor", status.HTTP_422_UNPROCESSABLE_ENTITY)
    return page_index


def encode_cursor(page_index: int) -> str:
    return f"page:{page_index}"


def current_utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()
