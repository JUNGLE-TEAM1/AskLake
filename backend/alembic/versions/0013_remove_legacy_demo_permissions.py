"""Remove legacy demo permission grants from live resource authorization."""

from alembic import op
from sqlalchemy import inspect, text


revision = "0013_remove_legacy_demo_permissions"
down_revision = "0012_review_analysis_runs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if inspect(bind).has_table("permission_grants"):
        bind.execute(text(
            "DELETE FROM permission_grants "
            "WHERE source IN ('admin_seed', 'admin_seed_deleted')"
        ))


def downgrade() -> None:
    # Deleted demo grants represented fabricated authorization and must not be restored.
    pass

