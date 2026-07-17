from typing import Any

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.services.rag_search_service import RagSearchService
from app.services.rag_service import RagService
from app.services.semantic_model_service import SemanticModelService


def build_semantic_rag_context(
    *,
    db: Any,
    settings: Settings,
    actor: ActorContext,
    query: str,
    dataset_ids: list[str],
    semantic_model_id: str | None = None,
    filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve and execute the shared semantic-layer RAG contract.

    Every caller receives both retrieval data and the identity of the
    published semantic model(s) that authorized the retrieval.  This prevents
    a UI from showing a generic "RAG ready" label while actually using an
    unrelated Dataset-only search path.
    """
    requested_dataset_ids = list(dict.fromkeys(str(item) for item in dataset_ids if str(item).strip()))
    empty = {"sources": [], "retrieval": {"mode": "hybrid", "status": "unavailable", "provenance": "semantic_layer_rag", "datasetIds": requested_dataset_ids, "semanticModels": []}}
    if db is None:
        return empty

    try:
        semantic_models = SemanticModelService(db)
    except Exception as exc:
        empty["retrieval"].update({"status": "semantic_layer_unavailable", "reason": exc.__class__.__name__})
        return empty
    if semantic_model_id:
        model = semantic_models.published_query_model(semantic_model_id, actor)
        if model is None:
            empty["retrieval"].update({"status": "semantic_model_not_available", "semanticModelId": semantic_model_id})
            return empty
        resolved_models = [model]
        model_dataset_ids = {
            str(item)
            for item in model.get("datasetIds", [])
            if str(item).strip()
        }
        if not requested_dataset_ids:
            requested_dataset_ids = list(model_dataset_ids)
            empty["retrieval"]["datasetIds"] = requested_dataset_ids
        missing_dataset_ids = [
            dataset_id
            for dataset_id in requested_dataset_ids
            if dataset_id not in model_dataset_ids
        ]
        if missing_dataset_ids:
            empty["retrieval"].update({
                "status": "semantic_model_dataset_mismatch",
                "semanticModelId": semantic_model_id,
                "missingDatasetIds": missing_dataset_ids,
            })
            return empty
    else:
        if not requested_dataset_ids:
            return empty
        resolved_models = semantic_models.published_query_models_for_datasets(requested_dataset_ids, actor)

    if not resolved_models:
        empty["retrieval"]["status"] = "no_published_semantic_model"
        return empty

    bound_dataset_ids = {
        str(dataset_id)
        for model in resolved_models
        for dataset_id in model.get("datasetIds", [])
        if str(dataset_id).strip()
    }
    unbound_dataset_ids = [
        dataset_id
        for dataset_id in requested_dataset_ids
        if dataset_id not in bound_dataset_ids
    ]
    if unbound_dataset_ids:
        empty["retrieval"].update({
            "status": "dataset_without_published_semantic_model",
            "missingDatasetIds": unbound_dataset_ids,
            "semanticModels": resolved_models,
            "semanticModelIds": [str(model["id"]) for model in resolved_models],
        })
        return empty

    # Retrieval is intentionally scoped to the exact Dataset selection. A
    # published model may contain additional Datasets, but selecting one of
    # them must not silently pull evidence from all of its siblings.
    resolved_dataset_ids = requested_dataset_ids
    rag_service = RagService(db)
    aliases: list[str] = []
    targets: list[dict[str, Any]] = []
    alias_model_ids: dict[str, list[str]] = {}
    for dataset_id in resolved_dataset_ids:
        try:
            rag_service._dataset(dataset_id, actor, "query")
            profile = rag_service.profile(dataset_id, actor)
        except Exception:
            continue
        if profile.review_state != "approved" or profile.serving_status not in {"serving", "stale"} or not profile.target_alias:
            continue
        alias = profile.target_alias
        model_ids = [
            str(model["id"])
            for model in resolved_models
            if dataset_id in model.get("datasetIds", [])
        ]
        if not model_ids:
            continue
        if alias in aliases:
            alias_model_ids[alias] = list(dict.fromkeys([*alias_model_ids[alias], *model_ids]))
            continue
        aliases.append(alias)
        alias_model_ids[alias] = model_ids
        target = {
            **rag_service.search_target_context(dataset_id, actor, profile=profile),
            "alias": alias,
        }
        # search_target_context is the canonical source.  The profile fallback
        # keeps older callers/test doubles from crashing while a pre-provider
        # manifest is being surfaced as unavailable/degraded instead.
        target.setdefault("embeddingProvider", getattr(profile, "active_embedding_provider", None))
        target.setdefault("embeddingModel", getattr(profile, "active_embedding_model", None))
        target.setdefault("embeddingDimensions", getattr(profile, "active_embedding_dimensions", None))
        targets.append(target)

    retrieval_base = {
        "provenance": "semantic_layer_rag",
        "datasetIds": resolved_dataset_ids,
        "semanticModels": resolved_models,
        "semanticModelIds": [str(model["id"]) for model in resolved_models],
        "semanticModelNames": [str(model["name"]) for model in resolved_models],
        "semanticModelVersions": [model.get("version") for model in resolved_models],
        "aliases": aliases,
    }
    if not aliases:
        return {"sources": [], "retrieval": {"mode": "hybrid", "status": "no_active_rag_index", **retrieval_base, "resultCount": 0}}

    try:
        result = RagSearchService(settings).search(
            query=query,
            aliases=aliases,
            targets=targets,
            filters=filters,
            actor=actor,
        )
    except Exception as exc:
        return {"sources": [], "retrieval": {"mode": "hybrid", "status": "unavailable", "reason": exc.__class__.__name__, **retrieval_base, "resultCount": 0}}

    retrieval = dict(result.get("retrieval") or {})
    retrieval.update(retrieval_base)
    sources = []
    for source in result.get("sources") or []:
        enriched = dict(source)
        source_alias = str(enriched.get("retrievalAlias") or "")
        model_ids = alias_model_ids.get(source_alias, [])
        if not model_ids:
            # Fail closed if a search transport returns evidence from an alias
            # that was not bound to one of the resolved Semantic Models.
            continue
        enriched["semanticModelIds"] = model_ids
        enriched["semanticModels"] = [model for model in resolved_models if str(model["id"]) in model_ids]
        sources.append(enriched)
    retrieval["resultCount"] = len(sources)
    if result.get("sources") and not sources:
        retrieval["status"] = "evidence_scope_mismatch"
        retrieval["reason"] = "Search evidence was not bound to the resolved semantic model aliases"
    return {"sources": sources, "retrieval": retrieval}
