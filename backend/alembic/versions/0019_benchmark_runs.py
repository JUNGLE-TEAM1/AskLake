"""Add durable Nessie SQL benchmark run lineage."""

from alembic import op
import sqlalchemy as sa


revision = "0019_benchmark_runs"
down_revision = "0018_realtime_archive_recovery"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "benchmark_runs" not in inspector.get_table_names():
        op.create_table(
            "benchmark_runs",
            sa.Column("id", sa.String(length=64), primary_key=True),
            sa.Column("idempotency_key", sa.String(length=255), nullable=False, unique=True),
            sa.Column("campaign_id", sa.String(length=128), nullable=False),
            sa.Column("case_id", sa.String(length=128), nullable=False),
            sa.Column("suite_version", sa.String(length=64), nullable=False),
            sa.Column("candidate_role", sa.String(length=32), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("repetition_index", sa.Integer(), nullable=False),
            sa.Column("request_id", sa.String(length=255), nullable=True),
            sa.Column("query_run_id", sa.String(length=255), nullable=True),
            sa.Column("sanitized_sql_hash", sa.String(length=64), nullable=True),
            sa.Column("dataset_snapshot_hash", sa.String(length=64), nullable=False),
            sa.Column("runtime_profile", sa.String(length=255), nullable=False),
            sa.Column("cache_mode", sa.String(length=16), nullable=False),
            sa.Column("payload", sa.JSON(), nullable=False),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )
    inspector = sa.inspect(op.get_bind())
    existing_indexes = {
        item["name"] for item in inspector.get_indexes("benchmark_runs")
    }
    for name, columns in (
        ("ix_benchmark_runs_campaign_case", ["campaign_id", "case_id"]),
        ("ix_benchmark_runs_status", ["status"]),
        ("ix_benchmark_runs_expires_at", ["expires_at"]),
    ):
        if name not in existing_indexes:
            op.create_index(name, "benchmark_runs", columns)


def downgrade() -> None:
    op.drop_index("ix_benchmark_runs_expires_at", table_name="benchmark_runs")
    op.drop_index("ix_benchmark_runs_status", table_name="benchmark_runs")
    op.drop_index("ix_benchmark_runs_campaign_case", table_name="benchmark_runs")
    op.drop_table("benchmark_runs")
