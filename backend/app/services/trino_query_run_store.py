"""Persistence boundary for serialized Trino Query Run state."""

from fastapi import status

from app.core.errors import ApiError
from app.repositories.sql_repository import SqlRepository
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoQueryRunResponse


class TrinoQueryRunStore:
    def __init__(self, repository: SqlRepository) -> None:
        self.repository = repository

    def get_payload(self, run_id: str) -> dict[str, object]:
        payload = self.repository.get_run_payload(run_id)
        if payload is None or payload.get("engine") != "trino":
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "Trino query run not found",
                status.HTTP_404_NOT_FOUND,
                {"runId": run_id},
            )
        return payload

    def load(self, run_id: str) -> TrinoQueryRunResponse:
        return TrinoQueryRunResponse.model_validate(self.get_payload(run_id))

    def save(
        self,
        response: TrinoQueryRunResponse,
        *,
        compiled_query: str,
        trino_next_uri: str | None,
    ) -> None:
        self.repository.save_run_payload(self.response_payload(
            response,
            compiled_query=compiled_query,
            trino_next_uri=trino_next_uri,
        ))

    def save_collector(
        self,
        response: TrinoQueryRunResponse,
        *,
        compiled_query: str,
        trino_next_uri: str | None,
        worker_id: str,
        generation: int,
    ) -> bool:
        return self.repository.save_collector_run_payload(
            self.response_payload(
                response,
                compiled_query=compiled_query,
                trino_next_uri=trino_next_uri,
            ),
            worker_id=worker_id,
            generation=generation,
        )

    def response_payload(
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
