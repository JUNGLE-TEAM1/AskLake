"""Add hot/archive parity evidence and recovery operation ledger."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0014_realtime_archive_recovery"
down_revision = "0013_catalog_realtime_publication"
branch_labels = None
depends_on = None


def _json_document():
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    tables = _table_names()
    if "realtime_parity_checks" not in tables:
        op.create_table(
            "realtime_parity_checks",
            sa.Column("id", sa.String(length=160), nullable=False),
            sa.Column("dataset_id", sa.String(length=120), nullable=False),
            sa.Column("pipeline_version_id", sa.String(length=160), nullable=False),
            sa.Column("hot_binding_version_id", sa.String(length=160), nullable=False),
            sa.Column("archive_binding_version_id", sa.String(length=160), nullable=False),
            sa.Column("source_boundary", _json_document(), nullable=False),
            sa.Column("dimension_version_ids", _json_document(), nullable=False),
            sa.Column("hot_evidence", _json_document(), nullable=False),
            sa.Column("archive_evidence", _json_document(), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column(
                "mismatch_fields",
                _json_document(),
                nullable=False,
                server_default=sa.text("'[]'"),
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.CheckConstraint(
                "status IN ('matched', 'mismatch')",
                name="ck_realtime_parity_checks_status",
            ),
            sa.PrimaryKeyConstraint("id", name="pk_realtime_parity_checks"),
        )
        op.create_index(
            "realtime_parity_checks_dataset_created_idx",
            "realtime_parity_checks",
            ["dataset_id", "created_at"],
        )
        op.create_index(
            "realtime_parity_checks_status_idx",
            "realtime_parity_checks",
            ["status", "created_at"],
        )

    tables = _table_names()
    if "realtime_recovery_operations" not in tables:
        op.create_table(
            "realtime_recovery_operations",
            sa.Column("id", sa.String(length=160), nullable=False),
            sa.Column("idempotency_key", sa.String(length=256), nullable=False),
            sa.Column("dataset_id", sa.String(length=120), nullable=False),
            sa.Column("operation_kind", sa.String(length=32), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("parity_check_id", sa.String(length=160), nullable=False),
            sa.Column("expected_binding_epoch", sa.BigInteger(), nullable=False),
            sa.Column("previous_binding_version_id", sa.String(length=160), nullable=True),
            sa.Column("target_binding_version_id", sa.String(length=160), nullable=False),
            sa.Column("target_engine", sa.String(length=32), nullable=False),
            sa.Column("pipeline_version_id", sa.String(length=160), nullable=False),
            sa.Column("target_binding", _json_document(), nullable=False),
            sa.Column("source_boundary", _json_document(), nullable=False),
            sa.Column("dimension_version_ids", _json_document(), nullable=False),
            sa.Column(
                "tail_start_offsets",
                _json_document(),
                nullable=False,
                server_default=sa.text("'[]'"),
            ),
            sa.Column(
                "gate_evidence",
                _json_document(),
                nullable=False,
                server_default=sa.text("'{}'"),
            ),
            sa.Column("attempt_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("result_binding_epoch", sa.BigInteger(), nullable=True),
            sa.Column("result_revision", sa.BigInteger(), nullable=True),
            sa.Column("result_event_cursor", sa.BigInteger(), nullable=True),
            sa.Column("requested_by", sa.String(length=255), nullable=False),
            sa.Column("reason", sa.String(length=2000), nullable=False),
            sa.Column("correlation_id", sa.String(length=160), nullable=False),
            sa.Column("last_error_code", sa.String(length=120), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.CheckConstraint(
                "operation_kind IN ('rebuild', 'cutover', 'rollback')",
                name="ck_realtime_recovery_operations_kind",
            ),
            sa.CheckConstraint(
                "status IN ('planned', 'running', 'ready', 'completed', 'failed')",
                name="ck_realtime_recovery_operations_status",
            ),
            sa.CheckConstraint(
                "target_engine IN ('clickhouse', 'trino')",
                name="ck_realtime_recovery_operations_engine",
            ),
            sa.CheckConstraint(
                "expected_binding_epoch >= 0 AND attempt_count >= 0",
                name="ck_realtime_recovery_operations_counters",
            ),
            sa.CheckConstraint(
                "result_binding_epoch IS NULL OR result_binding_epoch >= 0",
                name="ck_realtime_recovery_operations_result_epoch",
            ),
            sa.CheckConstraint(
                "result_revision IS NULL OR result_revision >= 0",
                name="ck_realtime_recovery_operations_result_revision",
            ),
            sa.ForeignKeyConstraint(
                ["parity_check_id"],
                ["realtime_parity_checks.id"],
                name="fk_realtime_recovery_operations_parity",
                ondelete="RESTRICT",
            ),
            sa.PrimaryKeyConstraint("id", name="pk_realtime_recovery_operations"),
            sa.UniqueConstraint(
                "idempotency_key",
                name="realtime_recovery_operations_idempotency_uq",
            ),
        )
        op.create_index(
            "realtime_recovery_operations_dataset_created_idx",
            "realtime_recovery_operations",
            ["dataset_id", "created_at"],
        )
        op.create_index(
            "realtime_recovery_operations_status_idx",
            "realtime_recovery_operations",
            ["operation_kind", "status", "updated_at"],
        )


def downgrade() -> None:
    tables = _table_names()
    if "realtime_recovery_operations" in tables:
        op.drop_table("realtime_recovery_operations")
    if "realtime_parity_checks" in tables:
        op.drop_table("realtime_parity_checks")
