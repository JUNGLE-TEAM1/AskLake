from copy import deepcopy
from typing import Any


MAX_USED_EVIDENCE = 24


def _nonnegative_count(value: object, fallback: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return fallback
    return value


def validate_used_evidence_ids(
    value: object,
    rag_context: dict[str, Any] | None,
) -> list[str]:
    """Validate model-reported evidence against the exact supplied RAG candidates."""

    if not isinstance(value, list) or len(value) > MAX_USED_EVIDENCE:
        raise ValueError("AI usedEvidenceIds must be a bounded list")
    normalized: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError("AI usedEvidenceIds must contain only strings")
        evidence_id = item.strip()
        if not evidence_id or len(evidence_id) > 255 or evidence_id in normalized:
            raise ValueError("AI usedEvidenceIds are invalid or duplicated")
        normalized.append(evidence_id)

    sources = rag_context.get("sources") if isinstance(rag_context, dict) else None
    allowed_ids = {
        str(source.get("documentId") or "").strip()
        for source in sources or []
        if isinstance(source, dict) and str(source.get("documentId") or "").strip()
    }
    if any(evidence_id not in allowed_ids for evidence_id in normalized):
        raise ValueError("AI cited evidence outside the supplied RAG context")
    return normalized


def retain_used_rag_evidence(
    rag_context: dict[str, Any] | None,
    used_evidence_ids: list[str],
) -> dict[str, Any] | None:
    """Return RAG metadata with only sources the generation says it actually used."""

    if not isinstance(rag_context, dict):
        return None
    normalized = validate_used_evidence_ids(used_evidence_ids, rag_context)
    source_by_id: dict[str, dict[str, Any]] = {}
    for source in rag_context.get("sources") or []:
        if not isinstance(source, dict):
            continue
        document_id = str(source.get("documentId") or "").strip()
        if document_id and document_id not in source_by_id:
            source_by_id[document_id] = source
    selected_sources = [deepcopy(source_by_id[item]) for item in normalized]

    retrieval = deepcopy(rag_context.get("retrieval")) if isinstance(rag_context.get("retrieval"), dict) else {}
    retrieval["candidateResultCount"] = _nonnegative_count(
        retrieval.get("resultCount"),
        len(source_by_id),
    )
    retrieval["resultCount"] = len(selected_sources)
    retrieval["evidenceStatus"] = "used" if selected_sources else "not_used"
    retrieval["fallbackEvidenceCount"] = sum(
        1 for source in selected_sources if source.get("fallbackApplied") is True
    )
    retrieval["fallbackReasons"] = sorted({
        str(reason)
        for source in selected_sources
        for reason in source.get("fallbackReasons") or []
        if str(reason).strip()
    })
    return {"sources": selected_sources, "retrieval": retrieval}
