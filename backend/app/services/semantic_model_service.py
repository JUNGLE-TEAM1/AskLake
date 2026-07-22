from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import status
from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, permissions_for_actor, require_permission
from app.core.errors import ApiError
from app.models.semantic_rag import (
    SemanticDimensionModel,
    SemanticMetricModel,
    SemanticModelDatasetModel,
    SemanticModelModel,
    SemanticModelVersionModel,
    SemanticRelationshipModel,
    SemanticVocabularyModel,
)
from app.repositories.permission_repository import list_permission_grants_by_resource, replace_permission_ui_grants
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.permissions import PermissionGrant
from app.schemas.semantic import (
    SemanticModelCreate,
    SemanticModelPatch,
    SemanticModelResponse,
    SemanticPublishResponse,
    SemanticValidationResponse,
)
from app.services.resource_permission_service import permission_grants_for_resource
from app.services.catalog_schema import dataset_schema, sample_values, schema_fingerprint, schema_names


SEMANTIC_TABLES = [
    SemanticModelModel.__table__, SemanticModelVersionModel.__table__, SemanticModelDatasetModel.__table__,
    SemanticMetricModel.__table__, SemanticDimensionModel.__table__, SemanticRelationshipModel.__table__,
    SemanticVocabularyModel.__table__,
]


def ensure_semantic_schema(db: Session) -> None:
    """Compatibility bootstrap; Alembic remains the deployment source of truth."""
    from app.models.base import Base
    Base.metadata.create_all(bind=db.get_bind(), tables=SEMANTIC_TABLES)


