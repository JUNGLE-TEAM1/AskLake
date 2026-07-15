from datetime import date, datetime, timezone
import hashlib
import json
import re
from typing import Any
from uuid import uuid4

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, require_permission
from app.core.config import settings
from app.core.errors import ApiError
from app.models.semantic_rag import RagClassificationRunModel, RagColumnRecommendationModel, RagDatasetProfileModel, RagIndexJobModel, RagIndexManifestModel
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.semantic import RagApproveRequest, RagClassifyResponse, RagDocumentPreviewResponse, RagIndexResponse, RagJobResponse, RagProfileResponse
from app.services.ai_gateway_client import AiGatewayClient
from app.services.catalog_schema import dataset_schema, schema_fingerprint, schema_names
from app.services.rag_document_service import build_documents, dataset_columns
from app.services.resource_permission_service import dataset_with_persisted_permission_grants


RAG_TABLES = [RagDatasetProfileModel.__table__, RagClassificationRunModel.__table__, RagColumnRecommendationModel.__table__, RagIndexJobModel.__table__, RagIndexManifestModel.__table__]
RAG_PARENT_SCHEMA_VERSION = "rag-parent-v3"
EMBEDDING_INPUT_VERSION = "title_body_fields_v2"
CHUNKING_VERSION = "rag-chunk-v3"
FIELD_RENDERING_VERSION = "field_blocks_v1"
FILTER_CONTRACT_VERSION = "typed-filter-v1"


def safe_identifier(value: str) -> str:
    normalized = re.sub(r"[^0-9A-Za-z_-]+", "_", str(value or "")).strip("_")
    return normalized[:200] or "dataset"


def ensure_rag_schema(db: Session) -> None:
    # Production schema is owned by Alembic.  Local/test environments retain
    # the convenience bootstrap used by the existing in-memory test harness.
    if not settings.rag_runtime_create_schema and not settings.allows_header_auth_fallback:
        return
    from app.models.base import Base
    Base.metadata.create_all(bind=db.get_bind(), tables=RAG_TABLES)


