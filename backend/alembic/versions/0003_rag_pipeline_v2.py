"""add RAG v2 staged pipeline metadata"""

from alembic import context, op
import sqlalchemy as sa


revision = "0003_rag_pipeline_v2"
down_revision = "0002_schema_bindings"
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
        ("parent_count", sa.Column("parent_count", sa.Integer(), nullable=False, server_default="0")),
        ("chunk_count", sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0")),
        ("stage", sa.Column("stage", sa.String(length=32), nullable=False, server_default="queued")),
        ("source_fingerprint", sa.Column("source_fingerprint", sa.String(length=128), nullable=True)),
        ("policy_fingerprint", sa.Column("policy_fingerprint", sa.String(length=128), nullable=True)),
        ("embedding_model", sa.Column("embedding_model", sa.String(length=255), nullable=True)),
        ("embedding_dimensions", sa.Column("embedding_dimensions", sa.Integer(), nullable=True)),
        ("parent_table", sa.Column("parent_table", sa.String(length=512), nullable=True)),
        ("chunk_table", sa.Column("chunk_table", sa.String(length=512), nullable=True)),
        ("checkpoint_path", sa.Column("checkpoint_path", sa.String(length=1024), nullable=True)),
    ):
        _add_if_missing("rag_index_jobs", name, column)
    for name, column in (
        ("policy_fingerprint", sa.Column("policy_fingerprint", sa.String(length=128), nullable=True)),
        ("chunking_version", sa.Column("chunking_version", sa.String(length=64), nullable=True)),
        ("embedding_input_version", sa.Column("embedding_input_version", sa.String(length=64), nullable=True)),
        ("parent_schema_version", sa.Column("parent_schema_version", sa.String(length=64), nullable=True)),
    ):
        _add_if_missing("rag_index_manifests", name, column)


def downgrade() -> None:
    for table, name in (
        ("rag_index_manifests", "parent_schema_version"),
        ("rag_index_manifests", "embedding_input_version"),
        ("rag_index_manifests", "chunking_version"),
        ("rag_index_manifests", "policy_fingerprint"),
        ("rag_index_jobs", "checkpoint_path"),
        ("rag_index_jobs", "chunk_table"),
        ("rag_index_jobs", "parent_table"),
        ("rag_index_jobs", "embedding_dimensions"),
        ("rag_index_jobs", "embedding_model"),
        ("rag_index_jobs", "policy_fingerprint"),
        ("rag_index_jobs", "source_fingerprint"),
        ("rag_index_jobs", "stage"),
        ("rag_index_jobs", "chunk_count"),
        ("rag_index_jobs", "parent_count"),
    ):
        op.drop_column(table, name)
