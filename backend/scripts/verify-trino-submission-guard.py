from threading import Barrier, Lock, Thread
from uuid import uuid4

from sqlalchemy import delete, func, select

from app.core.database import SessionLocal
from app.models.sql import SqlRunModel
from app.repositories.sql_repository import SqlRepository


def reservation_payload(run_id: str, actor_key: str, client_request_id: str | None) -> dict[str, object]:
    return {
        "baseDatasetId": "ds_submission_guard",
        "clientRequestId": client_request_id,
        "engine": "trino",
        "query": "SELECT 1",
        "referenceDatasetIds": [],
        "result": {"storageStatus": "collecting"},
        "runId": run_id,
        "status": "queued",
        "submittedAt": "2026-07-11T00:00:00+00:00",
        "submittedByName": actor_key,
        "submittedByUserId": actor_key,
    }


def run_concurrent_reservations(
    *,
    actor_key: str,
    client_request_id: str | None,
    fingerprint: str,
    max_active_runs: int,
) -> tuple[list[str], list[BaseException]]:
    barrier = Barrier(2)
    lock = Lock()
    outcomes: list[str] = []
    errors: list[BaseException] = []

    def reserve(index: int) -> None:
        db = SessionLocal()
        try:
            repository = SqlRepository(db)
            barrier.wait(timeout=5)
            reservation = repository.reserve_trino_submission(
                reservation_payload(f"trino_submission_{uuid4().hex[:12]}", actor_key, client_request_id),
                actor_key=actor_key,
                client_request_id=client_request_id,
                request_fingerprint=fingerprint,
                max_active_runs=max_active_runs,
            )
            with lock:
                outcomes.append(reservation.outcome)
        except BaseException as exc:
            with lock:
                errors.append(exc)
        finally:
            db.close()

    threads = [Thread(target=reserve, args=(index,)) for index in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
        assert not thread.is_alive(), "Concurrent reservation did not finish"
    return outcomes, errors


def verify() -> None:
    unique = uuid4().hex[:12]
    idempotent_actor = f"submission-idempotent-{unique}"
    capped_actor = f"submission-cap-{unique}"
    racing_key_actor = f"submission-key-{unique}"
    actor_keys = [idempotent_actor, capped_actor, racing_key_actor]

    db = SessionLocal()
    try:
        repository = SqlRepository(db)
        assert db.get_bind().dialect.name == "postgresql", "Submission guard verification requires PostgreSQL"

        first_run_id = f"trino_submission_{uuid4().hex[:12]}"
        first = repository.reserve_trino_submission(
            reservation_payload(first_run_id, idempotent_actor, "retry-key"),
            actor_key=idempotent_actor,
            client_request_id="retry-key",
            request_fingerprint="fingerprint-a",
            max_active_runs=2,
        )
        assert first.outcome == "created"
        repeated = repository.reserve_trino_submission(
            reservation_payload(f"trino_submission_{uuid4().hex[:12]}", idempotent_actor, "retry-key"),
            actor_key=idempotent_actor,
            client_request_id="retry-key",
            request_fingerprint="fingerprint-a",
            max_active_runs=2,
        )
        assert repeated.outcome == "existing"
        assert repeated.payload and repeated.payload["runId"] == first_run_id
        conflicting = repository.reserve_trino_submission(
            reservation_payload(f"trino_submission_{uuid4().hex[:12]}", idempotent_actor, "retry-key"),
            actor_key=idempotent_actor,
            client_request_id="retry-key",
            request_fingerprint="fingerprint-b",
            max_active_runs=2,
        )
        assert conflicting.outcome == "conflict"

        capped_outcomes, capped_errors = run_concurrent_reservations(
            actor_key=capped_actor,
            client_request_id=None,
            fingerprint="capped-fingerprint",
            max_active_runs=1,
        )
        assert capped_errors == []
        assert sorted(capped_outcomes) == ["created", "limit"]

        key_outcomes, key_errors = run_concurrent_reservations(
            actor_key=racing_key_actor,
            client_request_id="same-network-retry",
            fingerprint="same-fingerprint",
            max_active_runs=2,
        )
        assert key_errors == []
        assert sorted(key_outcomes) == ["created", "existing"]
        same_key_count = db.scalar(
            select(func.count())
            .select_from(SqlRunModel)
            .where(SqlRunModel.actor_key == racing_key_actor)
            .where(SqlRunModel.client_request_id == "same-network-retry")
        )
        assert same_key_count == 1
    finally:
        db.rollback()
        db.execute(delete(SqlRunModel).where(SqlRunModel.actor_key.in_(actor_keys)))
        db.commit()
        db.close()


if __name__ == "__main__":
    verify()
    print("Trino submission guard verification passed.")
