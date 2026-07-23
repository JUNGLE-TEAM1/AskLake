#!/usr/bin/env python3
from __future__ import annotations

from datetime import UTC, datetime, timedelta
import os
from uuid import uuid4

import psycopg
from psycopg import sql
from sqlalchemy import delete

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.realtime import RealtimeEventModel
from app.repositories.realtime_event_repository import (
    REALTIME_NOTIFY_CHANNEL,
    RealtimeEventRepository,
)


def psycopg_dsn(database_url: str) -> str:
    if database_url.startswith("postgresql+psycopg://"):
        return "postgresql://" + database_url.removeprefix("postgresql+psycopg://")
    if database_url.startswith("postgres://"):
        return "postgresql://" + database_url.removeprefix("postgres://")
    return database_url


def main() -> None:
    if os.environ.get("ASKLAKE_VERIFY_REALTIME_POSTGRES", "").lower() != "true":
        raise RuntimeError(
            "Set ASKLAKE_VERIFY_REALTIME_POSTGRES=true with DATABASE_URL pointing to a disposable PostgreSQL database."
        )
    if not settings.database_url.startswith(("postgresql://", "postgresql+", "postgres://")):
        raise RuntimeError("Realtime PostgreSQL verification requires a PostgreSQL DATABASE_URL.")

    suffix = uuid4().hex[:12]
    dataset_id = f"verify_realtime_{suffix}"
    other_dataset_id = f"verify_realtime_other_{suffix}"
    key_prefix = f"verify-realtime:{suffix}:"
    dsn = psycopg_dsn(settings.database_url)

    with SessionLocal() as setup_db:
        RealtimeEventRepository(setup_db, ensure_schema=True)

    try:
        with psycopg.connect(dsn, autocommit=True) as listener:
            listener.execute(
                sql.SQL("LISTEN {}").format(sql.Identifier(REALTIME_NOTIFY_CHANNEL))
            )
            with SessionLocal() as db:
                repository = RealtimeEventRepository(db)
                first, first_created = repository.append(
                    event_type="dataset.revision.committed",
                    resource_type="dataset",
                    resource_id=dataset_id,
                    aggregate_revision=1,
                    correlation_id=f"run-{suffix}",
                    idempotency_key=f"{key_prefix}dataset:1",
                    invalidations=[f"dataset:{dataset_id}:freshness"],
                    payload={"runId": f"run-{suffix}", "commitKind": "stream"},
                )
                repeated, repeated_created = repository.append(
                    event_type="dataset.revision.committed",
                    resource_type="dataset",
                    resource_id=dataset_id,
                    aggregate_revision=1,
                    correlation_id=f"run-{suffix}",
                    idempotency_key=f"{key_prefix}dataset:1",
                    invalidations=[f"dataset:{dataset_id}:freshness"],
                    payload={"runId": f"run-{suffix}", "commitKind": "stream"},
                )
                other, other_created = repository.append(
                    event_type="dataset.revision.committed",
                    resource_type="dataset",
                    resource_id=other_dataset_id,
                    aggregate_revision=1,
                    correlation_id=f"run-other-{suffix}",
                    idempotency_key=f"{key_prefix}other:1",
                    invalidations=[f"dataset:{other_dataset_id}:freshness"],
                    payload={"runId": f"run-other-{suffix}", "commitKind": "stream"},
                )
                db.commit()

                assert first_created is True and repeated_created is False and other_created is True
                assert first.event_id == repeated.event_id and first.event_id != other.event_id

            notification = next(listener.notifies(timeout=5, stop_after=1), None)
            assert notification is not None, "PostgreSQL LISTEN did not receive the committed realtime NOTIFY."
            assert notification.channel == REALTIME_NOTIFY_CHANNEL
            assert int(notification.payload) == first.event_id

        with SessionLocal() as verification_db:
            repository = RealtimeEventRepository(verification_db)
            replay = repository.replay(
                after_cursor=0,
                resources={("dataset", dataset_id)},
                limit=10,
            )
            assert [event.event_id for event in replay] == [first.event_id]
            assert all(event.resource_id == dataset_id for event in replay)

            model = repository.by_idempotency_key(f"{key_prefix}dataset:1")
            assert model is not None
            model.expires_at = datetime.now(UTC) - timedelta(seconds=1)
            verification_db.commit()
            assert repository.replay(
                after_cursor=0,
                resources={("dataset", dataset_id)},
                limit=10,
            ) == []
            assert repository.cleanup_expired() >= 1
            verification_db.commit()

        print("verify-realtime-postgres: ok")
    finally:
        with SessionLocal() as cleanup_db:
            cleanup_db.execute(
                delete(RealtimeEventModel).where(
                    RealtimeEventModel.idempotency_key.like(f"{key_prefix}%")
                )
            )
            cleanup_db.commit()


if __name__ == "__main__":
    main()
