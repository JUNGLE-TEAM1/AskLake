"""Persist AI generation token and estimated-cost provenance."""

from alembic import op

from app.models.identity import AiGenerationUsageModel


revision = "0012_ai_generation_usage"
down_revision = "0011_rag_control_plane_fencing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    AiGenerationUsageModel.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    AiGenerationUsageModel.__table__.drop(bind=op.get_bind(), checkfirst=True)
