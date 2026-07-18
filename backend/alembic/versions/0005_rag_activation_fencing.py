"""Persist RAG activation fencing and physical validation evidence."""

from alembic import context, op
import sqlalchemy as sa


revision = "0005_rag_activation_fencing"
down_revision = "0004_rag_validation_contract"
branch_labels = None
depends_on = None


def _add_if_missing(table: str, name: str, column: sa.Column) -> None:
    bind = op.get_bind()
    if context.is_offline_mode():
        op.add_column(table, column)
        return
    existing = {item["name"] for item in sa.inspect(bind).get_columns(table)}
    if name not in existing:
        op.add_column(table, column)


def upgrade() -> None:
    for name, column in (
        ("approved_schema_fingerprint", sa.Column("approved_schema_fingerprint", sa.String(length=128), nullable=True)),
        ("approved_definition_fingerprint", sa.Column("approved_definition_fingerprint", sa.String(length=128), nullable=True)),
        ("desired_generation", sa.Column("desired_generation", sa.Integer(), nullable=False, server_default="0")),
    ):
        _add_if_missing("rag_dataset_profiles", name, column)
    for name, column in (
        ("generation", sa.Column("generation", sa.Integer(), nullable=False, server_default="0")),
        ("validation_status", sa.Column("validation_status", sa.String(length=32), nullable=False, server_default="pending")),
        ("validated_at", sa.Column("validated_at", sa.DateTime(timezone=True), nullable=True)),
        ("validated_index", sa.Column("validated_index", sa.String(length=255), nullable=True)),
        ("validated_document_count", sa.Column("validated_document_count", sa.Integer(), nullable=True)),
        ("validated_parent_count", sa.Column("validated_parent_count", sa.Integer(), nullable=True)),
        ("validated_dimensions", sa.Column("validated_dimensions", sa.Integer(), nullable=True)),
        ("validation_evidence_hash", sa.Column("validation_evidence_hash", sa.String(length=128), nullable=True)),
    ):
        _add_if_missing("rag_index_jobs", name, column)
    _add_if_missing("rag_index_manifests", "generation", sa.Column("generation", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    for table, name in (
        ("rag_index_manifests", "generation"),
        ("rag_index_jobs", "validation_evidence_hash"),
        ("rag_index_jobs", "validated_dimensions"),
        ("rag_index_jobs", "validated_parent_count"),
        ("rag_index_jobs", "validated_document_count"),
        ("rag_index_jobs", "validated_index"),
        ("rag_index_jobs", "validated_at"),
        ("rag_index_jobs", "validation_status"),
        ("rag_index_jobs", "generation"),
        ("rag_dataset_profiles", "desired_generation"),
        ("rag_dataset_profiles", "approved_schema_fingerprint"),
        ("rag_dataset_profiles", "approved_definition_fingerprint"),
    ):
        op.drop_column(table, name)
