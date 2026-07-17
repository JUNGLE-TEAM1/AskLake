"""Persist single-use AI context consumption across service replicas."""

from alembic import op

from app.models.identity import AiContextConsumptionModel


revision = "0011_ai_context_consumptions"
down_revision = "0010_ai_generation_usage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    AiContextConsumptionModel.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    AiContextConsumptionModel.__table__.drop(bind=op.get_bind(), checkfirst=True)
