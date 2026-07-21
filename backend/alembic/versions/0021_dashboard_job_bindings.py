"""Add durable Dashboard Job bindings and delivery state."""

from alembic import op
import sqlalchemy as sa


revision = "0021_dashboard_job_bindings"
down_revision = "0020_continuous_sql_incremental_binding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = set(inspector.get_table_names())
    if "dashboard_job_bindings" not in existing:
        op.create_table(
            "dashboard_job_bindings",
            sa.Column("id", sa.String(length=120), primary_key=True),
            sa.Column("dashboard_id", sa.String(length=64), nullable=False),
            sa.Column("job_id", sa.String(length=160), nullable=False),
            sa.Column("job_kind", sa.String(length=32), nullable=False),
            sa.Column("output_dataset_id", sa.String(length=160), nullable=False),
            sa.Column("mode", sa.String(length=32), nullable=False, server_default="managed"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_by", sa.String(length=255), nullable=False),
            sa.Column("detached_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("dashboard_id", name="uq_dashboard_job_bindings_dashboard"),
        )
        op.create_index("ix_dashboard_job_bindings_dashboard_id", "dashboard_job_bindings", ["dashboard_id"])
        op.create_index("ix_dashboard_job_bindings_job", "dashboard_job_bindings", ["job_kind", "job_id"])
        op.create_index("ix_dashboard_job_bindings_dataset", "dashboard_job_bindings", ["output_dataset_id", "mode"])
    if "dashboard_binding_deliveries" not in existing:
        op.create_table(
            "dashboard_binding_deliveries",
            sa.Column("id", sa.String(length=160), primary_key=True),
            sa.Column("binding_id", sa.String(length=120), nullable=False),
            sa.Column("dataset_revision", sa.BigInteger(), nullable=False),
            sa.Column("mutation_type", sa.String(length=32), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
            sa.Column("applied_revision", sa.BigInteger(), nullable=True),
            sa.Column("calculated_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("error_code", sa.String(length=120), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["binding_id"], ["dashboard_job_bindings.id"], ondelete="CASCADE"),
            sa.UniqueConstraint("binding_id", "dataset_revision", name="uq_dashboard_binding_delivery_revision"),
        )
        op.create_index("ix_dashboard_binding_deliveries_binding_id", "dashboard_binding_deliveries", ["binding_id"])
        op.create_index("ix_dashboard_binding_deliveries_status", "dashboard_binding_deliveries", ["status", "updated_at"])


def downgrade() -> None:
    op.drop_table("dashboard_binding_deliveries")
    op.drop_table("dashboard_job_bindings")
