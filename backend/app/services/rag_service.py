from datetime import date, datetime, timezone
import hashlib
import json
import math
import re
from typing import Any
from uuid import uuid4

from fastapi import status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, require_permission
from app.core.config import settings
from app.core.errors import ApiError
from app.models.semantic_rag import RagClassificationRunModel, RagColumnRecommendationModel, RagDatasetProfileModel, RagIndexJobModel, RagIndexManifestModel
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.common import ErrorCode
from app.schemas.semantic import RagApproveRequest, RagClassifyResponse, RagDocumentPreviewResponse, RagIndexResponse, RagProfileResponse
from app.services.ai_gateway_client import AiGatewayClient
from app.services.catalog_schema import dataset_schema, schema_fingerprint
from app.services.rag_contracts import (
    CHUNKING_VERSION,
    EMBEDDING_INPUT_VERSION,
    FIELD_RENDERING_VERSION,
    FILTER_CONTRACT_VERSION,
    RAG_JOB_LIST_DEFAULT_LIMIT,
    RAG_JOB_LIST_MAX_LIMIT,
    RAG_JOB_STAGES,
    RAG_PARENT_SCHEMA_VERSION,
)
from app.services.rag_document_service import build_documents, dataset_columns
from app.services.rag_job_lifecycle import RagJobLifecycleMixin
from app.services.resource_permission_service import dataset_with_persisted_permission_grants


RAG_TABLES = [RagDatasetProfileModel.__table__, RagClassificationRunModel.__table__, RagColumnRecommendationModel.__table__, RagIndexJobModel.__table__, RagIndexManifestModel.__table__]


def safe_identifier(value: str) -> str:
    # Iceberg/Spark SQL identifiers are unquoted here, so hyphens are not
    # valid even though they are valid in Dataset and job IDs.
    normalized = re.sub(r"[^0-9A-Za-z_]+", "_", str(value or "")).strip("_")
    return normalized[:200] or "dataset"


def ensure_rag_schema(db: Session) -> None:
    # Production schema is owned by Alembic.  Local/test environments retain
    # the convenience bootstrap used by the existing in-memory test harness.
    if not settings.rag_runtime_create_schema and not settings.allows_header_auth_fallback:
        return
    from app.models.base import Base
    Base.metadata.create_all(bind=db.get_bind(), tables=RAG_TABLES)


