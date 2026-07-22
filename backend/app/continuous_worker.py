"""Dedicated process that owns Continuous reconciliation and Spark side effects."""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import uuid

from app.core.config import settings
from app.core.database import SessionLocal
from app.repositories.continuous_control_lease_repository import acquire_or_renew
from app.services.continuous_sql_service import sync_active_continuous_sql_jobs
from app.services.continuous_sql_incremental import reconcile_continuous_sql_source_bindings
from app.services.etl_service import sync_active_kafka_continuous_runtimes
from app.services.trino_sql_auto_refresh import sync_revision_driven_trino_sql_jobs

logger = logging.getLogger(__name__)
_OWNER_ID = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


def run_once() -> bool:
    with SessionLocal() as db:
        generation = acquire_or_renew(
            db,
            control_plane="continuous-runtime-sync",
            owner_id=_OWNER_ID,
            lease_seconds=settings.continuous_control_lease_seconds,
        )
    if generation is None:
        return False
    sync_active_kafka_continuous_runtimes()
    sync_revision_driven_trino_sql_jobs()
    reconcile_continuous_sql_source_bindings()
    sync_active_continuous_sql_jobs()
    return True


async def run_forever() -> None:
    if settings.continuous_control_plane != "worker":
        raise RuntimeError("continuous worker requires ASKLAKE_CONTINUOUS_CONTROL_PLANE=worker")
    while True:
        try:
            await asyncio.to_thread(run_once)
        except Exception:
            logger.exception("Continuous worker cycle failed")
        await asyncio.sleep(settings.continuous_runtime_sync_interval_seconds)


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    asyncio.run(run_forever())
