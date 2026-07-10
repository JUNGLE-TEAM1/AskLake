from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    TextStructuringEvaluationModel,
    TextStructuringModelModel,
    TextStructuringReviewItemModel,
    TextStructuringSpecModel,
    TextStructuringSpecVersionModel,
    TextStructuringTrainingRunModel,
)

_schema_ready_bind_ids: set[int] = set()


def ensure_text_structuring_schema(db: Session) -> None:
    bind = db.get_bind()
    bind_key = id(bind)
    if bind_key in _schema_ready_bind_ids:
        return
    tables = [
        TextStructuringSpecModel.__table__,
        TextStructuringSpecVersionModel.__table__,
        TextStructuringReviewItemModel.__table__,
        TextStructuringTrainingRunModel.__table__,
        TextStructuringModelModel.__table__,
        TextStructuringEvaluationModel.__table__,
    ]
    TextStructuringSpecModel.metadata.create_all(bind=bind, tables=tables)
    _schema_ready_bind_ids.add(bind_key)


class TextStructuringRepository:
    def __init__(self, db: Session):
        self.db = db
        ensure_text_structuring_schema(db)

    def create_spec(
        self,
        spec: TextStructuringSpecModel,
        version: TextStructuringSpecVersionModel,
    ) -> tuple[TextStructuringSpecModel, TextStructuringSpecVersionModel]:
        self.db.add(spec)
        self.db.add(version)
        self.db.commit()
        self.db.refresh(spec)
        self.db.refresh(version)
        return spec, version

    def list_specs(self, owner: str | None = None) -> list[TextStructuringSpecModel]:
        statement = select(TextStructuringSpecModel).order_by(TextStructuringSpecModel.updated_at.desc())
        if owner:
            statement = statement.where(TextStructuringSpecModel.owner == owner)
        return list(self.db.scalars(statement).all())

    def get_spec(self, spec_id: str) -> TextStructuringSpecModel | None:
        return self.db.get(TextStructuringSpecModel, spec_id)

    def list_versions(self, spec_id: str) -> list[TextStructuringSpecVersionModel]:
        statement = (
            select(TextStructuringSpecVersionModel)
            .where(TextStructuringSpecVersionModel.spec_id == spec_id)
            .order_by(TextStructuringSpecVersionModel.version.desc())
        )
        return list(self.db.scalars(statement).all())

    def get_version(self, spec_id: str, version: int) -> TextStructuringSpecVersionModel | None:
        return self.db.scalar(
            select(TextStructuringSpecVersionModel).where(
                TextStructuringSpecVersionModel.spec_id == spec_id,
                TextStructuringSpecVersionModel.version == version,
            )
        )

    def add_version(
        self,
        spec: TextStructuringSpecModel,
        version: TextStructuringSpecVersionModel,
    ) -> TextStructuringSpecVersionModel:
        self.db.add(version)
        self.db.add(spec)
        self.db.commit()
        self.db.refresh(version)
        self.db.refresh(spec)
        return version

    def publish_version(
        self,
        spec: TextStructuringSpecModel,
        version: TextStructuringSpecVersionModel,
        published_at: str,
    ) -> TextStructuringSpecVersionModel:
        version.status = "published"
        version.published_at = published_at
        spec.active_version = version.version
        spec.status = "published"
        self.db.add_all([spec, version])
        self.db.commit()
        self.db.refresh(spec)
        self.db.refresh(version)
        return version

    def upsert_review_items(self, items: Iterable[TextStructuringReviewItemModel]) -> None:
        for item in items:
            existing = self.db.get(TextStructuringReviewItemModel, item.id)
            if existing is None:
                self.db.add(item)
                continue
            existing.input_snapshot = item.input_snapshot
            existing.prediction = item.prediction
            existing.reasons = item.reasons
            existing.route = item.route
            existing.confidence = item.confidence
            if existing.status == "pending":
                existing.source_hash = item.source_hash
        self.db.commit()

    def list_review_items(
        self,
        spec_id: str,
        status: str | None = None,
        limit: int = 100,
    ) -> list[TextStructuringReviewItemModel]:
        statement = select(TextStructuringReviewItemModel).where(
            TextStructuringReviewItemModel.spec_id == spec_id
        )
        if status:
            statement = statement.where(TextStructuringReviewItemModel.status == status)
        statement = statement.order_by(TextStructuringReviewItemModel.created_at.desc()).limit(limit)
        return list(self.db.scalars(statement).all())

    def get_review_item(self, item_id: str) -> TextStructuringReviewItemModel | None:
        return self.db.get(TextStructuringReviewItemModel, item_id)

    def save_review_item(self, item: TextStructuringReviewItemModel) -> TextStructuringReviewItemModel:
        self.db.add(item)
        self.db.commit()
        self.db.refresh(item)
        return item

    def reviewed_items(self, spec_id: str, version: int) -> list[TextStructuringReviewItemModel]:
        return list(
            self.db.scalars(
                select(TextStructuringReviewItemModel).where(
                    TextStructuringReviewItemModel.spec_id == spec_id,
                    TextStructuringReviewItemModel.spec_version == version,
                    TextStructuringReviewItemModel.status.in_(["accepted", "corrected"]),
                )
            ).all()
        )

    def create_training_run(self, run: TextStructuringTrainingRunModel) -> TextStructuringTrainingRunModel:
        self.db.add(run)
        self.db.commit()
        self.db.refresh(run)
        return run

    def save_training_run(self, run: TextStructuringTrainingRunModel) -> TextStructuringTrainingRunModel:
        self.db.add(run)
        self.db.commit()
        self.db.refresh(run)
        return run

    def create_model(self, model: TextStructuringModelModel) -> TextStructuringModelModel:
        self.db.add(model)
        self.db.commit()
        self.db.refresh(model)
        return model

    def get_model(self, model_id: str) -> TextStructuringModelModel | None:
        return self.db.get(TextStructuringModelModel, model_id)

    def list_models(self, spec_id: str) -> list[TextStructuringModelModel]:
        return list(
            self.db.scalars(
                select(TextStructuringModelModel)
                .where(TextStructuringModelModel.spec_id == spec_id)
                .order_by(TextStructuringModelModel.created_at.desc())
            ).all()
        )

    def get_champion_model(self, spec_id: str, version: int) -> TextStructuringModelModel | None:
        return self.db.scalar(
            select(TextStructuringModelModel).where(
                TextStructuringModelModel.spec_id == spec_id,
                TextStructuringModelModel.spec_version == version,
                TextStructuringModelModel.status == "champion",
            )
        )

    def promote_model(self, model: TextStructuringModelModel) -> TextStructuringModelModel:
        current = self.db.scalars(
            select(TextStructuringModelModel).where(
                TextStructuringModelModel.spec_id == model.spec_id,
                TextStructuringModelModel.status == "champion",
            )
        ).all()
        for item in current:
            item.status = "retired"
            self.db.add(item)
        model.status = "champion"
        self.db.add(model)
        self.db.commit()
        self.db.refresh(model)
        return model
