"""Persist AI generation token and estimated-cost provenance."""

from alembic import op

from app.models.identity import AiGenerationUsageModel


revision = "0010_ai_generation_usage"
down_revision = "0009_rag_activation_reconciliation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    AiGenerationUsageModel.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    AiGenerationUsageModel.__table__.drop(bind=op.get_bind(), checkfirst=True)
