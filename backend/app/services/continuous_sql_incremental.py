"""Catalog-revision trigger for baseline-bound Continuous SQL Jobs."""

from __future__ import annotations

import logging

from app.core.database import SessionLocal
from app.repositories.continuous_sql_repository import ContinuousSqlRepository
from app.repositories.dashboard_live_repository import DashboardLiveRepository


logger = logging.getLogger(__name__)


def reconcile_continuous_sql_source_bindings() -> int:
    """Mark only Jobs whose Kafka Dataset has a new durable revision as lagging."""
    changed = 0
    with SessionLocal() as db:
        repository = ContinuousSqlRepository(db)
        live = DashboardLiveRepository(db, ensure_schema=False)
        for binding, job in repository.list_active_incremental_bindings():
            freshness = live.get_freshness(binding.source_dataset_id)
            latest_revision = int(freshness.latest_revision or 0) if freshness else 0
            next_status = (
                "lagging"
                if latest_revision > int(binding.source_revision or 0)
                else "ready"
            )
            if binding.status == next_status:
                continue
            binding.status = next_status
            binding.last_error_code = None
            binding.last_error_message = None
            db.add(binding)
            changed += 1
            logger.info(
                "continuous_sql_source_revision_detected job_id=%s source_dataset_id=%s checkpoint_revision=%s latest_revision=%s",
                job.id,
                binding.source_dataset_id,
                binding.source_revision,
                latest_revision,
            )
        db.commit()
    return changed
