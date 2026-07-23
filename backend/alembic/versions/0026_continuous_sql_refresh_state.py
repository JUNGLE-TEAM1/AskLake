"""Persist revision-driven Trino refresh state on Continuous SQL Jobs."""

from alembic import op
import sqlalchemy as sa


revision = "0026_continuous_sql_refresh_state"
down_revision = "0025_dataset_revision_snapshot_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "continuous_sql_jobs" not in set(inspector.get_table_names()):
        return
    columns = {item["name"] for item in inspector.get_columns("continuous_sql_jobs")}
    additions = {
        "latest_source_revision": sa.Column("latest_source_revision", sa.BigInteger(), nullable=False, server_default="0"),
        "processing_source_revision": sa.Column("processing_source_revision", sa.BigInteger(), nullable=True),
        "published_source_revision": sa.Column("published_source_revision", sa.BigInteger(), nullable=False, server_default="0"),
        "refresh_status": sa.Column("refresh_status", sa.String(length=32), nullable=False, server_default="idle"),
        "refresh_claimed_at": sa.Column("refresh_claimed_at", sa.DateTime(timezone=True), nullable=True),
        "refresh_last_error": sa.Column("refresh_last_error", sa.Text(), nullable=True),
    }
    for name, column in additions.items():
        if name not in columns:
            op.add_column("continuous_sql_jobs", column)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "continuous_sql_jobs" not in set(inspector.get_table_names()):
        return
    columns = {item["name"] for item in inspector.get_columns("continuous_sql_jobs")}
    for name in (
        "refresh_last_error",
        "refresh_claimed_at",
        "refresh_status",
        "published_source_revision",
        "processing_source_revision",
        "latest_source_revision",
    ):
        if name in columns:
            op.drop_column("continuous_sql_jobs", name)
