"""Add the ClickHouse Realtime V2 control-plane foundation.

This is an expand-only production migration.  It deliberately does not alter
the existing Dataset revision, freshness, or realtime event-log tables; those
public publication contracts are extended in the later Catalog/revision phase.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0016_clickhouse_realtime_v2_foundation"
down_revision = "0015_ai_generation_evidence_audit"
branch_labels = None
depends_on = None


ACTIVE_DIMENSION_INDEX = "uq_realtime_dimension_versions_active_dataset"
ACTIVE_PIPELINE_VERSION_INDEX = "uq_realtime_pipeline_versions_one_active"
V2_TABLES_IN_DROP_ORDER = (
    "realtime_routing_assignments",
    "realtime_unmatched_events",
    "realtime_dimension_versions",
    "realtime_ingest_exceptions",
    "realtime_partition_receipt_ranges",
    "realtime_materializations",
    "realtime_partition_checkpoints",
    "realtime_pipeline_deployments",
    "realtime_pipeline_versions",
    "realtime_pipelines",
)


def _json_document() -> sa.types.TypeEngine:
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def _created_at() -> sa.Column:
    return sa.Column(
        "created_at",
        sa.DateTime(timezone=True),
        nullable=False,
        server_default=sa.func.now(),
    )


def _updated_at() -> sa.Column:
    return sa.Column(
        "updated_at",
        sa.DateTime(timezone=True),
        nullable=False,
        server_default=sa.func.now(),
    )


def upgrade() -> None:
    op.create_table(
        "realtime_pipelines",
        sa.Column("id", sa.String(length=160), nullable=False),
        sa.Column(
            "scope_id",
            sa.String(length=64),
            nullable=False,
            server_default=sa.text("'deployment'"),
        ),
        sa.Column("logical_dataset_id", sa.String(length=160), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("execution_mode", sa.String(length=48), nullable=False),
        sa.Column(
            "desired_state",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'stopped'"),
        ),
        # Kept nullable during expand/shadow deployment.  The FK is installed
        # after the version table exists on PostgreSQL.
        sa.Column("active_version_id", sa.String(length=160), nullable=True),
        sa.Column("owner_user_id", sa.String(length=255), nullable=False),
        _created_at(),
        _updated_at(),
        sa.CheckConstraint(
            "scope_id = 'deployment'",
            name="ck_realtime_pipelines_deployment_scope",
        ),
        sa.CheckConstraint(
            "execution_mode IN "
            "('realtime_incremental', 'near_realtime_refresh', 'streaming_required')",
            name="ck_realtime_pipelines_execution_mode",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_realtime_pipelines"),
        sa.UniqueConstraint(
            "scope_id",
            "logical_dataset_id",
            name="uq_realtime_pipelines_scope_dataset",
        ),
    )
    op.create_index(
        "ix_realtime_pipelines_desired_state",
        "realtime_pipelines",
        ["desired_state", "updated_at"],
    )

    op.create_table(
        "realtime_pipeline_versions",
        sa.Column("id", sa.String(length=160), nullable=False),
        sa.Column("pipeline_id", sa.String(length=160), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        # PostgreSQL renders this as a database-owned identity sequence.  The
        # global generation is part of the serving row-version fencing token.
        sa.Column(
            "pipeline_generation",
            sa.BigInteger(),
            sa.Identity(start=1),
            nullable=False,
        ),
        sa.Column("normalized_sql", sa.Text(), nullable=False),
        sa.Column("sql_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("compiled_clickhouse_sql", sa.Text(), nullable=True),
        sa.Column("source_dataset_id", sa.String(length=160), nullable=False),
        sa.Column(
            "reference_dataset_ids",
            _json_document(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
        sa.Column(
            "join_semantics",
            _json_document(),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "correction_policy",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'bounded_repair'"),
        ),
        sa.Column("schema_fingerprint", sa.String(length=64), nullable=False),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'draft'"),
        ),
        sa.Column("created_by", sa.String(length=255), nullable=False),
        _created_at(),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("version > 0", name="ck_realtime_pipeline_versions_version"),
        sa.CheckConstraint(
            "correction_policy IN ('future_only', 'bounded_repair', 'full_rebuild')",
            name="ck_realtime_pipeline_versions_correction_policy",
        ),
        sa.CheckConstraint(
            "status IN "
            "('draft', 'validating', 'shadow_building', 'shadow_ready', 'active', "
            "'draining', 'retired', 'validation_failed', 'deployment_failed', "
            "'degraded', 'rollback_required')",
            name="ck_realtime_pipeline_versions_status",
        ),
        sa.ForeignKeyConstraint(
            ["pipeline_id"],
            ["realtime_pipelines.id"],
            name="fk_realtime_pipeline_versions_pipeline",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_realtime_pipeline_versions"),
        sa.UniqueConstraint(
            "pipeline_id",
            "version",
            name="uq_realtime_pipeline_versions_pipeline_version",
        ),
        # Supports the same-pipeline composite active-pointer FK below.
        sa.UniqueConstraint(
            "pipeline_id",
            "id",
            name="uq_realtime_pipeline_versions_pipeline_id",
        ),
        sa.UniqueConstraint(
            "pipeline_generation",
            name="uq_realtime_pipeline_versions_generation",
        ),
    )
    op.create_index(
        "ix_realtime_pipeline_versions_status",
        "realtime_pipeline_versions",
        ["pipeline_id", "status", "created_at"],
    )
    op.create_index(
        ACTIVE_PIPELINE_VERSION_INDEX,
        "realtime_pipeline_versions",
        ["pipeline_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
        sqlite_where=sa.text("status = 'active'"),
    )

    # SQLite is used only by the migration topology unit test and cannot add a
    # foreign key with ALTER TABLE.  Production PostgreSQL receives the
    # deferrable active-pointer constraint after both sides of the cycle exist.
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_realtime_pipelines_active_version",
            "realtime_pipelines",
            "realtime_pipeline_versions",
            ["id", "active_version_id"],
            ["pipeline_id", "id"],
            ondelete="RESTRICT",
            deferrable=True,
            initially="DEFERRED",
        )

    op.create_table(
        "realtime_pipeline_deployments",
        sa.Column("id", sa.String(length=160), nullable=False),
        sa.Column("pipeline_version_id", sa.String(length=160), nullable=False),
        sa.Column("environment", sa.String(length=64), nullable=False),
        sa.Column("physical_database", sa.String(length=255), nullable=False),
        sa.Column("physical_table", sa.String(length=255), nullable=False),
        sa.Column("shadow_table", sa.String(length=255), nullable=True),
        sa.Column("deployed_sql_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column("deployed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_health_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(length=120), nullable=True),
        sa.Column("last_error_detail_safe", sa.Text(), nullable=True),
        _created_at(),
        _updated_at(),
        sa.CheckConstraint(
            "status IN "
            "('pending', 'deploying', 'shadow', 'available', 'degraded', 'failed', 'retired')",
            name="ck_realtime_pipeline_deployments_status",
        ),
        sa.ForeignKeyConstraint(
            ["pipeline_version_id"],
            ["realtime_pipeline_versions.id"],
            name="fk_realtime_pipeline_deployments_version",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_realtime_pipeline_deployments"),
        sa.UniqueConstraint(
            "pipeline_version_id",
            "environment",
            name="uq_realtime_pipeline_deployments_version_environment",
        ),
    )
    op.create_index(
        "ix_realtime_pipeline_deployments_health",
        "realtime_pipeline_deployments",
        ["environment", "status", "last_health_at"],
    )

    op.create_table(
        "realtime_partition_checkpoints",
        sa.Column("pipeline_version_id", sa.String(length=160), nullable=False),
        sa.Column("topic", sa.String(length=249), nullable=False),
        sa.Column("partition", sa.Integer(), nullable=False),
        sa.Column(
            "last_observed_offset",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("-1"),
        ),
        sa.Column(
            "last_contiguously_received_offset",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("-1"),
        ),
        sa.Column(
            "last_applied_offset",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("-1"),
        ),
        sa.Column("lease_owner", sa.String(length=255), nullable=True),
        sa.Column(
            "lease_generation",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        _updated_at(),
        sa.CheckConstraint("partition >= 0", name="ck_realtime_checkpoints_partition"),
        sa.CheckConstraint(
            "last_observed_offset >= -1 "
            "AND last_contiguously_received_offset >= -1 "
            "AND last_applied_offset >= -1",
            name="ck_realtime_checkpoints_offset_floor",
        ),
        sa.CheckConstraint(
            "last_applied_offset <= last_contiguously_received_offset "
            "AND last_contiguously_received_offset <= last_observed_offset",
            name="ck_realtime_checkpoints_contiguous_order",
        ),
        sa.CheckConstraint(
            "lease_generation >= 0",
            name="ck_realtime_checkpoints_lease_generation",
        ),
        sa.ForeignKeyConstraint(
            ["pipeline_version_id"],
            ["realtime_pipeline_versions.id"],
            name="fk_realtime_partition_checkpoints_version",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "pipeline_version_id",
            "topic",
            "partition",
            name="pk_realtime_partition_checkpoints",
        ),
    )
    op.create_index(
        "ix_realtime_partition_checkpoints_lease",
        "realtime_partition_checkpoints",
        ["lease_expires_at", "pipeline_version_id"],
    )

    op.create_table(
        "realtime_materializations",
        sa.Column("id", sa.String(length=160), nullable=False),
        sa.Column("pipeline_version_id", sa.String(length=160), nullable=False),
        sa.Column("source_boundary", _json_document(), nullable=False),
        sa.Column("source_fingerprint", sa.String(length=64), nullable=False),
        sa.Column(
            "dimension_version_ids",
            _json_document(),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column("clickhouse_query_id", sa.String(length=255), nullable=False),
        sa.Column("lease_generation", sa.BigInteger(), nullable=False),
        sa.Column("target_row_count", sa.BigInteger(), nullable=True),
        sa.Column("target_checksum", sa.String(length=128), nullable=True),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'reserved'"),
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("committed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_revision", sa.BigInteger(), nullable=True),
        sa.Column(
            "retry_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("last_error_code", sa.String(length=120), nullable=True),
        _updated_at(),
        sa.CheckConstraint(
            "target_row_count IS NULL OR target_row_count >= 0",
            name="ck_realtime_materializations_row_count",
        ),
        sa.CheckConstraint(
            "lease_generation >= 0 AND retry_count >= 0",
            name="ck_realtime_materializations_generations",
        ),
        sa.CheckConstraint(
            "status IN "
            "('reserved', 'running', 'materialized', 'published', 'failed', 'reconciling')",
            name="ck_realtime_materializations_status",
        ),
        sa.CheckConstraint(
            "status NOT IN ('materialized', 'published') OR "
            "(committed_at IS NOT NULL AND target_row_count IS NOT NULL "
            "AND target_checksum IS NOT NULL)",
            name="ck_realtime_materializations_target_evidence",
        ),
        sa.CheckConstraint(
            "status <> 'published' OR published_revision IS NOT NULL",
            name="ck_realtime_materializations_publication_evidence",
        ),
        sa.ForeignKeyConstraint(
            ["pipeline_version_id"],
            ["realtime_pipeline_versions.id"],
            name="fk_realtime_materializations_version",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_realtime_materializations"),
        sa.UniqueConstraint(
            "pipeline_version_id",
            "source_fingerprint",
            name="uq_realtime_materializations_source_fingerprint",
        ),
        sa.UniqueConstraint(
            "clickhouse_query_id",
            name="uq_realtime_materializations_clickhouse_query",
        ),
    )
    op.create_index(
        "ix_realtime_materializations_status",
        "realtime_materializations",
        ["status", "started_at"],
    )

    op.create_table(
        "realtime_partition_receipt_ranges",
        sa.Column("pipeline_version_id", sa.String(length=160), nullable=False),
        sa.Column("topic", sa.String(length=249), nullable=False),
        sa.Column("partition", sa.Integer(), nullable=False),
        sa.Column("from_offset_inclusive", sa.BigInteger(), nullable=False),
        sa.Column("to_offset_inclusive", sa.BigInteger(), nullable=False),
        sa.Column("expected_position_count", sa.BigInteger(), nullable=False),
        sa.Column("raw_position_count", sa.BigInteger(), nullable=False),
        sa.Column("expected_positions_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "raw_or_resolved_positions_hash",
            sa.String(length=64),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'verifying'"),
        ),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        _created_at(),
        _updated_at(),
        sa.CheckConstraint("partition >= 0", name="ck_realtime_receipts_partition"),
        sa.CheckConstraint(
            "from_offset_inclusive >= 0 "
            "AND to_offset_inclusive >= from_offset_inclusive",
            name="ck_realtime_receipts_offset_range",
        ),
        sa.CheckConstraint(
            "expected_position_count >= 0 AND raw_position_count >= 0 "
            "AND raw_position_count <= expected_position_count",
            name="ck_realtime_receipts_position_counts",
        ),
        sa.CheckConstraint(
            "status IN ('verifying', 'contiguous', 'blocked')",
            name="ck_realtime_receipts_status",
        ),
        sa.CheckConstraint(
            "status <> 'contiguous' OR "
            "(verified_at IS NOT NULL "
            "AND expected_positions_hash = raw_or_resolved_positions_hash)",
            name="ck_realtime_receipts_contiguous_evidence",
        ),
        sa.ForeignKeyConstraint(
            ["pipeline_version_id"],
            ["realtime_pipeline_versions.id"],
            name="fk_realtime_partition_receipts_version",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "pipeline_version_id",
            "topic",
            "partition",
            "from_offset_inclusive",
            "to_offset_inclusive",
            name="pk_realtime_partition_receipt_ranges",
        ),
    )
    op.create_index(
        "ix_realtime_partition_receipts_status",
        "realtime_partition_receipt_ranges",
        ["pipeline_version_id", "status", "topic", "partition"],
    )

    op.create_table(
        "realtime_ingest_exceptions",
        sa.Column("pipeline_version_id", sa.String(length=160), nullable=False),
        sa.Column("topic", sa.String(length=249), nullable=False),
        sa.Column("partition", sa.Integer(), nullable=False),
        sa.Column("kafka_offset", sa.BigInteger(), nullable=False),
        sa.Column("payload_hash", sa.String(length=64), nullable=False),
        sa.Column("quarantine_locator", sa.String(length=2048), nullable=True),
        sa.Column("error_code", sa.String(length=120), nullable=False),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'quarantined'"),
        ),
        sa.Column("audit_actor", sa.String(length=255), nullable=True),
        sa.Column("audit_reason", sa.Text(), nullable=True),
        sa.Column("audited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("replayed_at", sa.DateTime(timezone=True), nullable=True),
        _created_at(),
        _updated_at(),
        sa.CheckConstraint(
            "partition >= 0 AND kafka_offset >= 0",
            name="ck_realtime_ingest_exceptions_position",
        ),
        sa.CheckConstraint(
            "status IN "
            "('quarantined', 'replay_pending', 'resolved', 'audited_skip', 'source_expired')",
            name="ck_realtime_ingest_exceptions_status",
        ),
        sa.CheckConstraint(
            "status <> 'audited_skip' OR "
            "(quarantine_locator IS NOT NULL AND audit_actor IS NOT NULL "
            "AND length(trim(audit_actor)) > 0 "
            "AND audit_reason IS NOT NULL AND length(trim(audit_reason)) > 0 "
            "AND audited_at IS NOT NULL)",
            name="ck_realtime_ingest_exceptions_audited_skip",
        ),
        sa.ForeignKeyConstraint(
            ["pipeline_version_id"],
            ["realtime_pipeline_versions.id"],
            name="fk_realtime_ingest_exceptions_version",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "pipeline_version_id",
            "topic",
            "partition",
            "kafka_offset",
            name="pk_realtime_ingest_exceptions",
        ),
    )
    op.create_index(
        "ix_realtime_ingest_exceptions_status",
        "realtime_ingest_exceptions",
        ["status", "updated_at"],
    )

    op.create_table(
        "realtime_dimension_versions",
        sa.Column("id", sa.String(length=160), nullable=False),
        sa.Column(
            "scope_id",
            sa.String(length=64),
            nullable=False,
            server_default=sa.text("'deployment'"),
        ),
        sa.Column("dimension_dataset_id", sa.String(length=160), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("semantics", sa.String(length=32), nullable=False),
        sa.Column("schema_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("source_snapshot_id", sa.String(length=255), nullable=True),
        sa.Column("physical_database", sa.String(length=255), nullable=True),
        sa.Column("physical_table", sa.String(length=255), nullable=True),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'draft'"),
        ),
        sa.Column("row_count", sa.BigInteger(), nullable=True),
        sa.Column("checksum", sa.String(length=128), nullable=True),
        sa.Column("validity_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(length=255), nullable=False),
        _created_at(),
        sa.CheckConstraint(
            "scope_id = 'deployment'",
            name="ck_realtime_dimension_versions_deployment_scope",
        ),
        sa.CheckConstraint(
            "version > 0",
            name="ck_realtime_dimension_versions_version",
        ),
        sa.CheckConstraint(
            "semantics IN ('current', 'temporal')",
            name="ck_realtime_dimension_versions_semantics",
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'publishing', 'active', 'retired', 'failed')",
            name="ck_realtime_dimension_versions_status",
        ),
        sa.CheckConstraint(
            "row_count IS NULL OR row_count >= 0",
            name="ck_realtime_dimension_versions_row_count",
        ),
        sa.CheckConstraint(
            "status <> 'active' OR "
            "(physical_database IS NOT NULL AND physical_table IS NOT NULL "
            "AND published_at IS NOT NULL AND validity_checked_at IS NOT NULL)",
            name="ck_realtime_dimension_versions_active_evidence",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_realtime_dimension_versions"),
        sa.UniqueConstraint(
            "scope_id",
            "dimension_dataset_id",
            "version",
            name="uq_realtime_dimension_versions_dataset_version",
        ),
    )
    op.create_index(
        ACTIVE_DIMENSION_INDEX,
        "realtime_dimension_versions",
        ["scope_id", "dimension_dataset_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
        sqlite_where=sa.text("status = 'active'"),
    )
    op.create_index(
        "ix_realtime_dimension_versions_status",
        "realtime_dimension_versions",
        ["status", "created_at"],
    )

    op.create_table(
        "realtime_unmatched_events",
        sa.Column("pipeline_version_id", sa.String(length=160), nullable=False),
        sa.Column("serving_key", sa.String(length=64), nullable=False),
        sa.Column(
            "missing_dimension_dataset_id",
            sa.String(length=160),
            nullable=False,
        ),
        sa.Column("source_position", _json_document(), nullable=False),
        # Canonical SHA-256 of the source-position document. Serving keys can
        # repeat across Kafka offsets, so they cannot identify a repair item.
        sa.Column("source_position_hash", sa.String(length=64), nullable=False),
        sa.Column("missing_policy", sa.String(length=48), nullable=False),
        sa.Column("missing_dimension_keys", _json_document(), nullable=False),
        sa.Column("raw_payload_hash", sa.String(length=64), nullable=False),
        sa.Column("archive_locator", sa.String(length=2048), nullable=True),
        sa.Column(
            "dimension_version_ids",
            _json_document(),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "correction_generation",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("next_retry_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "retry_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column("resolved_materialization_id", sa.String(length=160), nullable=True),
        _updated_at(),
        sa.CheckConstraint(
            "missing_policy IN ('hold_and_repair', 'publish_null_then_correct')",
            name="ck_realtime_unmatched_events_missing_policy",
        ),
        sa.CheckConstraint(
            "correction_generation >= 0 AND retry_count >= 0",
            name="ck_realtime_unmatched_events_generations",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'retrying', 'resolved', 'quarantined', 'source_expired')",
            name="ck_realtime_unmatched_events_status",
        ),
        sa.ForeignKeyConstraint(
            ["pipeline_version_id"],
            ["realtime_pipeline_versions.id"],
            name="fk_realtime_unmatched_events_version",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["resolved_materialization_id"],
            ["realtime_materializations.id"],
            name="fk_realtime_unmatched_events_materialization",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint(
            "pipeline_version_id",
            "source_position_hash",
            "missing_dimension_dataset_id",
            name="pk_realtime_unmatched_events",
        ),
    )
    op.create_index(
        "ix_realtime_unmatched_events_retry",
        "realtime_unmatched_events",
        ["status", "next_retry_at"],
    )
    op.create_index(
        "ix_realtime_unmatched_events_dimension",
        "realtime_unmatched_events",
        ["missing_dimension_dataset_id", "status"],
    )
    op.create_index(
        "ix_realtime_unmatched_events_serving_key",
        "realtime_unmatched_events",
        ["pipeline_version_id", "serving_key", "status"],
    )

    op.create_table(
        "realtime_routing_assignments",
        sa.Column(
            "scope_id",
            sa.String(length=64),
            nullable=False,
            server_default=sa.text("'deployment'"),
        ),
        sa.Column("resource_type", sa.String(length=32), nullable=False),
        sa.Column("resource_id", sa.String(length=160), nullable=False),
        sa.Column("desired_engine", sa.String(length=32), nullable=False),
        sa.Column("pipeline_version_id", sa.String(length=160), nullable=True),
        sa.Column(
            "binding_epoch",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("sticky_bucket", sa.Integer(), nullable=True),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column("assignment_reason", sa.String(length=255), nullable=False),
        sa.Column("assigned_by", sa.String(length=255), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        _created_at(),
        _updated_at(),
        sa.CheckConstraint(
            "scope_id = 'deployment'",
            name="ck_realtime_routing_assignments_deployment_scope",
        ),
        sa.CheckConstraint(
            "resource_type IN ('dataset', 'dashboard')",
            name="ck_realtime_routing_assignments_resource_type",
        ),
        sa.CheckConstraint(
            "desired_engine IN ('clickhouse', 'trino')",
            name="ck_realtime_routing_assignments_engine",
        ),
        sa.CheckConstraint(
            "binding_epoch >= 0",
            name="ck_realtime_routing_assignments_binding_epoch",
        ),
        sa.CheckConstraint(
            "sticky_bucket IS NULL OR (sticky_bucket >= 0 AND sticky_bucket < 10000)",
            name="ck_realtime_routing_assignments_sticky_bucket",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'active', 'disabled')",
            name="ck_realtime_routing_assignments_status",
        ),
        sa.CheckConstraint(
            "status <> 'active' OR desired_engine <> 'clickhouse' "
            "OR pipeline_version_id IS NOT NULL",
            name="ck_realtime_routing_assignments_active_clickhouse_version",
        ),
        sa.ForeignKeyConstraint(
            ["pipeline_version_id"],
            ["realtime_pipeline_versions.id"],
            name="fk_realtime_routing_assignments_version",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint(
            "scope_id",
            "resource_type",
            "resource_id",
            name="pk_realtime_routing_assignments",
        ),
    )
    op.create_index(
        "ix_realtime_routing_assignments_engine",
        "realtime_routing_assignments",
        ["desired_engine", "status", "updated_at"],
    )


def downgrade() -> None:
    """Drop only V2 foundation objects for disposable development databases.

    Production rollback is a feature-flag/pointer operation.  This destructive
    downgrade exists so migration reversibility can be tested before release.
    """

    # Break the only circular edge before child-first table removal.  SQLite's
    # migration-test schema intentionally omits this ALTER-only FK.
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint(
            "fk_realtime_pipelines_active_version",
            "realtime_pipelines",
            type_="foreignkey",
        )
    for table_name in V2_TABLES_IN_DROP_ORDER:
        op.drop_table(table_name)
