"""Compatibility façade for the Trino Query Run feature.

The public service shape is intentionally stable for API routes and workers.
Submission, access, collection, lifecycle, and result I/O are owned by focused
services assembled here.
"""

from typing import Iterable, Iterator

from app.core.auth_context import ActorContext
from app.core.config import Settings, settings
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.trino import (
    CreateTrinoFullResultRequest,
    SubmitTrinoQueryRunRequest,
    TrinoClientPage,
    TrinoQueryEstimate,
    TrinoQueryEstimateRequest,
    TrinoQueryRunChartRequest,
    TrinoQueryRunChartResponse,
    TrinoQueryRunListResponse,
    TrinoQueryRunResponse,
    TrinoQueryRunResultPage,
    TrinoQueryValidationRequest,
    TrinoQueryValidationResponse,
)
from app.services.trino_client import TrinoClient
from app.services.trino_full_result import TrinoFullResultService
from app.services.trino_query_access import TrinoQueryAccessService
from app.services.trino_query_collector import TrinoQueryCollectorService
from app.services.trino_query_lifecycle import TrinoQueryLifecycleService
from app.services.trino_query_result_manifest import (
    result_collection_progress_percentage,
    with_result_collection_timing,
)
from app.services.trino_query_results import CollectorLeaseLost, TrinoQueryResultService
from app.services.trino_query_run_state import (
    apply_terminal_timestamps,
    apply_trino_page,
    apply_trino_query_info,
    build_reserved_run_response,
    build_run_response,
    decode_cursor,
    decode_cursor_position,
    encode_cursor,
    float_or_none,
    int_or_none,
    is_run_submitter,
    merge_trino_query_state,
    merge_trino_run_stats,
    normalized_result_page_size,
    parse_trino_data_size_bytes,
    parse_trino_duration_ms,
    query_audit_metadata,
    query_run_estimate_snapshot,
    to_history_item,
    trino_request_fingerprint,
    trino_stats,
    trino_status,
    unique_values,
)
from app.services.trino_query_run_store import TrinoQueryRunStore
from app.services.trino_query_submission import TrinoQuerySubmissionService
from app.services.trino_result_storage import TrinoResultStorage


