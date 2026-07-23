"""Store immutable Iceberg snapshot identity for each Dataset revision."""

from alembic import op
import sqlalchemy as sa


revision = "0025_dataset_revision_snapshot_identity"
down_revision = "0024_sql_execution_tree_locking"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "dataset_revision_commits" not in set(inspector.get_table_names()):
        return
    columns = {item["name"] for item in inspector.get_columns("dataset_revision_commits")}
    if "snapshot_id" not in columns:
        op.add_column(
            "dataset_revision_commits",
            sa.Column("snapshot_id", sa.String(length=255), nullable=True),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "dataset_revision_commits" not in set(inspector.get_table_names()):
        return
    columns = {item["name"] for item in inspector.get_columns("dataset_revision_commits")}
    if "snapshot_id" in columns:
        with op.batch_alter_table("dataset_revision_commits") as batch:
            batch.drop_column("snapshot_id")
