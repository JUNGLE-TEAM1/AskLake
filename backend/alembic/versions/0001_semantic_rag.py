"""semantic model and rag metadata foundation"""

from alembic import context, op
import sqlalchemy as sa

from app.models.semantic_rag import (
    RagClassificationRunModel, RagColumnRecommendationModel, RagDatasetProfileModel, RagIndexJobModel, RagIndexManifestModel,
    SemanticDimensionModel, SemanticMetricModel, SemanticModelDatasetModel, SemanticModelModel, SemanticModelVersionModel, SemanticRelationshipModel, SemanticVocabularyModel,
)

revision = "0001_semantic_rag"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if not context.is_offline_mode():
        inspector = sa.inspect(bind)
        if "catalog_datasets" in inspector.get_table_names() and "source_manifest" not in {column["name"] for column in inspector.get_columns("catalog_datasets")}: 
            op.add_column("catalog_datasets", sa.Column("source_manifest", sa.JSON(), nullable=True))
    tables = [SemanticModelModel.__table__, SemanticModelVersionModel.__table__, SemanticModelDatasetModel.__table__, SemanticMetricModel.__table__, SemanticDimensionModel.__table__, SemanticRelationshipModel.__table__, SemanticVocabularyModel.__table__, RagDatasetProfileModel.__table__, RagClassificationRunModel.__table__, RagColumnRecommendationModel.__table__, RagIndexJobModel.__table__, RagIndexManifestModel.__table__]
    for table in tables:
        table.create(bind=bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in [RagIndexManifestModel.__table__, RagIndexJobModel.__table__, RagColumnRecommendationModel.__table__, RagClassificationRunModel.__table__, RagDatasetProfileModel.__table__, SemanticVocabularyModel.__table__, SemanticRelationshipModel.__table__, SemanticDimensionModel.__table__, SemanticMetricModel.__table__, SemanticModelDatasetModel.__table__, SemanticModelVersionModel.__table__, SemanticModelModel.__table__]:
        table.drop(bind=bind, checkfirst=True)
