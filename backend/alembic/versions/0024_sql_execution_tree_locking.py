"""Add SQL execution tree runs, nodes, and atomic Job locks."""

from alembic import op
import sqlalchemy as sa


revision = "0024_sql_execution_tree_locking"
down_revision = "0023_sql_job_execution_tree_persistence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    existing = set(sa.inspect(connection).get_table_names())
    if "continuous_sql_tree_runs" not in existing:
        op.create_table(
            "continuous_sql_tree_runs",
            sa.Column("tree_run_id", sa.String(200), primary_key=True),
            sa.Column("sql_job_id", sa.String(160), nullable=False),
            sa.Column("continuous_sql_run_id", sa.String(200), nullable=True),
            sa.Column("generation", sa.Integer(), nullable=False),
            sa.Column("trigger_type", sa.String(32), nullable=False, server_default="parent_tree"),
            sa.Column("status", sa.String(32), nullable=False, server_default="locked"),
            sa.Column("fencing_token", sa.String(160), nullable=False),
            sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("input_dataset_revisions", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column("started_at", sa.String(64), nullable=False),
            sa.Column("ended_at", sa.String(64), nullable=True),
            sa.Column("last_error_code", sa.String(120), nullable=True),
            sa.Column("last_error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["sql_job_id"], ["continuous_sql_jobs.id"], ondelete="CASCADE"),
            sa.UniqueConstraint("sql_job_id", "generation", name="uq_continuous_sql_tree_run_generation"),
        )
        op.create_index("ix_continuous_sql_tree_runs_job_status", "continuous_sql_tree_runs", ["sql_job_id", "status"])
    if "continuous_sql_tree_node_runs" not in existing:
        op.create_table(
            "continuous_sql_tree_node_runs",
            sa.Column("node_run_id", sa.String(220), primary_key=True),
            sa.Column("tree_run_id", sa.String(200), nullable=False),
            sa.Column("job_id", sa.String(160), nullable=False),
            sa.Column("node_type", sa.String(32), nullable=False),
            sa.Column("trigger_type", sa.String(32), nullable=False, server_default="parent_tree"),
            sa.Column("parent_run_id", sa.String(200), nullable=True),
            sa.Column("producer_run_id", sa.String(200), nullable=True),
            sa.Column("status", sa.String(32), nullable=False, server_default="locked"),
            sa.Column("input_dataset_revisions", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column("started_at", sa.String(64), nullable=False),
            sa.Column("ended_at", sa.String(64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["tree_run_id"], ["continuous_sql_tree_runs.tree_run_id"], ondelete="CASCADE"),
            sa.UniqueConstraint("tree_run_id", "job_id", name="uq_continuous_sql_tree_node_job"),
        )
        op.create_index("ix_continuous_sql_tree_node_runs_job", "continuous_sql_tree_node_runs", ["job_id", "status"])
    if "continuous_sql_tree_job_locks" not in existing:
        op.create_table(
            "continuous_sql_tree_job_locks",
            sa.Column("job_id", sa.String(160), primary_key=True),
            sa.Column("tree_run_id", sa.String(200), nullable=False),
            sa.Column("node_run_id", sa.String(220), nullable=False),
            sa.Column("owner_sql_job_id", sa.String(160), nullable=False),
            sa.Column("lock_kind", sa.String(32), nullable=False),
            sa.Column("generation", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("fencing_token", sa.String(160), nullable=False),
            sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("released_at", sa.String(64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["tree_run_id"], ["continuous_sql_tree_runs.tree_run_id"], ondelete="CASCADE"),
        )
        op.create_index("ix_continuous_sql_tree_job_locks_tree", "continuous_sql_tree_job_locks", ["tree_run_id", "active"])
        op.create_index("ix_continuous_sql_tree_job_locks_owner", "continuous_sql_tree_job_locks", ["owner_sql_job_id", "active"])


def downgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    for table in (
        "continuous_sql_tree_job_locks",
        "continuous_sql_tree_node_runs",
        "continuous_sql_tree_runs",
    ):
        if table in existing:
            op.drop_table(table)
