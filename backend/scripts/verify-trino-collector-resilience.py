from datetime import datetime, timedelta, timezone
from threading import Event, Thread
from typing import Callable

from sqlalchemy import delete

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.database import SessionLocal
from app.models.identity import AuditEventModel
from app.models.sql import SqlRunModel, SqlRunResultPageModel
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

    def write_page(self, *, run_id: str, page_index: int, columns: list[str], rows: list[list[object]], attempt_id: str | None = None) -> StoredTrinoResultPage:
        key = f"test/{run_id}/{page_index}{f'-{attempt_id}' if attempt_id else ''}"
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

    def read_page(self, *, object_key: str, expected_checksum: str) -> tuple[list[str], list[list[object]]]:
        assert expected_checksum == "test-checksum"
        return self.pages[object_key]


class ImmediateTrinoClient:
    def fetch(self, _: str) -> TrinoClientPage:
        return TrinoClientPage(
            columns=["id"],
            nextUri=None,
            queryId="collector_takeover_query",
            rawStats={"state": "FINISHED"},
            rows=[[2]],
            state="FINISHED",
        )

    def cancel(self, _: str) -> None:
        return None


class TakeoverResultStorage(MemoryResultStorage):
    def __init__(self, trigger_attempt: str) -> None:
        super().__init__()
        self.on_takeover: Callable[[], None] | None = None
        self.trigger_attempt = trigger_attempt
        self.triggered = False

    def write_page(self, *, run_id: str, page_index: int, columns: list[str], rows: list[list[object]], attempt_id: str | None = None) -> StoredTrinoResultPage:
        stored = super().write_page(
            run_id=run_id,
            page_index=page_index,
            columns=columns,
            rows=rows,
            attempt_id=attempt_id,
        )
        if attempt_id == self.trigger_attempt and not self.triggered:
            self.triggered = True
            assert self.on_takeover is not None
            self.on_takeover()
        return stored


class UngovernedResultPageService(TrinoQueryRunService):
    def _require_access_for_response(self, *_: object, **__: object) -> None:
        return None


class DummyDb:
    def rollback(self) -> None:
        return None


