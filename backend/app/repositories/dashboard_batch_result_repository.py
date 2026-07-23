from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.dashboard_runtime import DashboardBatchWidgetResult


BATCH_RESULT_RETENTION = timedelta(days=7)


class DashboardBatchResultRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, cache_key: str) -> DashboardBatchWidgetResult | None:
        return self.db.get(DashboardBatchWidgetResult, cache_key)

    def save(
        self,
        *,
        cache_key: str,
        dataset_id: str,
        dataset_version: str,
        widget_type: str,
        config_hash: str,
        actor_scope_hash: str,
        result_payload: dict[str, Any],
    ) -> datetime:
        calculated_at = datetime.now(UTC)
        values = {
            "cache_key": cache_key,
            "dataset_id": dataset_id,
            "dataset_version": dataset_version,
            "widget_type": widget_type,
            "config_hash": config_hash,
            "actor_scope_hash": actor_scope_hash,
            "result_payload": result_payload,
            "calculated_at": calculated_at,
        }
        dialect = self.db.get_bind().dialect.name
        insert = postgresql_insert if dialect == "postgresql" else sqlite_insert
        statement = insert(DashboardBatchWidgetResult).values(**values)
        statement = statement.on_conflict_do_update(
            index_elements=[DashboardBatchWidgetResult.cache_key],
            set_={
                "result_payload": result_payload,
                "calculated_at": calculated_at,
            },
        )
        self.db.execute(statement)
        self.db.execute(
            delete(DashboardBatchWidgetResult).where(
                DashboardBatchWidgetResult.calculated_at < calculated_at - BATCH_RESULT_RETENTION
            )
        )
        self.db.flush()
        return calculated_at
