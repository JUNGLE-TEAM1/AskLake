from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.core.schema_management import metadata_schema_mutation_allowed
from app.models.dashboard_runtime import (
    DashboardBatchWidgetResult,
    DashboardPage,
    DashboardRevision,
    DashboardWidget,
)


DASHBOARD_CARD_RUNTIME_SCHEMA_VERSION = "20260718_dashboard_card_runtime_v1"
DASHBOARD_BATCH_CACHE_SCHEMA_VERSION = "20260718_dashboard_batch_cache_v1"
DASHBOARD_SCHEMA_VERSION = DASHBOARD_BATCH_CACHE_SCHEMA_VERSION
DASHBOARD_SCHEMA_VERSIONS = (
    DASHBOARD_CARD_RUNTIME_SCHEMA_VERSION,
    DASHBOARD_BATCH_CACHE_SCHEMA_VERSION,
)
DASHBOARD_SCHEMA_LOCK_KEY = "asklake:dashboard-schema-migration"


@dataclass(frozen=True)
class DashboardSchemaMigration:
    version: str
    apply: Callable[[Session], None]


POSTGRESQL_DASHBOARD_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS dashboards (
        id text PRIMARY KEY,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()",
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()",
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS name text",
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS owner text",
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS status text",
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS dataset_id text",
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS source_run_id text",
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS published_revision_id text",
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS has_published_revision boolean NOT NULL DEFAULT false",
    """
    UPDATE dashboards
    SET
        name = COALESCE(name, payload->>'name'),
        owner = COALESCE(owner, payload->>'owner'),
        status = COALESCE(status, payload->>'status'),
        dataset_id = COALESCE(dataset_id, payload->>'datasetId'),
        source_run_id = COALESCE(source_run_id, payload->>'sourceRunId'),
        published_revision_id = COALESCE(published_revision_id, payload->>'publishedRevisionId'),
        has_published_revision = has_published_revision OR COALESCE(
            CASE
                WHEN payload ? 'hasPublishedRevision' THEN (payload->>'hasPublishedRevision')::boolean
                ELSE false
            END,
            false
        )
    """,
    """
    CREATE TABLE IF NOT EXISTS dashboard_tags (
        dashboard_id text NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        tag text NOT NULL,
        PRIMARY KEY (dashboard_id, tag)
    )
    """,
    "CREATE INDEX IF NOT EXISTS dashboards_updated_at_idx ON dashboards (updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS dashboards_owner_idx ON dashboards (owner)",
    "CREATE INDEX IF NOT EXISTS dashboard_tags_tag_idx ON dashboard_tags (tag)",
    """
    CREATE TABLE IF NOT EXISTS dashboard_revisions (
        id varchar(64) PRIMARY KEY,
        dashboard_id varchar(64) NOT NULL,
        kind varchar(32) NOT NULL,
        version integer NOT NULL DEFAULT 1,
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "ALTER TABLE dashboard_revisions ADD COLUMN IF NOT EXISTS dashboard_id varchar(64) NOT NULL DEFAULT ''",
    "ALTER TABLE dashboard_revisions ADD COLUMN IF NOT EXISTS kind varchar(32) NOT NULL DEFAULT 'draft'",
    "ALTER TABLE dashboard_revisions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1",
    "ALTER TABLE dashboard_revisions ADD COLUMN IF NOT EXISTS published_at timestamptz",
    "ALTER TABLE dashboard_revisions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()",
    "ALTER TABLE dashboard_revisions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()",
    """
    CREATE TABLE IF NOT EXISTS dashboard_pages (
        id varchar(64) PRIMARY KEY,
        revision_id varchar(64) NOT NULL REFERENCES dashboard_revisions(id) ON DELETE CASCADE,
        title varchar(120) NOT NULL,
        order_index integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "ALTER TABLE dashboard_pages ADD COLUMN IF NOT EXISTS revision_id varchar(64) NOT NULL DEFAULT ''",
    "ALTER TABLE dashboard_pages ADD COLUMN IF NOT EXISTS title varchar(120) NOT NULL DEFAULT 'Untitled page'",
    "ALTER TABLE dashboard_pages ADD COLUMN IF NOT EXISTS order_index integer NOT NULL DEFAULT 0",
    "ALTER TABLE dashboard_pages ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()",
    "ALTER TABLE dashboard_pages ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()",
    """
    CREATE TABLE IF NOT EXISTS dashboard_widgets (
        id varchar(64) PRIMARY KEY,
        page_id varchar(64) NOT NULL REFERENCES dashboard_pages(id) ON DELETE CASCADE,
        type varchar(32) NOT NULL,
        title varchar(160),
        dataset_id varchar(64),
        query_id varchar(64),
        layout jsonb NOT NULL DEFAULT '{}'::jsonb,
        config jsonb NOT NULL DEFAULT '{}'::jsonb,
        data jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS page_id varchar(64) NOT NULL DEFAULT ''",
    "ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS type varchar(32) NOT NULL DEFAULT 'bar_chart'",
    "ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS title varchar(160)",
    "ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS dataset_id varchar(64)",
    "ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS query_id varchar(64)",
    "ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS layout jsonb NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '[]'::jsonb",
    "ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()",
    "ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()",
    "UPDATE dashboard_widgets SET layout = '{}'::jsonb WHERE layout IS NULL",
    "UPDATE dashboard_widgets SET config = '{}'::jsonb WHERE config IS NULL",
    "UPDATE dashboard_widgets SET data = '[]'::jsonb WHERE data IS NULL",
    "CREATE INDEX IF NOT EXISTS dashboard_revisions_dashboard_kind_idx ON dashboard_revisions (dashboard_id, kind, version DESC)",
    "CREATE INDEX IF NOT EXISTS dashboard_pages_revision_idx ON dashboard_pages (revision_id, order_index)",
    "CREATE INDEX IF NOT EXISTS dashboard_widgets_page_idx ON dashboard_widgets (page_id, created_at)",
)


SQLITE_DASHBOARD_COLUMNS = {
    "payload": "JSON NOT NULL DEFAULT '{}'",
    "created_at": "DATETIME",
    "updated_at": "DATETIME",
    "name": "TEXT",
    "owner": "TEXT",
    "status": "TEXT",
    "dataset_id": "TEXT",
    "source_run_id": "TEXT",
    "published_revision_id": "TEXT",
    "has_published_revision": "BOOLEAN NOT NULL DEFAULT 0",
}


def _apply_postgresql_dashboard_schema(db: Session) -> None:
    for statement in POSTGRESQL_DASHBOARD_SCHEMA_STATEMENTS:
        db.execute(text(statement))


def _apply_sqlite_dashboard_schema(db: Session) -> None:
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dashboards (
            id TEXT PRIMARY KEY,
            payload JSON NOT NULL DEFAULT '{}',
            created_at DATETIME,
            updated_at DATETIME,
            name TEXT,
            owner TEXT,
            status TEXT,
            dataset_id TEXT,
            source_run_id TEXT,
            published_revision_id TEXT,
            has_published_revision BOOLEAN NOT NULL DEFAULT 0
        )
    """))
    existing_columns = {
        column["name"]
        for column in inspect(db.connection()).get_columns("dashboards")
    }
    for column_name, definition in SQLITE_DASHBOARD_COLUMNS.items():
        if column_name not in existing_columns:
            db.execute(text(
                f"ALTER TABLE dashboards ADD COLUMN {column_name} {definition}"
            ))

    db.execute(text("""
        UPDATE dashboards
        SET
            created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
            updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP),
            name = COALESCE(
                name,
                CASE WHEN json_valid(payload) THEN json_extract(payload, '$.name') END
            ),
            owner = COALESCE(
                owner,
                CASE WHEN json_valid(payload) THEN json_extract(payload, '$.owner') END
            ),
            status = COALESCE(
                status,
                CASE WHEN json_valid(payload) THEN json_extract(payload, '$.status') END
            ),
            dataset_id = COALESCE(
                dataset_id,
                CASE WHEN json_valid(payload) THEN json_extract(payload, '$.datasetId') END
            ),
            source_run_id = COALESCE(
                source_run_id,
                CASE WHEN json_valid(payload) THEN json_extract(payload, '$.sourceRunId') END
            ),
            published_revision_id = COALESCE(
                published_revision_id,
                CASE WHEN json_valid(payload) THEN json_extract(payload, '$.publishedRevisionId') END
            ),
            has_published_revision = CASE
                WHEN has_published_revision = 1 THEN 1
                WHEN json_valid(payload)
                    AND json_extract(payload, '$.hasPublishedRevision') = 1 THEN 1
                ELSE 0
            END
    """))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dashboard_tags (
            dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            PRIMARY KEY (dashboard_id, tag)
        )
    """))
    db.execute(text(
        "CREATE INDEX IF NOT EXISTS dashboards_updated_at_idx "
        "ON dashboards (updated_at DESC)"
    ))
    db.execute(text(
        "CREATE INDEX IF NOT EXISTS dashboards_owner_idx ON dashboards (owner)"
    ))
    db.execute(text(
        "CREATE INDEX IF NOT EXISTS dashboard_tags_tag_idx ON dashboard_tags (tag)"
    ))
    DashboardRevision.metadata.create_all(
        bind=db.get_bind(),
        tables=[
            DashboardRevision.__table__,
            DashboardPage.__table__,
            DashboardWidget.__table__,
        ],
    )


def _apply_dashboard_card_runtime_v1(db: Session) -> None:
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        _apply_postgresql_dashboard_schema(db)
        return
    if dialect == "sqlite":
        _apply_sqlite_dashboard_schema(db)
        return
    raise RuntimeError(f"Unsupported Dashboard schema migration dialect: {dialect}")


def _apply_dashboard_batch_cache_v1(db: Session) -> None:
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        db.execute(text("""
            CREATE TABLE IF NOT EXISTS dashboard_batch_widget_results (
                cache_key varchar(64) PRIMARY KEY,
                dataset_id varchar(120) NOT NULL,
                dataset_version varchar(64) NOT NULL,
                widget_type varchar(32) NOT NULL,
                config_hash varchar(64) NOT NULL,
                actor_scope_hash varchar(64) NOT NULL,
                result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
                calculated_at timestamptz NOT NULL DEFAULT now()
            )
        """))
        db.execute(text(
            "CREATE INDEX IF NOT EXISTS dashboard_batch_widget_results_dataset_idx "
            "ON dashboard_batch_widget_results (dataset_id, dataset_version)"
        ))
        db.execute(text(
            "CREATE INDEX IF NOT EXISTS dashboard_batch_widget_results_calculated_at_idx "
            "ON dashboard_batch_widget_results (calculated_at)"
        ))
        return
    if dialect == "sqlite":
        DashboardBatchWidgetResult.metadata.create_all(
            bind=db.get_bind(),
            tables=[DashboardBatchWidgetResult.__table__],
        )
        return
    raise RuntimeError(f"Unsupported Dashboard schema migration dialect: {dialect}")


DASHBOARD_SCHEMA_MIGRATIONS = (
    DashboardSchemaMigration(
        version=DASHBOARD_CARD_RUNTIME_SCHEMA_VERSION,
        apply=_apply_dashboard_card_runtime_v1,
    ),
    DashboardSchemaMigration(
        version=DASHBOARD_BATCH_CACHE_SCHEMA_VERSION,
        apply=_apply_dashboard_batch_cache_v1,
    ),
)


def _ensure_migration_table(db: Session) -> None:
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("""
            CREATE TABLE IF NOT EXISTS dashboard_schema_migrations (
                version varchar(96) PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
        """))
        return
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dashboard_schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """))


