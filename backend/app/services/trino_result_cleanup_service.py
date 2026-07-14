from dataclasses import dataclass
from datetime import datetime, timezone

from app.core.auth_context import ActorContext
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.sql_repository import SqlRepository
from app.schemas.trino import TrinoQueryRunResponse
from app.services.trino_result_storage import TrinoResultStorage


@dataclass(frozen=True)
class TrinoResultCleanupSummary:
    expired_runs: int
    removed_objects: int
    removed_pages: int


class TrinoResultCleanupService:
    """Expires private query-result objects and their metadata after retention."""

    def __init__(self, repository: SqlRepository, storage: TrinoResultStorage) -> None:
        self.repository = repository
        self.storage = storage

    def cleanup_expired(self, *, now: datetime | None = None) -> TrinoResultCleanupSummary:
        current_time = now or datetime.now(timezone.utc)
        expired_runs = 0
        removed_objects = 0
        removed_pages = 0

        after_run_id: str | None = None
        while True:
            payloads = self.repository.list_terminal_trino_run_payload_batch(after_run_id=after_run_id)
            if not payloads:
                break
            for payload in payloads:
                after_run_id = str(payload.get("runId") or after_run_id or "") or after_run_id
                try:
                    response = TrinoQueryRunResponse.model_validate(payload)
                    expiry = parse_timestamp(response.result.retention_expires_at if response.result else None)
                except (TypeError, ValueError):
                    continue
                if (
                    expiry is None
                    or expiry > current_time
                    or response.result is None
                    or response.result.storage_status == "expired"
                ):
                    continue

                run_removed_objects = 0
                for page in self.repository.list_result_pages(response.run_id):
                    if page.storage_backend in {"s3", "minio"} and page.object_key:
                        self.storage.delete_object(page.object_key)
                        removed_objects += 1
                        run_removed_objects += 1
                run_removed_pages = self.repository.delete_result_pages(response.run_id)
                removed_pages += run_removed_pages
                expired = response.model_copy(update={
                    "result": response.result.model_copy(update={
                        "available_page_count": 0,
                        "byte_size": 0,
                        "next_cursor": None,
                        "page_count": 0,
                        "storage_status": "expired",
                    }),
                })
                updated_payload = dict(payload)
                updated_payload.update(expired.model_dump(by_alias=True, exclude_none=True, mode="json"))
                self.repository.save_run_payload(updated_payload)
                safe_record_audit_event(
                    self.repository.db,
                    action="query_run.result.expired",
                    actor=ActorContext(name="AskLake System", role="admin"),
                    api_path="/internal/trino-result-cleanup",
                    http_method="DELETE",
                    metadata={"removedObjects": run_removed_objects, "removedPages": run_removed_pages},
                    result="success",
                    status_code=200,
                    target_id=response.run_id,
                    target_type="query_run",
                )
                expired_runs += 1

        return TrinoResultCleanupSummary(
            expired_runs=expired_runs,
            removed_objects=removed_objects,
            removed_pages=removed_pages,
        )


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