class BatchedCleanupRepository:
    def __init__(self, payloads: list[dict[str, object]]) -> None:
        self.db = DummyDb()
        self.payloads = {str(payload["runId"]): dict(payload) for payload in payloads}
        self.batch_calls = 0

    def list_terminal_trino_run_payload_batch(self, *, after_run_id: str | None = None, limit: int = 100) -> list[dict[str, object]]:
        self.batch_calls += 1
        run_ids = sorted(run_id for run_id in self.payloads if after_run_id is None or run_id > after_run_id)
        return [dict(self.payloads[run_id]) for run_id in run_ids[:limit]]

    def list_result_pages(self, _: str) -> list[object]:
        return []

    def delete_result_pages(self, _: str) -> int:
        return 0

    def save_run_payload(self, payload: dict[str, object]) -> dict[str, object]:
        self.payloads[str(payload["runId"])] = dict(payload)
        return payload


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
    takeover_run_id = "trino_collector_takeover"
    pagination_run_id = "trino_collector_pagination"
    test_run_ids = [run_id, retry_run_id, active_cleanup_run_id, takeover_run_id, pagination_run_id]
    worker_id = "resilience-worker"
    first_db = SessionLocal()
    second_db = SessionLocal()
    try:
        first_repo = SqlRepository(first_db)
        second_repo = SqlRepository(second_db)
        first_db.execute(delete(AuditEventModel).where(AuditEventModel.target_id.in_(test_run_ids)))
        first_db.execute(delete(SqlRunResultPageModel).where(SqlRunResultPageModel.run_id.in_(test_run_ids)))
        first_db.execute(delete(SqlRunModel).where(SqlRunModel.id.in_(test_run_ids)))
        first_db.commit()
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

        active_cleanup_payload = payload_for(active_cleanup_run_id, status="running", next_uri=None)
        active_cleanup_payload["result"]["retentionExpiresAt"] = "2020-01-01T00:00:00+00:00"  # type: ignore[index]
        first_repo.save_run_payload(active_cleanup_payload)
        cleanup = TrinoResultCleanupService(first_repo, storage)  # type: ignore[arg-type]
        assert cleanup.cleanup_expired().expired_runs == 0
        active_payload = second_repo.get_run_payload(active_cleanup_run_id)
        assert active_payload and active_payload["status"] == "running"

        first_repo.save_run_payload(payload_for(
            takeover_run_id,
            status="running",
            next_uri="http://trino:8080/v1/statement/takeover",
        ))
        stale_claim = first_repo.claim_next_trino_run("stale-worker", 60)
        assert stale_claim and stale_claim.run_id == takeover_run_id
        takeover_storage = TakeoverResultStorage(f"g{stale_claim.generation}")
        replacement_outcome: list[object] = []

        def take_over() -> None:
            model = second_db.get(SqlRunModel, takeover_run_id)
            assert model is not None
            model.collector_lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            second_db.commit()
            replacement_claim = second_repo.claim_next_trino_run("replacement-worker", 60)
            assert replacement_claim and replacement_claim.run_id == takeover_run_id
            replacement_service = TrinoQueryRunService(
                repository=second_repo,
                catalog_repository=CatalogRepository(second_db),
                client=ImmediateTrinoClient(),  # type: ignore[arg-type]
                result_storage=takeover_storage,  # type: ignore[arg-type]
                runtime_settings=Settings(_env_file=None, trino_enabled=True),
            )
            replacement_outcome.append(replacement_service.collect_claimed_run(
                takeover_run_id,
                "replacement-worker",
                replacement_claim.generation,
            ))

        takeover_storage.on_takeover = take_over
        stale_service = TrinoQueryRunService(
            repository=first_repo,
            catalog_repository=CatalogRepository(first_db),
            client=ImmediateTrinoClient(),  # type: ignore[arg-type]
            result_storage=takeover_storage,  # type: ignore[arg-type]
            runtime_settings=Settings(_env_file=None, trino_enabled=True),
        )
        stale_result = stale_service.collect_claimed_run(
            takeover_run_id,
            "stale-worker",
            stale_claim.generation,
        )
        assert stale_result.status == "succeeded"
        assert replacement_outcome and getattr(replacement_outcome[0], "status") == "succeeded"
        takeover_pages = second_repo.list_result_pages(takeover_run_id)
        assert len(takeover_pages) == 1
        assert takeover_pages[0].object_key in takeover_storage.pages
        assert list(takeover_storage.pages) == [takeover_pages[0].object_key]
        assert "replacement" not in str(takeover_pages[0].object_key)
        assert f"g{stale_claim.generation + 1}" in str(takeover_pages[0].object_key)

        pagination_payload = payload_for(pagination_run_id, status="succeeded", next_uri=None)
        pagination_payload["resultPageSize"] = 100
        pagination_payload["result"] = {
            **pagination_payload["result"],  # type: ignore[arg-type]
            "availablePageCount": 1,
            "pageCount": 1,
            "rowCount": 230,
            "storageStatus": "available",
        }
        first_repo.save_run_payload(pagination_payload)
        pagination_storage = MemoryResultStorage()
        stored_page = pagination_storage.write_page(
            run_id=pagination_run_id,
            page_index=0,
            columns=["id"],
            rows=[[row] for row in range(230)],
        )
        first_repo.save_result_page_metadata(
            run_id=pagination_run_id,
            page_index=0,
            columns=stored_page.columns,
            object_key=stored_page.object_key,
            row_count=stored_page.row_count,
            compressed_bytes=stored_page.compressed_bytes,
            checksum=stored_page.checksum,
        )
        pagination_service = UngovernedResultPageService(
            repository=first_repo,
            catalog_repository=CatalogRepository(first_db),
            result_storage=pagination_storage,  # type: ignore[arg-type]
            runtime_settings=Settings(_env_file=None, trino_enabled=True, trino_result_cursor_secret="pagination-secret"),
        )
        page_one = pagination_service.get_result_page(pagination_run_id, None, ActorContext(role="admin"))
        page_two = pagination_service.get_result_page(pagination_run_id, page_one.next_cursor, ActorContext(role="admin"))
        page_three = pagination_service.get_result_page(pagination_run_id, page_two.next_cursor, ActorContext(role="admin"))
        assert [page_one.page_size, page_two.page_size, page_three.page_size] == [100, 100, 30]
        assert page_one.rows[0] == [0] and page_two.rows[0] == [100] and page_three.rows[-1] == [229]
        assert page_three.next_cursor is None

        cleanup_payloads: list[dict[str, object]] = []
        for index in range(125):
            cleanup_payload = payload_for(f"trino_cleanup_batch_{index:03d}", status="succeeded", next_uri=None)
            cleanup_payload["result"] = {
                **cleanup_payload["result"],  # type: ignore[arg-type]
                "retentionExpiresAt": "2020-01-01T00:00:00+00:00",
                "storageStatus": "available",
            }
            cleanup_payloads.append(cleanup_payload)
        batched_repository = BatchedCleanupRepository(cleanup_payloads)
        batched_cleanup = TrinoResultCleanupService(batched_repository, MemoryResultStorage())  # type: ignore[arg-type]
        cleanup_summary = batched_cleanup.cleanup_expired()
        assert cleanup_summary.expired_runs == 125
        assert batched_repository.batch_calls >= 3
        assert all(
            payload["result"]["storageStatus"] == "expired"  # type: ignore[index]
            for payload in batched_repository.payloads.values()
        )
    finally:
        second_db.execute(delete(AuditEventModel).where(AuditEventModel.target_id.in_(test_run_ids)))
        second_db.execute(delete(SqlRunResultPageModel).where(SqlRunResultPageModel.run_id.in_(test_run_ids)))
        second_db.execute(delete(SqlRunModel).where(SqlRunModel.id.in_(test_run_ids)))
        second_db.commit()
        first_db.close()
        second_db.close()


if __name__ == "__main__":
    verify()
    print("Trino collector resilience verification passed.")
