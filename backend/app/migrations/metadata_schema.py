from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.migrations.dashboard_schema import migrate_dashboard_schema
from app.repositories import etl_repository
from app.repositories.continuous_sql_repository import ensure_continuous_sql_schema
from app.repositories.catalog_deletion_repository import ensure_catalog_deletion_schema
from app.repositories.dashboard_live_repository import ensure_dashboard_live_schema
from app.repositories.realtime_event_repository import ensure_realtime_event_schema
from app.repositories.sql_repository_schema import ensure_sql_schema


@dataclass(frozen=True)
class MetadataSchemaBootstrapResult:
    dashboard_versions: tuple[str, ...]


def bootstrap_metadata_schema(db: Session) -> MetadataSchemaBootstrapResult:
    """Prepare metadata tables before the API or control-plane starts serving work."""
    dashboard_versions = tuple(migrate_dashboard_schema(db))
    ensure_dashboard_live_schema(db)
    ensure_realtime_event_schema(db)
    ensure_continuous_sql_schema(db)
    ensure_catalog_deletion_schema(db)
    etl_repository.ensure_schema(db, bootstrap=True)
    ensure_sql_schema(db)
    return MetadataSchemaBootstrapResult(dashboard_versions=dashboard_versions)
