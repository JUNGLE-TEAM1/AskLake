"""Persist verified AI evidence consumption provenance."""

from alembic import op
import sqlalchemy as sa


revision = "0016_ai_generation_evidence_audit"
down_revision = "0015_rag_control_plane_fencing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "ai_generation_usage" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("ai_generation_usage")}
    columns = {
        "actor_id": sa.Column("actor_id", sa.String(length=255), nullable=True),
        "actor_name": sa.Column("actor_name", sa.String(length=255), nullable=True),
        "candidate_evidence_ids": sa.Column("candidate_evidence_ids", sa.JSON(), nullable=False, server_default="[]"),
        "used_evidence_ids": sa.Column("used_evidence_ids", sa.JSON(), nullable=False, server_default="[]"),
        "context_fingerprint": sa.Column("context_fingerprint", sa.String(length=64), nullable=True),
        "output_fingerprint": sa.Column("output_fingerprint", sa.String(length=64), nullable=True),
        "evidence_status": sa.Column("evidence_status", sa.String(length=32), nullable=False, server_default="pending"),
    }
    for name, column in columns.items():
        if name not in existing:
            op.add_column("ai_generation_usage", column)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "ai_generation_usage" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("ai_generation_usage")}
    for name in (
        "evidence_status",
        "output_fingerprint",
        "context_fingerprint",
        "used_evidence_ids",
        "candidate_evidence_ids",
        "actor_name",
        "actor_id",
    ):
        if name in existing:
            op.drop_column("ai_generation_usage", name)
