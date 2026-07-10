from datetime import datetime, timezone
import re
from typing import Iterable
from uuid import uuid4

from fastapi import status

from app.core.auth_context import ActorContext, require_permission
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
    TrinoQueryRunStats,
)
from app.services.governance_enforcement import require_governed_access
from app.services.resource_permission_service import dataset_with_persisted_permission_grants
from app.services.sql_service import (
    SQL_TABLE_REFERENCE_RE,
    build_dataset_context_map,
    mask_sql_comments_and_literals,
    normalize_sql_identifier,
    resolve_referenced_datasets,
    unique_dataset_ids,
    validate_read_only_query,
)
from app.services.trino_client import TrinoClient


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
        statement = validate_read_only_query(request.query)
        context_datasets = self._resolve_context(request)
        self._require_query_access(context_datasets, actor_context, request.query)
        referenced_datasets = resolve_referenced_datasets(
            mask_sql_comments_and_literals(statement),
            context_datasets,
        )
        compiled_query = compile_trino_query(statement, referenced_datasets, context_datasets)
        page = self.client.submit(compiled_query)
        response = build_run_response(request, page)
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
        self._require_access_for_response(response, actor or ActorContext())
        return response

    def refresh(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        payload = self._get_payload(run_id)
        response = TrinoQueryRunResponse.model_validate(payload)
        self._require_access_for_response(response, actor or ActorContext())
        next_uri = str(payload.get("trinoNextUri") or "").strip()
        if response.status in {"succeeded", "failed", "cancelled"} or not next_uri:
            return response

        page = self.client.fetch(next_uri)
        updated = apply_trino_page(response, page)
        updated_payload = updated.model_dump(by_alias=True, exclude_none=True, mode="json")
        updated_payload["compiledQuery"] = payload.get("compiledQuery")
        updated_payload["trinoNextUri"] = page.next_uri
        self.repository.save_run_payload(updated_payload)
        return updated

    def cancel(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        payload = self._get_payload(run_id)
        response = TrinoQueryRunResponse.model_validate(payload)
        actor_context = actor or ActorContext()
        self._require_access_for_response(response, actor_context)
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
            target_type="dataset",
        )
        return cancelled

    def _resolve_context(self, request: SubmitTrinoQueryRunRequest) -> list[CatalogDatasetResponse]:
        base_dataset = self._get_dataset(request.base_dataset_id, label="Base dataset")
        reference_ids = unique_dataset_ids(request.reference_dataset_ids)
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
                metadata={"owner": dataset.owner, "query": query[:500]},
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
                    metadata={"owner": dataset.owner, "query": query[:500]},
                    result="forbidden",
                    status_code=exc.status_code,
                    target_id=dataset.id,
                    target_name=dataset.name,
                    target_type="dataset",
                )
                raise

    def _require_access_for_response(self, response: TrinoQueryRunResponse, actor: ActorContext) -> None:
        context_datasets = [
            self._get_dataset(response.base_dataset_id, label="Base dataset"),
            *(self._get_dataset(dataset_id, label="Reference dataset") for dataset_id in response.reference_dataset_ids),
        ]
        self._require_query_access(context_datasets, actor, response.query)

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


def compile_trino_query(
    statement: str,
    referenced_datasets: list[CatalogDatasetResponse],
    context_datasets: list[CatalogDatasetResponse],
) -> str:
    dataset_by_table_name = build_dataset_context_map(context_datasets)
    referenced_by_id = {dataset.id: dataset for dataset in referenced_datasets}

    def replace_reference(match: re.Match[str]) -> str:
        raw_identifier = match.group(1)
        dataset = dataset_by_table_name.get(normalize_sql_identifier(raw_identifier))
        if dataset is None or dataset.id not in referenced_by_id:
            return match.group(0)
        mapping = dataset.query_engine_table
        if mapping is None:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Dataset is missing its Trino table mapping",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"datasetId": dataset.id, "datasetName": dataset.name},
            )
        physical_table = ".".join(
            quote_trino_identifier(part)
            for part in (mapping.catalog, mapping.schema_, mapping.table)
        )
        identifier_start = match.start(1) - match.start(0)
        return f"{match.group(0)[:identifier_start]}{physical_table}"

    return SQL_TABLE_REFERENCE_RE.sub(replace_reference, statement)


def build_run_response(
    request: SubmitTrinoQueryRunRequest,
    page: TrinoClientPage,
) -> TrinoQueryRunResponse:
    response = TrinoQueryRunResponse(
        base_dataset_id=request.base_dataset_id,
        error=page.error,
        query=request.query,
        reference_dataset_ids=unique_dataset_ids(request.reference_dataset_ids),
        result=TrinoQueryRunResult(columns=page.columns) if page.columns else None,
        run_id=f"trino_{uuid4().hex[:12]}",
        stats=trino_stats(page.raw_stats),
        status=trino_status(page),
        submitted_at=current_utc_timestamp(),
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


def quote_trino_identifier(identifier: str) -> str:
    escaped = str(identifier).replace('"', '""')
    return f'"{escaped}"'


def current_utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()