class TrinoQueryRunService:
    """Stable façade used by API routes, collectors, and legacy callers."""

    def __init__(
        self,
        repository: SqlRepository,
        catalog_repository: CatalogRepository,
        client: TrinoClient | None = None,
        progress_client: TrinoClient | None = None,
        result_storage: TrinoResultStorage | None = None,
        runtime_settings: Settings | None = None,
    ) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository
        self.settings = runtime_settings or settings
        self.client = client or TrinoClient(self.settings)
        self.progress_client = progress_client or (TrinoClient(self.settings) if client is None else self.client)
        self.result_storage = result_storage or TrinoResultStorage(self.settings)

        self.run_store = TrinoQueryRunStore(repository)
        self.access_service = TrinoQueryAccessService(repository, catalog_repository)
        self.result_service = TrinoQueryResultService(
            repository,
            self.result_storage,
            self.settings,
            self.access_service,
            self.run_store,
            self.client,
        )
        self.submission_service = TrinoQuerySubmissionService(
            repository,
            self.settings,
            self.client,
            self.access_service,
            self.result_service,
            self.run_store,
        )
        self.full_result_service = TrinoFullResultService(
            repository,
            self.settings,
            self.access_service,
            self.result_service,
            self.run_store,
            self.submission_service,
        )
        self.lifecycle_service = TrinoQueryLifecycleService(
            repository,
            self.client,
            self.access_service,
            self.result_service,
            self.run_store,
        )
        self.collector_service = TrinoQueryCollectorService(
            repository,
            self.settings,
            self.client,
            self.progress_client,
            self.result_service,
            self.run_store,
        )

    def submit(
        self,
        request: SubmitTrinoQueryRunRequest,
        actor: ActorContext | None = None,
    ) -> TrinoQueryRunResponse:
        return self.submission_service.submit(request, actor)

    def create_full_result_run(
        self,
        preview_run_id: str,
        request: CreateTrinoFullResultRequest,
        actor: ActorContext | None = None,
    ) -> TrinoQueryRunResponse:
        return self.full_result_service.create(preview_run_id, request, actor or ActorContext())

    def estimate(
        self,
        request: TrinoQueryEstimateRequest,
        actor: ActorContext | None = None,
    ) -> TrinoQueryEstimate:
        return self.submission_service.estimate(request, actor)

    def validate(
        self,
        request: TrinoQueryValidationRequest,
        actor: ActorContext | None = None,
    ) -> TrinoQueryValidationResponse:
        return self.submission_service.validate(request, actor)

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
        return self.submission_service.compile_for_actor(
            base_dataset_id=base_dataset_id,
            reference_dataset_ids=reference_dataset_ids,
            query=query,
            actor=actor,
            api_path=api_path,
            http_method=http_method,
        )

    def list_for_actor(
        self,
        actor: ActorContext | None = None,
        *,
        limit: int = 20,
    ) -> TrinoQueryRunListResponse:
        return self.lifecycle_service.list_for_actor(actor, limit=limit)

    def get(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        return self.lifecycle_service.get(run_id, actor)

    def refresh(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        return self.lifecycle_service.refresh(run_id, actor)

    def collect_claimed_run(self, run_id: str, worker_id: str, generation: int) -> TrinoQueryRunResponse:
        return self.collector_service.collect_claimed_run(run_id, worker_id, generation)

    def cancel(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        return self.lifecycle_service.cancel(run_id, actor)

    def get_result_page(
        self,
        run_id: str,
        cursor: str | None,
        actor: ActorContext | None = None,
    ) -> TrinoQueryRunResultPage:
        return self.result_service.get_result_page(run_id, cursor, actor)

    def prepare_csv_export(self, run_id: str, actor: ActorContext | None = None) -> Iterator[bytes]:
        return self.result_service.prepare_csv_export(run_id, actor)

    def prepare_chart_data(
        self,
        run_id: str,
        request: TrinoQueryRunChartRequest,
        actor: ActorContext | None = None,
    ) -> TrinoQueryRunChartResponse:
        return self.result_service.prepare_chart_data(run_id, request, actor)

    # Compatibility wrappers keep existing internal callers and focused tests
    # working while all canonical logic lives in the collaborators above.
    def _resolve_context(self, request: SubmitTrinoQueryRunRequest) -> list[CatalogDatasetResponse]:
        return self.access_service.resolve_context(request)

    def _get_dataset(self, dataset_id: str, *, label: str) -> CatalogDatasetResponse:
        return self.access_service.get_dataset(dataset_id, label=label)

    def _require_query_access(
        self,
        datasets: Iterable[CatalogDatasetResponse],
        actor: ActorContext,
        query: str,
        *,
        api_path: str = "/api/query/runs",
        http_method: str = "POST",
    ) -> None:
        self.access_service.require_query_access(
            datasets,
            actor,
            query,
            api_path=api_path,
            http_method=http_method,
        )

    def require_query_access_for_run(
        self,
        response: TrinoQueryRunResponse,
        actor: ActorContext,
        *,
        api_path: str,
        http_method: str,
    ) -> list[CatalogDatasetResponse]:
        return self.access_service.require_query_access_for_run(
            response,
            actor,
            api_path=api_path,
            http_method=http_method,
        )

    def _require_access_for_response(
        self,
        response: TrinoQueryRunResponse,
        actor: ActorContext,
        *,
        operation: str,
    ) -> None:
        self.access_service.require_access_for_response(response, actor, operation=operation)

    def _build_query_estimate(
        self,
        *,
        actor: ActorContext,
        context_datasets: list[CatalogDatasetResponse],
        compiled_query: str,
        query: str,
    ) -> TrinoQueryEstimate:
        return self.submission_service.build_query_estimate(
            actor=actor,
            context_datasets=context_datasets,
            compiled_query=compiled_query,
            query=query,
        )

    def _fetch_with_live_progress(
        self,
        response: TrinoQueryRunResponse,
        *,
        next_uri: str,
        compiled_query: str,
        worker_id: str,
        generation: int,
    ) -> tuple[TrinoClientPage | None, TrinoQueryRunResponse]:
        return self.collector_service.fetch_with_live_progress(
            response,
            next_uri=next_uri,
            compiled_query=compiled_query,
            worker_id=worker_id,
            generation=generation,
        )

    def _sample_query_info(self, response: TrinoQueryRunResponse) -> TrinoQueryRunResponse:
        return self.collector_service.sample_query_info(response)

    def _store_result_page(
        self,
        response: TrinoQueryRunResponse,
        page: TrinoClientPage,
        *,
        source_next_uri: str | None = None,
        worker_id: str | None = None,
        generation: int | None = None,
    ) -> TrinoQueryRunResponse:
        return self.result_service.store_page(
            response,
            page,
            source_next_uri=source_next_uri,
            worker_id=worker_id,
            generation=generation,
        )

    def _with_result_manifest(
        self,
        response: TrinoQueryRunResponse,
        columns: list[str],
        *,
        next_uri: str | None,
    ) -> TrinoQueryRunResponse:
        return self.result_service.with_manifest(response, columns, next_uri=next_uri)

    def _finalize_result_storage(self, response: TrinoQueryRunResponse) -> TrinoQueryRunResponse:
        return self.result_service.finalize_storage(response)

    def _result_persistence_failed(self, response: TrinoQueryRunResponse) -> TrinoQueryRunResponse:
        return self.result_service.persistence_failed(response)

    def _save_response(
        self,
        response: TrinoQueryRunResponse,
        *,
        compiled_query: str,
        trino_next_uri: str | None,
    ) -> None:
        self.run_store.save(response, compiled_query=compiled_query, trino_next_uri=trino_next_uri)

    def _save_collector_response(
        self,
        response: TrinoQueryRunResponse,
        *,
        compiled_query: str,
        trino_next_uri: str | None,
        worker_id: str,
        generation: int,
    ) -> bool:
        return self.run_store.save_collector(
            response,
            compiled_query=compiled_query,
            trino_next_uri=trino_next_uri,
            worker_id=worker_id,
            generation=generation,
        )

    def _response_payload(
        self,
        response: TrinoQueryRunResponse,
        *,
        compiled_query: str,
        trino_next_uri: str | None,
    ) -> dict[str, object]:
        return self.run_store.response_payload(
            response,
            compiled_query=compiled_query,
            trino_next_uri=trino_next_uri,
        )

    def _cancel_after_result_persistence_failure(self, next_uri: str | None) -> None:
        self.result_service.cancel_after_persistence_failure(next_uri)

    def _delete_partial_result_pages(self, run_id: str) -> None:
        self.result_service.delete_partial_pages(run_id)

    def _require_result_retention(self, response: TrinoQueryRunResponse) -> None:
        self.result_service.require_retention(response)

    def _get_payload(self, run_id: str) -> dict[str, object]:
        return self.run_store.get_payload(run_id)
