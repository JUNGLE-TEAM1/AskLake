"""Extend Catalog freshness, revision, and event evidence for realtime V2."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0017_catalog_realtime_publication"
down_revision = "0016_clickhouse_realtime_v2_foundation"
branch_labels = None
depends_on = None


FRESHNESS_COLUMNS = (
    sa.Column("binding_epoch", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
    sa.Column("active_serving_engine", sa.String(length=32), nullable=True),
    sa.Column("active_serving_version_id", sa.String(length=160), nullable=True),
    sa.Column("active_archive_snapshot_id", sa.String(length=255), nullable=True),
    sa.Column("latest_source_boundary", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True),
    sa.Column("latest_checksum", sa.String(length=128), nullable=True),
    sa.Column("latest_mutation_type", sa.String(length=32), nullable=True),
)
REVISION_COLUMNS = (
    sa.Column("materialization_id", sa.String(length=160), nullable=True),
    sa.Column("source_boundary", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True),
    sa.Column("serving_engine", sa.String(length=32), nullable=True),
    sa.Column("serving_version_id", sa.String(length=160), nullable=True),
    sa.Column("binding_epoch", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
    sa.Column(
        "dimension_version_ids",
        sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
        nullable=False,
        server_default=sa.text("'{}'"),
    ),
    sa.Column("mutation_type", sa.String(length=32), nullable=False, server_default=sa.text("'append'")),
)


def _json_document():
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _column_names(table: str) -> set[str]:
    return {item["name"] for item in sa.inspect(op.get_bind()).get_columns(table)}


def _constraint_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    names = {item.get("name") for item in inspector.get_check_constraints(table)}
    return {str(item) for item in names if item}


def _ensure_freshness() -> None:
    if "dataset_freshness" not in _table_names():
        op.create_table(
            "dataset_freshness",
            sa.Column("dataset_id", sa.String(length=120), nullable=False),
            sa.Column("latest_revision", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
            sa.Column("latest_run_id", sa.String(length=160), nullable=True),
            sa.Column("next_check_after_ms", sa.Integer(), nullable=False, server_default=sa.text("1000")),
            *FRESHNESS_COLUMNS,
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("binding_epoch >= 0", name="ck_dataset_freshness_binding_epoch"),
            sa.CheckConstraint(
                "latest_mutation_type IS NULL OR latest_mutation_type IN ('append', 'upsert', 'replace', 'retract')",
                name="ck_dataset_freshness_mutation_type",
            ),
            sa.PrimaryKeyConstraint("dataset_id", name="pk_dataset_freshness"),
        )
        return
    existing = _column_names("dataset_freshness")
    for column in FRESHNESS_COLUMNS:
        if column.name not in existing:
            op.add_column("dataset_freshness", column)
    constraints = _constraint_names("dataset_freshness")
    with op.batch_alter_table("dataset_freshness") as batch:
        if "ck_dataset_freshness_binding_epoch" not in constraints:
            batch.create_check_constraint("ck_dataset_freshness_binding_epoch", "binding_epoch >= 0")
        if "ck_dataset_freshness_mutation_type" not in constraints:
            batch.create_check_constraint(
                "ck_dataset_freshness_mutation_type",
                "latest_mutation_type IS NULL OR latest_mutation_type IN ('append', 'upsert', 'replace', 'retract')",
            )


def _ensure_revision_commits() -> None:
    if "dataset_revision_commits" not in _table_names():
        op.create_table(
            "dataset_revision_commits",
            sa.Column("dataset_id", sa.String(length=120), nullable=False),
            sa.Column("revision", sa.BigInteger(), nullable=False),
            sa.Column("run_id", sa.String(length=160), nullable=False),
            sa.Column("storage_location", sa.String(length=2048), nullable=False),
            sa.Column("storage_format", sa.String(length=32), nullable=False, server_default=sa.text("'parquet'")),
            sa.Column("materialization_mode", sa.String(length=32), nullable=False, server_default=sa.text("'delta'")),
            sa.Column("commit_kind", sa.String(length=32), nullable=False, server_default=sa.text("'legacy'")),
            sa.Column("row_count", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
            sa.Column("source_ranges", _json_document(), nullable=False, server_default=sa.text("'[]'")),
            sa.Column("source_fingerprint", sa.String(length=64), nullable=True),
            sa.Column("manifest_location", sa.String(length=2048), nullable=True),
            *REVISION_COLUMNS,
            sa.Column("committed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("binding_epoch >= 0", name="ck_dataset_revision_binding_epoch"),
            sa.CheckConstraint(
                "mutation_type IN ('append', 'upsert', 'replace', 'retract')",
                name="ck_dataset_revision_mutation_type",
            ),
            sa.PrimaryKeyConstraint("dataset_id", "revision", name="pk_dataset_revision_commits"),
            sa.UniqueConstraint("run_id", name="dataset_revision_commits_run_id_uq"),
        )
    else:
        existing = _column_names("dataset_revision_commits")
        for column in REVISION_COLUMNS:
            if column.name not in existing:
                op.add_column("dataset_revision_commits", column)
        constraints = _constraint_names("dataset_revision_commits")
        with op.batch_alter_table("dataset_revision_commits") as batch:
            if "ck_dataset_revision_binding_epoch" not in constraints:
                batch.create_check_constraint("ck_dataset_revision_binding_epoch", "binding_epoch >= 0")
            if "ck_dataset_revision_mutation_type" not in constraints:
                batch.create_check_constraint(
                    "ck_dataset_revision_mutation_type",
                    "mutation_type IN ('append', 'upsert', 'replace', 'retract')",
                )
    indexes = {item["name"] for item in sa.inspect(op.get_bind()).get_indexes("dataset_revision_commits")}
    if "dataset_revision_commits_dataset_revision_idx" not in indexes:
        op.create_index(
            "dataset_revision_commits_dataset_revision_idx",
            "dataset_revision_commits",
            ["dataset_id", "revision"],
        )
    if "dataset_revision_commits_materialization_uq" not in indexes:
        op.create_index(
            "dataset_revision_commits_materialization_uq",
            "dataset_revision_commits",
            ["materialization_id"],
            unique=True,
            postgresql_where=sa.text("materialization_id IS NOT NULL"),
            sqlite_where=sa.text("materialization_id IS NOT NULL"),
        )


def _ensure_event_log() -> None:
    if "realtime_event_log" not in _table_names():
        cursor_type = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
        op.create_table(
            "realtime_event_log",
            sa.Column("id", cursor_type, autoincrement=True, nullable=False),
            sa.Column("scope_id", sa.String(length=64), nullable=False, server_default=sa.text("'deployment'")),
            sa.Column("event_type", sa.String(length=96), nullable=False),
            sa.Column("schema_version", sa.Integer(), nullable=False, server_default=sa.text("1")),
            sa.Column("resource_type", sa.String(length=64), nullable=False),
            sa.Column("resource_id", sa.String(length=160), nullable=False),
            sa.Column("aggregate_revision", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
            sa.Column("correlation_id", sa.String(length=160), nullable=False),
            sa.Column("idempotency_key", sa.String(length=256), nullable=False),
            sa.Column("invalidations", _json_document(), nullable=False, server_default=sa.text("'[]'")),
            sa.Column("payload", _json_document(), nullable=False, server_default=sa.text("'{}'")),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.CheckConstraint("scope_id = 'deployment'", name="ck_realtime_event_log_scope"),
            sa.CheckConstraint("schema_version IN (1, 2)", name="ck_realtime_event_log_schema_version"),
            sa.PrimaryKeyConstraint("id", name="pk_realtime_event_log"),
            sa.UniqueConstraint("idempotency_key", name="realtime_event_log_idempotency_key_uq"),
        )
    else:
        constraints = _constraint_names("realtime_event_log")
        with op.batch_alter_table("realtime_event_log") as batch:
            if "ck_realtime_event_log_scope" not in constraints:
                batch.create_check_constraint("ck_realtime_event_log_scope", "scope_id = 'deployment'")
            if "ck_realtime_event_log_schema_version" not in constraints:
                batch.create_check_constraint(
                    "ck_realtime_event_log_schema_version", "schema_version IN (1, 2)"
                )
    indexes = {item["name"] for item in sa.inspect(op.get_bind()).get_indexes("realtime_event_log")}
    for name, columns in (
        ("realtime_event_log_scope_cursor_idx", ["scope_id", "id"]),
        ("realtime_event_log_resource_cursor_idx", ["resource_type", "resource_id", "id"]),
        ("realtime_event_log_expiry_idx", ["expires_at"]),
    ):
        if name not in indexes:
            op.create_index(name, "realtime_event_log", columns)


def upgrade() -> None:
    _ensure_freshness()
    _ensure_revision_commits()
    _ensure_event_log()


def downgrade() -> None:
    for name in (
        "dataset_revision_commits_materialization_uq",
    ):
        indexes = {item["name"] for item in sa.inspect(op.get_bind()).get_indexes("dataset_revision_commits")}
        if name in indexes:
            op.drop_index(name, table_name="dataset_revision_commits")
    with op.batch_alter_table("realtime_event_log") as batch:
        batch.drop_constraint("ck_realtime_event_log_schema_version", type_="check")
        batch.drop_constraint("ck_realtime_event_log_scope", type_="check")
    with op.batch_alter_table("dataset_revision_commits") as batch:
        batch.drop_constraint("ck_dataset_revision_mutation_type", type_="check")
        batch.drop_constraint("ck_dataset_revision_binding_epoch", type_="check")
        for column in reversed(REVISION_COLUMNS):
            batch.drop_column(column.name)
    with op.batch_alter_table("dataset_freshness") as batch:
        batch.drop_constraint("ck_dataset_freshness_mutation_type", type_="check")
        batch.drop_constraint("ck_dataset_freshness_binding_epoch", type_="check")
        for column in reversed(FRESHNESS_COLUMNS):
            batch.drop_column(column.name)
