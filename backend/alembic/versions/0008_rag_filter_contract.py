"""Persist the metadata filter contract for each immutable RAG build."""

from alembic import context, op
import sqlalchemy as sa


revision = "0008_rag_filter_contract"
down_revision = "0007_rag_operational_controls"
branch_labels = None
depends_on = None


def _add_if_missing(table: str, column: sa.Column) -> None:
    bind = op.get_bind()
    if context.is_offline_mode():
        op.add_column(table, column)
        return
    existing = {item["name"] for item in sa.inspect(bind).get_columns(table)}
    if column.name not in existing:
        op.add_column(table, column)


def upgrade() -> None:
    for table in ("rag_index_jobs", "rag_index_manifests"):
        _add_if_missing(table, sa.Column("metadata_columns", sa.JSON(), nullable=False, server_default=sa.text("'[]'")))
        _add_if_missing(table, sa.Column("metadata_types", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))
        _add_if_missing(table, sa.Column("filter_contract_version", sa.String(64), nullable=True))


def downgrade() -> None:
    for table in ("rag_index_manifests", "rag_index_jobs"):
        for name in ("filter_contract_version", "metadata_types", "metadata_columns"):
            op.drop_column(table, name)
