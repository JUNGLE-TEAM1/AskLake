from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.core.schema_management import metadata_schema_bootstrap
from app.migrations.dashboard_schema import migrate_dashboard_schema
from app.repositories import etl_repository
from app.repositories.audit_repository import ensure_audit_event_table
from app.repositories.catalog_repository import ensure_catalog_schema
from app.repositories.continuous_sql_repository import ensure_continuous_sql_schema
from app.repositories.catalog_deletion_repository import ensure_catalog_deletion_schema
from app.repositories.dashboard_live_repository import ensure_dashboard_live_schema
from app.repositories.governance_repository import ensure_governance_tables
from app.repositories.permission_repository import ensure_permission_grant_table
from app.repositories.realtime_event_repository import ensure_realtime_event_schema
from app.repositories.sql_repository_schema import ensure_sql_schema
from app.services.auth_service import ensure_auth_tables
from app.services.semantic_model_service import ensure_semantic_schema


@dataclass(frozen=True)
class MetadataSchemaBootstrapResult:
    dashboard_versions: tuple[str, ...]


def bootstrap_metadata_schema(db: Session) -> MetadataSchemaBootstrapResult:
    """Prepare metadata tables before the API or control-plane starts serving work."""
    with metadata_schema_bootstrap():
        dashboard_versions = tuple(migrate_dashboard_schema(db))
        ensure_auth_tables(db)
        ensure_audit_event_table(db)
        ensure_governance_tables(db)
        ensure_permission_grant_table(db)
        ensure_dashboard_live_schema(db)
        ensure_realtime_event_schema(db)
        ensure_continuous_sql_schema(db)
        ensure_catalog_deletion_schema(db)
        etl_repository.ensure_schema(db, bootstrap=True)
        ensure_catalog_schema(db)
        ensure_sql_schema(db)
        ensure_semantic_schema(db)
    return MetadataSchemaBootstrapResult(dashboard_versions=dashboard_versions)
