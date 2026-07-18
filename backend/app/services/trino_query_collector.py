"""Background continuation collector for persisted Trino Query Runs."""

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
import logging
from time import monotonic

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.sql_repository import SqlRepository
from app.schemas.trino import TrinoClientPage, TrinoQueryRunResponse
from app.services.trino_client import TrinoClient, TrinoQueryInfo
from app.services.trino_query_result_manifest import with_result_collection_timing
from app.services.trino_query_results import CollectorLeaseLost, TrinoQueryResultService
from app.services.trino_query_run_state import apply_trino_page, apply_trino_query_info
from app.services.trino_query_run_store import TrinoQueryRunStore


logger = logging.getLogger(__name__)


class TrinoQueryCollectorService:
    def __init__(
        self,
        repository: SqlRepository,
        settings: Settings,
        client: TrinoClient,
        progress_client: TrinoClient,
        results: TrinoQueryResultService,
        run_store: TrinoQueryRunStore,
    ) -> None:
        self.repository = repository
        self.settings = settings
        self.client = client
        self.progress_client = progress_client
        self.results = results
        self.run_store = run_store

    def collect_claimed_run(self, run_id: str, worker_id: str, generation: int) -> TrinoQueryRunResponse:
        payload = self.run_store.get_payload(run_id)
        response = TrinoQueryRunResponse.model_validate(payload)
        pages_collected = 0
        while response.status not in {"succeeded", "failed", "cancelled"}:
            next_uri = str(payload.get("trinoNextUri") or "").strip()
            if not next_uri:
                break
            if not self._renew_lease(run_id, worker_id, generation):
                return response
            response, payload, fenced = self._ensure_collection_started(
                response,
                payload,
                next_uri=next_uri,
                worker_id=worker_id,
                generation=generation,
            )
            if fenced:
                return response
            page, response = self.fetch_with_live_progress(
                response,
                next_uri=next_uri,
                compiled_query=str(payload.get("compiledQuery") or ""),
                worker_id=worker_id,
                generation=generation,
            )
            if page is None:
                return response
            if not self._renew_lease(run_id, worker_id, generation):
                return self.run_store.load(run_id)
            try:
                updated = self._apply_and_store_page(
                    response,
                    page,
                    source_next_uri=next_uri,
                    worker_id=worker_id,
                    generation=generation,
                )
            except CollectorLeaseLost:
                return self.run_store.load(run_id)
            if not self.run_store.save_collector(
                updated,
                compiled_query=str(payload.get("compiledQuery") or ""),
                trino_next_uri=page.next_uri,
                worker_id=worker_id,
                generation=generation,
            ):
                return self.run_store.load(run_id)
            if updated.status in {"succeeded", "failed", "cancelled"}:
                self._record_terminal_audit(updated)
                return updated
            response = updated
            payload = self.run_store.get_payload(run_id)
            pages_collected += 1
            if pages_collected >= self.settings.trino_collector_pages_per_lease:
                self.repository.release_trino_collector_lease(run_id, worker_id, generation)
                return response
        self.repository.release_trino_collector_lease(run_id, worker_id, generation)
        return response

    def fetch_with_live_progress(
        self,
        response: TrinoQueryRunResponse,
        *,
        next_uri: str,
        compiled_query: str,
        worker_id: str,
        generation: int,
    ) -> tuple[TrinoClientPage | None, TrinoQueryRunResponse]:
        query_info_fetcher = getattr(self.progress_client, "query_info", None)
        if not response.trino_query_id or not callable(query_info_fetcher):
            return self.client.fetch(next_uri), response
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="trino-page-fetch")
        try:
            fetch_future = executor.submit(self.client.fetch, next_uri)
            progress_poll_seconds = self.settings.trino_progress_poll_seconds
            lease_refresh_seconds = max(1.0, self.settings.trino_collector_lease_seconds / 3)
            next_progress_at = monotonic() + progress_poll_seconds
            next_lease_refresh_at = monotonic() + lease_refresh_seconds
            while True:
                now = monotonic()
                wait_seconds = max(0.01, min(next_progress_at, next_lease_refresh_at) - now)
                try:
                    return fetch_future.result(timeout=wait_seconds), response
                except FutureTimeoutError:
                    response, next_progress_at, next_lease_refresh_at, fenced = self._observe_progress(
                        response,
                        compiled_query=compiled_query,
                        next_uri=next_uri,
                        worker_id=worker_id,
                        generation=generation,
                        next_progress_at=next_progress_at,
                        next_lease_refresh_at=next_lease_refresh_at,
                        progress_poll_seconds=progress_poll_seconds,
                        lease_refresh_seconds=lease_refresh_seconds,
                    )
                    if fenced:
                        return None, self.run_store.load(response.run_id)
        finally:
            executor.shutdown(wait=False, cancel_futures=True)

    def sample_query_info(self, response: TrinoQueryRunResponse) -> TrinoQueryRunResponse:
        query_info_fetcher = getattr(self.progress_client, "query_info", None)
        if not response.trino_query_id or not callable(query_info_fetcher):
            return response
        try:
            query_info = query_info_fetcher(response.trino_query_id)
        except Exception as exc:
            logger.debug("Trino QueryInfo sampling failed for %s: %s", response.run_id, exc)
            return response
        if not isinstance(query_info, TrinoQueryInfo):
            return response
        return apply_trino_query_info(response, query_info)

    def _ensure_collection_started(
        self,
        response: TrinoQueryRunResponse,
        payload: dict[str, object],
        *,
        next_uri: str,
        worker_id: str,
        generation: int,
    ) -> tuple[TrinoQueryRunResponse, dict[str, object], bool]:
        if response.result is not None and response.result.collection_started_at is not None:
            return response, payload, False
        response = with_result_collection_timing(response)
        if not self.run_store.save_collector(
            response,
            compiled_query=str(payload.get("compiledQuery") or ""),
            trino_next_uri=next_uri,
            worker_id=worker_id,
            generation=generation,
        ):
            return self.run_store.load(response.run_id), self.run_store.get_payload(response.run_id), True
        return response, self.run_store.get_payload(response.run_id), False

    def _apply_and_store_page(
        self,
        response: TrinoQueryRunResponse,
        page: TrinoClientPage,
        *,
        source_next_uri: str,
        worker_id: str,
        generation: int,
    ) -> TrinoQueryRunResponse:
        updated = apply_trino_page(response, page)
        if (page.state or "").upper() == "FINISHED" and (
            updated.stats is None or updated.stats.output_rows is None
        ):
            updated = self.sample_query_info(updated)
        try:
            return self.results.finalize_storage(self.results.store_page(
                updated,
                page,
                source_next_uri=source_next_uri,
                worker_id=worker_id,
                generation=generation,
            ))
        except CollectorLeaseLost:
            raise
        except ApiError:
            self.results.cancel_after_persistence_failure(page.next_uri)
            return self.results.persistence_failed(updated)

    def _observe_progress(
        self,
        response: TrinoQueryRunResponse,
        *,
        compiled_query: str,
        next_uri: str,
        worker_id: str,
        generation: int,
        next_progress_at: float,
        next_lease_refresh_at: float,
        progress_poll_seconds: float,
        lease_refresh_seconds: float,
    ) -> tuple[TrinoQueryRunResponse, float, float, bool]:
        now = monotonic()
        if now >= next_lease_refresh_at:
            if not self._renew_lease(response.run_id, worker_id, generation):
                return response, next_progress_at, next_lease_refresh_at, True
            next_lease_refresh_at = now + lease_refresh_seconds
        if now < next_progress_at:
            return response, next_progress_at, next_lease_refresh_at, False
        next_progress_at = now + progress_poll_seconds
        sampled = self.sample_query_info(response)
        if sampled == response:
            return response, next_progress_at, next_lease_refresh_at, False
        saved = self.run_store.save_collector(
            sampled,
            compiled_query=compiled_query,
            trino_next_uri=next_uri,
            worker_id=worker_id,
            generation=generation,
        )
        return sampled, next_progress_at, next_lease_refresh_at, not saved

    def _renew_lease(self, run_id: str, worker_id: str, generation: int) -> bool:
        return self.repository.renew_trino_collector_lease(
            run_id,
            worker_id,
            generation,
            self.settings.trino_collector_lease_seconds,
        )

    def _record_terminal_audit(self, response: TrinoQueryRunResponse) -> None:
        safe_record_audit_event(
            self.repository.db,
            action=f"query_run.{response.status}",
            actor=ActorContext(name="AskLake Collector", role="admin"),
            api_path=f"/api/query/runs/{response.run_id}",
            http_method="GET",
            metadata={
                "trinoQueryId": response.trino_query_id,
                "stats": response.stats.model_dump(by_alias=True) if response.stats else {},
            },
            result="success" if response.status == "succeeded" else "failed",
            target_id=response.run_id,
            target_type="query_run",
        )
