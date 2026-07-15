"""Persist the logical-to-physical RAG column mapping."""

from alembic import context, op
import sqlalchemy as sa


revision = "0006_rag_physical_column_mapping"
down_revision = "0005_rag_activation_fencing"
branch_labels = None
depends_on = None


def _add_if_missing(table: str, name: str) -> None:
    bind = op.get_bind()
    if context.is_offline_mode():
        op.add_column(table, sa.Column(name, sa.JSON(), nullable=False, server_default=sa.text("'{}'")))
        return
    existing = {item["name"] for item in sa.inspect(bind).get_columns(table)}
    if name not in existing:
        op.add_column(table, sa.Column(name, sa.JSON(), nullable=False, server_default=sa.text("'{}'")))


def upgrade() -> None:
    _add_if_missing("rag_dataset_profiles", "physical_column_mapping")
    _add_if_missing("rag_index_jobs", "physical_column_mapping")
    _add_if_missing("rag_index_manifests", "physical_column_mapping")


def downgrade() -> None:
    for table in ("rag_index_manifests", "rag_index_jobs", "rag_dataset_profiles"):
        op.drop_column(table, "physical_column_mapping")
