import hashlib
import json
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.identity import AiGenerationUsageModel
from app.schemas.common import ErrorCode


def evidence_candidate_ids(rag_context: dict[str, Any] | None) -> list[str]:
    return list(dict.fromkeys(
        str(source.get("documentId") or "").strip()
        for source in (rag_context or {}).get("sources") or []
        if isinstance(source, dict) and str(source.get("documentId") or "").strip()
    ))


def verified_used_evidence_ids(rag_context: dict[str, Any] | None) -> list[str]:
    return evidence_candidate_ids(rag_context)


def persist_verified_generation_evidence(
    db: Session,
    *,
    actor: ActorContext,
    candidate_ids: list[str],
    context_payload: dict[str, Any],
    mode: str,
    model: str,
    output_payload: dict[str, Any],
    provider: str,
    request_id: str,
    used_ids: list[str],
) -> None:
    candidates = _bounded_unique_ids(candidate_ids)
    used = _bounded_unique_ids(used_ids)
    if any(evidence_id not in set(candidates) for evidence_id in used):
        raise ApiError(
            ErrorCode.INTERNAL_ERROR,
            "Verified AI evidence is outside the supplied candidate set",
            status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
    normalized_request_id = request_id.strip()
    normalized_provider = provider.strip()
    normalized_model = model.strip()
    if not normalized_request_id or not normalized_provider or not normalized_model:
        raise ApiError(
            ErrorCode.INTERNAL_ERROR,
            "AI generation audit provenance is incomplete",
            status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    try:
        record = db.get(AiGenerationUsageModel, normalized_request_id)
        if record is None:
            record = AiGenerationUsageModel(
                request_id=normalized_request_id,
                mode=mode[:64],
                provider=normalized_provider[:100],
                model=normalized_model[:255],
                input_tokens=0,
                output_tokens=0,
                total_tokens=0,
                estimated_cost_usd=0,
            )
            db.add(record)
        record.mode = mode[:64]
        record.provider = normalized_provider[:100]
        record.model = normalized_model[:255]
        record.actor_id = (actor.id or actor.name)[:255]
        record.actor_name = actor.name[:255]
        record.candidate_evidence_ids = candidates
        record.used_evidence_ids = used
        record.context_fingerprint = _fingerprint(context_payload)
        record.output_fingerprint = _fingerprint(output_payload)
        record.evidence_status = "verified"
        db.commit()
    except ApiError:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise ApiError(
            ErrorCode.INTERNAL_ERROR,
            "AI generation evidence audit could not be persisted",
            status.HTTP_500_INTERNAL_SERVER_ERROR,
        ) from exc


def _bounded_unique_ids(values: list[str]) -> list[str]:
    normalized = list(dict.fromkeys(str(value).strip() for value in values if str(value).strip()))
    if len(normalized) > 24 or any(len(value) > 255 for value in normalized):
        raise ApiError(
            ErrorCode.INTERNAL_ERROR,
            "AI evidence audit IDs exceed the bounded contract",
            status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
    return normalized


def _fingerprint(value: dict[str, Any]) -> str:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
