"""Add SQL execution-tree producer metadata and dependency persistence."""

from alembic import op
import sqlalchemy as sa


revision = "0023_sql_job_execution_tree_persistence"
down_revision = "0022_remove_dashboard_job_bindings"
branch_labels = None
depends_on = None


CATALOG_PRODUCER_COLUMNS = (
    ("producer_job_id", sa.String(length=160)),
    ("producer_job_kind", sa.String(length=64)),
    ("execution_mode", sa.String(length=32)),
    ("source_kind", sa.String(length=64)),
    ("relation_mode", sa.String(length=32)),
    ("runtime_status", sa.String(length=64)),
)


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    existing_tables = set(inspector.get_table_names())

    if "catalog_datasets" in existing_tables:
        # Deployments that ran the old metadata bootstrap can already have
        # these additive columns while their Alembic row is still at 0022.
        # PostgreSQL catalog inspection can be stale inside that bootstrap
        # transaction, so use its native idempotent DDL rather than relying on
        # a preflight snapshot alone.
        if connection.dialect.name == "postgresql":
            for column_name, column_type in CATALOG_PRODUCER_COLUMNS:
                type_sql = connection.dialect.type_compiler.process(column_type)
                op.execute(sa.text(
                    f"ALTER TABLE catalog_datasets ADD COLUMN IF NOT EXISTS {column_name} {type_sql}"
                ))
            op.execute(sa.text(
                "CREATE INDEX IF NOT EXISTS ix_catalog_datasets_producer_job_id "
                "ON catalog_datasets (producer_job_id)"
            ))
        else:
            _upgrade_catalog_producer_columns(connection)

    if "continuous_sql_dependencies" not in existing_tables:
        op.create_table(
            "continuous_sql_dependencies",
            sa.Column("sql_job_id", sa.String(length=160), nullable=False),
            sa.Column("input_dataset_id", sa.String(length=160), nullable=False),
            sa.Column("child_job_id", sa.String(length=160), nullable=True),
            sa.Column("input_type", sa.String(length=32), nullable=False),
            sa.Column("execution_policy", sa.String(length=32), nullable=False),
            sa.Column("required", sa.Boolean(), nullable=False, server_default=sa.true()),
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
            sa.ForeignKeyConstraint(
                ["sql_job_id"],
                ["continuous_sql_jobs.id"],
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("sql_job_id", "input_dataset_id"),
            sa.CheckConstraint(
                "input_type IN ('realtime', 'batch', 'static')",
                name="ck_continuous_sql_dependency_input_type",
            ),
            sa.CheckConstraint(
                "execution_policy IN ('run_on_tree_start', 'reuse_snapshot')",
                name="ck_continuous_sql_dependency_execution_policy",
            ),
            sa.CheckConstraint(
                "(child_job_id IS NULL AND input_type = 'static' AND execution_policy = 'reuse_snapshot') "
                "OR (child_job_id IS NOT NULL AND execution_policy = 'run_on_tree_start')",
                name="ck_continuous_sql_dependency_owner",
            ),
            sa.UniqueConstraint(
                "sql_job_id",
                "input_dataset_id",
                name="uq_continuous_sql_dependency_input",
            ),
        )
        op.create_index(
            "ix_continuous_sql_dependencies_child_job_id",
            "continuous_sql_dependencies",
            ["child_job_id"],
        )
        op.create_index(
            "ix_continuous_sql_dependencies_child_job",
            "continuous_sql_dependencies",
            ["child_job_id", "input_type"],
        )


def _upgrade_catalog_producer_columns(connection) -> None:
    """SQLite/test fallback; PostgreSQL uses ADD COLUMN IF NOT EXISTS."""
    existing_columns = {
        column["name"] for column in sa.inspect(connection).get_columns("catalog_datasets")
    }
    for column_name, column_type in CATALOG_PRODUCER_COLUMNS:
        if column_name not in existing_columns:
            op.add_column(
                "catalog_datasets",
                sa.Column(column_name, column_type, nullable=True),
            )
    existing_indexes = {
        index["name"] for index in sa.inspect(connection).get_indexes("catalog_datasets")
    }
    if "ix_catalog_datasets_producer_job_id" not in existing_indexes:
        op.create_index(
            "ix_catalog_datasets_producer_job_id",
            "catalog_datasets",
            ["producer_job_id"],
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    existing_tables = set(inspector.get_table_names())

    if "continuous_sql_dependencies" in existing_tables:
        op.drop_table("continuous_sql_dependencies")

    if "catalog_datasets" not in existing_tables:
        return
    existing_indexes = {
        index["name"] for index in sa.inspect(connection).get_indexes("catalog_datasets")
    }
    if "ix_catalog_datasets_producer_job_id" in existing_indexes:
        op.drop_index(
            "ix_catalog_datasets_producer_job_id",
            table_name="catalog_datasets",
        )
    existing_columns = {
        column["name"] for column in sa.inspect(connection).get_columns("catalog_datasets")
    }
    for column_name, _ in reversed(CATALOG_PRODUCER_COLUMNS):
        if column_name in existing_columns:
            op.drop_column("catalog_datasets", column_name)
