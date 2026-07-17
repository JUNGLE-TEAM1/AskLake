"""Harden RAG request snapshots and active-manifest fencing."""

from datetime import datetime, timezone

from alembic import context, op
import sqlalchemy as sa


revision = "0015_rag_control_plane_fencing"
down_revision = "0014_rag_embedding_provider"
branch_labels = None
depends_on = None


ACTIVE_MANIFEST_INDEX = "uq_rag_index_manifests_one_active_per_dataset"


def _add_if_missing(table: str, column: sa.Column) -> None:
    bind = op.get_bind()
    if context.is_offline_mode():
        op.add_column(table, column)
        return
    existing = {item["name"] for item in sa.inspect(bind).get_columns(table)}
    if column.name not in existing:
        op.add_column(table, column)


def _retire_duplicate_active_manifests() -> None:
    if context.is_offline_mode():
        return
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT id, dataset_id
            FROM rag_index_manifests
            WHERE status = 'active'
            ORDER BY dataset_id,
                     generation DESC,
                     COALESCE(activated_at, created_at) DESC,
                     id DESC
            """
        )
    ).mappings()
    seen: set[str] = set()
    retired_at = datetime.now(timezone.utc)
    for row in rows:
        dataset_id = str(row["dataset_id"])
        if dataset_id not in seen:
            seen.add(dataset_id)
            continue
        bind.execute(
            sa.text(
                """
                UPDATE rag_index_manifests
                SET status = 'retired', retired_at = COALESCE(retired_at, :retired_at)
                WHERE id = :manifest_id AND status = 'active'
                """
            ),
            {"manifest_id": row["id"], "retired_at": retired_at},
        )


def _create_active_manifest_index() -> None:
    bind = op.get_bind()
    if not context.is_offline_mode():
        existing = {item["name"] for item in sa.inspect(bind).get_indexes("rag_index_manifests")}
        if ACTIVE_MANIFEST_INDEX in existing:
            return
    op.create_index(
        ACTIVE_MANIFEST_INDEX,
        "rag_index_manifests",
        ["dataset_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
        sqlite_where=sa.text("status = 'active'"),
    )


def upgrade() -> None:
    for column in (
        sa.Column("request_fingerprint", sa.String(128), nullable=True),
        sa.Column("embedding_provider_snapshot", sa.String(100), nullable=True),
        sa.Column("body_columns", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("title_columns", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("identifier_columns", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("contract_versions", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    ):
        _add_if_missing("rag_index_jobs", column)
    for column in (
        sa.Column("body_columns", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("title_columns", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("identifier_columns", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("contract_versions", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    ):
        _add_if_missing("rag_index_manifests", column)
    _retire_duplicate_active_manifests()
    _create_active_manifest_index()


def downgrade() -> None:
    if context.is_offline_mode() or ACTIVE_MANIFEST_INDEX in {
        item["name"] for item in sa.inspect(op.get_bind()).get_indexes("rag_index_manifests")
    }:
        op.drop_index(ACTIVE_MANIFEST_INDEX, table_name="rag_index_manifests")
    for table, names in (
        (
            "rag_index_manifests",
            ("contract_versions", "identifier_columns", "title_columns", "body_columns"),
        ),
        (
            "rag_index_jobs",
            (
                "contract_versions",
                "identifier_columns",
                "title_columns",
                "body_columns",
                "embedding_provider_snapshot",
                "request_fingerprint",
            ),
        ),
    ):
        for name in names:
            op.drop_column(table, name)
