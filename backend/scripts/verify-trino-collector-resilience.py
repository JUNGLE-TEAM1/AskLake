from datetime import datetime, timedelta, timezone
from threading import Event, Thread

from sqlalchemy import delete

from app.core.config import Settings
from app.core.database import SessionLocal
from app.models.sql import SqlRunModel
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.trino import TrinoClientPage
from app.services.trino_query_run_service import TrinoQueryRunService
from app.services.trino_result_cleanup_service import TrinoResultCleanupService
from app.services.trino_result_storage import StoredTrinoResultPage


class BlockingTrinoClient:
    def __init__(self) -> None:
        self.fetch_started = Event()
        self.allow_fetch = Event()

    def fetch(self, _: str) -> TrinoClientPage:
        self.fetch_started.set()
        assert self.allow_fetch.wait(timeout=5), "collector fetch did not resume"
        return TrinoClientPage(
            columns=["id"],
            nextUri=None,
            queryId="collector_resilience_query",
            rawStats={"state": "FINISHED"},
            rows=[[1]],
            state="FINISHED",
        )

    def cancel(self, _: str) -> None:
        return None


class MemoryResultStorage:
    def __init__(self) -> None:
        self.pages: dict[str, tuple[list[str], list[list[object]]]] = {}

    def write_page(self, *, run_id: str, page_index: int, columns: list[str], rows: list[list[object]]) -> StoredTrinoResultPage:
        key = f"test/{run_id}/{page_index}"
        self.pages[key] = (columns, rows)
        return StoredTrinoResultPage(
            checksum="test-checksum",
            columns=columns,
            compressed_bytes=32,
            object_key=key,
            row_count=len(rows),
        )

    def delete_object(self, object_key: str, *, suppress_errors: bool = False) -> None:
        self.pages.pop(object_key, None)


def payload_for(run_id: str, *, status: str, next_uri: str | None) -> dict[str, object]:
    return {
        "baseDatasetId": "ds_resilience",
        "engine": "trino",
        "query": "SELECT 1",
        "referenceDatasetIds": [],
        "result": {
            "availablePageCount": 0,
            "byteSize": 0,
            "columns": [],
            "pageCount": 0,
            "retentionExpiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "rowCount": 0,
            "storage": "minio",
            "storageStatus": "collecting",
        },
        "runId": run_id,
        "status": status,
        "submittedAt": datetime.now(timezone.utc).isoformat(),
        "submittedByName": "Resilience Test",
        "trinoNextUri": next_uri,
    }


def verify() -> None:
    run_id = "trino_collector_resilience"
    retry_run_id = "trino_collector_retry"
    active_cleanup_run_id = "trino_collector_active_cleanup"
    worker_id = "resilience-worker"
    first_db = SessionLocal()
    second_db = SessionLocal()
    try:
        first_repo = SqlRepository(first_db)
        second_repo = SqlRepository(second_db)
        first_repo.save_run_payload(payload_for(run_id, status="running", next_uri="http://trino:8080/v1/statement/test"))
        claim = first_repo.claim_next_trino_run(worker_id, 60)
        assert claim is not None

        client = BlockingTrinoClient()
        storage = MemoryResultStorage()
        service = TrinoQueryRunService(
            repository=first_repo,
            catalog_repository=CatalogRepository(first_db),
            client=client,  # type: ignore[arg-type]
            result_storage=storage,  # type: ignore[arg-type]
            runtime_settings=Settings(_env_file=None, trino_enabled=True),
        )
        outcome: list[object] = []

        def collect() -> None:
            outcome.append(service.collect_claimed_run(run_id, worker_id, claim.generation))

        thread = Thread(target=collect)
        thread.start()
        assert client.fetch_started.wait(timeout=5), "collector did not reach fetch"
        cancelled_payload = payload_for(run_id, status="cancelled", next_uri=None)
        assert second_repo.cancel_trino_run_payload(cancelled_payload)
        client.allow_fetch.set()
        thread.join(timeout=5)
        assert not thread.is_alive(), "collector did not complete"
        assert outcome and getattr(outcome[0], "status") == "cancelled"

        persisted = second_repo.get_run_payload(run_id)
        assert persisted and persisted["status"] == "cancelled"
        assert second_repo.list_result_pages(run_id) == []
        assert storage.pages == {}

        first_repo.save_run_payload(payload_for(retry_run_id, status="running", next_uri="http://trino:8080/v1/statement/retry"))
        retry_claim = first_repo.claim_next_trino_run(worker_id, 60)
        assert retry_claim and retry_claim.run_id == retry_run_id
        retry = first_repo.schedule_collector_retry(retry_run_id, worker_id=worker_id, generation=retry_claim.generation)
        assert retry and second_repo.claim_next_trino_run("other-worker", 60) is None

        active_cleanup_payload = payload_for(active_cleanup_run_id, status="running", next_uri="http://trino:8080/v1/statement/active")
        active_cleanup_payload["result"]["retentionExpiresAt"] = "2020-01-01T00:00:00+00:00"  # type: ignore[index]
        first_repo.save_run_payload(active_cleanup_payload)
        cleanup = TrinoResultCleanupService(first_repo, storage)  # type: ignore[arg-type]
        assert cleanup.cleanup_expired().expired_runs == 0
        active_payload = second_repo.get_run_payload(active_cleanup_run_id)
        assert active_payload and active_payload["status"] == "running"
    finally:
        second_db.execute(delete(SqlRunModel).where(SqlRunModel.id.in_([run_id, retry_run_id, active_cleanup_run_id])))
        second_db.commit()
        first_db.close()
        second_db.close()


if __name__ == "__main__":
    verify()
    print("Trino collector resilience verification passed.")
