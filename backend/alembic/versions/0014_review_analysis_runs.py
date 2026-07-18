"""Persist asynchronous review-analysis run state."""

from alembic import op

from app.models.etl import ReviewAnalysisRunModel


revision = "0014_review_analysis_runs"
down_revision = "0013_ai_context_consumptions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    ReviewAnalysisRunModel.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    ReviewAnalysisRunModel.__table__.drop(bind=op.get_bind(), checkfirst=True)
