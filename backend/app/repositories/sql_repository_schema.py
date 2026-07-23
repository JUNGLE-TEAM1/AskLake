from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.core.schema_management import metadata_schema_mutation_allowed
from app.models.sql import SqlRunModel, SqlRunResultPageModel


_schema_ready_bind_ids: set[int] = set()


def ensure_sql_schema(db: Session) -> None:
    bind = db.get_bind()
    bind_key = id(bind)
    if bind_key in _schema_ready_bind_ids:
        return
    if not metadata_schema_mutation_allowed(db, "SQL"):
        return

    with bind.begin() as connection:
        inspector = inspect(connection)
        if "sql_runs" not in inspector.get_table_names():
            SqlRunModel.__table__.create(bind=connection)
        else:
            existing_run_columns = {column["name"] for column in inspector.get_columns("sql_runs")}
            run_column_defs = {
                "actor_key": "TEXT",
                "client_request_id": "TEXT",
                "request_fingerprint": "TEXT",
                "collector_owner": "TEXT",
                "collector_lease_expires_at": "TIMESTAMP WITH TIME ZONE",
                "collector_next_uri": "TEXT",
                "collector_generation": "INTEGER NOT NULL DEFAULT 0",
                "collector_attempt_count": "INTEGER NOT NULL DEFAULT 0",
                "collector_next_attempt_at": "TIMESTAMP WITH TIME ZONE",
            }
            for column_name, column_type in run_column_defs.items():
                if column_name not in existing_run_columns:
                    connection.execute(text(f"ALTER TABLE sql_runs ADD COLUMN {column_name} {column_type}"))
        if "sql_run_result_pages" not in inspector.get_table_names():
            SqlRunResultPageModel.__table__.create(bind=connection)
        else:
            existing_columns = {column["name"] for column in inspector.get_columns("sql_run_result_pages")}
            column_defs = {
                "storage_backend": "TEXT",
                "object_key": "TEXT",
                "row_count": "INTEGER",
                "checksum": "TEXT",
                "source_next_uri": "TEXT",
            }
            for column_name, column_type in column_defs.items():
                if column_name not in existing_columns:
                    connection.execute(text(f"ALTER TABLE sql_run_result_pages ADD COLUMN {column_name} {column_type}"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_sql_runs_collector_claim ON sql_runs (collector_next_uri, collector_lease_expires_at, collector_next_attempt_at)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_sql_runs_actor_key ON sql_runs (actor_key)"))
        connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_sql_run_actor_client_request ON sql_runs (actor_key, client_request_id) WHERE client_request_id IS NOT NULL"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_sql_run_result_pages_source_uri ON sql_run_result_pages (run_id, source_next_uri)"))

    _schema_ready_bind_ids.add(bind_key)


def string_or_none(value: object) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None
