from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import status
from sqlalchemy import select

from app.core.auth_context import ActorContext
from app.core.config import settings
from app.core.errors import ApiError
from app.models.semantic_rag import (
    RagDatasetProfileModel,
    RagIndexJobModel,
    RagIndexManifestModel,
)
from app.schemas.semantic import RagJobResponse
from app.services.catalog_schema import schema_fingerprint
from app.services.rag_contracts import (
    CHUNKING_VERSION,
    EMBEDDING_INPUT_VERSION,
    RAG_PARENT_SCHEMA_VERSION,
)
from app.services.rag_job_validation import RagJobValidationMixin


class RagJobLifecycleMixin(RagJobValidationMixin):
    def complete_job(self, job_id: str, result: dict[str, Any]) -> RagJobResponse:
        job, profile = self._locked_job_and_profile(job_id)
        result_status = str(result.get("status") or "success").strip().casefold()
        chunking_version = str(result.get("chunkingVersion") or CHUNKING_VERSION)
        if result_status not in {"failed", "canceled"} and job.activation_status == "pending":
            return self._activation_callback_response(
                job,
                profile,
                chunking_version=chunking_version,
            )

        self._reject_persisted_superseded_callback(job, profile, result_status)
        if job.status in {"ready", "failed", "canceled"}:
            return self.job(job_id, ActorContext(name=job.requested_by, role="admin"))

        progress_response = self._stage_callback_response(
            job,
            profile,
            result_status,
            result,
        )
        if progress_response is not None:
            return progress_response
        if result_status != "success":
            return self._failed_callback_response(job, profile, result)

        self._enforce_activation_fence(job, profile)
        self._prepare_activation(job, profile, result)
        return self._activation_callback_response(
            job,
            profile,
            chunking_version=chunking_version,
        )

    def _locked_job_and_profile(
        self,
        job_id: str,
    ) -> tuple[RagIndexJobModel, RagDatasetProfileModel]:
        job = self.db.scalar(
            select(RagIndexJobModel)
            .where(RagIndexJobModel.id == job_id)
            .with_for_update()
        )
        if job is None:
            raise ApiError(
                "not_found",
                f"RAG job {job_id} was not found",
                status.HTTP_404_NOT_FOUND,
            )
        profile = self.db.scalar(
            select(RagDatasetProfileModel)
            .where(RagDatasetProfileModel.dataset_id == job.dataset_id)
            .with_for_update()
        ) or self._profile_row(job.dataset_id)
        return job, profile

    def _reject_persisted_superseded_callback(
        self,
        job: RagIndexJobModel,
        profile: RagDatasetProfileModel,
        result_status: str,
    ) -> None:
        if result_status in {"failed", "canceled"}:
            return
        superseded_reason = self._persisted_superseded_fence_reason(job, profile)
        if superseded_reason is None:
            return
        if job.status not in {"failed", "canceled"}:
            job.status = "failed"
            job.stage = "failed"
            if job.activation_status == "pending":
                job.activation_status = "failed"
            job.error = "RAG callback belongs to a superseded activation generation"
            job.completed_at = datetime.now(timezone.utc)
            self.db.commit()
        raise self._superseded_callback_error(
            job,
            profile.desired_generation,
            fence_reason=superseded_reason,
        )

    def _stage_callback_response(
        self,
        job: RagIndexJobModel,
        profile: RagDatasetProfileModel,
        result_status: str,
        result: dict[str, Any],
    ) -> RagJobResponse | None:
        stage_updates = {
            "parent_staged": ("staging", "staging", "pending"),
            "chunked": ("chunking", "chunking", "pending"),
            "embedding": ("embedding", "embedding", "generating"),
            "indexing": ("indexing", "indexing", "generating"),
            "validating": ("validating", "validating", "generating"),
        }
        if result_status not in stage_updates:
            return None
        stage_order = {
            "queued": 0,
            "staging": 1,
            "chunking": 2,
            "embedding": 3,
            "indexing": 4,
            "validating": 5,
            "ready": 6,
            "failed": 99,
            "canceled": 99,
        }
        next_status = stage_updates[result_status][0]
        actor = ActorContext(name=job.requested_by, role="admin")
        if stage_order.get(next_status, -1) < stage_order.get(job.status, -1):
            return self.job(job.id, actor)

        job.status, job.stage, profile.embedding_status = stage_updates[result_status]
        profile.index_status = job.status
        job.parent_count = int(result.get("parentCount") or job.parent_count)
        job.chunk_count = int(result.get("chunkCount") or job.chunk_count)
        job.failed_count = int(result.get("failedCount") or job.failed_count)
        job.row_count = int(result.get("rowCount") or job.row_count)
        job.failed_row_rate = float(result.get("failedRate") or job.failed_row_rate)
        job.failed_row_report = (
            result["failedRowReport"]
            if isinstance(result.get("failedRowReport"), dict)
            else (job.failed_row_report or {})
        )
        job.fallback_count = int(result.get("fallbackCount") or job.fallback_count)
        job.fallback_reasons = (
            result["fallbackReasons"]
            if isinstance(result.get("fallbackReasons"), dict)
            else (job.fallback_reasons or {})
        )
        job.document_count = int(result.get("documentCount") or job.document_count)
        job.indexed_count = int(result.get("indexedCount") or job.indexed_count)
        job.embedding_dimensions = (
            int(result.get("dimensions") or job.embedding_dimensions or 0)
            or job.embedding_dimensions
        )
        job.embedding_provider = (
            str(result.get("embeddingProvider") or job.embedding_provider or "") or None
        )
        job.embedding_model = str(
            result.get("embeddingModel")
            or job.embedding_model
            or settings.rag_embedding_model
        )
        job.checkpoint_path = (
            str(result.get("checkpointPath") or job.checkpoint_path or "") or None
        )
        self.db.commit()
        return self.job(job.id, actor)

    def _failed_callback_response(
        self,
        job: RagIndexJobModel,
        profile: RagDatasetProfileModel,
        result: dict[str, Any],
    ) -> RagJobResponse:
        job.status = "failed"
        job.stage = "failed"
        is_current_generation = int(job.generation or 0) == int(
            profile.desired_generation or 0
        )
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
        return self.job(
            job.id,
            ActorContext(name=job.requested_by, role="admin"),
        )

    def _enforce_activation_fence(
        self,
        job: RagIndexJobModel,
        profile: RagDatasetProfileModel,
    ) -> None:
        fence_reason = self._validation_fence_reason(job)
        if fence_reason is None:
            current_dataset = self.catalog.get_dataset_payload(job.dataset_id) or {}
            fence_reason = self._activation_fence_reason(
                job,
                profile,
                current_dataset,
            )
        if fence_reason is None:
            return

        superseded = fence_reason in {
            "generation",
            "sourceFingerprint",
            "policyFingerprint",
            "profileApproval",
        }
        job.status = "failed"
        job.stage = "failed"
        job.error = f"RAG activation fence rejected the callback: {fence_reason}"
        job.completed_at = datetime.now(timezone.utc)
        if not superseded and int(job.generation or 0) == int(
            profile.desired_generation or 0
        ):
            profile.index_status = "failed"
            profile.embedding_status = "failed"
            profile.last_error = job.error
        self.db.commit()
        if superseded:
            raise self._superseded_callback_error(
                job,
                profile.desired_generation,
                fence_reason=fence_reason,
            )
        raise ApiError(
            "rag_activation_rejected",
            job.error,
            status.HTTP_409_CONFLICT,
            {
                "jobId": job.id,
                "stopDag": True,
                "retryable": False,
                "fenceReason": fence_reason,
            },
        )

    def _prepare_activation(
        self,
        job: RagIndexJobModel,
        profile: RagDatasetProfileModel,
        result: dict[str, Any],
    ) -> None:
        job.status = "ready"
        job.stage = "ready"
        job.indexed_count = int(result.get("indexedCount") or job.document_count)
        job.parent_count = int(result.get("parentCount") or job.parent_count)
        job.chunk_count = int(result.get("chunkCount") or job.chunk_count)
        job.failed_count = int(result.get("failedCount") or job.failed_count)
        job.row_count = int(result.get("rowCount") or job.row_count)
        job.failed_row_rate = float(result.get("failedRate") or job.failed_row_rate)
        job.failed_row_report = (
            result["failedRowReport"]
            if isinstance(result.get("failedRowReport"), dict)
            else (job.failed_row_report or {})
        )
        job.fallback_count = int(result.get("fallbackCount") or job.fallback_count)
        job.fallback_reasons = (
            result["fallbackReasons"]
            if isinstance(result.get("fallbackReasons"), dict)
            else (job.fallback_reasons or {})
        )
        job.document_count = int(
            result.get("documentCount") or job.chunk_count or job.document_count
        )
        job.embedding_dimensions = int(
            result.get("dimensions")
            or job.embedding_dimensions
            or settings.rag_embedding_dimensions
        )
        job.embedding_provider = (
            str(result.get("embeddingProvider") or job.embedding_provider or "") or None
        )
        job.activation_status = "pending"
        job.activation_alias = (
            profile.target_alias
            or f"{settings.rag_index_prefix}-ds-{job.dataset_id}"
        )
        job.activation_previous_index = self._current_serving_index(
            job.dataset_id,
            profile,
            stale_target=job.target_index,
        )
        job.activation_target_index = (
            str(result.get("activeIndex") or job.target_index or "") or None
        )
        job.activation_started_at = datetime.now(timezone.utc)
        job.error = None
        self.db.commit()

    def _activation_callback_response(
        self,
        job: RagIndexJobModel,
        profile: RagDatasetProfileModel,
        *,
        chunking_version: str,
    ) -> RagJobResponse:
        activation_result = self._process_pending_activation(
            job.id,
            chunking_version=chunking_version,
        )
        refreshed = self.db.get(RagIndexJobModel, job.id) or job
        if activation_result == "committed":
            return self.job(job.id, ActorContext(name=job.requested_by, role="admin"))
        if activation_result == "superseded":
            reason = self._persisted_superseded_fence_reason(refreshed, profile) or "generation"
            raise self._superseded_callback_error(
                refreshed,
                profile.desired_generation,
                fence_reason=reason,
            )
        raise ApiError(
            "rag_activation_pending",
            "Alias activation outcome is not yet determinate; reconciliation will retry",
            status.HTTP_503_SERVICE_UNAVAILABLE,
            {"jobId": job.id, "stopDag": True, "retryable": True},
        )

    @staticmethod
    def _persisted_superseded_fence_reason(
        job: RagIndexJobModel,
        profile: RagDatasetProfileModel,
    ) -> str | None:
        if int(job.generation or 0) != int(profile.desired_generation or 0):
            return "generation"
        error = str(job.error or "")
        prefixes = (
            "RAG activation fence rejected the callback: ",
            "Pending alias activation was superseded: ",
        )
        for prefix in prefixes:
            if error.startswith(prefix):
                reason = error[len(prefix):].strip()
                if reason in {"generation", "sourceFingerprint", "policyFingerprint", "profileApproval"}:
                    return reason
        if error == "RAG callback belongs to a superseded activation generation":
            return "generation"
        return None

    @staticmethod
    def _superseded_callback_error(
        job: RagIndexJobModel,
        desired_generation: int,
        *,
        fence_reason: str = "generation",
    ) -> ApiError:
        return ApiError(
            "rag_job_superseded",
            "RAG callback belongs to a superseded immutable build",
            status.HTTP_409_CONFLICT,
            {
                "jobId": job.id,
                "jobGeneration": int(job.generation or 0),
                "desiredGeneration": int(desired_generation or 0),
                "fenceReason": fence_reason,
                "stopDag": True,
                "retryable": False,
            },
        )

    @classmethod
    def _activation_fence_reason(
        cls,
        job: RagIndexJobModel,
        profile: RagDatasetProfileModel,
        dataset: dict[str, Any],
    ) -> str | None:
        if int(job.generation or 0) != int(profile.desired_generation or 0):
            return "generation"
        if profile.review_state != "approved":
            return "profileApproval"
        source = dataset.get("sourceManifest") or dataset.get("source_manifest") or {}
        current_source_fingerprint = str(source.get("fingerprint") or "") if isinstance(source, dict) else ""
        if current_source_fingerprint != (job.source_fingerprint or ""):
            return "sourceFingerprint"
        current_policy = cls._policy_fingerprint(dataset, profile) if dataset else None
        if not job.policy_fingerprint or current_policy != job.policy_fingerprint:
            return "policyFingerprint"
        return cls._validation_fence_reason(job)

    @staticmethod
    def _validation_fence_reason(job: RagIndexJobModel) -> str | None:
        if job.status not in {"validating", "ready"} or job.stage not in {"validating", "ready"}:
            return "validationStage"
        if job.validation_status != "passed" or job.validated_index != (job.activation_target_index or job.target_index):
            return "validationStatus"
        if job.validated_document_count != int(job.indexed_count or job.chunk_count):
            return "validatedDocumentCount"
        if job.validated_parent_count != int(job.parent_count):
            return "validatedParentCount"
        if job.validated_dimensions != int(job.embedding_dimensions or 0):
            return "validatedDimensions"
        return None

    def _current_serving_index(
        self,
        dataset_id: str,
        profile: RagDatasetProfileModel,
        *,
        stale_target: str | None,
    ) -> str | None:
        manifest = self.db.scalar(
            select(RagIndexManifestModel)
            .where(RagIndexManifestModel.dataset_id == dataset_id, RagIndexManifestModel.status == "active")
            .order_by(RagIndexManifestModel.generation.desc(), RagIndexManifestModel.activated_at.desc())
        )
        candidate = manifest.index_name if manifest is not None else profile.active_index
        return candidate if candidate and candidate != stale_target else None

    @staticmethod
    def _cas_activate_alias(client: Any, alias: str, target: str, expected_previous: str | None) -> str:
        try:
            before = client.alias_indices(alias)
        except Exception:
            return "pending"
        if before == [target]:
            return "applied"
        expected = [expected_previous] if expected_previous else []
        if before != expected:
            return "pending"
        actions: list[dict[str, Any]] = []
        if expected_previous:
            actions.append({"remove": {"alias": alias, "index": expected_previous, "must_exist": True}})
        actions.append({"add": {"alias": alias, "index": target}})
        try:
            client._request("POST", "_aliases", json={"actions": actions})
        except Exception:
            try:
                return "applied" if client.alias_indices(alias) == [target] else "pending"
            except Exception:
                return "pending"
        try:
            return "applied" if client.alias_indices(alias) == [target] else "pending"
        except Exception:
            return "pending"

    @staticmethod
    def _cas_remove_stale_alias(client: Any, alias: str, stale_target: str, replacement: str | None) -> str:
        try:
            before = client.alias_indices(alias)
        except Exception:
            return "pending"
        if stale_target not in before:
            return "removed"
        actions: list[dict[str, Any]] = [
            {"remove": {"alias": alias, "index": stale_target, "must_exist": True}}
        ]
        if before == [stale_target] and replacement and replacement != stale_target:
            actions.append({"add": {"alias": alias, "index": replacement}})
        try:
            client._request("POST", "_aliases", json={"actions": actions})
        except Exception:
            try:
                return "removed" if stale_target not in client.alias_indices(alias) else "pending"
            except Exception:
                return "pending"
        try:
            return "removed" if stale_target not in client.alias_indices(alias) else "pending"
        except Exception:
            return "pending"

    @staticmethod
    def _mark_superseded_activation(job: RagIndexJobModel, reason: str) -> None:
        job.activation_status = "failed"
        job.status = "failed"
        job.stage = "failed"
        job.error = f"Pending alias activation was superseded: {reason}"
        job.completed_at = datetime.now(timezone.utc)

    def _process_pending_activation(self, job_id: str, *, chunking_version: str) -> str:
        job = self.db.scalar(select(RagIndexJobModel).where(RagIndexJobModel.id == job_id).with_for_update())
        if job is None or job.activation_status != "pending":
            return "committed" if job is not None and job.activation_status == "committed" else "superseded"
        profile = self.db.scalar(
            select(RagDatasetProfileModel)
            .where(RagDatasetProfileModel.dataset_id == job.dataset_id)
            .with_for_update()
        )
        if profile is None or not job.activation_alias or not job.activation_target_index:
            self._mark_superseded_activation(job, "missing activation intent")
            self.db.commit()
            return "superseded"

        dataset = self.catalog.get_dataset_payload(job.dataset_id) or {}
        fence_reason = self._activation_fence_reason(job, profile, dataset)
        if fence_reason is not None:
            if not settings.opensearch_base_url:
                self._mark_superseded_activation(job, fence_reason)
                self.db.commit()
                return "superseded"
            from app.clients.opensearch_client import OpenSearchClient

            client = OpenSearchClient(settings)
            replacement = self._current_serving_index(job.dataset_id, profile, stale_target=job.activation_target_index)
            cleanup = self._cas_remove_stale_alias(client, job.activation_alias, job.activation_target_index, replacement)
            if cleanup == "pending":
                job.error = f"Superseded alias cleanup is pending: {fence_reason}"
                self.db.commit()
                return "pending"
            self._mark_superseded_activation(job, fence_reason)
            self.db.commit()
            return "superseded"

        if not settings.opensearch_base_url:
            final_dataset = self.catalog.get_dataset_payload(job.dataset_id) or {}
            final_reason = self._activation_fence_reason(job, profile, final_dataset)
            if final_reason is not None:
                self._mark_superseded_activation(job, final_reason)
                self.db.commit()
                return "superseded"
            self._finalize_activation(job, profile, final_dataset, job.activation_target_index, chunking_version=chunking_version)
            return "committed"

        from app.clients.opensearch_client import OpenSearchClient

        client = OpenSearchClient(settings)
        before_external_dataset = self.catalog.get_dataset_payload(job.dataset_id) or {}
        before_external_reason = self._activation_fence_reason(job, profile, before_external_dataset)
        if before_external_reason is not None:
            cleanup = self._cas_remove_stale_alias(
                client,
                job.activation_alias,
                job.activation_target_index,
                self._current_serving_index(job.dataset_id, profile, stale_target=job.activation_target_index),
            )
            if cleanup == "pending":
                job.error = f"Superseded alias cleanup is pending: {before_external_reason}"
                self.db.commit()
                return "pending"
            self._mark_superseded_activation(job, before_external_reason)
            self.db.commit()
            return "superseded"

        expected_previous = self._current_serving_index(job.dataset_id, profile, stale_target=job.activation_target_index)
        switched = self._cas_activate_alias(client, job.activation_alias, job.activation_target_index, expected_previous)
        if switched != "applied":
            job.error = "Alias activation outcome is unknown; reconciliation will retry"
            self.db.commit()
            return "pending"

        after_external_dataset = self.catalog.get_dataset_payload(job.dataset_id) or {}
        after_external_reason = self._activation_fence_reason(job, profile, after_external_dataset)
        if after_external_reason is not None:
            cleanup = self._cas_remove_stale_alias(
                client,
                job.activation_alias,
                job.activation_target_index,
                self._current_serving_index(job.dataset_id, profile, stale_target=job.activation_target_index),
            )
            if cleanup == "pending":
                job.error = f"Post-switch alias cleanup is pending: {after_external_reason}"
                self.db.commit()
                return "pending"
            self._mark_superseded_activation(job, after_external_reason)
            self.db.commit()
            return "superseded"
        try:
            if client.alias_indices(job.activation_alias) != [job.activation_target_index]:
                job.error = "Alias changed after activation; reconciliation will retry"
                self.db.commit()
                return "pending"
        except Exception:
            job.error = "Alias activation cannot yet be confirmed; reconciliation will retry"
            self.db.commit()
            return "pending"
        self._finalize_activation(job, profile, after_external_dataset, job.activation_target_index, chunking_version=chunking_version)
        return "committed"

    def reconcile_alias_activations(self, *, limit: int | None = None) -> int:
        """Resolve persisted activation intents without overwriting a newer alias."""
        statement = select(RagIndexJobModel.id).where(RagIndexJobModel.activation_status == "pending").order_by(RagIndexJobModel.activation_started_at.asc())
        if limit is not None and limit > 0:
            statement = statement.limit(limit)
        job_ids = list(self.db.scalars(statement).all())
        repaired = 0
        for job_id in job_ids:
            if self._process_pending_activation(job_id, chunking_version=CHUNKING_VERSION) == "committed":
                repaired += 1
        return repaired

    def _finalize_activation(self, job: RagIndexJobModel, profile: RagDatasetProfileModel, dataset: dict[str, Any], target_index: str | None, *, chunking_version: str) -> None:
        now = datetime.now(timezone.utc)
        profile.active_index = target_index
        active_manifests = self.db.scalars(
            select(RagIndexManifestModel)
            .where(
                RagIndexManifestModel.dataset_id == job.dataset_id,
                RagIndexManifestModel.status == "active",
                RagIndexManifestModel.index_name != target_index,
            )
            .with_for_update()
        ).all()
        for manifest in active_manifests:
            manifest.status = "retired"
            manifest.retired_at = now
        if active_manifests:
            self.db.flush()
        manifest = self.db.scalar(select(RagIndexManifestModel).where(RagIndexManifestModel.dataset_id == job.dataset_id, RagIndexManifestModel.index_name == target_index))
        if manifest is None:
            manifest = RagIndexManifestModel(id=f"ragmanifest_{uuid4().hex}", dataset_id=job.dataset_id, index_name=target_index or "", alias_name=job.activation_alias or profile.target_alias or "")
            self.db.add(manifest)
        versions = job.contract_versions or self._contract_version_snapshot()
        manifest.generation = job.generation
        manifest.physical_column_mapping = job.physical_column_mapping or profile.physical_column_mapping or {}
        manifest.body_columns = job.body_columns or []
        manifest.title_columns = job.title_columns or []
        manifest.metadata_columns = job.metadata_columns or []
        manifest.identifier_columns = job.identifier_columns or []
        manifest.metadata_types = job.metadata_types or {}
        manifest.contract_versions = versions
        manifest.filter_contract_version = versions.get("filterContractVersion") or job.filter_contract_version
        manifest.status = "active"
        manifest.embedding_provider = job.embedding_provider
        manifest.embedding_model = job.embedding_model or settings.rag_embedding_model
        manifest.dimensions = job.embedding_dimensions or settings.rag_embedding_dimensions
        manifest.document_count = job.indexed_count
        manifest.parent_count = job.parent_count
        manifest.chunk_count = job.chunk_count
        manifest.failed_count = job.failed_count
        manifest.row_count = job.row_count
        manifest.failed_row_rate = job.failed_row_rate
        manifest.failed_row_rate_threshold = job.failed_row_rate_threshold
        manifest.failed_row_report = job.failed_row_report or {}
        manifest.fallback_count = job.fallback_count
        manifest.fallback_reasons = job.fallback_reasons or {}
        manifest.source_fingerprint = job.source_fingerprint
        manifest.schema_fingerprint = schema_fingerprint(dataset)
        manifest.policy_fingerprint = job.policy_fingerprint
        manifest.semantic_bindings_fingerprint = self._semantic_bindings_fingerprint(profile.semantic_bindings)
        manifest.chunking_version = versions.get("chunkingVersion") or chunking_version
        manifest.embedding_input_version = versions.get("embeddingInputVersion") or EMBEDDING_INPUT_VERSION
        manifest.parent_schema_version = versions.get("parentSchemaVersion") or RAG_PARENT_SCHEMA_VERSION
        manifest.parent_table = job.parent_table
        manifest.chunk_table = job.chunk_table
        manifest.checkpoint_path = job.checkpoint_path
        manifest.activated_at = manifest.activated_at or now
        profile.index_status = "ready"
        profile.embedding_status = "ready"
        profile.last_error = None
        job.status = "ready"
        job.stage = "ready"
        job.activation_status = "committed"
        job.activation_committed_at = now
        job.completed_at = job.completed_at or now
        job.error = None
        self.db.commit()
