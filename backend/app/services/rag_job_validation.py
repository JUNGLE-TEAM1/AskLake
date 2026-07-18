from datetime import datetime, timedelta, timezone
import hashlib
import json
from typing import Any

from fastapi import status
from sqlalchemy import select

from app.core.auth_context import ActorContext
from app.core.config import settings
from app.core.errors import ApiError
from app.models.semantic_rag import RagIndexJobModel
from app.schemas.common import ErrorCode
from app.schemas.semantic import RagJobListItem, RagJobResponse, RagJobStage
from app.services.rag_contracts import (
    CHUNKING_VERSION,
    EMBEDDING_INPUT_VERSION,
    FIELD_RENDERING_VERSION,
    FILTER_CONTRACT_VERSION,
    RAG_JOB_LIST_DEFAULT_LIMIT,
    RAG_JOB_LIST_MAX_LIMIT,
    RAG_JOB_STAGE_ORDER,
    RagJobCompletionState,
)


class RagJobValidationMixin:
    def job(self, job_id: str, actor: ActorContext) -> RagJobResponse:
        job = self.db.get(RagIndexJobModel, job_id)
        if job is None:
            raise ApiError("not_found", f"RAG job {job_id} was not found", status.HTTP_404_NOT_FOUND)
        self._dataset(job.dataset_id, actor, "view")
        completion = self._job_completion_state(job)
        observed_at = datetime.now(timezone.utc)
        return RagJobResponse(
            job_id=job.id,
            dataset_id=job.dataset_id,
            status=self._effective_job_status(job, observed_at),
            requested_mode=job.requested_mode,
            target_index=job.target_index,
            document_count=job.document_count,
            indexed_count=job.indexed_count,
            parent_count=job.parent_count,
            chunk_count=job.chunk_count,
            failed_count=job.failed_count,
            row_count=job.row_count,
            failed_row_rate=job.failed_row_rate,
            failed_row_rate_threshold=job.failed_row_rate_threshold,
            failed_row_report=job.failed_row_report or {},
            fallback_count=job.fallback_count,
            fallback_reasons=job.fallback_reasons or {},
            stage=completion.stage,
            is_complete=completion.is_complete,
            progress_percent=completion.progress_percent,
            progress_determinate=completion.progress_determinate,
            source_fingerprint=job.source_fingerprint,
            policy_fingerprint=job.policy_fingerprint,
            embedding_provider=job.embedding_provider,
            embedding_model=job.embedding_model,
            embedding_dimensions=job.embedding_dimensions,
            parent_table=job.parent_table,
            chunk_table=job.chunk_table,
            checkpoint_path=job.checkpoint_path,
            error=self._effective_job_error(job, observed_at),
            airflow_run_id=job.airflow_run_id,
            generation=job.generation,
            validation_status=job.validation_status,
            validated_at=job.validated_at,
            physical_column_mapping=job.physical_column_mapping or {},
            activation_status=job.activation_status,
            activation_alias=job.activation_alias,
            activation_target_index=job.activation_target_index,
            completed_at=job.completed_at,
        )

    def list_jobs(self, dataset_id: str, actor: ActorContext, *, limit: int = RAG_JOB_LIST_DEFAULT_LIMIT) -> list[RagJobListItem]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= RAG_JOB_LIST_MAX_LIMIT:
            raise ApiError(ErrorCode.VALIDATION_ERROR, f"RAG job list limit must be between 1 and {RAG_JOB_LIST_MAX_LIMIT}", status.HTTP_400_BAD_REQUEST)
        self._dataset(dataset_id, actor, "view")
        jobs = self.db.scalars(
            select(RagIndexJobModel)
            .where(RagIndexJobModel.dataset_id == dataset_id)
            .order_by(RagIndexJobModel.created_at.desc(), RagIndexJobModel.id.desc())
            .limit(limit)
        ).all()
        observed_at = datetime.now(timezone.utc)
        return [
            self._job_list_item(job, observed_at=observed_at)
            for job in jobs
        ]

    @classmethod
    def _job_list_item(
        cls,
        job: RagIndexJobModel,
        *,
        observed_at: datetime | None = None,
    ) -> RagJobListItem:
        completion = cls._job_completion_state(job)
        return RagJobListItem(
            job_id=job.id,
            dataset_id=job.dataset_id,
            requested_mode=job.requested_mode,
            status=cls._effective_job_status(job, observed_at),
            stage=completion.stage,
            is_complete=completion.is_complete,
            progress_percent=completion.progress_percent,
            progress_determinate=completion.progress_determinate,
            document_count=job.document_count,
            indexed_count=job.indexed_count,
            parent_count=job.parent_count,
            chunk_count=job.chunk_count,
            failed_count=job.failed_count,
            row_count=job.row_count,
            fallback_count=job.fallback_count,
            embedding_provider=job.embedding_provider,
            embedding_model=job.embedding_model,
            embedding_dimensions=job.embedding_dimensions,
            validation_status=job.validation_status,
            validated_at=job.validated_at,
            validated_index=job.validated_index,
            validated_document_count=job.validated_document_count,
            validated_parent_count=job.validated_parent_count,
            validated_dimensions=job.validated_dimensions,
            validation_evidence_hash=job.validation_evidence_hash,
            activation_status=job.activation_status,
            activation_alias=job.activation_alias,
            activation_previous_index=job.activation_previous_index,
            activation_target_index=job.activation_target_index,
            activation_started_at=job.activation_started_at,
            activation_committed_at=job.activation_committed_at,
            error=cls._effective_job_error(job, observed_at),
            created_at=job.created_at,
            updated_at=job.updated_at,
            completed_at=job.completed_at,
        )

    @classmethod
    def _job_has_stalled(
        cls,
        job: RagIndexJobModel,
        observed_at: datetime | None,
    ) -> bool:
        if (
            observed_at is None
            or job.status in {"failed", "canceled"}
            or cls._job_completion_state(job).is_complete
        ):
            return False
        last_update = job.updated_at or job.created_at
        if last_update.tzinfo is None:
            last_update = last_update.replace(tzinfo=timezone.utc)
        if observed_at.tzinfo is None:
            observed_at = observed_at.replace(tzinfo=timezone.utc)
        return observed_at - last_update > timedelta(
            seconds=settings.rag_job_stale_seconds
        )

    @classmethod
    def _effective_job_status(
        cls,
        job: RagIndexJobModel,
        observed_at: datetime | None,
    ) -> str:
        return "failed" if cls._job_has_stalled(job, observed_at) else job.status

    @classmethod
    def _effective_job_error(
        cls,
        job: RagIndexJobModel,
        observed_at: datetime | None,
    ) -> str | None:
        if not cls._job_has_stalled(job, observed_at):
            return job.error
        return job.error or (
            f"RAG 작업이 {settings.rag_job_stale_seconds}초 동안 진행 상태를 "
            "갱신하지 않아 중단된 작업으로 표시됩니다. 다시 색인해 주세요."
        )

    @classmethod
    def _job_completion_state(cls, job: RagIndexJobModel) -> RagJobCompletionState:
        is_complete = (
            job.status == "ready"
            and job.stage == "ready"
            and job.validation_status == "passed"
            and job.activation_status == "committed"
            and job.completed_at is not None
        )
        if is_complete:
            return RagJobCompletionState(stage="ready", is_complete=True, progress_percent=100, progress_determinate=True)

        stage = cls._job_evidenced_stage(job)
        if stage != "indexing" or int(job.chunk_count or 0) <= 0:
            return RagJobCompletionState(stage=stage, is_complete=False, progress_percent=None, progress_determinate=False)
        chunk_count = int(job.chunk_count or 0)
        indexed_count = max(0, min(int(job.indexed_count or 0), chunk_count))
        progress_percent = min(99, (indexed_count * 100) // chunk_count)
        return RagJobCompletionState(stage=stage, is_complete=False, progress_percent=progress_percent, progress_determinate=True)

    @classmethod
    def _job_evidenced_stage(cls, job: RagIndexJobModel) -> RagJobStage:
        if (
            job.status == "ready"
            and job.stage == "ready"
            and job.validation_status == "passed"
            and job.activation_status == "committed"
            and job.completed_at is not None
        ):
            return "ready"

        evidenced_stages: list[RagJobStage] = ["queued"]
        for stored_value in (job.stage, job.status):
            if stored_value in RAG_JOB_STAGE_ORDER:
                evidenced_stages.append("validating" if stored_value == "ready" else stored_value)
        if any(int(value or 0) > 0 for value in (job.row_count, job.parent_count, job.failed_count)):
            evidenced_stages.append("staging")
        if int(job.chunk_count or 0) > 0:
            evidenced_stages.append("chunking")
        if str(job.embedding_provider or "").strip():
            evidenced_stages.append("embedding")
        if int(job.indexed_count or 0) > 0:
            evidenced_stages.append("indexing")
        if (
            job.validation_status != "pending"
            or job.validated_at is not None
            or job.validated_index is not None
            or job.validated_document_count is not None
            or job.validated_parent_count is not None
            or job.validated_dimensions is not None
            or job.validation_evidence_hash is not None
            or job.activation_status != "none"
        ):
            evidenced_stages.append("validating")
        return max(evidenced_stages, key=RAG_JOB_STAGE_ORDER.__getitem__)

    def validate_job(self, job_id: str) -> dict[str, Any]:
        """Validate a physical index before the serving alias can move."""
        job = self.db.get(RagIndexJobModel, job_id)
        if job is None:
            raise ApiError(
                "not_found",
                f"RAG job {job_id} was not found",
                status.HTTP_404_NOT_FOUND,
            )
        if not settings.opensearch_base_url or not job.target_index:
            raise ApiError(
                "service_unavailable",
                "OpenSearch is required to validate a RAG index",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        from app.clients.opensearch_client import OpenSearchClient

        client = OpenSearchClient(settings)
        actual_chunks, actual_parents = self._validate_index_counts(job, client)
        properties, required = self._validate_index_mapping(job, client)
        sample_hits = self._validation_sample_hits(job, client, actual_chunks)
        smoke_evidence = (
            self._validate_sample_smoke(job, client, properties, sample_hits[0])
            if sample_hits
            else {}
        )
        return self._persist_validation_evidence(
            job,
            actual_chunks=actual_chunks,
            actual_parents=actual_parents,
            required=required,
            smoke_evidence=smoke_evidence,
        )

    @staticmethod
    def _validate_index_counts(
        job: RagIndexJobModel,
        client: Any,
    ) -> tuple[int, int]:
        expected_chunks = job.indexed_count or job.chunk_count
        actual_chunks = client.count(job.target_index)
        if actual_chunks != expected_chunks:
            raise ApiError(
                "rag_validation_failed",
                f"OpenSearch chunk count mismatch: expected {expected_chunks}, got {actual_chunks}",
                status.HTTP_409_CONFLICT,
            )
        actual_parents = (
            client.distinct_count(job.target_index, "parent_document_id")
            if actual_chunks
            else 0
        )
        if actual_parents != job.parent_count:
            raise ApiError(
                "rag_validation_failed",
                f"OpenSearch parent count mismatch: expected {job.parent_count}, got {actual_parents}",
                status.HTTP_409_CONFLICT,
            )
        if actual_chunks and not str(job.embedding_provider or "").strip():
            raise ApiError(
                "rag_validation_failed",
                "RAG job is missing embedding provider provenance",
                status.HTTP_409_CONFLICT,
            )
        if actual_chunks and not str(job.embedding_model or "").strip():
            raise ApiError(
                "rag_validation_failed",
                "RAG job is missing embedding model provenance",
                status.HTTP_409_CONFLICT,
            )
        return actual_chunks, actual_parents

    def _validate_index_mapping(
        self,
        job: RagIndexJobModel,
        client: Any,
    ) -> tuple[dict[str, Any], set[str]]:
        properties = self._mapping_properties(
            client.mapping(job.target_index),
            job.target_index,
        )
        required = {
            "document_id",
            "parent_document_id",
            "body",
            "embedding_text",
            "body_vector",
            "metadata_filter",
            "chunk_index",
            "chunk_count",
            "char_start",
            "char_end",
            "embedding_provider",
            "embedding_model",
            "embedding_dimensions",
            "source_fields",
            "parent_source_fields",
            "embedding_input_version",
            "field_rendering_version",
        }
        missing = sorted(required - set(properties))
        if missing:
            raise ApiError(
                "rag_validation_failed",
                f"OpenSearch mapping is missing fields: {', '.join(missing)}",
                status.HTTP_409_CONFLICT,
            )
        vector_mapping = properties.get("body_vector") or {}
        if int(vector_mapping.get("dimension") or 0) != int(
            job.embedding_dimensions or 0
        ):
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch vector dimension does not match the job manifest",
                status.HTTP_409_CONFLICT,
            )
        return properties, required

    @staticmethod
    def _validation_sample_hits(
        job: RagIndexJobModel,
        client: Any,
        actual_chunks: int,
    ) -> list[dict[str, Any]]:
        response = client.search_raw(
            job.target_index,
            {
                "size": 1,
                "_source": [
                    "document_id",
                    "title",
                    "body",
                    "embedding_text",
                    "body_vector",
                    "metadata_filter",
                    "source_fields",
                    "parent_source_fields",
                    "embedding_input_version",
                    "field_rendering_version",
                    "chunking_version",
                    "embedding_provider",
                    "embedding_model",
                    "embedding_dimensions",
                ],
                "query": {"match_all": {}},
            },
        )
        sample_hits = (
            response.get("hits", {}).get("hits", [])
            if isinstance(response, dict)
            else []
        )
        if actual_chunks and not sample_hits:
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch sample document query returned no document",
                status.HTTP_409_CONFLICT,
            )
        metadata_columns = list(job.metadata_columns or [])
        if job.filter_contract_version != FILTER_CONTRACT_VERSION:
            raise ApiError(
                "rag_validation_failed",
                "RAG job metadata filter contract version is missing or unsupported",
                status.HTTP_409_CONFLICT,
            )
        if metadata_columns and not sample_hits:
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch has no document from which to validate approved metadata fields",
                status.HTTP_409_CONFLICT,
            )
        return sample_hits

    def _validate_sample_smoke(
        self,
        job: RagIndexJobModel,
        client: Any,
        properties: dict[str, Any],
        raw_hit: dict[str, Any],
    ) -> dict[str, Any]:
        sample_hit = raw_hit if isinstance(raw_hit, dict) else {}
        sample_source = sample_hit.get("_source") or {}
        sample_id = str(
            sample_hit.get("_id")
            or sample_source.get("document_id")
            or ""
        )
        vector = self._validate_sample_provenance(job, sample_source)
        bm25_query = self._bm25_smoke_query(sample_source)
        bm25_ids = self._search_result_ids(
            client,
            job.target_index,
            bm25_query,
        )
        if not bm25_ids or (sample_id and sample_id not in bm25_ids):
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch BM25 multi_match smoke query did not return the sample document",
                status.HTTP_409_CONFLICT,
            )
        knn_ids = self._search_result_ids(
            client,
            job.target_index,
            {
                "size": 1,
                "query": {
                    "knn": {
                        "body_vector": {
                            "vector": vector,
                            "k": 1,
                        }
                    }
                },
            },
        )
        if not knn_ids:
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch k-NN smoke query returned no document",
                status.HTTP_409_CONFLICT,
            )
        return {
            "bm25": {
                "query": bm25_query,
                "resultIds": bm25_ids[:10],
            },
            "knn": {
                "query": {
                    "field": "body_vector",
                    "k": 1,
                    "dimensions": len(vector),
                },
                "resultIds": knn_ids[:10],
            },
            "metadataFilters": self._validate_metadata_smoke(
                job,
                client,
                properties,
            ),
        }

    @staticmethod
    def _validate_sample_provenance(
        job: RagIndexJobModel,
        sample_source: dict[str, Any],
    ) -> list[Any]:
        vector = sample_source.get("body_vector")
        if not isinstance(vector, list) or len(vector) != int(
            job.embedding_dimensions or 0
        ):
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch stored vector is missing or has the wrong dimension",
                status.HTTP_409_CONFLICT,
            )
        sample_provider = str(sample_source.get("embedding_provider") or "").strip()
        sample_model = str(sample_source.get("embedding_model") or "").strip()
        if not sample_provider:
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch document is missing embedding provider provenance",
                status.HTTP_409_CONFLICT,
            )
        if sample_provider != str(job.embedding_provider or "").strip():
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch embedding provider does not match the job contract",
                status.HTTP_409_CONFLICT,
            )
        if not sample_model:
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch document is missing embedding model provenance",
                status.HTTP_409_CONFLICT,
            )
        if sample_model != str(job.embedding_model or "").strip():
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch embedding model does not match the job contract",
                status.HTTP_409_CONFLICT,
            )
        versions_match = (
            sample_source.get("embedding_input_version")
            == EMBEDDING_INPUT_VERSION
            and sample_source.get("field_rendering_version")
            == FIELD_RENDERING_VERSION
            and sample_source.get("chunking_version") == CHUNKING_VERSION
        )
        if not versions_match:
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch document versions do not match the RAG v3 contract",
                status.HTTP_409_CONFLICT,
            )
        if not isinstance(sample_source.get("source_fields"), list):
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch document is missing source field provenance",
                status.HTTP_409_CONFLICT,
            )
        if not isinstance(sample_source.get("parent_source_fields"), list):
            raise ApiError(
                "rag_validation_failed",
                "OpenSearch document is missing parent source field provenance",
                status.HTTP_409_CONFLICT,
            )
        return vector

    @staticmethod
    def _bm25_smoke_query(sample_source: dict[str, Any]) -> dict[str, Any]:
        title_text = str(sample_source.get("title") or "").strip()
        body_text = str(sample_source.get("body") or "").strip()
        embedding_text = str(sample_source.get("embedding_text") or "").strip()
        if title_text:
            field, query_text = "title", title_text[:500]
        elif body_text:
            field, query_text = "body", body_text[:500]
        else:
            field, query_text = "embedding_text", embedding_text[:500] or "rag"
        return {
            "size": 10,
            "query": {
                "match_phrase": {
                    field: query_text,
                }
            },
        }

    @staticmethod
    def _search_result_ids(
        client: Any,
        index: str,
        query: dict[str, Any],
    ) -> list[str]:
        response = client.search_raw(index, query)
        hits = (
            response.get("hits", {}).get("hits", [])
            if isinstance(response, dict)
            else []
        )
        return [
            str(
                item.get("_id")
                or (item.get("_source") or {}).get("document_id")
                or ""
            )
            for item in hits
            if isinstance(item, dict)
        ]

    def _validate_metadata_smoke(
        self,
        job: RagIndexJobModel,
        client: Any,
        properties: dict[str, Any],
    ) -> list[dict[str, Any]]:
        evidence: list[dict[str, Any]] = []
        metadata_types = job.metadata_types or {}
        raw_mapping = properties.get("metadata_filter")
        metadata_mapping = (
            (raw_mapping or {}).get("properties") or {}
            if isinstance(raw_mapping, dict)
            else {}
        )
        for logical_field in list(job.metadata_columns or []):
            physical_field = str(
                (job.physical_column_mapping or {}).get(logical_field)
                or self._physical_column_name(logical_field)
            )
            field_type, suffix = self._metadata_storage_contract(
                logical_field,
                physical_field,
                metadata_types,
                metadata_mapping,
            )
            field_hit, value = self._sample_metadata_value(
                job,
                client,
                logical_field,
                physical_field,
                field_type,
                suffix,
            )
            query = (
                {
                    "range": {
                        f"metadata_filter.{physical_field}.{suffix}": {
                            "gte": value,
                        }
                    }
                }
                if field_type in {"number", "date"}
                else {
                    "term": {
                        f"metadata_filter.{physical_field}.{suffix}": value,
                    }
                }
            )
            result_ids = self._search_result_ids(
                client,
                job.target_index,
                {"size": 10, "query": query},
            )
            field_source = field_hit.get("_source") or {}
            sample_id = str(
                field_hit.get("_id")
                or field_source.get("document_id")
                or ""
            )
            if not result_ids or (sample_id and sample_id not in result_ids):
                raise ApiError(
                    "rag_validation_failed",
                    f"OpenSearch metadata pre-filter smoke query did not return the sampled document for '{logical_field}'",
                    status.HTTP_409_CONFLICT,
                )
            evidence.append(
                {
                    "logicalField": logical_field,
                    "physicalField": physical_field,
                    "type": field_type,
                    "query": query,
                    "resultIds": result_ids[:10],
                }
            )
        return evidence

    @staticmethod
    def _metadata_storage_contract(
        logical_field: str,
        physical_field: str,
        metadata_types: dict[str, Any],
        metadata_mapping: dict[str, Any],
    ) -> tuple[str, str]:
        data_type = str(metadata_types.get(physical_field) or "").casefold()
        if not data_type:
            raise ApiError(
                "rag_validation_failed",
                f"Metadata type is missing for approved field '{logical_field}'",
                status.HTTP_409_CONFLICT,
            )
        if any(
            token in data_type
            for token in (
                "int",
                "long",
                "float",
                "double",
                "decimal",
                "numeric",
                "number",
            )
        ):
            field_type, suffix = "number", "number"
        elif any(token in data_type for token in ("date", "time", "timestamp")):
            field_type, suffix = "date", "date"
        elif "bool" in data_type:
            field_type, suffix = "boolean", "boolean"
        else:
            field_type, suffix = "string", "keyword"
        field_mapping = metadata_mapping.get(physical_field)
        value_mapping = (
            (field_mapping or {}).get("properties")
            if isinstance(field_mapping, dict)
            else {}
        )
        if not isinstance(value_mapping, dict) or suffix not in value_mapping:
            raise ApiError(
                "rag_validation_failed",
                f"OpenSearch mapping is missing typed metadata field '{physical_field}.{suffix}'",
                status.HTTP_409_CONFLICT,
            )
        return field_type, suffix

    @staticmethod
    def _sample_metadata_value(
        job: RagIndexJobModel,
        client: Any,
        logical_field: str,
        physical_field: str,
        field_type: str,
        suffix: str,
    ) -> tuple[dict[str, Any], Any]:
        response = client.search_raw(
            job.target_index,
            {
                "size": 1,
                "_source": ["document_id", "metadata_filter"],
                "query": {
                    "exists": {
                        "field": f"metadata_filter.{physical_field}",
                    }
                },
            },
        )
        hits = (
            response.get("hits", {}).get("hits", [])
            if isinstance(response, dict)
            else []
        )
        if not hits:
            raise ApiError(
                "rag_validation_failed",
                f"No indexed value exists for approved metadata field '{logical_field}'",
                status.HTTP_409_CONFLICT,
            )
        field_hit = hits[0] if isinstance(hits[0], dict) else {}
        field_source = field_hit.get("_source") or {}
        metadata_filter = field_source.get("metadata_filter")
        typed = (
            metadata_filter.get(physical_field)
            if isinstance(metadata_filter, dict)
            else None
        )
        if not isinstance(typed, dict) or typed.get("type") != field_type:
            raise ApiError(
                "rag_validation_failed",
                f"Indexed metadata type for '{logical_field}' does not match the Catalog contract",
                status.HTTP_409_CONFLICT,
            )
        value = typed.get(suffix)
        if value is None:
            raise ApiError(
                "rag_validation_failed",
                f"Indexed metadata value is missing for approved field '{logical_field}'",
                status.HTTP_409_CONFLICT,
            )
        return field_hit, value

    def _persist_validation_evidence(
        self,
        job: RagIndexJobModel,
        *,
        actual_chunks: int,
        actual_parents: int,
        required: set[str],
        smoke_evidence: dict[str, Any],
    ) -> dict[str, Any]:
        evidence = {
            "index": job.target_index,
            "documentCount": actual_chunks,
            "parentCount": actual_parents,
            "dimensions": int(job.embedding_dimensions or 0),
            "embeddingProvider": job.embedding_provider,
            "embeddingModel": job.embedding_model,
            "requiredFields": sorted(required),
            "smoke": smoke_evidence,
        }
        evidence_hash = hashlib.sha256(
            json.dumps(
                evidence,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        job.validation_status = "passed"
        job.validated_at = datetime.now(timezone.utc)
        job.validated_index = job.target_index
        job.validated_document_count = actual_chunks
        job.validated_parent_count = actual_parents
        job.validated_dimensions = int(job.embedding_dimensions or 0)
        job.validation_evidence_hash = evidence_hash
        self.db.commit()
        return {
            "validationPassed": True,
            "validatedIndex": job.target_index,
            "documentCount": actual_chunks,
            "parentCount": actual_parents,
            "dimensions": job.embedding_dimensions,
            "embeddingProvider": job.embedding_provider,
            "embeddingModel": job.embedding_model,
            "validationEvidenceHash": evidence_hash,
        }

    @staticmethod
    def _mapping_properties(mapping: dict[str, Any], index: str) -> dict[str, Any]:
        root = mapping.get(index) if isinstance(mapping.get(index), dict) else next((value for value in mapping.values() if isinstance(value, dict)), {})
        mappings = root.get("mappings") if isinstance(root, dict) else {}
        properties = mappings.get("properties") if isinstance(mappings, dict) else {}
        return properties if isinstance(properties, dict) else {}
