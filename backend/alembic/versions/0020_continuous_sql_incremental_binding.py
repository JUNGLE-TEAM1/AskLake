"""Add durable Continuous SQL baseline and Kafka source checkpoints."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0020_continuous_sql_incremental_binding"
down_revision = "0019_benchmark_runs"
branch_labels = None
depends_on = None


def _json_document():
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "continuous_sql_incremental_bindings" in inspector.get_table_names():
        return
    op.create_table(
        "continuous_sql_incremental_bindings",
        sa.Column("job_id", sa.String(length=160), nullable=False),
        sa.Column("source_dataset_id", sa.String(length=160), nullable=False),
        sa.Column("baseline_dataset_id", sa.String(length=160), nullable=False),
        sa.Column("baseline_snapshot_id", sa.String(length=255), nullable=False),
        sa.Column("baseline_revision", sa.BigInteger(), nullable=False),
        sa.Column("source_revision", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("source_run_id", sa.String(length=200), nullable=True),
        sa.Column("source_fingerprint", sa.String(length=64), nullable=True),
        sa.Column("source_ranges", _json_document(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("static_snapshots", _json_document(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("next_offsets", _json_document(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("output_revision", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("processed_rows", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("processed_static_keys", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("full_refresh_count", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="ready"),
        sa.Column("last_error_code", sa.String(length=120), nullable=True),
        sa.Column("last_error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["job_id"], ["continuous_sql_jobs.id"]),
        sa.PrimaryKeyConstraint("job_id"),
    )
    op.create_index(
        "ix_continuous_sql_incremental_bindings_source_dataset_id",
        "continuous_sql_incremental_bindings",
        ["source_dataset_id"],
    )
    op.create_index(
        "ix_continuous_sql_incremental_bindings_source_revision",
        "continuous_sql_incremental_bindings",
        ["source_dataset_id", "source_revision"],
    )
    op.create_index(
        "ix_continuous_sql_incremental_bindings_status",
        "continuous_sql_incremental_bindings",
        ["status", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_continuous_sql_incremental_bindings_status",
        table_name="continuous_sql_incremental_bindings",
    )
    op.drop_index(
        "ix_continuous_sql_incremental_bindings_source_revision",
        table_name="continuous_sql_incremental_bindings",
    )
    op.drop_index(
        "ix_continuous_sql_incremental_bindings_source_dataset_id",
        table_name="continuous_sql_incremental_bindings",
    )
    op.drop_table("continuous_sql_incremental_bindings")
