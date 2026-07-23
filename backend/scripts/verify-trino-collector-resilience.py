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
from app.services.trino_client import TrinoQueryInfo
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


class SlowProgressFetchClient:
    def __init__(self) -> None:
        self.allow_fetch = Event()
        self.fetch_started = Event()

    def fetch(self, _: str) -> TrinoClientPage:
        self.fetch_started.set()
        assert self.allow_fetch.wait(timeout=5), "live progress fetch did not resume"
        return TrinoClientPage(
            columns=["id"],
            nextUri=None,
            queryId="live_progress_query",
            rawStats={"progressPercentage": 100, "state": "FINISHED"},
            rows=[[1]],
            state="FINISHED",
        )

    def cancel(self, _: str) -> None:
        return None


class SequenceProgressClient:
    def __init__(self) -> None:
        self.calls = 0
        self.sampled = Event()

    def query_info(self, query_id: str) -> TrinoQueryInfo:
        self.calls += 1
        self.sampled.set()
        if self.calls == 1:
            return TrinoQueryInfo(
                query_id=query_id,
                raw_stats={
                    "completedDrivers": 39,
                    "elapsedTime": "2.50s",
                    "peakUserMemoryReservation": "8MB",
                    "processedInputDataSize": "16MB",
                    "processedInputPositions": 1,
                    "progressPercentage": 24.074074074074073,
                    "totalDrivers": 162,
                },
                state="RUNNING",
            )
        return TrinoQueryInfo(
            query_id=query_id,
            raw_stats={
                "completedDrivers": 162,
                "outputDataSize": "32B",
                "outputPositions": 1,
                "progressPercentage": 100,
                "totalDrivers": 162,
            },
            state="FINISHED",
        )


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
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self.access_service.require_access_for_response = lambda *_args, **_kwargs: None  # type: ignore[method-assign]


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
            "storage": "s3",
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
    live_progress_run_id = "trino_collector_live_progress"
    test_run_ids = [run_id, retry_run_id, active_cleanup_run_id, takeover_run_id, pagination_run_id, live_progress_run_id]
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
        assert first_repo.cancel_trino_run_payload(payload_for(retry_run_id, status="cancelled", next_uri=None))

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
        takeover_started_at: list[str] = []

        def take_over() -> None:
            before_takeover = second_repo.get_run_payload(takeover_run_id)
            assert before_takeover
            started_at = before_takeover["result"].get("collectionStartedAt")  # type: ignore[union-attr]
            assert isinstance(started_at, str)
            takeover_started_at.append(started_at)
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
        takeover_persisted = second_repo.get_run_payload(takeover_run_id)
        assert takeover_persisted and takeover_started_at
        assert takeover_persisted["result"]["collectionStartedAt"] == takeover_started_at[0]  # type: ignore[index]
        assert takeover_persisted["result"]["firstPageAvailableAt"]  # type: ignore[index]
        assert takeover_persisted["result"]["collectionCompletedAt"]  # type: ignore[index]
        assert takeover_persisted["result"]["collectionElapsedMs"] >= 0  # type: ignore[index]
        assert takeover_persisted["result"]["totalReadyMs"] >= 0  # type: ignore[index]

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
        assert [page_one.page_size, page_two.page_size, page_three.page_size] == [100, 100, 100]
        assert [len(page_one.rows), len(page_two.rows), len(page_three.rows)] == [100, 100, 30]
        assert [page_one.page_number, page_two.page_number, page_three.page_number] == [1, 2, 3]
        assert [page_one.total_pages, page_two.total_pages, page_three.total_pages] == [3, 3, 3]
        assert page_one.rows[0] == [0] and page_two.rows[0] == [100] and page_three.rows[-1] == [229]
        assert page_three.next_cursor is None

        live_progress_payload = payload_for(
            live_progress_run_id,
            status="running",
            next_uri="http://trino:8080/v1/statement/live-progress",
        )
        live_progress_payload["trinoQueryId"] = "live_progress_query"
        first_repo.save_run_payload(live_progress_payload)
        live_progress_claim = first_repo.claim_next_trino_run("live-progress-worker", 60)
        assert live_progress_claim and live_progress_claim.run_id == live_progress_run_id
        slow_client = SlowProgressFetchClient()
        progress_client = SequenceProgressClient()
        captured_progress: list[float] = []
        lease_refreshed = Event()
        lease_renewals: list[int] = []
        original_save_collector_payload = first_repo.save_collector_run_payload
        original_renew_collector_lease = first_repo.renew_trino_collector_lease

        def capture_collector_progress(payload: dict[str, object], *, worker_id: str, generation: int) -> bool:
            progress = (payload.get("stats") or {}).get("progressPercentage")  # type: ignore[union-attr]
            if isinstance(progress, (int, float)):
                captured_progress.append(float(progress))
                if progress < 100:
                    assert payload.get("trinoNextUri") == "http://trino:8080/v1/statement/live-progress"
            return original_save_collector_payload(payload, worker_id=worker_id, generation=generation)

        def capture_collector_lease_renewal(run_id: str, worker_id: str, generation: int, lease_seconds: int) -> bool:
            renewed = original_renew_collector_lease(run_id, worker_id, generation, lease_seconds)
            if renewed:
                lease_renewals.append(lease_seconds)
                if len(lease_renewals) >= 2:
                    lease_refreshed.set()
            return renewed

        first_repo.save_collector_run_payload = capture_collector_progress  # type: ignore[method-assign]
        first_repo.renew_trino_collector_lease = capture_collector_lease_renewal  # type: ignore[method-assign]
        live_progress_settings = Settings(
            _env_file=None,
            trino_enabled=True,
            trino_progress_poll_seconds=0.1,
        ).model_copy(update={"trino_collector_lease_seconds": 1})
        live_progress_service = TrinoQueryRunService(
            repository=first_repo,
            catalog_repository=CatalogRepository(first_db),
            client=slow_client,  # type: ignore[arg-type]
            progress_client=progress_client,  # type: ignore[arg-type]
            result_storage=MemoryResultStorage(),  # type: ignore[arg-type]
            runtime_settings=live_progress_settings,
        )
        live_progress_outcome: list[object] = []

        def collect_live_progress() -> None:
            live_progress_outcome.append(live_progress_service.collect_claimed_run(
                live_progress_run_id,
                "live-progress-worker",
                live_progress_claim.generation,
            ))

        live_progress_thread = Thread(target=collect_live_progress)
        live_progress_thread.start()
        assert slow_client.fetch_started.wait(timeout=5)
        assert progress_client.sampled.wait(timeout=5)
        assert lease_refreshed.wait(timeout=3), "collector lease was not refreshed during a long fetch"
        slow_client.allow_fetch.set()
        live_progress_thread.join(timeout=5)
        first_repo.save_collector_run_payload = original_save_collector_payload  # type: ignore[method-assign]
        first_repo.renew_trino_collector_lease = original_renew_collector_lease  # type: ignore[method-assign]
        assert not live_progress_thread.is_alive()
        assert live_progress_outcome and getattr(live_progress_outcome[0], "status") == "succeeded"
        assert any(round(progress, 1) == 24.1 for progress in captured_progress)
        live_progress_persisted = second_repo.get_run_payload(live_progress_run_id)
        assert live_progress_persisted
        assert live_progress_persisted["stats"]["outputRows"] == 1  # type: ignore[index]
        assert live_progress_persisted["stats"]["elapsedMs"] == 2_500  # type: ignore[index]
        assert live_progress_persisted["stats"]["peakMemoryBytes"] == 8 * 1024**2  # type: ignore[index]
        assert live_progress_persisted["stats"]["processedBytes"] == 16 * 1024**2  # type: ignore[index]
        assert live_progress_persisted["stats"]["processedRows"] == 1  # type: ignore[index]
        assert live_progress_persisted["stats"]["queryCompletedAt"]  # type: ignore[index]
        assert live_progress_persisted["result"]["expectedRowCount"] == 1  # type: ignore[index]
        assert live_progress_persisted["result"]["collectionProgressPercentage"] == 100  # type: ignore[index]
        assert live_progress_persisted["result"]["collectionStartedAt"]  # type: ignore[index]
        assert live_progress_persisted["result"]["firstPageAvailableAt"]  # type: ignore[index]
        assert live_progress_persisted["result"]["collectionCompletedAt"]  # type: ignore[index]
        assert live_progress_persisted["result"]["firstPageElapsedMs"] >= 0  # type: ignore[index]
        assert live_progress_persisted["result"]["collectionElapsedMs"] >= 0  # type: ignore[index]
        assert live_progress_persisted["result"]["totalReadyMs"] >= 0  # type: ignore[index]

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
