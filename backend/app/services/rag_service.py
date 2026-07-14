from datetime import datetime, timezone
from datetime import date
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


def safe_identifier(value: str) -> str:
    normalized = re.sub(r"[^0-9A-Za-z_-]+", "_", str(value or "")).strip("_")
    return normalized[:200] or "dataset"


def ensure_rag_schema(db: Session) -> None:
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
        return RagProfileResponse(dataset_id=dataset_id, review_state=row.review_state, index_status=effective_index_status, build_status=row.index_status, serving_status=serving_status, embedding_status=row.embedding_status, schema=dataset_schema(dataset), schema_fingerprint=row.schema_fingerprint or schema_fingerprint(dataset), body_columns=row.body_columns or [], title_columns=row.title_columns or [], metadata_columns=row.metadata_columns or [], identifier_columns=row.identifier_columns or [], excluded_columns=row.excluded_columns or [], classifier=row.classifier, classifier_confidence=row.classifier_confidence, target_alias=row.target_alias, active_index=serving_index, active_source_fingerprint=active_manifest.source_fingerprint if active_manifest else None, active_embedding_model=active_manifest.embedding_model if active_manifest else None, active_embedding_dimensions=active_manifest.dimensions if active_manifest else None, active_chunking_version=active_manifest.chunking_version if active_manifest else None, last_error=row.last_error, semantic_bindings=row.semantic_bindings or {}, recommendations=[{"id": item.id, "columnName": item.column_name, "role": item.role, "confidence": item.confidence, "reason": item.reason, "approved": item.approved} for item in recommendations])

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
        requested = set(request.body_columns) | set(request.title_columns) | set(request.metadata_columns) | set(request.identifier_columns) | set(request.excluded_columns)
        if not requested.issubset(columns):
            raise ApiError("validation_error", "RAG columns must exist in the Catalog Dataset schema", status.HTTP_400_BAD_REQUEST)
        role_sets = [set(request.body_columns), set(request.title_columns), set(request.metadata_columns), set(request.identifier_columns), set(request.excluded_columns)]
        if sum(len(item) for item in role_sets) != len(set().union(*role_sets)):
            raise ApiError("validation_error", "A column cannot have multiple RAG roles", status.HTTP_400_BAD_REQUEST)
        row.body_columns = request.body_columns
        row.title_columns = request.title_columns
        row.metadata_columns = request.metadata_columns
        row.identifier_columns = request.identifier_columns
        row.excluded_columns = request.excluded_columns
        row.review_state = "approved"
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
        documents = build_documents(dataset_id=dataset_id, dataset_name=str(dataset.get("name") or dataset_id), rows=dataset.get("sampleRows") or [], columns=dataset_columns(dataset), body_columns=row.body_columns or [], title_columns=row.title_columns or [], metadata_columns=row.metadata_columns or [], identifier_columns=row.identifier_columns or [], semantic_bindings=row.semantic_bindings or {}, target_index=alias, limit=settings.rag_document_preview_limit)
        return RagDocumentPreviewResponse(dataset_id=dataset_id, target_alias=alias, source_columns=[*(row.body_columns or []), *(row.title_columns or []), *(row.metadata_columns or []), *(row.identifier_columns or [])], documents=documents)

    def validate_search_filters(self, dataset_id: str, actor: ActorContext, filters: dict[str, Any]) -> dict[str, dict[str, Any]]:
        """Validate the public filter DTO against approved Catalog metadata columns.

        The API deliberately rejects unknown fields and the legacy ``{"gte": ...}``
        shorthand.  Otherwise a typo would silently broaden retrieval and a caller
        could query a column that the Dataset owner never approved for RAG metadata.
        """
        dataset = self._dataset(dataset_id, actor, "query")
        profile = self._profile_row(dataset_id)
        schema_by_name = {str(item.get("name")): str(item.get("dataType") or item.get("data_type") or "unknown").casefold() for item in dataset_schema(dataset) if isinstance(item, dict)}
        result: dict[str, dict[str, Any]] = {}
        for field, predicate in (filters or {}).items():
            if field not in set(profile.metadata_columns or []):
                raise ApiError("validation_error", f"RAG filter field '{field}' is not an approved metadata column", status.HTTP_400_BAD_REQUEST)
            if not isinstance(predicate, dict) or set(predicate) != {"operator", "value"}:
                raise ApiError("validation_error", f"RAG filter '{field}' must use {{operator, value}}", status.HTTP_400_BAD_REQUEST)
            operator = predicate.get("operator")
            value = predicate.get("value")
            if operator not in {"eq", "gte", "gt", "lte", "lt"} or value is None:
                raise ApiError("validation_error", f"RAG filter '{field}' has an invalid operator or value", status.HTTP_400_BAD_REQUEST)
            data_type = schema_by_name.get(field, "unknown")
            numeric = any(token in data_type for token in ("int", "float", "double", "decimal", "number", "numeric"))
            temporal = any(token in data_type for token in ("date", "time", "timestamp"))
            if operator != "eq" and not (numeric or temporal):
                raise ApiError("validation_error", f"Range operators are not supported for text metadata column '{field}'", status.HTTP_400_BAD_REQUEST)
            if numeric and not isinstance(value, (int, float)) or numeric and isinstance(value, bool):
                raise ApiError("validation_error", f"RAG filter value for numeric column '{field}' must be numeric", status.HTTP_400_BAD_REQUEST)
            if temporal:
                try:
                    date.fromisoformat(str(value)[:10])
                except ValueError as exc:
                    raise ApiError("validation_error", f"RAG filter value for temporal column '{field}' must be ISO date/time", status.HTTP_400_BAD_REQUEST) from exc
            result[field] = {"operator": operator, "value": value}
        return result

    def index(self, dataset_id: str, actor: ActorContext, *, mode: str = "index", idempotency_key: str | None = None) -> RagIndexResponse:
        dataset = self._dataset(dataset_id, actor, "query")
        require_permission(actor, "publish", owner=dataset.get("owner"), grants=dataset.get("permissionGrants") or [], resource_label="Dataset RAG index")
        row = self._profile_row(dataset_id)
        if row.review_state != "approved":
            raise ApiError("validation_error", "Approve the RAG profile before indexing", status.HTTP_400_BAD_REQUEST)
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
        if mode == "index" and active_manifest is not None and active_manifest.source_fingerprint == (source_fingerprint or None) and active_manifest.policy_fingerprint == policy_fingerprint and active_manifest.embedding_model == settings.rag_embedding_model and active_manifest.index_name:
            return RagIndexResponse(job_id=f"active:{active_manifest.index_name}", dataset_id=dataset_id, status="ready", target_index=active_manifest.index_name)
        job_id = f"ragjob_{uuid4().hex}"
        parent_table = f"{settings.trino_catalog}.{settings.rag_parent_iceberg_namespace}.parents_{safe_identifier(dataset_id)}_{safe_identifier(job_id)}"
        chunk_table = f"{settings.trino_catalog}.{settings.rag_parent_iceberg_namespace}.chunks_{safe_identifier(dataset_id)}_{safe_identifier(job_id)}"
        job = RagIndexJobModel(id=job_id, dataset_id=dataset_id, status="queued", stage="queued", requested_by=actor.name, requested_mode=mode, idempotency_key=idempotency_key, target_index=target, document_count=0, source_fingerprint=source_fingerprint or None, policy_fingerprint=policy_fingerprint, embedding_model=settings.rag_embedding_model, embedding_dimensions=settings.rag_embedding_dimensions, parent_table=parent_table, chunk_table=chunk_table, checkpoint_path=f"{settings.rag_staging_base_path.rstrip('/')}/rag/checkpoints/parents/dataset_id={dataset_id}/job_id={job_id}")
        row.index_status = "queued"
        row.embedding_status = "pending"
        self.db.add(job)
        self.db.commit()
        self._trigger_airflow(job, dataset, row)
        return RagIndexResponse(job_id=job.id, dataset_id=dataset_id, status=job.status, target_index=target)

    def reconcile_source_changes(self, *, limit: int = 20) -> int:
        """Enqueue one idempotent reindex for each changed active Dataset.

        Catalog writes update the source manifest, while the RAG manifest keeps
        the fingerprint used by the active alias.  The control-plane tick is
        the durable event boundary between those two stores; the idempotency
        key makes repeated ticks and multiple API replicas harmless.
        """
        actor = ActorContext(name="rag-reconciler", role="admin")
        active_manifests = self.db.scalars(
            select(RagIndexManifestModel)
            .where(RagIndexManifestModel.status == "active")
            .order_by(RagIndexManifestModel.activated_at.asc())
            .limit(limit)
        ).all()
        enqueued = 0
        for manifest in active_manifests:
            dataset = self.catalog.get_dataset_payload(manifest.dataset_id)
            source = (dataset.get("sourceManifest") or dataset.get("source_manifest")) if isinstance(dataset, dict) else None
            current_fingerprint = str(source.get("fingerprint") or "") if isinstance(source, dict) else ""
            profile = self.db.get(RagDatasetProfileModel, manifest.dataset_id)
            current_policy = self._policy_fingerprint(dataset, profile) if profile and isinstance(dataset, dict) else None
            changed = bool(current_fingerprint and current_fingerprint != manifest.source_fingerprint)
            changed = changed or bool(current_policy and current_policy != manifest.policy_fingerprint)
            changed = changed or bool(profile and manifest.embedding_model != settings.rag_embedding_model)
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
        job = self.db.get(RagIndexJobModel, job_id)
        if job is None:
            raise ApiError("not_found", f"RAG job {job_id} was not found", status.HTTP_404_NOT_FOUND)
        profile = self._profile_row(job.dataset_id)
        result_status = str(result.get("status") or "success")
        stage_updates = {
            "parent_staged": ("staging", "staging", "pending"),
            "chunked": ("chunking", "chunking", "pending"),
            "embedding": ("embedding", "embedding", "generating"),
            "indexing": ("indexing", "indexing", "generating"),
            "validating": ("validating", "validating", "generating"),
        }
        if result_status in stage_updates:
            job.status, job.stage, profile.embedding_status = stage_updates[result_status]
            profile.index_status = job.status
            job.parent_count = int(result.get("parentCount") or job.parent_count)
            job.chunk_count = int(result.get("chunkCount") or job.chunk_count)
            job.failed_count = int(result.get("failedCount") or job.failed_count)
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
            profile.index_status = "failed"
            profile.embedding_status = "failed"
            job.error = str(result.get("error") or "RAG worker failed")
        else:
            if result.get("validationPassed") is not True:
                job.status = "failed"
                job.stage = "failed"
                profile.index_status = "failed"
                profile.embedding_status = "failed"
                job.error = "Activation requires a successful OpenSearch validation result"
                job.completed_at = datetime.now(timezone.utc)
                self.db.commit()
                return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))
            job.status = "ready"
            job.stage = "ready"
            job.indexed_count = int(result.get("indexedCount") or job.document_count)
            job.parent_count = int(result.get("parentCount") or job.parent_count)
            job.chunk_count = int(result.get("chunkCount") or job.chunk_count)
            job.failed_count = int(result.get("failedCount") or job.failed_count)
            job.fallback_count = int(result.get("fallbackCount") or job.fallback_count)
            job.fallback_reasons = result.get("fallbackReasons") if isinstance(result.get("fallbackReasons"), dict) else (job.fallback_reasons or {})
            job.document_count = int(result.get("documentCount") or job.chunk_count or job.document_count)
            job.embedding_dimensions = int(result.get("dimensions") or job.embedding_dimensions or settings.rag_embedding_dimensions)
            profile.index_status = "ready"
            profile.embedding_status = "ready"
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
                    job.completed_at = datetime.now(timezone.utc)
                    self.db.commit()
                    return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))
            profile.active_index = next_index
            for manifest in self.db.scalars(select(RagIndexManifestModel).where(RagIndexManifestModel.dataset_id == job.dataset_id, RagIndexManifestModel.status == "active")).all():
                manifest.status = "retired"
            dataset = self.catalog.get_dataset_payload(job.dataset_id) or {}
            self.db.add(RagIndexManifestModel(id=f"ragmanifest_{uuid4().hex}", dataset_id=job.dataset_id, index_name=profile.active_index or job.target_index or "", alias_name=profile.target_alias or "", status="active", embedding_model=job.embedding_model or settings.rag_embedding_model, dimensions=job.embedding_dimensions or settings.rag_embedding_dimensions, document_count=job.indexed_count, parent_count=job.parent_count, chunk_count=job.chunk_count, failed_count=job.failed_count, fallback_count=job.fallback_count, fallback_reasons=job.fallback_reasons or {}, source_fingerprint=job.source_fingerprint, schema_fingerprint=schema_fingerprint(dataset), policy_fingerprint=job.policy_fingerprint, semantic_bindings_fingerprint=self._semantic_bindings_fingerprint(profile.semantic_bindings), chunking_version=str(result.get("chunkingVersion") or "rag-chunk-v2"), embedding_input_version="title_body_v1", parent_schema_version="rag-parent-v1", activated_at=datetime.now(timezone.utc)))
        job.completed_at = datetime.now(timezone.utc)
        self.db.commit()
        return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))

    def job(self, job_id: str, actor: ActorContext) -> RagJobResponse:
        job = self.db.get(RagIndexJobModel, job_id)
        if job is None:
            raise ApiError("not_found", f"RAG job {job_id} was not found", status.HTTP_404_NOT_FOUND)
        self._dataset(job.dataset_id, actor, "view")
        return RagJobResponse(job_id=job.id, dataset_id=job.dataset_id, status=job.status, requested_mode=job.requested_mode, target_index=job.target_index, document_count=job.document_count, indexed_count=job.indexed_count, parent_count=job.parent_count, chunk_count=job.chunk_count, failed_count=job.failed_count, fallback_count=job.fallback_count, fallback_reasons=job.fallback_reasons or {}, stage=job.stage, source_fingerprint=job.source_fingerprint, policy_fingerprint=job.policy_fingerprint, embedding_model=job.embedding_model, embedding_dimensions=job.embedding_dimensions, parent_table=job.parent_table, chunk_table=job.chunk_table, checkpoint_path=job.checkpoint_path, error=job.error, airflow_run_id=job.airflow_run_id)

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
        required = {"document_id", "parent_document_id", "body", "embedding_text", "body_vector", "metadata_filter", "chunk_index", "chunk_count", "char_start", "char_end", "embedding_model", "embedding_dimensions"}
        missing = sorted(required - set(properties))
        if missing:
            raise ApiError("rag_validation_failed", f"OpenSearch mapping is missing fields: {', '.join(missing)}", status.HTTP_409_CONFLICT)
        vector_mapping = properties.get("body_vector") or {}
        if int(vector_mapping.get("dimension") or 0) != int(job.embedding_dimensions or 0):
            raise ApiError("rag_validation_failed", "OpenSearch vector dimension does not match the job manifest", status.HTTP_409_CONFLICT)
        sample = client.search_raw(job.target_index, {"size": 1, "_source": ["body_vector", "metadata_filter"], "query": {"match_all": {}}})
        sample_hits = sample.get("hits", {}).get("hits", []) if isinstance(sample, dict) else []
        if actual_chunks and not sample_hits:
            raise ApiError("rag_validation_failed", "OpenSearch BM25 smoke query returned no document", status.HTTP_409_CONFLICT)
        if sample_hits:
            sample_source = sample_hits[0].get("_source") or {}
            vector = sample_source.get("body_vector")
            if not isinstance(vector, list) or len(vector) != int(job.embedding_dimensions or 0):
                raise ApiError("rag_validation_failed", "OpenSearch stored vector is missing or has the wrong dimension", status.HTTP_409_CONFLICT)
            client.search(job.target_index, {"size": 1, "query": {"knn": {"body_vector": {"vector": vector, "k": 1}}}})
            metadata = sample_source.get("metadata_filter") if isinstance(sample_source.get("metadata_filter"), dict) else {}
            if metadata:
                field, typed = next(iter(metadata.items()))
                if isinstance(typed, dict) and typed:
                    typed_field = next((candidate for candidate in ("keyword", "number", "date", "boolean") if candidate in typed), next(iter(typed)))
                    typed_value = typed[typed_field]
                    client.search(job.target_index, {"size": 1, "query": {"term": {f"metadata_filter.{field}.{typed_field}": typed_value}}})
        return {"validationPassed": True, "validatedIndex": job.target_index, "documentCount": actual_chunks, "parentCount": actual_parents, "dimensions": job.embedding_dimensions}

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
            "body": sorted(profile.body_columns or []),
            "title": sorted(profile.title_columns or []),
            "metadata": sorted(profile.metadata_columns or []),
            "identifier": sorted(profile.identifier_columns or []),
            "chunkTargetTokens": settings.rag_chunk_target_tokens,
            "chunkOverlapTokens": settings.rag_chunk_overlap_tokens,
            "chunkMaxTokens": settings.rag_chunk_max_tokens,
            "embeddingInputVersion": "title_body_v1",
            "chunkingVersion": "rag-chunk-v2",
            "embeddingModel": settings.rag_embedding_model,
            "embeddingDimensions": settings.rag_embedding_dimensions,
            "semanticBindings": profile.semantic_bindings or {},
        }
        return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    @staticmethod
    def _semantic_bindings_fingerprint(bindings: dict[str, Any] | None) -> str:
        return hashlib.sha256(json.dumps(bindings or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    def _trigger_airflow(self, job: RagIndexJobModel, dataset: dict[str, Any], profile: RagDatasetProfileModel) -> None:
        if not settings.airflow_api_base_url or not settings.airflow_api_token:
            job.status = "failed"
            job.stage = "failed"
            job.error = "RAG orchestration is not configured: AIRFLOW_API_BASE_URL and AIRFLOW_API_TOKEN are required"
            job.completed_at = datetime.now(timezone.utc)
            self.db.commit()
            return
        source_manifest = dataset.get("sourceManifest") or dataset.get("source_manifest")
        if not isinstance(source_manifest, dict) or source_manifest.get("manifestVersion") != 1 or source_manifest.get("datasetId") != job.dataset_id or not source_manifest.get("readUrl") or not source_manifest.get("sparkPath") or not source_manifest.get("format") or not source_manifest.get("fingerprint") or not source_manifest.get("expiresAt"):
            job.status = "failed"
            job.stage = "failed"
            job.error = "Catalog-issued sourceManifest with datasetId, readUrl, sparkPath, format, fingerprint, and expiry is required for Airflow indexing"
            job.completed_at = datetime.now(timezone.utc)
            self.db.commit()
            return
        import httpx
        dag_run_id = f"rag_{job.id}"
        payload = {"dag_run_id": dag_run_id, "conf": {"jobId": job.id, "datasetId": job.dataset_id, "targetIndex": job.target_index, "sourceManifest": source_manifest, "sourcePath": source_manifest["sparkPath"], "sourceFormat": source_manifest.get("format"), "sourceFingerprint": job.source_fingerprint, "datasetName": dataset.get("name"), "schema": dataset_schema(dataset), "bodyColumns": profile.body_columns, "titleColumns": profile.title_columns, "metadataColumns": profile.metadata_columns, "identifierColumns": profile.identifier_columns, "semanticBindings": profile.semantic_bindings, "policyFingerprint": job.policy_fingerprint, "embeddingModel": job.embedding_model, "embeddingDimensions": job.embedding_dimensions, "stagingBasePath": settings.rag_staging_base_path, "parentTable": job.parent_table, "chunkTable": job.chunk_table, "chunkTargetTokens": settings.rag_chunk_target_tokens, "chunkOverlapTokens": settings.rag_chunk_overlap_tokens, "chunkMaxTokens": settings.rag_chunk_max_tokens}}
        response = httpx.post(f"{settings.airflow_api_base_url.rstrip('/')}/api/v2/dags/{settings.rag_airflow_dag_id}/dagRuns", json=payload, headers={"Authorization": f"Bearer {settings.airflow_api_token}", "Content-Type": "application/json"}, timeout=settings.airflow_request_timeout_seconds)
        if response.status_code >= 400:
            job.status = "failed"
            job.stage = "failed"
            job.error = "Airflow rejected the RAG index request"
            job.completed_at = datetime.now(timezone.utc)
            self.db.commit()
            return
        job.airflow_run_id = dag_run_id
        self.db.commit()