class RagService(RagJobLifecycleMixin):
    def __init__(self, db: Session) -> None:
        self.db = db
        ensure_rag_schema(db)
        self.catalog = CatalogRepository(db)

    def profile(self, dataset_id: str, actor: ActorContext) -> RagProfileResponse:
        dataset = self._dataset(dataset_id, actor, "view")
        # Use the same initializer as classify/approve/index.  Constructing a
        # model directly here leaves SQLAlchemy client-side defaults as None
        # until flush, which made a first profile GET fail Pydantic validation
        # for all status fields.
        row = self._profile_row(dataset_id)
        active_manifest = self.db.scalar(select(RagIndexManifestModel).where(RagIndexManifestModel.dataset_id == dataset_id, RagIndexManifestModel.status == "active").order_by(RagIndexManifestModel.activated_at.desc()))
        recommendations = self.db.scalars(select(RagColumnRecommendationModel).where(RagColumnRecommendationModel.dataset_id == dataset_id).order_by(RagColumnRecommendationModel.column_name.asc())).all()
        current_source = dataset.get("sourceManifest") or dataset.get("source_manifest") or {}
        current_source_fingerprint = str(current_source.get("fingerprint") or "") if isinstance(current_source, dict) else ""
        current_policy = self._policy_fingerprint(dataset, row) if row.review_state == "approved" else None
        contract_changed = bool(active_manifest and row.review_state == "approved" and not self._manifest_contract_matches(dataset, row, active_manifest))
        stale = bool(active_manifest and ((current_source_fingerprint and active_manifest.source_fingerprint != current_source_fingerprint) or (current_policy and active_manifest.policy_fingerprint != current_policy) or contract_changed))
        serving_status = "stale" if stale else "serving" if active_manifest and (active_manifest.index_name or row.active_index) else "not_serving"
        effective_index_status = "stale" if stale else row.index_status
        serving_index = active_manifest.index_name if active_manifest else row.active_index
        return RagProfileResponse(dataset_id=dataset_id, review_state=row.review_state, index_status=effective_index_status, build_status=row.index_status, serving_status=serving_status, embedding_status=row.embedding_status, schema=dataset_schema(dataset), schema_fingerprint=row.schema_fingerprint or schema_fingerprint(dataset), body_columns=row.body_columns or [], title_columns=row.title_columns or [], metadata_columns=row.metadata_columns or [], identifier_columns=row.identifier_columns or [], excluded_columns=row.excluded_columns or [], classifier=row.classifier, classifier_confidence=row.classifier_confidence, target_alias=row.target_alias, active_index=serving_index, active_source_fingerprint=active_manifest.source_fingerprint if active_manifest else None, active_embedding_provider=active_manifest.embedding_provider if active_manifest else None, active_embedding_model=active_manifest.embedding_model if active_manifest else None, active_embedding_dimensions=active_manifest.dimensions if active_manifest else None, active_chunking_version=active_manifest.chunking_version if active_manifest else None, last_error=row.last_error, semantic_bindings=row.semantic_bindings or {}, physical_column_mapping=row.physical_column_mapping or {}, recommendations=[{"id": item.id, "columnName": item.column_name, "role": item.role, "confidence": item.confidence, "reason": item.reason, "approved": item.approved} for item in recommendations])

    def classify(self, dataset_id: str, actor: ActorContext, semantic_model_id: str | None = None) -> RagClassifyResponse:
        dataset = self._dataset(dataset_id, actor, "manage")
        row = self._profile_row(dataset_id)
        semantic_bindings = self._semantic_bindings(dataset_id, semantic_model_id, actor)
        classification_input = self._classification_input(dataset, semantic_bindings)
        run = RagClassificationRunModel(id=f"ragcr_{uuid4().hex}", dataset_id=dataset_id, status="running", model="pending", input_snapshot=classification_input)
        row.review_state = "classifying"
        row.schema_fingerprint = schema_fingerprint(dataset)
        row.semantic_bindings = semantic_bindings
        self.db.add(run)
        self.db.flush()
        try:
            output = AiGatewayClient().classify_dataset(run.id, classification_input)
        except Exception as exc:
            run.status = "failed"
            run.error = f"AI gateway classification unavailable ({exc.__class__.__name__})"
            run.completed_at = datetime.now(timezone.utc)
            row.review_state = "failed"
            row.last_error = "AI Gateway classification failed; no local classification was substituted."
            self.db.commit()
            if isinstance(exc, ApiError):
                raise
            raise ApiError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "AI gateway classification failed",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            ) from exc
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
        role_columns = {
            "bodyColumns": request.body_columns,
            "titleColumns": request.title_columns,
            "metadataColumns": request.metadata_columns,
            "identifierColumns": request.identifier_columns,
            "excludedColumns": request.excluded_columns,
        }
        for role_name, values in role_columns.items():
            if len(values) != len(set(values)):
                raise ApiError("validation_error", f"{role_name} cannot contain duplicate columns", status.HTTP_400_BAD_REQUEST)
        requested = set().union(*(set(values) for values in role_columns.values()))
        if not requested.issubset(columns):
            raise ApiError("validation_error", "RAG columns must exist in the Catalog Dataset schema", status.HTTP_400_BAD_REQUEST)
        body_columns = set(request.body_columns)
        title_columns = set(request.title_columns)
        metadata_columns = set(request.metadata_columns)
        identifier_columns = set(request.identifier_columns)
        disallowed_role_overlaps = (
            ("bodyColumns", body_columns, "titleColumns", title_columns),
            ("titleColumns", title_columns, "metadataColumns", metadata_columns),
            ("titleColumns", title_columns, "identifierColumns", identifier_columns),
            ("metadataColumns", metadata_columns, "identifierColumns", identifier_columns),
        )
        for left_name, left_columns, right_name, right_columns in disallowed_role_overlaps:
            conflicts = sorted(left_columns & right_columns)
            if conflicts:
                raise ApiError("validation_error", f"{left_name} and {right_name} cannot overlap: {', '.join(conflicts)}", status.HTTP_400_BAD_REQUEST)
        excluded_columns = set(request.excluded_columns)
        excluded_conflicts = sorted(excluded_columns & (body_columns | title_columns | metadata_columns | identifier_columns))
        if excluded_conflicts:
            raise ApiError("validation_error", f"excludedColumns cannot overlap another RAG role: {', '.join(excluded_conflicts)}", status.HTTP_400_BAD_REQUEST)
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
            source_columns = list(dict.fromkeys([*(row.body_columns or []), *(row.title_columns or []), *(row.metadata_columns or []), *(row.identifier_columns or [])]))
            return RagDocumentPreviewResponse(dataset_id=dataset_id, target_alias=alias, source_columns=source_columns, documents=documents)
        documents = build_documents(dataset_id=dataset_id, dataset_name=str(dataset.get("name") or dataset_id), rows=dataset.get("sampleRows") or [], columns=dataset_columns(dataset), body_columns=row.body_columns or [], title_columns=row.title_columns or [], metadata_columns=row.metadata_columns or [], identifier_columns=row.identifier_columns or [], semantic_bindings=row.semantic_bindings or {}, schema_types={str(item.get("name")): str(item.get("dataType") or item.get("data_type") or "") for item in dataset_schema(dataset) if isinstance(item, dict) and item.get("name")}, physical_column_mapping=row.physical_column_mapping or {}, target_index=alias, limit=settings.rag_document_preview_limit)
        source_columns = list(dict.fromkeys([*(row.body_columns or []), *(row.title_columns or []), *(row.metadata_columns or []), *(row.identifier_columns or [])]))
        return RagDocumentPreviewResponse(dataset_id=dataset_id, target_alias=alias, source_columns=source_columns, documents=documents)

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
            if (
                numeric
                and (
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(float(value))
                )
            ):
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

    def search_target_context(
        self,
        dataset_id: str,
        actor: ActorContext,
        *,
        profile: RagProfileResponse | None = None,
    ) -> dict[str, Any]:
        """Build the bounded, approved Dataset contract used by RAG query planning."""
        dataset = self._dataset(dataset_id, actor, "query")
        resolved_profile = profile or self.profile(dataset_id, actor)
        active_manifest = self.db.scalar(
            select(RagIndexManifestModel)
            .where(
                RagIndexManifestModel.dataset_id == dataset_id,
                RagIndexManifestModel.status == "active",
            )
            .order_by(RagIndexManifestModel.activated_at.desc())
        )
        schema_by_name = {
            str(item.get("name")): str(item.get("dataType") or item.get("data_type") or "unknown")
            for item in dataset_schema(dataset)
            if isinstance(item, dict) and item.get("name")
        }
        metadata_columns = list(
            active_manifest.metadata_columns
            if active_manifest and active_manifest.metadata_columns
            else resolved_profile.metadata_columns
        )
        physical_mapping = (
            active_manifest.physical_column_mapping
            if active_manifest and active_manifest.physical_column_mapping
            else resolved_profile.physical_column_mapping
        ) or self._physical_column_mapping(dataset_schema(dataset))
        metadata_types = active_manifest.metadata_types if active_manifest and active_manifest.metadata_types else {}
        return {
            "datasetId": dataset_id,
            "datasetName": str(dataset.get("name") or dataset_id),
            "description": str(dataset.get("description") or "")[:2_000],
            "embeddingProvider": active_manifest.embedding_provider if active_manifest else resolved_profile.active_embedding_provider,
            "embeddingModel": active_manifest.embedding_model if active_manifest else resolved_profile.active_embedding_model,
            "embeddingDimensions": active_manifest.dimensions if active_manifest else resolved_profile.active_embedding_dimensions,
            "titleFields": list(resolved_profile.title_columns),
            "bodyFields": list(resolved_profile.body_columns),
            "metadataFields": [
                {
                    "logicalField": logical,
                    "physicalField": str(physical_mapping.get(logical) or self._physical_column_name(logical)),
                    "storageType": self._storage_type(
                        str(
                            metadata_types.get(str(physical_mapping.get(logical) or self._physical_column_name(logical)))
                            or schema_by_name.get(logical)
                            or "unknown"
                        )
                    ),
                }
                for logical in metadata_columns
            ],
        }

    @staticmethod
    def _storage_type(data_type: str) -> str:
        normalized = data_type.casefold()
        if any(token in normalized for token in ("int", "long", "bigint", "float", "double", "decimal", "number", "numeric")):
            return "number"
        if any(token in normalized for token in ("date", "time", "timestamp")):
            return "date"
        if "bool" in normalized:
            return "boolean"
        return "keyword"

    @classmethod
    def _metadata_filter_contract(cls, dataset: dict[str, Any], profile: RagDatasetProfileModel) -> tuple[list[str], dict[str, str], dict[str, str]]:
        schema = dataset_schema(dataset)
        mapping = profile.physical_column_mapping or cls._physical_column_mapping(schema)
        schema_by_name = {str(item.get("name")): str(item.get("dataType") or item.get("data_type") or "string") for item in schema if isinstance(item, dict) and item.get("name")}
        metadata_columns = list(profile.metadata_columns or [])
        metadata_types = {mapping.get(logical, cls._physical_column_name(logical)): schema_by_name.get(logical, "string") for logical in metadata_columns}
        return metadata_columns, mapping, metadata_types

    @staticmethod
    def _contract_version_snapshot() -> dict[str, str]:
        return {
            "parentSchemaVersion": RAG_PARENT_SCHEMA_VERSION,
            "embeddingInputVersion": EMBEDDING_INPUT_VERSION,
            "chunkingVersion": CHUNKING_VERSION,
            "fieldRenderingVersion": FIELD_RENDERING_VERSION,
            "filterContractVersion": FILTER_CONTRACT_VERSION,
        }

    @staticmethod
    def _role_snapshot(profile: RagDatasetProfileModel) -> dict[str, list[str]]:
        return {
            "bodyColumns": list(profile.body_columns or []),
            "titleColumns": list(profile.title_columns or []),
            "metadataColumns": list(profile.metadata_columns or []),
            "identifierColumns": list(profile.identifier_columns or []),
        }

    @staticmethod
    def _configured_embedding_provider(
        active_manifest: RagIndexManifestModel | None,
        existing_job: RagIndexJobModel | None = None,
    ) -> str | None:
        fallback = str(
            (active_manifest.embedding_provider if active_manifest is not None else None)
            or (existing_job.embedding_provider_snapshot if existing_job is not None else None)
            or ""
        ).strip() or None
        if not settings.ai_gateway_base_url or not settings.ai_gateway_service_token:
            return fallback
        try:
            provider = str(AiGatewayClient().health_status().get("provider") or "").strip()
        except Exception:
            return fallback
        return provider or fallback

    @classmethod
    def _job_request_contract(
        cls,
        *,
        mode: str,
        source_fingerprint: str | None,
        policy_fingerprint: str,
        embedding_provider: str | None,
        embedding_model: str,
        embedding_dimensions: int,
        roles: dict[str, list[str]],
        versions: dict[str, str],
    ) -> dict[str, Any]:
        return {
            "mode": mode,
            "sourceFingerprint": source_fingerprint,
            "policyFingerprint": policy_fingerprint,
            "embeddingProvider": embedding_provider,
            "embeddingModel": embedding_model,
            "embeddingDimensions": embedding_dimensions,
            "roles": roles,
            "versions": versions,
        }

    @staticmethod
    def _request_fingerprint(contract: dict[str, Any]) -> str:
        encoded = json.dumps(contract, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    @classmethod
    def _idempotency_mismatches(
        cls,
        existing: RagIndexJobModel,
        contract: dict[str, Any],
        request_fingerprint: str,
    ) -> list[str]:
        roles = contract["roles"]
        comparisons = {
            "mode": (existing.requested_mode, contract["mode"]),
            "sourceFingerprint": (existing.source_fingerprint, contract["sourceFingerprint"]),
            "policyFingerprint": (existing.policy_fingerprint, contract["policyFingerprint"]),
            "embeddingProvider": (existing.embedding_provider_snapshot, contract["embeddingProvider"]),
            "embeddingModel": (existing.embedding_model, contract["embeddingModel"]),
            "embeddingDimensions": (existing.embedding_dimensions, contract["embeddingDimensions"]),
            "bodyColumns": (list(existing.body_columns or []), roles["bodyColumns"]),
            "titleColumns": (list(existing.title_columns or []), roles["titleColumns"]),
            "metadataColumns": (list(existing.metadata_columns or []), roles["metadataColumns"]),
            "identifierColumns": (list(existing.identifier_columns or []), roles["identifierColumns"]),
            "versions": (dict(existing.contract_versions or {}), contract["versions"]),
        }
        mismatches = [name for name, (stored, requested) in comparisons.items() if stored != requested]
        if existing.request_fingerprint is None:
            mismatches.append("requestFingerprint")
        elif existing.request_fingerprint != request_fingerprint and not mismatches:
            mismatches.append("requestFingerprint")
        return mismatches

    def index(self, dataset_id: str, actor: ActorContext, *, mode: str = "index", idempotency_key: str | None = None) -> RagIndexResponse:
        if mode not in {"index", "reindex"}:
            raise ApiError("validation_error", "RAG index mode must be index or reindex", status.HTTP_400_BAD_REQUEST)
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
        policy_fingerprint = self._policy_fingerprint(dataset, row)
        metadata_columns, physical_mapping, metadata_types = self._metadata_filter_contract(dataset, row)
        active_manifest = self.db.scalar(
            select(RagIndexManifestModel)
            .where(RagIndexManifestModel.dataset_id == dataset_id, RagIndexManifestModel.status == "active")
            .order_by(RagIndexManifestModel.generation.desc(), RagIndexManifestModel.activated_at.desc())
        )
        existing = None
        if idempotency_key:
            existing = self.db.scalar(select(RagIndexJobModel).where(RagIndexJobModel.dataset_id == dataset_id, RagIndexJobModel.idempotency_key == idempotency_key))
        embedding_provider_snapshot = self._configured_embedding_provider(active_manifest, existing)
        roles = self._role_snapshot(row)
        versions = self._contract_version_snapshot()
        request_contract = self._job_request_contract(
            mode=mode,
            source_fingerprint=source_fingerprint or None,
            policy_fingerprint=policy_fingerprint,
            embedding_provider=embedding_provider_snapshot,
            embedding_model=settings.rag_embedding_model,
            embedding_dimensions=settings.rag_embedding_dimensions,
            roles=roles,
            versions=versions,
        )
        request_fingerprint = self._request_fingerprint(request_contract)
        if existing is not None:
            mismatches = self._idempotency_mismatches(existing, request_contract, request_fingerprint)
            if mismatches:
                raise ApiError(
                    "idempotency_conflict",
                    "The idempotency key was already used for a different immutable RAG request",
                    status.HTTP_409_CONFLICT,
                    {"mismatchedFields": mismatches},
                )
            return RagIndexResponse(job_id=existing.id, dataset_id=dataset_id, status=existing.status, target_index=existing.target_index)
        alias = row.target_alias or f"{settings.rag_index_prefix}-ds-{dataset_id}"
        target = f"{alias}-v{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:6]}"
        if mode == "index" and active_manifest is not None and active_manifest.source_fingerprint == (source_fingerprint or None) and active_manifest.policy_fingerprint == policy_fingerprint and active_manifest.embedding_provider == embedding_provider_snapshot and active_manifest.embedding_model == settings.rag_embedding_model and active_manifest.dimensions == settings.rag_embedding_dimensions and active_manifest.index_name and self._manifest_contract_matches(dataset, row, active_manifest):
            return RagIndexResponse(job_id=f"active:{active_manifest.index_name}", dataset_id=dataset_id, status="ready", target_index=active_manifest.index_name)
        job_id = f"ragjob_{uuid4().hex}"
        spark_catalog = str(settings.asklake_spark_iceberg_catalog_name or settings.trino_catalog).strip()
        parent_table = f"{spark_catalog}.{settings.rag_parent_iceberg_namespace}.parents_{safe_identifier(dataset_id)}_{safe_identifier(job_id)}"
        chunk_table = f"{spark_catalog}.{settings.rag_parent_iceberg_namespace}.chunks_{safe_identifier(dataset_id)}_{safe_identifier(job_id)}"
        row.desired_generation = int(row.desired_generation or 0) + 1
        job = RagIndexJobModel(id=job_id, dataset_id=dataset_id, generation=row.desired_generation, physical_column_mapping=physical_mapping, body_columns=roles["bodyColumns"], title_columns=roles["titleColumns"], metadata_columns=metadata_columns, identifier_columns=roles["identifierColumns"], metadata_types=metadata_types, contract_versions=versions, filter_contract_version=FILTER_CONTRACT_VERSION, status="queued", stage="queued", requested_by=actor.name, requested_mode=mode, idempotency_key=idempotency_key, request_fingerprint=request_fingerprint, target_index=target, document_count=0, source_fingerprint=source_fingerprint or None, policy_fingerprint=policy_fingerprint, embedding_provider_snapshot=embedding_provider_snapshot, embedding_model=settings.rag_embedding_model, embedding_dimensions=settings.rag_embedding_dimensions, failed_row_rate_threshold=settings.rag_failed_row_rate_threshold, parent_table=parent_table, chunk_table=chunk_table, checkpoint_path=f"{settings.rag_staging_base_path.rstrip('/')}/rag/checkpoints/parents/dataset_id={dataset_id}/job_id={job_id}")
        row.index_status = "queued"
        row.embedding_status = "pending"
        self.db.add(job)
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            if not idempotency_key:
                raise
            winner = self.db.scalar(
                select(RagIndexJobModel).where(
                    RagIndexJobModel.dataset_id == dataset_id,
                    RagIndexJobModel.idempotency_key == idempotency_key,
                )
            )
            if winner is None:
                raise
            mismatches = self._idempotency_mismatches(winner, request_contract, request_fingerprint)
            if mismatches:
                raise ApiError(
                    "idempotency_conflict",
                    "The idempotency key was concurrently used for a different immutable RAG request",
                    status.HTTP_409_CONFLICT,
                    {"mismatchedFields": mismatches},
                )
            return RagIndexResponse(job_id=winner.id, dataset_id=dataset_id, status=winner.status, target_index=winner.target_index)
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
            contract_changed = bool(profile and isinstance(dataset, dict) and not self._manifest_contract_matches(dataset, profile, manifest))
            current_embedding_provider = self._configured_embedding_provider(manifest)
            changed = bool(current_fingerprint and current_fingerprint != manifest.source_fingerprint)
            changed = changed or bool(current_policy and current_policy != manifest.policy_fingerprint)
            changed = changed or contract_changed
            changed = changed or manifest.embedding_provider != current_embedding_provider
            changed = changed or bool(profile and manifest.embedding_model != settings.rag_embedding_model)
            changed = changed or bool(profile and manifest.dimensions != settings.rag_embedding_dimensions)
            if not changed:
                continue
            if profile is None or current_policy is None:
                continue
            auto_contract = self._job_request_contract(
                mode="reindex",
                source_fingerprint=current_fingerprint or None,
                policy_fingerprint=current_policy,
                embedding_provider=current_embedding_provider,
                embedding_model=settings.rag_embedding_model,
                embedding_dimensions=settings.rag_embedding_dimensions,
                roles=self._role_snapshot(profile),
                versions=self._contract_version_snapshot(),
            )
            key = f"auto-reindex:{self._request_fingerprint(auto_contract)}"
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

    def _apply_classification(self, run: RagClassificationRunModel, profile: RagDatasetProfileModel, output: dict[str, Any]) -> None:
        run.status = "completed"
        payload = output if isinstance(output, dict) else {}
        run.model = str(payload.get("model") or "unknown")
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
        role_columns = [str(item.get("columnName") or "") for item in roles]
        contract_errors: list[str] = []
        if len(roles) != len(raw_roles):
            contract_errors.append("unknown columns or roles")
        if len(role_columns) != len(set(role_columns)):
            contract_errors.append("duplicate columns")
        if set(role_columns) != schema_columns:
            contract_errors.append("incomplete schema coverage")
        has_search_text = any(item.get("role") in {"body", "title"} for item in roles)
        if not has_search_text:
            contract_errors.append("no searchable title/body field")
        if not any(item.get("role") == "identifier" for item in roles):
            contract_errors.append("no stable identifier field")
        if contract_errors:
            run.error = f"AI classification requires manual review: {', '.join(contract_errors)}"
        profile.review_state = "candidate" if roles and not contract_errors else "needs_review"
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
        metadata_columns, physical_mapping, metadata_types = RagService._metadata_filter_contract(dataset, profile)
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
            "parentSchemaVersion": RAG_PARENT_SCHEMA_VERSION,
            "filterContractVersion": FILTER_CONTRACT_VERSION,
            "metadataColumns": metadata_columns,
            "metadataPhysicalMapping": {str(column): physical_mapping.get(str(column), RagService._physical_column_name(column)) for column in metadata_columns},
            "metadataTypes": metadata_types,
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

    @classmethod
    def _manifest_contract_matches(cls, dataset: dict[str, Any], profile: RagDatasetProfileModel, manifest: RagIndexManifestModel) -> bool:
        metadata_columns, physical_mapping, metadata_types = cls._metadata_filter_contract(dataset, profile)
        expected_mapping = {str(column): physical_mapping.get(str(column), cls._physical_column_name(column)) for column in metadata_columns}
        actual_mapping = {str(column): (manifest.physical_column_mapping or {}).get(str(column)) for column in metadata_columns}
        actual_types = {str(key): str(value) for key, value in (manifest.metadata_types or {}).items()}
        roles = cls._role_snapshot(profile)
        versions = cls._contract_version_snapshot()
        return (
            bool(str(manifest.embedding_provider or "").strip())
            and manifest.embedding_model == settings.rag_embedding_model
            and manifest.dimensions == settings.rag_embedding_dimensions
            and manifest.parent_schema_version == RAG_PARENT_SCHEMA_VERSION
            and manifest.embedding_input_version == EMBEDDING_INPUT_VERSION
            and manifest.chunking_version == CHUNKING_VERSION
            and manifest.filter_contract_version == FILTER_CONTRACT_VERSION
            and dict(manifest.contract_versions or {}) == versions
            and manifest.semantic_bindings_fingerprint == cls._semantic_bindings_fingerprint(profile.semantic_bindings)
            and list(manifest.body_columns or []) == roles["bodyColumns"]
            and list(manifest.title_columns or []) == roles["titleColumns"]
            and list(manifest.metadata_columns or []) == metadata_columns
            and list(manifest.identifier_columns or []) == roles["identifierColumns"]
            and actual_mapping == expected_mapping
            and actual_types == {str(key): str(value) for key, value in metadata_types.items()}
        )

    def _fail_airflow_dispatch(self, job: RagIndexJobModel, message: str) -> None:
        locked_job = self.db.scalar(select(RagIndexJobModel).where(RagIndexJobModel.id == job.id).with_for_update()) or job
        profile = self.db.scalar(
            select(RagDatasetProfileModel)
            .where(RagDatasetProfileModel.dataset_id == locked_job.dataset_id)
            .with_for_update()
        )
        locked_job.status = "failed"
        locked_job.stage = "failed"
        locked_job.error = message
        locked_job.completed_at = datetime.now(timezone.utc)
        if profile is not None and int(locked_job.generation or 0) == int(profile.desired_generation or 0):
            profile.index_status = "failed"
            profile.embedding_status = "failed"
            profile.last_error = message
        self.db.commit()

    def _trigger_airflow(self, job: RagIndexJobModel, dataset: dict[str, Any], profile: RagDatasetProfileModel) -> None:
        airflow_token = settings.airflow_api_token or self._airflow_login_token()
        if not settings.airflow_api_base_url or not airflow_token:
            self._fail_airflow_dispatch(job, "RAG orchestration is not configured: AIRFLOW_API_BASE_URL and Airflow credentials are required")
            return
        source_manifest = dataset.get("sourceManifest") or dataset.get("source_manifest")
        if not isinstance(source_manifest, dict) or source_manifest.get("manifestVersion") != 1 or source_manifest.get("datasetId") != job.dataset_id or not source_manifest.get("readUrl") or not source_manifest.get("sparkPath") or not source_manifest.get("format") or not source_manifest.get("fingerprint") or not source_manifest.get("expiresAt"):
            self._fail_airflow_dispatch(job, "Catalog-issued sourceManifest with datasetId, readUrl, sparkPath, format, fingerprint, and expiry is required for Airflow indexing")
            return
        import httpx
        dag_run_id = f"rag_{job.id}"
        versions = job.contract_versions or self._contract_version_snapshot()
        payload = {"dag_run_id": dag_run_id, "logical_date": None, "conf": {"jobId": job.id, "datasetId": job.dataset_id, "targetIndex": job.target_index, "sourceManifest": source_manifest, "sourcePath": source_manifest["sparkPath"], "sourceFormat": source_manifest.get("format"), "sourceFingerprint": job.source_fingerprint, "datasetName": dataset.get("name"), "schema": dataset_schema(dataset), "bodyColumns": job.body_columns or [], "titleColumns": job.title_columns or [], "metadataColumns": job.metadata_columns or [], "metadataTypes": job.metadata_types or {}, "filterContractVersion": versions.get("filterContractVersion") or job.filter_contract_version, "identifierColumns": job.identifier_columns or [], "semanticBindings": profile.semantic_bindings, "physicalColumnMapping": job.physical_column_mapping or {}, "policyFingerprint": job.policy_fingerprint, "embeddingProvider": job.embedding_provider_snapshot, "embeddingModel": job.embedding_model, "embeddingDimensions": job.embedding_dimensions, "parentSchemaVersion": versions.get("parentSchemaVersion"), "embeddingInputVersion": versions.get("embeddingInputVersion"), "chunkingVersion": versions.get("chunkingVersion"), "fieldRenderingVersion": versions.get("fieldRenderingVersion"), "failedRowRateThreshold": job.failed_row_rate_threshold, "stagingBasePath": settings.rag_staging_base_path, "parentTable": job.parent_table, "chunkTable": job.chunk_table, "chunkTargetTokens": settings.rag_chunk_target_tokens, "chunkOverlapTokens": settings.rag_chunk_overlap_tokens, "chunkMaxTokens": settings.rag_chunk_max_tokens}}
        try:
            response = httpx.post(f"{settings.airflow_api_base_url.rstrip('/')}/api/v2/dags/{settings.rag_airflow_dag_id}/dagRuns", json=payload, headers={"Authorization": f"Bearer {airflow_token}", "Content-Type": "application/json"}, timeout=settings.airflow_request_timeout_seconds)
        except (httpx.HTTPError, TimeoutError) as exc:
            self._fail_airflow_dispatch(job, f"Airflow RAG dispatch failed before acknowledgement: {exc.__class__.__name__}")
            return
        if response.status_code >= 400:
            self._fail_airflow_dispatch(job, f"Airflow rejected the RAG index request ({response.status_code}): {response.text[:500]}")
            return
        job.airflow_run_id = dag_run_id
        self.db.commit()

    @staticmethod
    def _airflow_login_token() -> str | None:
        """Authenticate against Airflow FAB when no static API JWT is configured.

        Airflow 3 with the FAB auth manager exposes the browser login flow and
        stores the API JWT in the ``_token`` cookie.  The RAG endpoint used to
        require AIRFLOW_API_TOKEN unconditionally, even though the Compose
        contract already supplies AIRFLOW_USERNAME/PASSWORD.  Reusing that
        contract keeps local and production deployments consistent while still
        preferring a static service token when one is explicitly configured.
        """
        if not settings.airflow_api_base_url or not settings.airflow_username or not settings.airflow_password:
            return None
        import httpx

        base_url = settings.airflow_api_base_url.rstrip("/")
        try:
            with httpx.Client(timeout=settings.airflow_request_timeout_seconds, follow_redirects=True) as client:
                login_page = client.get(f"{base_url}/auth/login/")
                if login_page.status_code >= 400:
                    return None
                csrf_match = re.search(r'name=["\']csrf_token["\'][^>]*value=["\']([^"\']+)', login_page.text)
                if not csrf_match:
                    return None
                login_response = client.post(
                    f"{base_url}/auth/login/",
                    data={"csrf_token": csrf_match.group(1), "username": settings.airflow_username, "password": settings.airflow_password},
                )
                if login_response.status_code >= 400:
                    return None
                token = client.cookies.get("_token")
                return str(token) if token else None
        except httpx.HTTPError:
            return None
