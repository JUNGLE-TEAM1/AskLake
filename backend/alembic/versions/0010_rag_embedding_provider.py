"""Persist the provider used for each immutable RAG vector index."""

import sqlalchemy as sa
from alembic import context, op


revision = "0010_rag_embedding_provider"
down_revision = "0009_rag_activation_reconciliation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("rag_index_jobs", "rag_index_manifests"):
        if not context.is_offline_mode():
            columns = {
                item["name"]
                for item in sa.inspect(op.get_bind()).get_columns(table)
            }
            if "embedding_provider" in columns:
                continue
        op.add_column(
            table,
            sa.Column("embedding_provider", sa.String(length=100), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("rag_index_manifests", "embedding_provider")
    op.drop_column("rag_index_jobs", "embedding_provider")
