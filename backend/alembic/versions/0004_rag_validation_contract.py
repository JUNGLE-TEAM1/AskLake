"""record RAG validation, fallback, and active manifest contract"""

from alembic import context, op
import sqlalchemy as sa

revision = "0004_rag_validation_contract"
down_revision = "0003_rag_pipeline_v2"
branch_labels = None
depends_on = None


def _add_if_missing(table: str, name: str, column: sa.Column) -> None:
    bind = op.get_bind()
    if context.is_offline_mode():
        op.add_column(table, column)
        return
    existing = {item["name"] for item in sa.inspect(bind).get_columns(table)}
    if name not in existing:
        op.add_column(table, column)


def upgrade() -> None:
    for name, column in (
        ("failed_count", sa.Column("failed_count", sa.Integer(), nullable=False, server_default="0")),
        ("fallback_count", sa.Column("fallback_count", sa.Integer(), nullable=False, server_default="0")),
        ("fallback_reasons", sa.Column("fallback_reasons", sa.JSON(), nullable=False, server_default="{}")),
    ):
        _add_if_missing("rag_index_jobs", name, column)
    for name, column in (
        ("parent_count", sa.Column("parent_count", sa.Integer(), nullable=False, server_default="0")),
        ("chunk_count", sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0")),
        ("failed_count", sa.Column("failed_count", sa.Integer(), nullable=False, server_default="0")),
        ("fallback_count", sa.Column("fallback_count", sa.Integer(), nullable=False, server_default="0")),
        ("fallback_reasons", sa.Column("fallback_reasons", sa.JSON(), nullable=False, server_default="{}")),
        ("schema_fingerprint", sa.Column("schema_fingerprint", sa.String(length=128), nullable=True)),
        ("semantic_bindings_fingerprint", sa.Column("semantic_bindings_fingerprint", sa.String(length=128), nullable=True)),
    ):
        _add_if_missing("rag_index_manifests", name, column)


def downgrade() -> None:
    for table, name in (
        ("rag_index_manifests", "semantic_bindings_fingerprint"),
        ("rag_index_manifests", "schema_fingerprint"),
        ("rag_index_manifests", "fallback_reasons"),
        ("rag_index_manifests", "fallback_count"),
        ("rag_index_manifests", "failed_count"),
        ("rag_index_manifests", "chunk_count"),
        ("rag_index_manifests", "parent_count"),
        ("rag_index_jobs", "fallback_reasons"),
        ("rag_index_jobs", "fallback_count"),
        ("rag_index_jobs", "failed_count"),
    ):
        op.drop_column(table, name)