class SemanticModelService:
    def __init__(self, db: Session) -> None:
        self.db = db
        ensure_semantic_schema(db)

    def list_models(self, actor: ActorContext) -> list[SemanticModelResponse]:
        rows = self.db.scalars(select(SemanticModelModel).order_by(SemanticModelModel.updated_at.desc())).all()
        return [self._to_response(row, actor, enforce=False) for row in rows if self._can_view(row, actor)]

    def get(self, model_id: str, actor: ActorContext, *, enforce: bool = True) -> SemanticModelResponse:
        row = self.db.get(SemanticModelModel, model_id)
        if row is None:
            raise ApiError("not_found", f"Semantic model {model_id} was not found", status.HTTP_404_NOT_FOUND)
        if enforce:
            self._require(row, actor, "view")
        return self._to_response(row, actor, enforce=enforce)

    def published_query_model(self, model_id: str, actor: ActorContext) -> dict[str, Any] | None:
        """Return the compact, query-authorized provenance contract for one model."""
        row = self.db.get(SemanticModelModel, model_id)
        if row is None or row.status != "published" or not self._has(row, actor, "query"):
            return None
        return self._query_model_info(row)

    def published_query_models_for_datasets(
        self,
        dataset_ids: list[str],
        actor: ActorContext,
    ) -> list[dict[str, Any]]:
        """Resolve published semantic models that can be used for RAG retrieval.

        This is deliberately a query-permission check, not a view check.  A
        model can be visible in the UI while its underlying retrieval contract
        is not available to the current actor.
        """
        normalized_dataset_ids = list(dict.fromkeys(str(item) for item in dataset_ids if str(item).strip()))
        if not normalized_dataset_ids:
            return []
        rows = self.db.scalars(
            select(SemanticModelModel)
            .join(SemanticModelDatasetModel, SemanticModelDatasetModel.model_id == SemanticModelModel.id)
            .where(
                SemanticModelModel.status == "published",
                SemanticModelDatasetModel.dataset_id.in_(normalized_dataset_ids),
            )
            .order_by(SemanticModelModel.updated_at.desc())
        ).unique().all()
        return [self._query_model_info(row) for row in rows if self._has(row, actor, "query")]

    def create(self, request: SemanticModelCreate, actor: ActorContext) -> SemanticModelResponse:
        model_id = f"sm_{uuid4().hex}"
        model = SemanticModelModel(
            id=model_id, name=request.name, description=request.description, owner=actor.name,
            status="draft", grants=[grant.model_dump(by_alias=True) for grant in request.permission_grants],
        )
        self.db.add(model)
        self._replace_children(model_id, request)
        version = self._create_version(model_id, 1, request)
        self.db.flush()
        if request.permission_grants:
            replace_permission_ui_grants(self.db, resource_type="semantic_model", resource_id=model_id, grants=request.permission_grants, created_by=actor.name)
        self.db.commit()
        self.db.refresh(model)
        return self._to_response(model, actor, enforce=False)

    def update(self, model_id: str, request: SemanticModelPatch, actor: ActorContext) -> SemanticModelResponse:
        model = self._model(model_id)
        self._require(model, actor, "manage")
        if request.name is not None:
            model.name = request.name
        if request.description is not None:
            model.description = request.description
        if model.status == "published":
            model.status = "draft"
        self.db.commit()
        return self._to_response(model, actor, enforce=False)

    def replace_collection(self, model_id: str, kind: str, items: list[Any], actor: ActorContext) -> SemanticModelResponse:
        model = self._model(model_id)
        self._require(model, actor, "manage")
        current = self._definition_request(model_id)
        update = current.model_copy(update={kind: items})
        self._replace_children(model_id, update, only=kind)
        if model.status == "published":
            model.status = "draft"
        self._create_version(model_id, self._next_version(model_id), update)
        self.db.commit()
        return self._to_response(model, actor, enforce=False)

    def validate(self, model_id: str, actor: ActorContext) -> SemanticValidationResponse:
        model = self._model(model_id)
        self._require(model, actor, "view")
        errors: list[str] = []
        warnings: list[str] = []
        datasets = self.db.scalars(select(SemanticModelDatasetModel).where(SemanticModelDatasetModel.model_id == model_id)).all()
        metrics = self.db.scalars(select(SemanticMetricModel).where(SemanticMetricModel.model_id == model_id)).all()
        dimensions = self.db.scalars(select(SemanticDimensionModel).where(SemanticDimensionModel.model_id == model_id)).all()
        if not datasets:
            errors.append("At least one Catalog Dataset must be connected")
        if not metrics and not dimensions:
            warnings.append("No metric or dimension is defined yet")
        dataset_ids = {item.dataset_id for item in datasets}
        catalog_available = self._catalog_table_available()
        if dataset_ids and not catalog_available:
            warnings.append("Catalog schema validation is unavailable because the Catalog table is not initialized")
        for item in [*metrics, *dimensions]:
            if item.dataset_id and item.dataset_id not in dataset_ids:
                errors.append(f"Definition {item.name} references an unconnected Dataset")
            if item.dataset_id and item.dataset_id in dataset_ids and catalog_available:
                catalog_dataset = CatalogRepository(self.db).get_dataset_payload(item.dataset_id)
                if catalog_dataset is None:
                    errors.append(f"Definition {item.name} references a missing Catalog Dataset")
                    continue
                available_columns = set(schema_names(catalog_dataset))
                selected_columns = list(getattr(item, "source_columns", None) or []) if isinstance(item, SemanticMetricModel) else [str(item.column_name)]
                missing_columns = [column for column in selected_columns if column and column not in available_columns]
                if missing_columns:
                    errors.append(f"Definition {item.name} references missing schema column(s): {', '.join(missing_columns)}")
        return SemanticValidationResponse(valid=not errors, errors=errors, warnings=warnings)

    def publish(self, model_id: str, actor: ActorContext) -> SemanticPublishResponse:
        model = self._model(model_id)
        self._require(model, actor, "publish")
        validation = self.validate(model_id, actor)
        if not validation.valid:
            raise ApiError("validation_error", "; ".join(validation.errors), status.HTTP_400_BAD_REQUEST)
        version = self._next_version(model_id)
        latest = self.db.scalar(select(SemanticModelVersionModel).where(SemanticModelVersionModel.model_id == model_id).order_by(SemanticModelVersionModel.version.desc()))
        if latest is not None and latest.version == version:
            latest.status = "published"
            latest.published_at = datetime.now(timezone.utc)
            latest.published_by = actor.name
        else:
            definition = self._definition_request(model_id)
            self._create_version(model_id, version, definition, status_value="published", published_by=actor.name)
        model.status = "published"
        model.published_version = version
        self.db.commit()
        return SemanticPublishResponse(model=self._to_response(model, actor, enforce=False), published_version=version)

    def rollback(self, model_id: str, version: int, actor: ActorContext) -> SemanticModelResponse:
        model = self._model(model_id)
        self._require(model, actor, "publish")
        target = self.db.scalar(select(SemanticModelVersionModel).where(SemanticModelVersionModel.model_id == model_id, SemanticModelVersionModel.version == version))
        if target is None:
            raise ApiError("not_found", f"Semantic model version {version} was not found", status.HTTP_404_NOT_FOUND)
        model.published_version = version
        model.status = "published"
        self.db.commit()
        return self._to_response(model, actor, enforce=False)

    def versions(self, model_id: str, actor: ActorContext) -> list[dict[str, Any]]:
        model = self._model(model_id)
        self._require(model, actor, "view")
        rows = self.db.scalars(select(SemanticModelVersionModel).where(SemanticModelVersionModel.model_id == model_id).order_by(SemanticModelVersionModel.version.desc())).all()
        return [{"id": row.id, "version": row.version, "status": row.status, "publishedAt": row.published_at, "publishedBy": row.published_by} for row in rows]

    def _model(self, model_id: str) -> SemanticModelModel:
        row = self.db.get(SemanticModelModel, model_id)
        if row is None:
            raise ApiError("not_found", f"Semantic model {model_id} was not found", status.HTTP_404_NOT_FOUND)
        return row

    def _can_view(self, row: SemanticModelModel, actor: ActorContext) -> bool:
        return self._has(row, actor, "view") or self._has(row, actor, "query") or self._has(row, actor, "publish")

    def _require(self, row: SemanticModelModel, actor: ActorContext, action: str) -> None:
        grants = permission_grants_for_resource(self.db, "semantic_model", row.id, self._parse_grants(row.grants))
        require_permission(actor, action, owner=row.owner, grants=grants, resource_label="semantic model")

    def _has(self, row: SemanticModelModel, actor: ActorContext, action: str) -> bool:
        try:
            self._require(row, actor, action)
            return True
        except ApiError:
            return False

    def _to_response(self, row: SemanticModelModel, actor: ActorContext, *, enforce: bool) -> SemanticModelResponse:
        grants = permission_grants_for_resource(self.db, "semantic_model", row.id, self._parse_grants(row.grants))
        permissions = permissions_for_actor(actor, owner=row.owner, grants=[grant.model_dump(by_alias=True) for grant in grants], enforced=True)
        datasets = self.db.scalars(select(SemanticModelDatasetModel).where(SemanticModelDatasetModel.model_id == row.id).order_by(SemanticModelDatasetModel.created_at.asc())).all()
        metrics = self.db.scalars(select(SemanticMetricModel).where(SemanticMetricModel.model_id == row.id).order_by(SemanticMetricModel.created_at.asc())).all()
        dimensions = self.db.scalars(select(SemanticDimensionModel).where(SemanticDimensionModel.model_id == row.id).order_by(SemanticDimensionModel.created_at.asc())).all()
        relationships = self.db.scalars(select(SemanticRelationshipModel).where(SemanticRelationshipModel.model_id == row.id).order_by(SemanticRelationshipModel.created_at.asc())).all()
        vocabulary = self.db.scalars(select(SemanticVocabularyModel).where(SemanticVocabularyModel.model_id == row.id).order_by(SemanticVocabularyModel.created_at.asc())).all()
        return SemanticModelResponse(
            id=row.id, name=row.name, description=row.description, owner=row.owner, status=row.status,
            version=self._next_version(row.id), published_version=row.published_version,
            permission_grants=grants, permissions=permissions,
            datasets=[self._dataset_item(item) for item in datasets],
            metrics=[self._item(item) for item in metrics], dimensions=[self._item(item) for item in dimensions],
            relationships=[self._item(item) for item in relationships], vocabulary=[self._item(item) for item in vocabulary],
        )

    def _query_model_info(self, row: SemanticModelModel) -> dict[str, Any]:
        datasets = self.db.scalars(
            select(SemanticModelDatasetModel)
            .where(SemanticModelDatasetModel.model_id == row.id)
            .order_by(SemanticModelDatasetModel.created_at.asc())
        ).all()
        metrics = self.db.scalars(
            select(SemanticMetricModel)
            .where(SemanticMetricModel.model_id == row.id)
            .order_by(SemanticMetricModel.created_at.asc())
        ).all()
        dimensions = self.db.scalars(
            select(SemanticDimensionModel)
            .where(SemanticDimensionModel.model_id == row.id)
            .order_by(SemanticDimensionModel.created_at.asc())
        ).all()
        relationships = self.db.scalars(
            select(SemanticRelationshipModel)
            .where(SemanticRelationshipModel.model_id == row.id)
            .order_by(SemanticRelationshipModel.created_at.asc())
        ).all()
        vocabulary = self.db.scalars(
            select(SemanticVocabularyModel)
            .where(SemanticVocabularyModel.model_id == row.id)
            .order_by(SemanticVocabularyModel.created_at.asc())
        ).all()
        return {
            "id": row.id,
            "name": row.name,
            "version": row.published_version,
            "status": row.status,
            "datasetIds": [item.dataset_id for item in datasets],
            "metrics": [
                {
                    "name": item.name,
                    "label": item.label,
                    "description": item.description,
                    "expression": item.expression,
                    "datasetId": item.dataset_id,
                    "sourceColumns": item.source_columns or [],
                    "format": item.format,
                }
                for item in metrics
            ],
            "dimensions": [
                {
                    "name": item.name,
                    "label": item.label,
                    "description": item.description,
                    "columnName": item.column_name,
                    "datasetId": item.dataset_id,
                    "dataType": item.data_type,
                }
                for item in dimensions
            ],
            "relationships": [
                {
                    "fromDatasetId": item.from_dataset_id,
                    "toDatasetId": item.to_dataset_id,
                    "relationshipType": item.relationship_type,
                    "joinExpression": item.join_expression,
                }
                for item in relationships
            ],
            "vocabulary": [
                {"term": item.term, "synonyms": item.synonyms or []}
                for item in vocabulary
            ],
        }

    @staticmethod
    def _item(item: Any) -> dict[str, Any]:
        values = {key: getattr(item, key) for key in ("id", "name", "label", "description", "expression", "dataset_id", "source_columns", "column_name", "data_type", "format", "from_dataset_id", "to_dataset_id", "relationship_type", "join_expression", "term", "synonyms") if hasattr(item, key)}
        return values

    def _dataset_item(self, item: SemanticModelDatasetModel) -> dict[str, Any]:
        dataset = self._catalog_payload(item.dataset_id) or {}
        schema = dataset_schema(dataset)
        return {
            "id": item.id,
            "datasetId": item.dataset_id,
            "role": item.role,
            "joinConfig": item.join_config or {},
            "name": dataset.get("name") or item.dataset_id,
            "description": dataset.get("description") or "",
            "layer": dataset.get("layer"),
            "rows": dataset.get("rows"),
            "schema": [{**column, "sampleValues": sample_values(dataset, column["name"])} for column in schema],
            "schemaFingerprint": schema_fingerprint(dataset) if dataset else None,
        }

    def _catalog_table_available(self) -> bool:
        try:
            return "catalog_datasets" in inspect(self.db.get_bind()).get_table_names()
        except Exception:
            return False

    def _catalog_payload(self, dataset_id: str) -> dict[str, Any] | None:
        if not self._catalog_table_available():
            return None
        try:
            return CatalogRepository(self.db).get_dataset_payload(dataset_id)
        except Exception:
            return None

    def _replace_children(self, model_id: str, request: SemanticModelCreate, *, only: str | None = None) -> None:
        mapping = {
            "datasets": (SemanticModelDatasetModel, request.datasets, lambda item: dict(id=f"smd_{uuid4().hex}", model_id=model_id, dataset_id=item.dataset_id, role=item.role, join_config=item.join_config)),
            "metrics": (SemanticMetricModel, request.metrics, lambda item: dict(id=f"smm_{uuid4().hex}", model_id=model_id, **item.model_dump())),
            "dimensions": (SemanticDimensionModel, request.dimensions, lambda item: dict(id=f"smdim_{uuid4().hex}", model_id=model_id, **item.model_dump())),
            "relationships": (SemanticRelationshipModel, request.relationships, lambda item: dict(id=f"smr_{uuid4().hex}", model_id=model_id, **item.model_dump())),
            "vocabulary": (SemanticVocabularyModel, request.vocabulary, lambda item: dict(id=f"smv_{uuid4().hex}", model_id=model_id, **item.model_dump())),
        }
        for kind, (table, items, factory) in mapping.items():
            if only is not None and kind != only:
                continue
            if only is not None:
                for row in self.db.scalars(select(table).where(table.model_id == model_id)).all():
                    self.db.delete(row)
                # Flush deletes before replacement inserts so the unique
                # model/dataset constraint cannot be hit during autoflush.
                self.db.flush()
            self.db.add_all([table(**factory(item)) for item in items])

    def _create_version(self, model_id: str, version: int, request: SemanticModelCreate, *, status_value: str = "draft", published_by: str | None = None) -> SemanticModelVersionModel:
        definition = {"datasets": [item.model_dump() for item in request.datasets], "metrics": [item.model_dump() for item in request.metrics], "dimensions": [item.model_dump() for item in request.dimensions], "relationships": [item.model_dump() for item in request.relationships], "vocabulary": [item.model_dump() for item in request.vocabulary]}
        row = SemanticModelVersionModel(id=f"smv_{uuid4().hex}", model_id=model_id, version=version, status=status_value, definition=definition, published_at=datetime.now(timezone.utc) if status_value == "published" else None, published_by=published_by)
        self.db.add(row)
        return row

    def _next_version(self, model_id: str) -> int:
        latest = self.db.scalar(select(SemanticModelVersionModel).where(SemanticModelVersionModel.model_id == model_id).order_by(SemanticModelVersionModel.version.desc()))
        return (latest.version + 1) if latest else 1

    def _definition_request(self, model_id: str) -> SemanticModelCreate:
        datasets = self.db.scalars(select(SemanticModelDatasetModel).where(SemanticModelDatasetModel.model_id == model_id)).all()
        metrics = self.db.scalars(select(SemanticMetricModel).where(SemanticMetricModel.model_id == model_id)).all()
        dimensions = self.db.scalars(select(SemanticDimensionModel).where(SemanticDimensionModel.model_id == model_id)).all()
        relationships = self.db.scalars(select(SemanticRelationshipModel).where(SemanticRelationshipModel.model_id == model_id)).all()
        vocabulary = self.db.scalars(select(SemanticVocabularyModel).where(SemanticVocabularyModel.model_id == model_id)).all()
        return SemanticModelCreate(
            name="snapshot", datasets=[{"datasetId": item.dataset_id, "role": item.role, "joinConfig": item.join_config or {}} for item in datasets],
            metrics=[self._item(item) for item in metrics], dimensions=[self._item(item) for item in dimensions],
            relationships=[self._item(item) for item in relationships], vocabulary=[self._item(item) for item in vocabulary],
        )

    @staticmethod
    def _parse_grants(value: Any) -> list[PermissionGrant]:
        return [PermissionGrant.model_validate(item) for item in value or [] if isinstance(item, dict)]
