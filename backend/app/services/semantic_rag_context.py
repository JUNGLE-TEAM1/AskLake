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
    requested_dataset_ids = list(dict.fromkeys(str(item).strip() for item in dataset_ids if str(item).strip()))
    empty = _empty_rag_context(requested_dataset_ids)
    if db is None:
        return empty
    resolved_models, requested_dataset_ids, failure = _resolve_semantic_models(
        db=db,
        actor=actor,
        semantic_model_id=semantic_model_id,
        requested_dataset_ids=requested_dataset_ids,
        empty=empty,
    )
    if failure is not None:
        return failure

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
    aliases, targets, alias_model_ids, alias_dataset_ids = _rag_search_targets(
        rag_service=rag_service,
        actor=actor,
        dataset_ids=resolved_dataset_ids,
        resolved_models=resolved_models,
    )
    retrieval_base = _retrieval_provenance(resolved_dataset_ids, resolved_models, aliases)
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
    return _verified_search_result(
        result=result,
        retrieval_base=retrieval_base,
        resolved_models=resolved_models,
        alias_model_ids=alias_model_ids,
        alias_dataset_ids=alias_dataset_ids,
    )


def _empty_rag_context(dataset_ids: list[str]) -> dict[str, Any]:
    return {
        "sources": [],
        "retrieval": {
            "mode": "hybrid",
            "status": "unavailable",
            "provenance": "semantic_layer_rag",
            "datasetIds": dataset_ids,
            "semanticModels": [],
        },
    }


def _resolve_semantic_models(
    *,
    db: Any,
    actor: ActorContext,
    semantic_model_id: str | None,
    requested_dataset_ids: list[str],
    empty: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str], dict[str, Any] | None]:
    try:
        semantic_models = SemanticModelService(db)
    except Exception as exc:
        empty["retrieval"].update({"status": "semantic_layer_unavailable", "reason": exc.__class__.__name__})
        return [], requested_dataset_ids, empty
    if not semantic_model_id:
        if not requested_dataset_ids:
            return [], requested_dataset_ids, empty
        resolved = semantic_models.published_query_models_for_datasets(requested_dataset_ids, actor)
        if not resolved:
            empty["retrieval"]["status"] = "no_published_semantic_model"
            return [], requested_dataset_ids, empty
        return resolved, requested_dataset_ids, None

    model = semantic_models.published_query_model(semantic_model_id, actor)
    if model is None:
        empty["retrieval"].update({"status": "semantic_model_not_available", "semanticModelId": semantic_model_id})
        return [], requested_dataset_ids, empty
    model_dataset_ids = list(dict.fromkeys(
        str(item).strip()
        for item in model.get("datasetIds", [])
        if str(item).strip()
    ))
    model_dataset_id_set = set(model_dataset_ids)
    if not requested_dataset_ids:
        requested_dataset_ids = model_dataset_ids
        empty["retrieval"]["datasetIds"] = requested_dataset_ids
    missing_dataset_ids = [
        dataset_id
        for dataset_id in requested_dataset_ids
        if dataset_id not in model_dataset_id_set
    ]
    if missing_dataset_ids:
        empty["retrieval"].update({
            "status": "semantic_model_dataset_mismatch",
            "semanticModelId": semantic_model_id,
            "missingDatasetIds": missing_dataset_ids,
        })
        return [], requested_dataset_ids, empty
    return [model], requested_dataset_ids, None


def _rag_search_targets(
    *,
    rag_service: RagService,
    actor: ActorContext,
    dataset_ids: list[str],
    resolved_models: list[dict[str, Any]],
) -> tuple[list[str], list[dict[str, Any]], dict[str, list[str]], dict[str, set[str]]]:
    aliases: list[str] = []
    targets: list[dict[str, Any]] = []
    alias_model_ids: dict[str, list[str]] = {}
    alias_dataset_ids: dict[str, set[str]] = {}
    for dataset_id in dataset_ids:
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
        alias_dataset_ids.setdefault(alias, set()).add(dataset_id)
        if alias in aliases:
            alias_model_ids[alias] = list(dict.fromkeys([*alias_model_ids[alias], *model_ids]))
            continue
        aliases.append(alias)
        alias_model_ids[alias] = model_ids
        target = {
            **rag_service.search_target_context(dataset_id, actor, profile=profile),
            "alias": alias,
        }
        target.setdefault("embeddingProvider", getattr(profile, "active_embedding_provider", None))
        target.setdefault("embeddingModel", getattr(profile, "active_embedding_model", None))
        target.setdefault("embeddingDimensions", getattr(profile, "active_embedding_dimensions", None))
        targets.append(target)
    return aliases, targets, alias_model_ids, alias_dataset_ids


def _retrieval_provenance(
    dataset_ids: list[str],
    resolved_models: list[dict[str, Any]],
    aliases: list[str],
) -> dict[str, Any]:
    return {
        "provenance": "semantic_layer_rag",
        "datasetIds": dataset_ids,
        "semanticModels": resolved_models,
        "semanticModelIds": [str(model["id"]) for model in resolved_models],
        "semanticModelNames": [str(model["name"]) for model in resolved_models],
        "semanticModelVersions": [model.get("version") for model in resolved_models],
        "aliases": aliases,
    }


def _verified_search_result(
    *,
    result: dict[str, Any],
    retrieval_base: dict[str, Any],
    resolved_models: list[dict[str, Any]],
    alias_model_ids: dict[str, list[str]],
    alias_dataset_ids: dict[str, set[str]],
) -> dict[str, Any]:
    retrieval = dict(result.get("retrieval") or {})
    retrieval.update(retrieval_base)
    sources = []
    evidence_scope_mismatch = False
    for source in result.get("sources") or []:
        enriched = dict(source)
        source_alias = str(enriched.get("retrievalAlias") or "")
        source_dataset_id = str(enriched.get("datasetId") or "").strip()
        model_ids = alias_model_ids.get(source_alias, [])
        expected_dataset_ids = alias_dataset_ids.get(source_alias, set())
        if (
            not model_ids
            or len(expected_dataset_ids) != 1
            or source_dataset_id not in expected_dataset_ids
        ):
            # Fail closed if a search transport returns evidence from an alias
            # that was not bound to exactly the expected Dataset and Semantic Model.
            evidence_scope_mismatch = True
            continue
        enriched["semanticModelIds"] = model_ids
        enriched["semanticModels"] = [model for model in resolved_models if str(model["id"]) in model_ids]
        sources.append(enriched)
    if evidence_scope_mismatch:
        retrieval["status"] = "evidence_scope_mismatch"
        retrieval["reason"] = "Search evidence was not bound to the expected semantic model Dataset aliases"
        retrieval["resultCount"] = 0
        return {"sources": [], "retrieval": retrieval}
    retrieval["resultCount"] = len(sources)
    return {"sources": sources, "retrieval": retrieval}