def applied_dashboard_schema_versions(db: Session) -> set[str]:
    rows = db.execute(text(
        "SELECT version FROM dashboard_schema_migrations ORDER BY version"
    )).scalars().all()
    return {str(version) for version in rows}


def migrate_dashboard_schema(db: Session) -> list[str]:
    """Prepare Dashboard card/runtime tables before any user request is served."""
    if not metadata_schema_mutation_allowed(db, "Dashboard"):
        return []
    try:
        if db.get_bind().dialect.name == "postgresql":
            db.execute(
                text(
                    "SELECT pg_advisory_xact_lock("
                    "hashtextextended(:lock_key, 0)"
                    ")"
                ),
                {"lock_key": DASHBOARD_SCHEMA_LOCK_KEY},
            )
        _ensure_migration_table(db)
        applied_versions = applied_dashboard_schema_versions(db)
        newly_applied: list[str] = []
        for migration in DASHBOARD_SCHEMA_MIGRATIONS:
            if migration.version in applied_versions:
                continue
            migration.apply(db)
            db.execute(
                text(
                    "INSERT INTO dashboard_schema_migrations (version) "
                    "VALUES (:version)"
                ),
                {"version": migration.version},
            )
            newly_applied.append(migration.version)
        db.commit()
        return newly_applied
    except Exception:
        db.rollback()
        raise