class RagService:
    def __init__(self, db: Session) -> None:
        self.db = db
        ensure_rag_schema(db)
        self.catalog = CatalogRepository(db)

    def profile(self, dataset_id: str, actor: ActorContext) -> RagProfileResponse:
        dataset = self._dataset(dataset_id, actor, "view")
        row = self.db.get(RagDatasetProfileModel, dataset_id)
        if row is None:
            row = RagDatasetProfileModel(dataset_id=dataset_id, target_alias=f"{settings.rag_index_prefix}-ds-{dataset_id}")
        active_manifest = self.db.scalar(select(RagIndexManifestModel).where(RagIndexManifestModel.dataset_id == dataset_id, RagIndexManifestModel.status == "active").order_by(RagIndexManifestModel.activated_at.desc()))
        recommendations = self.db.scalars(select(RagColumnRecommendationModel).where(RagColumnRecommendationModel.dataset_id == dataset_id).order_by(RagColumnRecommendationModel.column_name.asc())).all()
        current_source = dataset.get("sourceManifest") or dataset.get("source_manifest") or {}
        current_source_fingerprint = str(current_source.get("fingerprint") or "") if isinstance(current_source, dict) else ""
        current_policy = self._policy_fingerprint(dataset, row) if row.review_state == "approved" else None
        stale = bool(active_manifest and ((current_source_fingerprint and active_manifest.source_fingerprint != current_source_fingerprint) or (current_policy and active_manifest.policy_fingerprint != current_policy)))
        serving_status = "stale" if stale else "serving" if active_manifest and (active_manifest.index_name or row.active_index) else "not_serving"
        effective_index_status = "stale" if stale else row.index_status
        serving_index = active_manifest.index_name if active_manifest else row.active_index
        return RagProfileResponse(dataset_id=dataset_id, review_state=row.review_state, index_status=effective_index_status, build_status=row.index_status, serving_status=serving_status, embedding_status=row.embedding_status, schema=dataset_schema(dataset), schema_fingerprint=row.schema_fingerprint or schema_fingerprint(dataset), body_columns=row.body_columns or [], title_columns=row.title_columns or [], metadata_columns=row.metadata_columns or [], identifier_columns=row.identifier_columns or [], excluded_columns=row.excluded_columns or [], classifier=row.classifier, classifier_confidence=row.classifier_confidence, target_alias=row.target_alias, active_index=serving_index, active_source_fingerprint=active_manifest.source_fingerprint if active_manifest else None, active_embedding_model=active_manifest.embedding_model if active_manifest else None, active_embedding_dimensions=active_manifest.dimensions if active_manifest else None, active_chunking_version=active_manifest.chunking_version if active_manifest else None, last_error=row.last_error, semantic_bindings=row.semantic_bindings or {}, physical_column_mapping=row.physical_column_mapping or {}, recommendations=[{"id": item.id, "columnName": item.column_name, "role": item.role, "confidence": item.confidence, "reason": item.reason, "approved": item.approved} for item in recommendations])

    def classify(self, dataset_id: str, actor: ActorContext, semantic_model_id: str | None = None) -> RagClassifyResponse:
        dataset = self._dataset(dataset_id, actor, "manage")
        row = self._profile_row(dataset_id)
        semantic_bindings = self._semantic_bindings(dataset_id, semantic_model_id, actor)
        classification_input = self._classification_input(dataset, semantic_bindings)
        run = RagClassificationRunModel(id=f"ragcr_{uuid4().hex}", dataset_id=dataset_id, status="running", model="ai-gateway", input_snapshot=classification_input)
        row.review_state = "classifying"
        row.schema_fingerprint = schema_fingerprint(dataset)
        row.semantic_bindings = semantic_bindings
        self.db.add(run)
        self.db.flush()
        try:
            output = AiGatewayClient().classify_dataset(run.id, classification_input)
        except Exception as exc:
            output = self._fallback_classification(dataset, semantic_bindings)
            run.error = f"AI gateway unavailable; deterministic fallback used: {exc.__class__.__name__}"
        self._apply_classification(run, row, output)
        self.db.commit()
        return RagClassifyResponse(run_id=run.id, dataset_id=dataset_id, status=run.status)

    def approve(self, dataset_id: str, request: RagApproveRequest, actor: ActorContext) -> RagProfileResponse:
        dataset = self._dataset(dataset_id, actor, "query")
        grants = dataset.get("permissionGrants") or []
        require_permission(actor, "publish", owner=dataset.get("owner"), grants=grants, resource_label="Dataset RAG profile")
        row = self._profile_row(dataset_id)
        columns = set(dataset_columns(dataset))
        normalized_names: dict[str, str] = {}
        normalized_owners: dict[str, str] = {}
        for column in dataset_columns(dataset):
            physical = self._physical_column_name(column)
            if physical in normalized_owners and normalized_owners[physical] != column:
                raise ApiError("validation_error", f"Catalog columns '{normalized_owners[physical]}' and '{column}' normalize to the same RAG field '{physical}'", status.HTTP_400_BAD_REQUEST)
            normalized_owners[physical] = column
            normalized_names[str(column)] = physical
        requested = set(request.body_columns) | set(request.title_columns) | set(request.metadata_columns) | set(request.identifier_columns) | set(request.excluded_columns)
        if not requested.issubset(columns):
            raise ApiError("validation_error", "RAG columns must exist in the Catalog Dataset schema", status.HTTP_400_BAD_REQUEST)
        role_sets = [set(request.body_columns), set(request.title_columns), set(request.metadata_columns), set(request.identifier_columns), set(request.excluded_columns)]
        if sum(len(item) for item in role_sets) != len(set().union(*role_sets)):
            raise ApiError("validation_error", "A column cannot have multiple RAG roles", status.HTTP_400_BAD_REQUEST)
        if not request.identifier_columns:
            raise ApiError("validation_error", "RAG indexing requires at least one stable identifier column assigned to the identifier role", status.HTTP_400_BAD_REQUEST)
        row.body_columns = request.body_columns
        row.title_columns = request.title_columns
        row.metadata_columns = request.metadata_columns
        row.identifier_columns = request.identifier_columns
        row.excluded_columns = request.excluded_columns
        row.review_state = "approved"
        row.approved_schema_fingerprint = schema_fingerprint(dataset)
        row.schema_fingerprint = row.approved_schema_fingerprint
        row.approved_definition_fingerprint = self._definition_fingerprint(row)
        row.physical_column_mapping = normalized_names
        row.index_status = "not_indexed"
        row.embedding_status = "pending"
        row.approved_by = actor.name
        row.approved_at = datetime.now(timezone.utc)
        row.target_alias = row.target_alias or f"{settings.rag_index_prefix}-ds-{dataset_id}"
        self.db.commit()
        return self.profile(dataset_id, actor)

    def preview(self, dataset_id: str, actor: ActorContext) -> RagDocumentPreviewResponse:
        dataset = self._dataset(dataset_id, actor, "query")
        row = self._profile_row(dataset_id)
        if row.review_state != "approved":
            raise ApiError("validation_error", "Approve RAG columns before previewing VectorDB documents", status.HTTP_400_BAD_REQUEST)
        alias = row.target_alias or f"{settings.rag_index_prefix}-ds-{dataset_id}"
        active_manifest = self.db.scalar(select(RagIndexManifestModel).where(RagIndexManifestModel.dataset_id == dataset_id, RagIndexManifestModel.status == "active").order_by(RagIndexManifestModel.activated_at.desc()))
        if active_manifest and settings.opensearch_base_url:
            from app.clients.opensearch_client import OpenSearchClient

            payload = OpenSearchClient(settings).search_raw(active_manifest.index_name, {"size": settings.rag_document_preview_limit, "query": {"match_all": {}}})
            hits = payload.get("hits", {}).get("hits", []) if isinstance(payload, dict) else []
            documents = [self._preview_document_from_index_hit(hit, dataset_name=str(dataset.get("name") or dataset_id), target_index=active_manifest.index_name) for hit in hits if isinstance(hit, dict)]
            return RagDocumentPreviewResponse(dataset_id=dataset_id, target_alias=alias, source_columns=[*(row.body_columns or []), *(row.title_columns or []), *(row.metadata_columns or []), *(row.identifier_columns or [])], documents=documents)
        documents = build_documents(dataset_id=dataset_id, dataset_name=str(dataset.get("name") or dataset_id), rows=dataset.get("sampleRows") or [], columns=dataset_columns(dataset), body_columns=row.body_columns or [], title_columns=row.title_columns or [], metadata_columns=row.metadata_columns or [], identifier_columns=row.identifier_columns or [], semantic_bindings=row.semantic_bindings or {}, schema_types={str(item.get("name")): str(item.get("dataType") or item.get("data_type") or "") for item in dataset_schema(dataset) if isinstance(item, dict) and item.get("name")}, physical_column_mapping=row.physical_column_mapping or {}, target_index=alias, limit=settings.rag_document_preview_limit)
        return RagDocumentPreviewResponse(dataset_id=dataset_id, target_alias=alias, source_columns=[*(row.body_columns or []), *(row.title_columns or []), *(row.metadata_columns or []), *(row.identifier_columns or [])], documents=documents)

    @staticmethod
    def _preview_document_from_index_hit(hit: dict[str, Any], *, dataset_name: str, target_index: str) -> dict[str, Any]:
        source = hit.get("_source") if isinstance(hit.get("_source"), dict) else {}
        metadata_filter = source.get("metadata_filter") if isinstance(source.get("metadata_filter"), dict) else {}
        return {
            "document_id": str(source.get("document_id") or hit.get("_id") or ""),
            "parent_document_id": source.get("parent_document_id"),
            "chunk_index": int(source.get("chunk_index") or 0),
            "start_sentence": int(source.get("start_sentence") or 0),
            "end_sentence": int(source.get("end_sentence") or 0),
            "dataset_id": str(source.get("dataset_id") or ""),
            "source_row_id": str(source.get("source_row_id") or ""),
            "body": str(source.get("body") or ""),
            "title": source.get("title"),
            "filter_terms": source.get("filter_terms") if isinstance(source.get("filter_terms"), dict) else {},
            "metadata_filter": metadata_filter,
            "metadata_display": source.get("metadata_display") if isinstance(source.get("metadata_display"), dict) else {},
            "semantic_bindings": source.get("semantic_bindings") if isinstance(source.get("semantic_bindings"), dict) else {},
            "source_dataset": str(source.get("source_dataset") or dataset_name),
            "source_columns": source.get("source_columns") if isinstance(source.get("source_columns"), list) else [],
            "source_fields": source.get("source_fields") if isinstance(source.get("source_fields"), list) else [],
            "target_index": target_index,
            "embedding_status": "ready" if source.get("body_vector") is not None else "pending",
            "content_hash": str(source.get("content_hash") or ""),
            "embedding_text": str(source.get("embedding_text") or ""),
            "chunking_strategy": str(source.get("chunking_strategy") or "unknown"),
            "chunking_version": str(source.get("chunking_version") or CHUNKING_VERSION),
            "embedding_input_version": str(source.get("embedding_input_version") or EMBEDDING_INPUT_VERSION),
            "field_rendering_version": str(source.get("field_rendering_version") or FIELD_RENDERING_VERSION),
        }

    def validate_search_filters(self, dataset_id: str, actor: ActorContext, filters: dict[str, Any]) -> dict[str, dict[str, Any]]:
        """Validate the public filter DTO against approved Catalog metadata columns.

        The API deliberately rejects unknown fields and the legacy ``{"gte": ...}``
        shorthand.  Otherwise a typo would silently broaden retrieval and a caller
        could query a column that the Dataset owner never approved for RAG metadata.
        """
        dataset = self._dataset(dataset_id, actor, "query")
        profile = self._profile_row(dataset_id)
        if not filters:
            return {}
        active_manifest = self.db.scalar(select(RagIndexManifestModel).where(RagIndexManifestModel.dataset_id == dataset_id, RagIndexManifestModel.status == "active").order_by(RagIndexManifestModel.activated_at.desc()))
        using_active_contract = active_manifest is not None
        if using_active_contract:
            if active_manifest.filter_contract_version != FILTER_CONTRACT_VERSION or not active_manifest.metadata_columns or not active_manifest.metadata_types:
                raise ApiError("rag_filter_contract_unavailable", "The serving index does not have an immutable metadata filter contract; rebuild the RAG index", status.HTTP_409_CONFLICT)
            allowed_metadata = list(active_manifest.metadata_columns or [])
            physical_mapping = active_manifest.physical_column_mapping or {}
            metadata_types = active_manifest.metadata_types or {}
            schema_by_name = {logical: str(metadata_types.get(str(physical_mapping.get(logical) or self._physical_column_name(logical))) or "unknown").casefold() for logical in allowed_metadata}
        else:
            schema_by_name = {str(item.get("name")): str(item.get("dataType") or item.get("data_type") or "unknown").casefold() for item in dataset_schema(dataset) if isinstance(item, dict)}
            physical_mapping = profile.physical_column_mapping or self._physical_column_mapping(dataset_schema(dataset))
            allowed_metadata = list(profile.metadata_columns or [])
        result: dict[str, dict[str, Any]] = {}
        for field, predicate in (filters or {}).items():
            if field not in set(allowed_metadata):
                raise ApiError("validation_error", f"RAG filter field '{field}' is not an approved metadata column", status.HTTP_400_BAD_REQUEST)
            if not isinstance(predicate, dict) or set(predicate) != {"operator", "value"}:
                raise ApiError("validation_error", f"RAG filter '{field}' must use {{operator, value}}", status.HTTP_400_BAD_REQUEST)
            operator = predicate.get("operator")
            value = predicate.get("value")
            if operator not in {"eq", "gte", "gt", "lte", "lt"} or value is None:
                raise ApiError("validation_error", f"RAG filter '{field}' has an invalid operator or value", status.HTTP_400_BAD_REQUEST)
            data_type = schema_by_name.get(field, "unknown")
            numeric = any(token in data_type for token in ("int", "long", "bigint", "float", "double", "decimal", "number", "numeric"))
            temporal = any(token in data_type for token in ("date", "time", "timestamp"))
            if operator != "eq" and not (numeric or temporal):
                raise ApiError("validation_error", f"Range operators are not supported for text metadata column '{field}'", status.HTTP_400_BAD_REQUEST)
            if (numeric and not isinstance(value, (int, float))) or (numeric and isinstance(value, bool)):
                raise ApiError("validation_error", f"RAG filter value for numeric column '{field}' must be numeric", status.HTTP_400_BAD_REQUEST)
            if temporal:
                try:
                    date.fromisoformat(str(value)[:10])
                except ValueError as exc:
                    raise ApiError("validation_error", f"RAG filter value for temporal column '{field}' must be ISO date/time", status.HTTP_400_BAD_REQUEST) from exc
            if "bool" in data_type and operator == "eq" and not isinstance(value, bool):
                raise ApiError("validation_error", f"RAG filter value for boolean column '{field}' must be boolean", status.HTTP_400_BAD_REQUEST)
            result[field] = {"operator": operator, "value": value, "storageType": "date" if temporal else "number" if numeric else "boolean" if "bool" in data_type else "keyword", "physicalField": physical_mapping.get(field, field)}
        return result

    @classmethod
    def _metadata_filter_contract(cls, dataset: dict[str, Any], profile: RagDatasetProfileModel) -> tuple[list[str], dict[str, str], dict[str, str]]:
        schema = dataset_schema(dataset)
        mapping = profile.physical_column_mapping or cls._physical_column_mapping(schema)
        schema_by_name = {str(item.get("name")): str(item.get("dataType") or item.get("data_type") or "string") for item in schema if isinstance(item, dict) and item.get("name")}
        metadata_columns = list(profile.metadata_columns or [])
        metadata_types = {mapping.get(logical, cls._physical_column_name(logical)): schema_by_name.get(logical, "string") for logical in metadata_columns}
        return metadata_columns, mapping, metadata_types

    def index(self, dataset_id: str, actor: ActorContext, *, mode: str = "index", idempotency_key: str | None = None) -> RagIndexResponse:
        dataset = self._dataset(dataset_id, actor, "query")
        require_permission(actor, "publish", owner=dataset.get("owner"), grants=dataset.get("permissionGrants") or [], resource_label="Dataset RAG index")
        row = self._profile_row(dataset_id)
        locked_row = self.db.scalar(select(RagDatasetProfileModel).where(RagDatasetProfileModel.dataset_id == dataset_id).with_for_update())
        if locked_row is not None:
            row = locked_row
        if row.review_state != "approved":
            raise ApiError("validation_error", "Approve the RAG profile before indexing", status.HTTP_400_BAD_REQUEST)
        current_schema_fingerprint = schema_fingerprint(dataset)
        approved_schema_fingerprint = row.approved_schema_fingerprint or row.schema_fingerprint
        if approved_schema_fingerprint and approved_schema_fingerprint != current_schema_fingerprint:
            row.review_state = "needs_review"
            row.index_status = "stale" if row.active_index else "not_indexed"
            row.embedding_status = "pending"
            self.db.commit()
            raise ApiError("schema_changed", "Catalog schema changed after approval; review and approve the RAG roles again before indexing", status.HTTP_409_CONFLICT)
        if row.approved_definition_fingerprint and row.approved_definition_fingerprint != self._definition_fingerprint(row):
            row.review_state = "needs_review"
            row.index_status = "stale" if row.active_index else "not_indexed"
            self.db.commit()
            raise ApiError("definition_changed", "RAG title/body/metadata roles changed after approval; approve the definition again before indexing", status.HTTP_409_CONFLICT)
        source_manifest = dataset.get("sourceManifest") or dataset.get("source_manifest") or {}
        source_fingerprint = str(source_manifest.get("fingerprint") or "") if isinstance(source_manifest, dict) else ""
        if idempotency_key:
            existing = self.db.scalar(select(RagIndexJobModel).where(RagIndexJobModel.dataset_id == dataset_id, RagIndexJobModel.idempotency_key == idempotency_key))
            if existing is not None:
                if existing.source_fingerprint != (source_fingerprint or None):
                    raise ApiError("idempotency_conflict", "The idempotency key was already used for a different source fingerprint", status.HTTP_409_CONFLICT)
                return RagIndexResponse(job_id=existing.id, dataset_id=dataset_id, status=existing.status, target_index=existing.target_index)
        alias = row.target_alias or f"{settings.rag_index_prefix}-ds-{dataset_id}"
        target = f"{alias}-v{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:6]}"
        policy_fingerprint = self._policy_fingerprint(dataset, row)
        active_manifest = self.db.scalar(select(RagIndexManifestModel).where(RagIndexManifestModel.dataset_id == dataset_id, RagIndexManifestModel.status == "active").order_by(RagIndexManifestModel.activated_at.desc()))
        if mode == "index" and active_manifest is not None and active_manifest.source_fingerprint == (source_fingerprint or None) and active_manifest.policy_fingerprint == policy_fingerprint and active_manifest.embedding_model == settings.rag_embedding_model and active_manifest.dimensions == settings.rag_embedding_dimensions and active_manifest.index_name:
            return RagIndexResponse(job_id=f"active:{active_manifest.index_name}", dataset_id=dataset_id, status="ready", target_index=active_manifest.index_name)
        job_id = f"ragjob_{uuid4().hex}"
        parent_table = f"{settings.trino_catalog}.{settings.rag_parent_iceberg_namespace}.parents_{safe_identifier(dataset_id)}_{safe_identifier(job_id)}"
        chunk_table = f"{settings.trino_catalog}.{settings.rag_parent_iceberg_namespace}.chunks_{safe_identifier(dataset_id)}_{safe_identifier(job_id)}"
        row.desired_generation = int(row.desired_generation or 0) + 1
        metadata_columns, physical_mapping, metadata_types = self._metadata_filter_contract(dataset, row)
        job = RagIndexJobModel(id=job_id, dataset_id=dataset_id, generation=row.desired_generation, physical_column_mapping=physical_mapping, metadata_columns=metadata_columns, metadata_types=metadata_types, filter_contract_version=FILTER_CONTRACT_VERSION, status="queued", stage="queued", requested_by=actor.name, requested_mode=mode, idempotency_key=idempotency_key, target_index=target, document_count=0, source_fingerprint=source_fingerprint or None, policy_fingerprint=policy_fingerprint, embedding_model=settings.rag_embedding_model, embedding_dimensions=settings.rag_embedding_dimensions, failed_row_rate_threshold=settings.rag_failed_row_rate_threshold, parent_table=parent_table, chunk_table=chunk_table, checkpoint_path=f"{settings.rag_staging_base_path.rstrip('/')}/rag/checkpoints/parents/dataset_id={dataset_id}/job_id={job_id}")
        row.index_status = "queued"
        row.embedding_status = "pending"
        self.db.add(job)
        self.db.commit()
        self._trigger_airflow(job, dataset, row)
        return RagIndexResponse(job_id=job.id, dataset_id=dataset_id, status=job.status, target_index=target)

    def reconcile_source_changes(self, *, limit: int | None = None) -> int:
        """Enqueue one idempotent reindex for each changed active Dataset.

        Catalog writes update the source manifest, while the RAG manifest keeps
        the fingerprint used by the active alias.  The control-plane tick is
        the durable event boundary between those two stores; the idempotency
        key makes repeated ticks and multiple API replicas harmless.
        """
        actor = ActorContext(name="rag-reconciler", role="admin")
        statement = select(RagIndexManifestModel).where(RagIndexManifestModel.status == "active").order_by(RagIndexManifestModel.activated_at.asc())
        if limit is not None and limit > 0:
            statement = statement.limit(limit)
        active_manifests = self.db.scalars(statement).all()
        enqueued = 0
        for manifest in active_manifests:
            dataset = self.catalog.get_dataset_payload(manifest.dataset_id)
            source = (dataset.get("sourceManifest") or dataset.get("source_manifest")) if isinstance(dataset, dict) else None
            current_fingerprint = str(source.get("fingerprint") or "") if isinstance(source, dict) else ""
            profile = self.db.get(RagDatasetProfileModel, manifest.dataset_id)
            current_policy = self._policy_fingerprint(dataset, profile) if profile and isinstance(dataset, dict) else None
            current_schema = schema_fingerprint(dataset) if isinstance(dataset, dict) else None
            approved_schema = (profile.approved_schema_fingerprint or profile.schema_fingerprint) if profile else None
            if profile and approved_schema and current_schema and approved_schema != current_schema:
                profile.review_state = "needs_review"
                profile.index_status = "stale"
                profile.embedding_status = "pending"
                self.db.commit()
                continue
            if profile and profile.approved_definition_fingerprint and profile.approved_definition_fingerprint != self._definition_fingerprint(profile):
                profile.review_state = "needs_review"
                profile.index_status = "stale"
                self.db.commit()
                continue
            changed = bool(current_fingerprint and current_fingerprint != manifest.source_fingerprint)
            changed = changed or bool(current_policy and current_policy != manifest.policy_fingerprint)
            changed = changed or bool(profile and manifest.embedding_model != settings.rag_embedding_model)
            changed = changed or bool(profile and manifest.dimensions != settings.rag_embedding_dimensions)
            if not changed:
                continue
            key = f"auto-reindex:{manifest.dataset_id}:{current_fingerprint}:{current_policy or ''}"
            existing = self.db.scalar(
                select(RagIndexJobModel).where(
                    RagIndexJobModel.dataset_id == manifest.dataset_id,
                    RagIndexJobModel.idempotency_key == key,
                )
            )
            if existing is not None:
                continue
            try:
                self.index(manifest.dataset_id, actor, mode="reindex", idempotency_key=key)
                enqueued += 1
            except Exception:
                self.db.rollback()
        return enqueued

    def complete_job(self, job_id: str, result: dict[str, Any]) -> RagJobResponse:
        job = self.db.scalar(select(RagIndexJobModel).where(RagIndexJobModel.id == job_id).with_for_update())
        if job is None:
            raise ApiError("not_found", f"RAG job {job_id} was not found", status.HTTP_404_NOT_FOUND)
        profile = self.db.scalar(select(RagDatasetProfileModel).where(RagDatasetProfileModel.dataset_id == job.dataset_id).with_for_update()) or self._profile_row(job.dataset_id)
        result_status = str(result.get("status") or "success")
        terminal_statuses = {"ready", "failed", "canceled"}
        if job.status in terminal_statuses:
            return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))
        stage_updates = {
            "parent_staged": ("staging", "staging", "pending"),
            "chunked": ("chunking", "chunking", "pending"),
            "embedding": ("embedding", "embedding", "generating"),
            "indexing": ("indexing", "indexing", "generating"),
            "validating": ("validating", "validating", "generating"),
        }
        stage_order = {"queued": 0, "staging": 1, "chunking": 2, "embedding": 3, "indexing": 4, "validating": 5, "ready": 6, "failed": 99, "canceled": 99}
        if result_status in stage_updates:
            if int(job.generation or 0) != int(profile.desired_generation or 0):
                job.status = "failed"
                job.stage = "failed"
                job.error = "RAG callback belongs to a superseded activation generation"
                job.completed_at = datetime.now(timezone.utc)
                self.db.commit()
                return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))
            next_status = stage_updates[result_status][0]
            if stage_order.get(next_status, -1) < stage_order.get(job.status, -1):
                return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))
            job.status, job.stage, profile.embedding_status = stage_updates[result_status]
            profile.index_status = job.status
            job.parent_count = int(result.get("parentCount") or job.parent_count)
            job.chunk_count = int(result.get("chunkCount") or job.chunk_count)
            job.failed_count = int(result.get("failedCount") or job.failed_count)
            job.row_count = int(result.get("rowCount") or job.row_count)
            job.failed_row_rate = float(result.get("failedRate") or job.failed_row_rate)
            job.failed_row_report = result.get("failedRowReport") if isinstance(result.get("failedRowReport"), dict) else (job.failed_row_report or {})
            job.fallback_count = int(result.get("fallbackCount") or job.fallback_count)
            job.fallback_reasons = result.get("fallbackReasons") if isinstance(result.get("fallbackReasons"), dict) else (job.fallback_reasons or {})
            job.document_count = int(result.get("documentCount") or job.document_count)
            job.indexed_count = int(result.get("indexedCount") or job.indexed_count)
            job.embedding_dimensions = int(result.get("dimensions") or job.embedding_dimensions or 0) or job.embedding_dimensions
            job.embedding_model = str(result.get("embeddingModel") or job.embedding_model or settings.rag_embedding_model)
            job.checkpoint_path = str(result.get("checkpointPath") or job.checkpoint_path or "") or None
            self.db.commit()
            return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))
        if result_status != "success":
            job.status = "failed"
            job.stage = "failed"
            is_current_generation = int(job.generation or 0) == int(profile.desired_generation or 0)
            if is_current_generation:
                profile.index_status = "failed"
                profile.embedding_status = "failed"
            job.error = str(result.get("error") or "RAG worker failed")
            if isinstance(result.get("failedRowReport"), dict):
                job.failed_row_report = result["failedRowReport"]
            job.row_count = int(result.get("rowCount") or job.row_count)
            job.failed_count = int(result.get("failedCount") or job.failed_count)
            job.failed_row_rate = float(result.get("failedRate") or job.failed_row_rate)
            if is_current_generation:
                profile.last_error = job.error
            job.completed_at = datetime.now(timezone.utc)
            self.db.commit()
            return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))
        else:
            validation_matches_job = (
                job.status == "validating"
                and job.stage == "validating"
                and job.validation_status == "passed"
                and job.validated_index == job.target_index
                and job.validated_document_count == int(job.indexed_count or job.chunk_count)
                and job.validated_parent_count == int(job.parent_count)
                and job.validated_dimensions == int(job.embedding_dimensions or 0)
            )
            current_dataset = (self.catalog.get_dataset_payload(job.dataset_id) or {}) if validation_matches_job else {}
            current_source = current_dataset.get("sourceManifest") or current_dataset.get("source_manifest") or {}
            current_source_fingerprint = str(current_source.get("fingerprint") or "") if isinstance(current_source, dict) else ""
            current_policy_fingerprint = self._policy_fingerprint(current_dataset, profile) if isinstance(current_dataset, dict) and current_dataset and profile.review_state == "approved" else None
            fenced_for_activation = (
                int(job.generation or 0) == int(profile.desired_generation or 0)
                and current_source_fingerprint == (job.source_fingerprint or "")
                and (not job.policy_fingerprint or current_policy_fingerprint == job.policy_fingerprint)
            )
            if not validation_matches_job or not fenced_for_activation:
                job.status = "failed"
                job.stage = "failed"
                if fenced_for_activation:
                    profile.index_status = "failed"
                    profile.embedding_status = "failed"
                job.error = "Activation requires persisted validation evidence for this target index and current generation"
                if fenced_for_activation:
                    profile.last_error = job.error
                job.completed_at = datetime.now(timezone.utc)
                self.db.commit()
                return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))
            job.status = "ready"
            job.stage = "ready"
            job.indexed_count = int(result.get("indexedCount") or job.document_count)
            job.parent_count = int(result.get("parentCount") or job.parent_count)
            job.chunk_count = int(result.get("chunkCount") or job.chunk_count)
            job.failed_count = int(result.get("failedCount") or job.failed_count)
            job.row_count = int(result.get("rowCount") or job.row_count)
            job.failed_row_rate = float(result.get("failedRate") or job.failed_row_rate)
            job.failed_row_report = result.get("failedRowReport") if isinstance(result.get("failedRowReport"), dict) else (job.failed_row_report or {})
            job.fallback_count = int(result.get("fallbackCount") or job.fallback_count)
            job.fallback_reasons = result.get("fallbackReasons") if isinstance(result.get("fallbackReasons"), dict) else (job.fallback_reasons or {})
            job.document_count = int(result.get("documentCount") or job.chunk_count or job.document_count)
            job.embedding_dimensions = int(result.get("dimensions") or job.embedding_dimensions or settings.rag_embedding_dimensions)
            profile.index_status = "ready"
            profile.embedding_status = "ready"
            profile.last_error = None
            previous_index = profile.active_index
            next_index = str(result.get("activeIndex") or job.target_index or "") or None
            if settings.opensearch_base_url and next_index:
                from app.clients.opensearch_client import OpenSearchClient
                try:
                    OpenSearchClient(settings).switch_alias(profile.target_alias or f"{settings.rag_index_prefix}-ds-{job.dataset_id}", next_index, previous_index)
                except Exception as exc:
                    job.status = "failed"
                    job.stage = "failed"
                    profile.index_status = "failed"
                    profile.embedding_status = "failed"
                    job.error = f"OpenSearch alias activation failed: {exc.__class__.__name__}"
                    profile.last_error = job.error
                    job.completed_at = datetime.now(timezone.utc)
                    self.db.commit()
                    return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))
            profile.active_index = next_index
            for manifest in self.db.scalars(select(RagIndexManifestModel).where(RagIndexManifestModel.dataset_id == job.dataset_id, RagIndexManifestModel.status == "active")).all():
                manifest.status = "retired"
                manifest.retired_at = datetime.now(timezone.utc)
            dataset = self.catalog.get_dataset_payload(job.dataset_id) or {}
            self.db.add(RagIndexManifestModel(id=f"ragmanifest_{uuid4().hex}", dataset_id=job.dataset_id, generation=job.generation, physical_column_mapping=job.physical_column_mapping or profile.physical_column_mapping or {}, metadata_columns=job.metadata_columns or [], metadata_types=job.metadata_types or {}, filter_contract_version=job.filter_contract_version, index_name=profile.active_index or job.target_index or "", alias_name=profile.target_alias or "", status="active", embedding_model=job.embedding_model or settings.rag_embedding_model, dimensions=job.embedding_dimensions or settings.rag_embedding_dimensions, document_count=job.indexed_count, parent_count=job.parent_count, chunk_count=job.chunk_count, failed_count=job.failed_count, row_count=job.row_count, failed_row_rate=job.failed_row_rate, failed_row_rate_threshold=job.failed_row_rate_threshold, failed_row_report=job.failed_row_report or {}, fallback_count=job.fallback_count, fallback_reasons=job.fallback_reasons or {}, source_fingerprint=job.source_fingerprint, schema_fingerprint=schema_fingerprint(dataset), policy_fingerprint=job.policy_fingerprint, semantic_bindings_fingerprint=self._semantic_bindings_fingerprint(profile.semantic_bindings), chunking_version=str(result.get("chunkingVersion") or CHUNKING_VERSION), embedding_input_version=EMBEDDING_INPUT_VERSION, parent_schema_version=RAG_PARENT_SCHEMA_VERSION, parent_table=job.parent_table, chunk_table=job.chunk_table, checkpoint_path=job.checkpoint_path, activated_at=datetime.now(timezone.utc)))
        job.completed_at = datetime.now(timezone.utc)
        self.db.commit()
        return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))

    def job(self, job_id: str, actor: ActorContext) -> RagJobResponse:
        job = self.db.get(RagIndexJobModel, job_id)
        if job is None:
            raise ApiError("not_found", f"RAG job {job_id} was not found", status.HTTP_404_NOT_FOUND)
        self._dataset(job.dataset_id, actor, "view")
        return RagJobResponse(job_id=job.id, dataset_id=job.dataset_id, status=job.status, requested_mode=job.requested_mode, target_index=job.target_index, document_count=job.document_count, indexed_count=job.indexed_count, parent_count=job.parent_count, chunk_count=job.chunk_count, failed_count=job.failed_count, row_count=job.row_count, failed_row_rate=job.failed_row_rate, failed_row_rate_threshold=job.failed_row_rate_threshold, failed_row_report=job.failed_row_report or {}, fallback_count=job.fallback_count, fallback_reasons=job.fallback_reasons or {}, stage=job.stage, source_fingerprint=job.source_fingerprint, policy_fingerprint=job.policy_fingerprint, embedding_model=job.embedding_model, embedding_dimensions=job.embedding_dimensions, parent_table=job.parent_table, chunk_table=job.chunk_table, checkpoint_path=job.checkpoint_path, error=job.error, airflow_run_id=job.airflow_run_id, generation=job.generation, validation_status=job.validation_status, validated_at=job.validated_at, physical_column_mapping=job.physical_column_mapping or {})

    def validate_job(self, job_id: str) -> dict[str, Any]:
        """Validate the newly built physical index before an alias can move.

        This is intentionally a backend-side check: Spark only proves that its
        HTTP dispatch finished.  The serving control plane must verify what
        OpenSearch actually persisted, including the vector mapping and smoke
        queries, while the old alias remains untouched.
        """
        job = self.db.get(RagIndexJobModel, job_id)
        if job is None:
            raise ApiError("not_found", f"RAG job {job_id} was not found", status.HTTP_404_NOT_FOUND)
        if not settings.opensearch_base_url or not job.target_index:
            raise ApiError("service_unavailable", "OpenSearch is required to validate a RAG index", status.HTTP_503_SERVICE_UNAVAILABLE)
        from app.clients.opensearch_client import OpenSearchClient
        client = OpenSearchClient(settings)
        expected_chunks = job.indexed_count or job.chunk_count
        actual_chunks = client.count(job.target_index)
        if actual_chunks != expected_chunks:
            raise ApiError("rag_validation_failed", f"OpenSearch chunk count mismatch: expected {expected_chunks}, got {actual_chunks}", status.HTTP_409_CONFLICT)
        actual_parents = client.distinct_count(job.target_index, "parent_document_id") if actual_chunks else 0
        if actual_parents != job.parent_count:
            raise ApiError("rag_validation_failed", f"OpenSearch parent count mismatch: expected {job.parent_count}, got {actual_parents}", status.HTTP_409_CONFLICT)
        mapping = client.mapping(job.target_index)
        properties = self._mapping_properties(mapping, job.target_index)
        required = {"document_id", "parent_document_id", "body", "embedding_text", "body_vector", "metadata_filter", "chunk_index", "chunk_count", "char_start", "char_end", "embedding_model", "embedding_dimensions", "source_fields", "parent_source_fields", "embedding_input_version", "field_rendering_version"}
        missing = sorted(required - set(properties))
        if missing:
            raise ApiError("rag_validation_failed", f"OpenSearch mapping is missing fields: {', '.join(missing)}", status.HTTP_409_CONFLICT)
        vector_mapping = properties.get("body_vector") or {}
        if int(vector_mapping.get("dimension") or 0) != int(job.embedding_dimensions or 0):
            raise ApiError("rag_validation_failed", "OpenSearch vector dimension does not match the job manifest", status.HTTP_409_CONFLICT)
        sample = client.search_raw(job.target_index, {"size": 1, "_source": ["document_id", "title", "body", "embedding_text", "body_vector", "metadata_filter", "source_fields", "parent_source_fields", "embedding_input_version", "field_rendering_version", "chunking_version", "embedding_model", "embedding_dimensions"], "query": {"match_all": {}}})
        sample_hits = sample.get("hits", {}).get("hits", []) if isinstance(sample, dict) else []
        if actual_chunks and not sample_hits:
            raise ApiError("rag_validation_failed", "OpenSearch sample document query returned no document", status.HTTP_409_CONFLICT)
        metadata_columns = list(job.metadata_columns or [])
        metadata_types = job.metadata_types or {}
        if job.filter_contract_version != FILTER_CONTRACT_VERSION:
            raise ApiError("rag_validation_failed", "RAG job metadata filter contract version is missing or unsupported", status.HTTP_409_CONFLICT)
        if metadata_columns and not sample_hits:
            raise ApiError("rag_validation_failed", "OpenSearch has no document from which to validate approved metadata fields", status.HTTP_409_CONFLICT)
        smoke_evidence: dict[str, Any] = {}
        if sample_hits:
            sample_hit = sample_hits[0] if isinstance(sample_hits[0], dict) else {}
            sample_id = str(sample_hit.get("_id") or (sample_hit.get("_source") or {}).get("document_id") or "")
            sample_source = sample_hit.get("_source") or {}
            vector = sample_source.get("body_vector")
            if not isinstance(vector, list) or len(vector) != int(job.embedding_dimensions or 0):
                raise ApiError("rag_validation_failed", "OpenSearch stored vector is missing or has the wrong dimension", status.HTTP_409_CONFLICT)
            if sample_source.get("embedding_input_version") != EMBEDDING_INPUT_VERSION or sample_source.get("field_rendering_version") != FIELD_RENDERING_VERSION or sample_source.get("chunking_version") != CHUNKING_VERSION:
                raise ApiError("rag_validation_failed", "OpenSearch document versions do not match the RAG v3 contract", status.HTTP_409_CONFLICT)
            if not isinstance(sample_source.get("source_fields"), list):
                raise ApiError("rag_validation_failed", "OpenSearch document is missing source field provenance", status.HTTP_409_CONFLICT)
            if not isinstance(sample_source.get("parent_source_fields"), list):
                raise ApiError("rag_validation_failed", "OpenSearch document is missing parent source field provenance", status.HTTP_409_CONFLICT)
            body_text = str(sample_source.get("body") or sample_source.get("title") or sample_source.get("embedding_text") or "")
            tokens = [token for token in re.findall(r"[A-Za-z0-9_]+|[가-힣]+", body_text) if token]
            bm25_query_text = body_text[:500] if body_text else (max(tokens, key=len) if tokens else "rag")
            bm25_query = {"size": 10, "query": {"multi_match": {"query": bm25_query_text, "fields": ["title^2", "body", "embedding_text"], "type": "phrase"}}}
            bm25_result = client.search_raw(job.target_index, bm25_query)
            bm25_ids = [str(item.get("_id") or (item.get("_source") or {}).get("document_id") or "") for item in (bm25_result.get("hits", {}).get("hits", []) if isinstance(bm25_result, dict) else []) if isinstance(item, dict)]
            if not bm25_ids or (sample_id and sample_id not in bm25_ids):
                raise ApiError("rag_validation_failed", "OpenSearch BM25 multi_match smoke query did not return the sample document", status.HTTP_409_CONFLICT)
            knn_query = {"size": 1, "query": {"knn": {"body_vector": {"vector": vector, "k": 1}}}}
            knn_result = client.search_raw(job.target_index, knn_query)
            knn_ids = [str(item.get("_id") or (item.get("_source") or {}).get("document_id") or "") for item in (knn_result.get("hits", {}).get("hits", []) if isinstance(knn_result, dict) else []) if isinstance(item, dict)]
            if not knn_ids:
                raise ApiError("rag_validation_failed", "OpenSearch k-NN smoke query returned no document", status.HTTP_409_CONFLICT)
            smoke_evidence["bm25"] = {"query": bm25_query, "resultIds": bm25_ids[:10]}
            smoke_evidence["knn"] = {"query": {"field": "body_vector", "k": 1, "dimensions": len(vector)}, "resultIds": knn_ids[:10]}
            metadata_evidence: list[dict[str, Any]] = []
            metadata_mapping = ((properties.get("metadata_filter") or {}).get("properties") or {}) if isinstance(properties.get("metadata_filter"), dict) else {}
            for logical_field in metadata_columns:
                physical_field = str((job.physical_column_mapping or {}).get(logical_field) or self._physical_column_name(logical_field))
                data_type = str(metadata_types.get(physical_field) or "").casefold()
                if not data_type:
                    raise ApiError("rag_validation_failed", f"Metadata type is missing for approved field '{logical_field}'", status.HTTP_409_CONFLICT)
                if any(token in data_type for token in ("int", "long", "float", "double", "decimal", "numeric", "number")):
                    field_type, suffix = "number", "number"
                elif any(token in data_type for token in ("date", "time", "timestamp")):
                    field_type, suffix = "date", "date"
                elif "bool" in data_type:
                    field_type, suffix = "boolean", "boolean"
                else:
                    field_type, suffix = "string", "keyword"
                field_mapping = metadata_mapping.get(physical_field) if isinstance(metadata_mapping, dict) else None
                value_mapping = (field_mapping or {}).get("properties") if isinstance(field_mapping, dict) else {}
                if not isinstance(value_mapping, dict) or suffix not in value_mapping:
                    raise ApiError("rag_validation_failed", f"OpenSearch mapping is missing typed metadata field '{physical_field}.{suffix}'", status.HTTP_409_CONFLICT)
                exists_result = client.search_raw(job.target_index, {"size": 1, "_source": ["document_id", "metadata_filter"], "query": {"exists": {"field": f"metadata_filter.{physical_field}"}}})
                exists_hits = exists_result.get("hits", {}).get("hits", []) if isinstance(exists_result, dict) else []
                if not exists_hits:
                    raise ApiError("rag_validation_failed", f"No indexed value exists for approved metadata field '{logical_field}'", status.HTTP_409_CONFLICT)
                field_hit = exists_hits[0] if isinstance(exists_hits[0], dict) else {}
                field_source = field_hit.get("_source") or {}
                typed = (field_source.get("metadata_filter") or {}).get(physical_field) if isinstance(field_source.get("metadata_filter"), dict) else None
                if not isinstance(typed, dict) or typed.get("type") != field_type:
                    raise ApiError("rag_validation_failed", f"Indexed metadata type for '{logical_field}' does not match the Catalog contract", status.HTTP_409_CONFLICT)
                value = typed.get(suffix)
                if value is None:
                    raise ApiError("rag_validation_failed", f"Indexed metadata value is missing for approved field '{logical_field}'", status.HTTP_409_CONFLICT)
                query = {"range": {f"metadata_filter.{physical_field}.{suffix}": {"gte": value}}} if field_type in {"number", "date"} else {"term": {f"metadata_filter.{physical_field}.{suffix}": value}}
                metadata_result = client.search_raw(job.target_index, {"size": 10, "query": query})
                metadata_ids = [str(item.get("_id") or (item.get("_source") or {}).get("document_id") or "") for item in (metadata_result.get("hits", {}).get("hits", []) if isinstance(metadata_result, dict) else []) if isinstance(item, dict)]
                sample_field_id = str(field_hit.get("_id") or field_source.get("document_id") or "")
                if not metadata_ids or (sample_field_id and sample_field_id not in metadata_ids):
                    raise ApiError("rag_validation_failed", f"OpenSearch metadata pre-filter smoke query did not return the sampled document for '{logical_field}'", status.HTTP_409_CONFLICT)
                metadata_evidence.append({"logicalField": logical_field, "physicalField": physical_field, "type": field_type, "query": query, "resultIds": metadata_ids[:10]})
            smoke_evidence["metadataFilters"] = metadata_evidence
        evidence = {
            "index": job.target_index,
            "documentCount": actual_chunks,
            "parentCount": actual_parents,
            "dimensions": int(job.embedding_dimensions or 0),
            "requiredFields": sorted(required),
            "smoke": smoke_evidence,
        }
        evidence_hash = hashlib.sha256(json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        job.validation_status = "passed"
        job.validated_at = datetime.now(timezone.utc)
        job.validated_index = job.target_index
        job.validated_document_count = actual_chunks
        job.validated_parent_count = actual_parents
        job.validated_dimensions = int(job.embedding_dimensions or 0)
        job.validation_evidence_hash = evidence_hash
        self.db.commit()
        return {"validationPassed": True, "validatedIndex": job.target_index, "documentCount": actual_chunks, "parentCount": actual_parents, "dimensions": job.embedding_dimensions, "validationEvidenceHash": evidence_hash}

    @staticmethod
    def _mapping_properties(mapping: dict[str, Any], index: str) -> dict[str, Any]:
        root = mapping.get(index) if isinstance(mapping.get(index), dict) else next((value for value in mapping.values() if isinstance(value, dict)), {})
        mappings = root.get("mappings") if isinstance(root, dict) else {}
        properties = mappings.get("properties") if isinstance(mappings, dict) else {}
        return properties if isinstance(properties, dict) else {}

    def _dataset(self, dataset_id: str, actor: ActorContext, action: str) -> dict[str, Any]:
        dataset = self.catalog.get_dataset_payload(dataset_id)
        if dataset is None:
            raise ApiError("not_found", f"Catalog Dataset {dataset_id} was not found", status.HTTP_404_NOT_FOUND)
        from app.schemas.catalog import CatalogDatasetResponse
        parsed = CatalogDatasetResponse.model_validate(dataset)
        parsed = dataset_with_persisted_permission_grants(self.db, parsed)
        payload = parsed.model_dump(by_alias=True, mode="json")
        require_permission(actor, action, owner=payload.get("owner"), grants=payload.get("permissionGrants") or [], resource_label="Catalog Dataset")
        return payload

    def _profile_row(self, dataset_id: str) -> RagDatasetProfileModel:
        row = self.db.get(RagDatasetProfileModel, dataset_id)
        if row is None:
            row = RagDatasetProfileModel(dataset_id=dataset_id, target_alias=f"{settings.rag_index_prefix}-ds-{dataset_id}")
            self.db.add(row)
            self.db.flush()
        return row

    @staticmethod
    def _classification_input(dataset: dict[str, Any], semantic_bindings: dict[str, list[dict[str, Any]]] | None = None) -> dict[str, Any]:
        return {"datasetId": dataset.get("id"), "datasetName": dataset.get("name"), "description": str(dataset.get("description") or "")[:2_000], "schema": dataset_schema(dataset)[:256], "sampleRows": (dataset.get("sampleRows") or [])[:settings.rag_classification_sample_rows], "rowCount": dataset.get("rows"), "semanticBindings": semantic_bindings or {}}

    @staticmethod
    def _fallback_classification(dataset: dict[str, Any], semantic_bindings: dict[str, list[dict[str, Any]]] | None = None) -> dict[str, Any]:
        columns = schema_names(dataset)
        bindings = semantic_bindings or {}
        semantic_columns = {
            str(column)
            for metric in bindings.get("metrics", [])
            if isinstance(metric, dict)
            for column in metric.get("sourceColumns", [])
        }
        semantic_columns.update(
            str(item.get("columnName"))
            for item in bindings.get("dimensions", [])
            if isinstance(item, dict) and item.get("columnName")
        )
        body = [column for column in columns if any(token in column.casefold() for token in ("review", "comment", "text", "content", "message", "description", "body"))]
        title = [column for column in columns if column not in body and any(token in column.casefold() for token in ("title", "subject", "headline", "name"))]
        identifiers = [column for column in columns if column not in body and column not in title and column.casefold().endswith("_id")]
        metadata = [column for column in columns if column not in body and column not in title and column not in identifiers and (column in semantic_columns or any(token in column.casefold() for token in ("rating", "score", "sentiment", "category", "status", "date", "region", "product")))]
        return {"classification": "review" if body else "generic_text", "confidence": 0.55, "roles": [{"columnName": column, "role": "body" if column in body else "title" if column in title else "identifier" if column in identifiers else "metadata" if column in metadata else "excluded", "confidence": 0.55, "reason": "Local deterministic classifier; Semantic binding matched" if column in semantic_columns else "Local deterministic classifier by column name"} for column in columns]}

    def _apply_classification(self, run: RagClassificationRunModel, profile: RagDatasetProfileModel, output: dict[str, Any]) -> None:
        run.status = "completed"
        payload = output if isinstance(output, dict) else {}
        run.output = payload
        run.completed_at = datetime.now(timezone.utc)
        schema_columns = {str(column.get("name")) for column in (run.input_snapshot or {}).get("schema", []) if isinstance(column, dict) and column.get("name")}
        allowed_roles = {"body", "title", "metadata", "identifier", "excluded"}
        raw_roles = payload.get("roles")
        if not isinstance(raw_roles, list):
            raw_roles = []
        roles = [
            item for item in raw_roles
            if isinstance(item, dict)
            and str(item.get("columnName") or "") in schema_columns
            and str(item.get("role") or "") in allowed_roles
        ]
        if len(roles) != len(raw_roles):
            run.error = "AI classification contained unknown columns or roles; invalid recommendations were discarded"
        profile.review_state = "candidate" if roles else "needs_review"
        profile.classifier = str(payload.get("classification") or "unknown")
        profile.classifier_confidence = float(payload.get("confidence") or 0)
        profile.body_columns = [str(item.get("columnName")) for item in roles if isinstance(item, dict) and item.get("role") == "body"]
        profile.title_columns = [str(item.get("columnName")) for item in roles if isinstance(item, dict) and item.get("role") == "title"]
        profile.metadata_columns = [str(item.get("columnName")) for item in roles if isinstance(item, dict) and item.get("role") == "metadata"]
        profile.identifier_columns = [str(item.get("columnName")) for item in roles if isinstance(item, dict) and item.get("role") == "identifier"]
        profile.excluded_columns = [str(item.get("columnName")) for item in roles if isinstance(item, dict) and item.get("role") == "excluded"]
        for item in self.db.scalars(select(RagColumnRecommendationModel).where(RagColumnRecommendationModel.dataset_id == run.dataset_id)).all():
            self.db.delete(item)
        for item in roles:
            if not isinstance(item, dict) or not item.get("columnName"):
                continue
            self.db.add(RagColumnRecommendationModel(id=f"ragrec_{uuid4().hex}", run_id=run.id, dataset_id=run.dataset_id, column_name=str(item["columnName"]), role=str(item.get("role") or "excluded"), confidence=float(item.get("confidence") or 0), reason=str(item.get("reason") or ""), approved=False))

    def _semantic_bindings(self, dataset_id: str, semantic_model_id: str | None, actor: ActorContext) -> dict[str, list[dict[str, Any]]]:
        if not semantic_model_id:
            return {}
        from app.models.semantic_rag import SemanticDimensionModel, SemanticMetricModel, SemanticModelDatasetModel, SemanticVocabularyModel
        from app.services.semantic_model_service import SemanticModelService

        SemanticModelService(self.db).get(semantic_model_id, actor)
        linked = {item.dataset_id for item in self.db.scalars(select(SemanticModelDatasetModel).where(SemanticModelDatasetModel.model_id == semantic_model_id)).all()}
        if dataset_id not in linked:
            raise ApiError("validation_error", "The Dataset is not connected to the selected Semantic Model", status.HTTP_400_BAD_REQUEST)
        metrics = self.db.scalars(select(SemanticMetricModel).where(SemanticMetricModel.model_id == semantic_model_id, SemanticMetricModel.dataset_id == dataset_id)).all()
        dimensions = self.db.scalars(select(SemanticDimensionModel).where(SemanticDimensionModel.model_id == semantic_model_id, SemanticDimensionModel.dataset_id == dataset_id)).all()
        vocabulary = self.db.scalars(select(SemanticVocabularyModel).where(SemanticVocabularyModel.model_id == semantic_model_id)).all()
        return {
            "metrics": [{"name": item.name, "label": item.label, "expression": item.expression, "sourceColumns": item.source_columns or []} for item in metrics],
            "dimensions": [{"name": item.name, "label": item.label, "columnName": item.column_name, "dataType": item.data_type} for item in dimensions],
            "vocabulary": [{"term": item.term, "synonyms": item.synonyms or []} for item in vocabulary],
        }

    @staticmethod
    def _policy_fingerprint(dataset: dict[str, Any], profile: RagDatasetProfileModel) -> str:
        payload = {
            "schemaFingerprint": schema_fingerprint(dataset),
            "body": list(profile.body_columns or []),
            "title": list(profile.title_columns or []),
            "metadata": list(profile.metadata_columns or []),
            "identifier": list(profile.identifier_columns or []),
            "chunkTargetTokens": settings.rag_chunk_target_tokens,
            "chunkOverlapTokens": settings.rag_chunk_overlap_tokens,
            "chunkMaxTokens": settings.rag_chunk_max_tokens,
            "embeddingInputVersion": EMBEDDING_INPUT_VERSION,
            "chunkingVersion": CHUNKING_VERSION,
            "fieldRenderingVersion": FIELD_RENDERING_VERSION,
            "embeddingModel": settings.rag_embedding_model,
            "embeddingDimensions": settings.rag_embedding_dimensions,
            "semanticBindings": profile.semantic_bindings or {},
        }
        return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    @staticmethod
    def _physical_column_name(column: Any) -> str:
        physical = re.sub(r"[^0-9A-Za-z_]+", "_", str(column or "").strip().lower())
        return re.sub(r"_+", "_", physical).strip("_") or "column"

    @classmethod
    def _physical_column_mapping(cls, schema: list[dict[str, Any]]) -> dict[str, str]:
        return {str(item.get("name")): cls._physical_column_name(item.get("name")) for item in schema if isinstance(item, dict) and item.get("name")}

    @staticmethod
    def _semantic_bindings_fingerprint(bindings: dict[str, Any] | None) -> str:
        return hashlib.sha256(json.dumps(bindings or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    @staticmethod
    def _definition_fingerprint(profile: RagDatasetProfileModel) -> str:
        payload = {
            "body": list(profile.body_columns or []),
            "title": list(profile.title_columns or []),
            "metadata": list(profile.metadata_columns or []),
            "identifier": list(profile.identifier_columns or []),
            "excluded": list(profile.excluded_columns or []),
            "semanticBindings": profile.semantic_bindings or {},
        }
        return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    def _trigger_airflow(self, job: RagIndexJobModel, dataset: dict[str, Any], profile: RagDatasetProfileModel) -> None:
        if not settings.airflow_api_base_url or not settings.airflow_api_token:
            job.status = "failed"
            job.stage = "failed"
            job.error = "RAG orchestration is not configured: AIRFLOW_API_BASE_URL and AIRFLOW_API_TOKEN are required"
            profile.last_error = job.error
            job.completed_at = datetime.now(timezone.utc)
            self.db.commit()
            return
        source_manifest = dataset.get("sourceManifest") or dataset.get("source_manifest")
        if not isinstance(source_manifest, dict) or source_manifest.get("manifestVersion") != 1 or source_manifest.get("datasetId") != job.dataset_id or not source_manifest.get("readUrl") or not source_manifest.get("sparkPath") or not source_manifest.get("format") or not source_manifest.get("fingerprint") or not source_manifest.get("expiresAt"):
            job.status = "failed"
            job.stage = "failed"
            job.error = "Catalog-issued sourceManifest with datasetId, readUrl, sparkPath, format, fingerprint, and expiry is required for Airflow indexing"
            profile.last_error = job.error
            job.completed_at = datetime.now(timezone.utc)
            self.db.commit()
            return
        import httpx
        dag_run_id = f"rag_{job.id}"
        payload = {"dag_run_id": dag_run_id, "conf": {"jobId": job.id, "datasetId": job.dataset_id, "targetIndex": job.target_index, "sourceManifest": source_manifest, "sourcePath": source_manifest["sparkPath"], "sourceFormat": source_manifest.get("format"), "sourceFingerprint": job.source_fingerprint, "datasetName": dataset.get("name"), "schema": dataset_schema(dataset), "bodyColumns": profile.body_columns, "titleColumns": profile.title_columns, "metadataColumns": profile.metadata_columns, "identifierColumns": profile.identifier_columns, "semanticBindings": profile.semantic_bindings, "physicalColumnMapping": job.physical_column_mapping or profile.physical_column_mapping or {}, "policyFingerprint": job.policy_fingerprint, "embeddingModel": job.embedding_model, "embeddingDimensions": job.embedding_dimensions, "parentSchemaVersion": RAG_PARENT_SCHEMA_VERSION, "embeddingInputVersion": EMBEDDING_INPUT_VERSION, "chunkingVersion": CHUNKING_VERSION, "fieldRenderingVersion": FIELD_RENDERING_VERSION, "failedRowRateThreshold": job.failed_row_rate_threshold, "stagingBasePath": settings.rag_staging_base_path, "parentTable": job.parent_table, "chunkTable": job.chunk_table, "chunkTargetTokens": settings.rag_chunk_target_tokens, "chunkOverlapTokens": settings.rag_chunk_overlap_tokens, "chunkMaxTokens": settings.rag_chunk_max_tokens}}
        response = httpx.post(f"{settings.airflow_api_base_url.rstrip('/')}/api/v2/dags/{settings.rag_airflow_dag_id}/dagRuns", json=payload, headers={"Authorization": f"Bearer {settings.airflow_api_token}", "Content-Type": "application/json"}, timeout=settings.airflow_request_timeout_seconds)
        if response.status_code >= 400:
            job.status = "failed"
            job.stage = "failed"
            job.error = "Airflow rejected the RAG index request"
            profile.last_error = job.error
            job.completed_at = datetime.now(timezone.utc)
            self.db.commit()
            return
        job.airflow_run_id = dag_run_id
        self.db.commit()
