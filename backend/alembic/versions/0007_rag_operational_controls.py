"""Add RAG failure reporting and artifact-retention metadata."""

from alembic import context, op
import sqlalchemy as sa


revision = "0007_rag_operational_controls"
down_revision = "0006_rag_physical_column_mapping"
branch_labels = None
depends_on = None


def _add(table: str, column: sa.Column) -> None:
    bind = op.get_bind()
    if context.is_offline_mode():
        op.add_column(table, column)
        return
    existing = {item["name"] for item in sa.inspect(bind).get_columns(table)}
    if column.name not in existing:
        op.add_column(table, column)


def upgrade() -> None:
    for table in ("rag_index_jobs", "rag_index_manifests"):
        _add(table, sa.Column("row_count", sa.Integer(), nullable=False, server_default="0"))
        _add(table, sa.Column("failed_row_rate", sa.Float(), nullable=False, server_default="0"))
        _add(table, sa.Column("failed_row_rate_threshold", sa.Float(), nullable=False, server_default="0.05"))
        _add(table, sa.Column("failed_row_report", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))
    for name, type_ in (("parent_table", sa.String(512)), ("chunk_table", sa.String(512)), ("checkpoint_path", sa.String(1024)), ("retired_at", sa.DateTime(timezone=True))):
        _add("rag_index_manifests", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name in ("retired_at", "checkpoint_path", "chunk_table", "parent_table"):
        op.drop_column("rag_index_manifests", name)
    for table in ("rag_index_manifests", "rag_index_jobs"):
        for name in ("failed_row_report", "failed_row_rate_threshold", "failed_row_rate", "row_count"):
            op.drop_column(table, name)
