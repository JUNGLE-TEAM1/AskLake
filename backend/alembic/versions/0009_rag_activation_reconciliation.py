"""Persist alias activation intent so DB/OpenSearch drift can be repaired."""

from alembic import context, op
import sqlalchemy as sa


revision = "0009_rag_activation_reconciliation"
down_revision = "0008_rag_filter_contract"
branch_labels = None
depends_on = None


def _add_if_missing(name: str, column: sa.Column) -> None:
    bind = op.get_bind()
    if context.is_offline_mode():
        op.add_column("rag_index_jobs", column)
        return
    existing = {item["name"] for item in sa.inspect(bind).get_columns("rag_index_jobs")}
    if name not in existing:
        op.add_column("rag_index_jobs", column)


def upgrade() -> None:
    _add_if_missing("activation_status", sa.Column("activation_status", sa.String(32), nullable=False, server_default="none"))
    _add_if_missing("activation_alias", sa.Column("activation_alias", sa.String(255), nullable=True))
    _add_if_missing("activation_previous_index", sa.Column("activation_previous_index", sa.String(255), nullable=True))
    _add_if_missing("activation_target_index", sa.Column("activation_target_index", sa.String(255), nullable=True))
    _add_if_missing("activation_started_at", sa.Column("activation_started_at", sa.DateTime(timezone=True), nullable=True))
    _add_if_missing("activation_committed_at", sa.Column("activation_committed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    for name in ("activation_committed_at", "activation_started_at", "activation_target_index", "activation_previous_index", "activation_alias", "activation_status"):
        op.drop_column("rag_index_jobs", name)
