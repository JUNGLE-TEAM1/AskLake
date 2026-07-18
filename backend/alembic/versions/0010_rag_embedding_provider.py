"""Persist the provider used for each immutable RAG vector index."""

import sqlalchemy as sa
from alembic import op


revision = "0010_rag_embedding_provider"
down_revision = "0009_rag_activation_reconciliation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rag_index_jobs",
        sa.Column("embedding_provider", sa.String(length=100), nullable=True),
    )
    op.add_column(
        "rag_index_manifests",
        sa.Column("embedding_provider", sa.String(length=100), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rag_index_manifests", "embedding_provider")
    op.drop_column("rag_index_jobs", "embedding_provider")
