"""persist physical schema bindings for semantic and rag definitions"""

from alembic import context, op
import sqlalchemy as sa


revision = "0002_schema_bindings"
down_revision = "0001_semantic_rag"
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
    _add_if_missing("semantic_metrics", "source_columns", sa.Column("source_columns", sa.JSON(), nullable=False, server_default="[]"))
    _add_if_missing("rag_dataset_profiles", "schema_fingerprint", sa.Column("schema_fingerprint", sa.String(length=128), nullable=True))
    _add_if_missing("rag_dataset_profiles", "title_columns", sa.Column("title_columns", sa.JSON(), nullable=False, server_default="[]"))
    _add_if_missing("rag_dataset_profiles", "identifier_columns", sa.Column("identifier_columns", sa.JSON(), nullable=False, server_default="[]"))
    _add_if_missing("rag_dataset_profiles", "semantic_bindings", sa.Column("semantic_bindings", sa.JSON(), nullable=False, server_default="{}"))


def downgrade() -> None:
    for table, column in (
        ("rag_dataset_profiles", "semantic_bindings"),
        ("rag_dataset_profiles", "identifier_columns"),
        ("rag_dataset_profiles", "title_columns"),
        ("rag_dataset_profiles", "schema_fingerprint"),
        ("semantic_metrics", "source_columns"),
    ):
        op.drop_column(table, column)
