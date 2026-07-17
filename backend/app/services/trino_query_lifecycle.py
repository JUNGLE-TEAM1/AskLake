"""Read, history, refresh, and cancellation operations for Query Runs."""

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.sql_repository import SqlRepository
from app.schemas.trino import TrinoQueryRunListResponse, TrinoQueryRunResponse
from app.services.trino_client import TrinoClient
from app.services.trino_query_access import TrinoQueryAccessService
from app.services.trino_query_result_manifest import current_utc_timestamp
from app.services.trino_query_results import TrinoQueryResultService
from app.services.trino_query_run_state import to_history_item
from app.services.trino_query_run_store import TrinoQueryRunStore


class TrinoQueryLifecycleService:
    def __init__(
        self,
        repository: SqlRepository,
        client: TrinoClient,
        access: TrinoQueryAccessService,
        results: TrinoQueryResultService,
        run_store: TrinoQueryRunStore,
    ) -> None:
        self.repository = repository
        self.client = client
        self.access = access
        self.results = results
        self.run_store = run_store

    def get(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        response = self.run_store.load(run_id)
        self.access.require_access_for_response(response, actor or ActorContext(), operation="view")
        return response

    def refresh(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        """Read persisted collector state; browser polling never consumes Trino pages."""
        return self.get(run_id, actor)

    def list_for_actor(
        self,
        actor: ActorContext | None = None,
        *,
        limit: int = 20,
    ) -> TrinoQueryRunListResponse:
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

    def cancel(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse:
        payload = self.run_store.get_payload(run_id)
        response = TrinoQueryRunResponse.model_validate(payload)
        actor_context = actor or ActorContext()
        self.access.require_access_for_response(response, actor_context, operation="cancel")
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
            return self.run_store.load(run_id)
        self._cancel_trino(next_uri)
        self.results.delete_partial_pages(run_id)
        self._record_cancellation(cancelled, actor_context)
        return cancelled

    def _cancel_trino(self, next_uri: str) -> None:
        try:
            self.client.cancel(next_uri)
        except ApiError:
            return

    def _record_cancellation(self, response: TrinoQueryRunResponse, actor: ActorContext) -> None:
        safe_record_audit_event(
            self.repository.db,
            action="query_run.cancel",
            actor=actor,
            api_path=f"/api/query/runs/{response.run_id}/cancel",
            http_method="POST",
            metadata={"runId": response.run_id, "trinoQueryId": response.trino_query_id},
            result="success",
            status_code=status.HTTP_200_OK,
            target_id=response.base_dataset_id,
            target_type="query_run",
        )
