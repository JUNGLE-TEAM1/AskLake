from typing import Any
import math
import re
from datetime import date
from uuid import uuid4

from app.core.auth_context import ActorContext
from app.core.config import Settings, settings
from app.services.ai_gateway_client import AiGatewayClient
from app.clients.opensearch_client import OpenSearchClient
from app.services.rag_tokens import count_tokens, truncate_tokens


def hybrid_rrf(lexical_hits: list[dict[str, Any]], vector_hits: list[dict[str, Any]], *, final_k: int = 8, vector_weight: float = 0.7, lexical_weight: float = 0.3, rrf_k: int = 60) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for rank, hit in enumerate(vector_hits, start=1):
        key = str(hit.get("_id") or hit.get("id") or hit.get("document_id"))
        item = merged.setdefault(key, {**hit, "_id": key, "retrieval": {}})
        item["retrieval"]["vectorRank"] = rank
        item["retrieval"]["vectorScore"] = finite_float(hit.get("_score"))
        item["retrieval"]["score"] = item["retrieval"].get("score", 0) + vector_weight / (rrf_k + rank)
    for rank, hit in enumerate(lexical_hits, start=1):
        key = str(hit.get("_id") or hit.get("id") or hit.get("document_id"))
        item = merged.setdefault(key, {**hit, "_id": key, "retrieval": {}})
        item["retrieval"]["lexicalRank"] = rank
        item["retrieval"]["lexicalScore"] = finite_float(hit.get("_score"))
        item["retrieval"]["score"] = item["retrieval"].get("score", 0) + lexical_weight / (rrf_k + rank)
    return sorted(merged.values(), key=lambda item: item.get("retrieval", {}).get("score", 0), reverse=True)[:final_k]


class RagSearchService:
    def __init__(self, runtime_settings: Settings | None = None, *, search_client: OpenSearchClient | None = None, gateway_client: AiGatewayClient | None = None) -> None:
        self.settings = runtime_settings or settings
        self.search_client = search_client or OpenSearchClient(self.settings)
        self.gateway_client = gateway_client or AiGatewayClient(self.settings)

    def search(self, *, query: str, aliases: list[str], actor: ActorContext, filters: dict[str, Any] | None = None, embedding_model: str | None = None, targets: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        if not aliases or not self.settings.opensearch_base_url:
            return {"sources": [], "retrieval": {"mode": "hybrid", "status": "not_configured", "aliases": aliases}}
        requested_targets = targets or [{"alias": alias, "embeddingModel": embedding_model} for alias in aliases]
        requested_targets = [
            {
                **target,
                "datasetId": str(target.get("datasetId") or target.get("alias") or ""),
            }
            for target in requested_targets
            if str(target.get("alias") or "").strip()
        ]
        if not requested_targets:
            return {"sources": [], "retrieval": {"mode": "hybrid", "status": "not_configured", "aliases": []}}

        try:
            plans, planner_provenance = self._query_plans(query, requested_targets)
        except Exception as exc:
            return {
                "sources": [],
                "retrieval": {
                    "mode": "hybrid",
                    "status": "query_planning_unavailable",
                    "reason": exc.__class__.__name__,
                    "aliases": [str(target["alias"]) for target in requested_targets],
                    "resultCount": 0,
                },
            }

        candidates: list[dict[str, Any]] = []
        degraded = False
        degradation_reasons: set[str] = set()
        active_aliases: list[str] = []
        applied_filters: dict[str, Any] = {}
        filter_clauses_by_alias: dict[str, list[dict[str, Any]]] = {}
        query_embedding_provenance: dict[str, dict[str, Any]] = {}
        for target in requested_targets:
            alias = str(target.get("alias") or "")
            dataset_id = str(target.get("datasetId") or alias)
            plan = plans.get(dataset_id)
            if not alias or plan is None or not plan["inDomain"]:
                continue
            active_aliases.append(alias)
            semantic_query = str(plan["semanticQuery"] or query).strip()
            target_filters = {**plan["filters"], **(filters or {})}
            filter_clauses = build_metadata_filter_clauses(target_filters)
            filter_clauses_by_alias[alias] = filter_clauses
            applied_filters[dataset_id] = target_filters
            model = target.get("embeddingModel") or embedding_model
            lexical_query: dict[str, Any] = {"must": {"multi_match": {"query": semantic_query, "fields": ["title^2", "body", "embedding_text"]}}}
            if filter_clauses:
                lexical_query["filter"] = filter_clauses
            try:
                lexical_hits = self.search_client.search(alias, {"size": 30, "query": {"bool": lexical_query}})
            except Exception:
                lexical_hits = []
                degraded = True
                degradation_reasons.add("lexical_search_unavailable")
            expected_provider = str(target.get("embeddingProvider") or "").strip()
            expected_model = str(model or "").strip()
            expected_dimensions = target.get("embeddingDimensions")
            try:
                if not expected_provider:
                    raise ValueError("Serving embedding provider is missing")
                if not expected_model:
                    raise ValueError("Serving embedding model is missing")
                if isinstance(expected_dimensions, bool) or not isinstance(expected_dimensions, int) or expected_dimensions <= 0:
                    raise ValueError("Serving embedding dimensions are missing")
                create_with_metadata = getattr(self.gateway_client, "create_embeddings_with_metadata", None)
                if not callable(create_with_metadata):
                    raise ValueError("Query embedding provenance is unavailable")
                embedding_result = create_with_metadata([semantic_query], model=expected_model)
                vector = embedding_result["data"][0]
                if embedding_result.get("provider") != expected_provider:
                    raise ValueError("Query embedding provider does not match the serving index")
                if embedding_result.get("model") != expected_model:
                    raise ValueError("Query embedding model does not match the serving index")
                if embedding_result.get("dimensions") != expected_dimensions or len(vector) != expected_dimensions:
                    raise ValueError("Query embedding dimensions do not match the serving manifest")
                query_embedding_provenance[dataset_id] = {
                    "provider": embedding_result.get("provider"),
                    "model": embedding_result.get("model"),
                    "dimensions": embedding_result.get("dimensions"),
                }
                knn: dict[str, Any] = {"vector": vector, "k": 30}
                if filter_clauses:
                    knn["filter"] = {"bool": {"filter": filter_clauses}}
            except Exception as exc:
                vector_hits = []
                degraded = True
                degradation_reasons.add(query_embedding_degradation_reason(exc))
            else:
                try:
                    vector_hits = self.search_client.search(alias, {"size": 30, "query": {"knn": {"body_vector": knn}}})
                except Exception:
                    vector_hits = []
                    degraded = True
                    degradation_reasons.add("vector_search_unavailable")
            alias_hits = hybrid_rrf(lexical_hits, vector_hits, final_k=30)
            for hit in alias_hits:
                hit["_rag_alias"] = alias
            candidates.extend(alias_hits)
        # Diversify before the retrieval budget is cut. Chunk-level top-24
        # can otherwise be monopolized by one long parent, causing unrelated
        # parents to disappear before the required parent deduplication step.
        parent_candidates: dict[str, dict[str, Any]] = {}
        for hit in sorted(candidates, key=lambda item: float(item.get("retrieval", {}).get("score", 0)), reverse=True):
            source = hit.get("_source") if isinstance(hit.get("_source"), dict) else hit
            parent_key = str(source.get("parent_document_id") or hit.get("_id") or hit.get("id") or hit.get("document_id"))
            parent_candidates.setdefault(parent_key, hit)
        hits = list(parent_candidates.values())[:24]
        try:
            sources = self._merge_parent_context(
                hits,
                aliases=active_aliases,
                filter_clauses_by_alias=filter_clauses_by_alias,
                final_k=8,
            )
        except Exception:
            degraded = True
            degradation_reasons.add("context_expansion_unavailable")
            sources = [self._source(hit) for hit in hits[:8]]
        retrieval = {
            "mode": "hybrid",
            "status": "degraded" if degraded else "ready",
            "aliases": active_aliases,
            "filters": applied_filters,
            "vectorWeight": 0.7,
            "lexicalWeight": 0.3,
            "degradationReasons": sorted(degradation_reasons),
            "queryPlannerProvider": planner_provenance.get("provider"),
            "queryPlannerModel": planner_provenance.get("model"),
            "queryEmbeddings": query_embedding_provenance,
            "resultCount": 0,
        }
        if not sources:
            retrieval["status"] = (
                "no_relevant_evidence"
                if not active_aliases
                else "degraded_no_matches"
                if degraded
                else "no_matches"
            )
            return {"sources": [], "retrieval": retrieval}

        try:
            sources, relevance_model, relevance_provider = self._filter_relevant_sources(query, sources, applied_filters)
        except Exception as exc:
            retrieval.update({
                "status": "relevance_unavailable",
                "reason": exc.__class__.__name__,
                "resultCount": 0,
            })
            return {"sources": [], "retrieval": retrieval}
        retrieval.update({
            "status": "degraded" if degraded and sources else "ready" if sources else "no_relevant_evidence",
            "relevanceModel": relevance_model,
            "relevanceProvider": relevance_provider,
            "relevanceThreshold": self.settings.rag_relevance_min_score,
            "resultCount": len(sources),
            "fallbackEvidenceCount": sum(1 for source in sources if source.get("fallbackApplied") is True),
            "fallbackReasons": sorted({
                str(reason)
                for source in sources
                for reason in source.get("fallbackReasons", [])
                if str(reason).strip()
            }),
        })
        return {"sources": sources, "retrieval": retrieval}

    def _query_plans(
        self,
        query: str,
        targets: list[dict[str, Any]],
    ) -> tuple[dict[str, dict[str, Any]], dict[str, str | None]]:
        if not self.settings.rag_query_intelligence_enabled:
            return (
                {
                    str(target["datasetId"]): {
                        "semanticQuery": query,
                        "inDomain": True,
                        "filters": {},
                    }
                    for target in targets
                },
                {"provider": None, "model": None},
            )
        payload = self.gateway_client.plan_rag_query(
            request_id=str(uuid4()),
            query=query,
            datasets=[self._planning_target(target) for target in targets],
        )
        raw_plans = payload.get("plans") if isinstance(payload, dict) else None
        if not isinstance(raw_plans, list):
            raise ValueError("RAG query planner did not return plans")
        expected_ids = [str(target["datasetId"]) for target in targets]
        target_by_id = {str(target["datasetId"]): target for target in targets}
        plans: dict[str, dict[str, Any]] = {}
        for raw_plan in raw_plans:
            if not isinstance(raw_plan, dict):
                raise ValueError("RAG query plan is invalid")
            dataset_id = str(raw_plan.get("datasetId") or "")
            if dataset_id not in target_by_id or dataset_id in plans:
                raise ValueError("RAG query plan Dataset scope is invalid")
            semantic_query = str(raw_plan.get("semanticQuery") or "").strip()
            if not semantic_query:
                raise ValueError("RAG semantic query is empty")
            plans[dataset_id] = {
                "semanticQuery": semantic_query,
                "inDomain": raw_plan.get("inDomain") is True,
                "filters": self._planned_filters(raw_plan.get("filters"), target_by_id[dataset_id]),
            }
        if list(plans) != expected_ids:
            raise ValueError("RAG query planner must preserve Dataset order and coverage")
        return plans, {
            "provider": str(payload.get("provider") or "") or None,
            "model": str(payload.get("model") or "") or None,
        }

    @staticmethod
    def _planning_target(target: dict[str, Any]) -> dict[str, Any]:
        metadata_fields = target.get("metadataFields") if isinstance(target.get("metadataFields"), list) else []
        return {
            "datasetId": str(target.get("datasetId") or target.get("alias") or ""),
            "datasetName": str(target.get("datasetName") or target.get("datasetId") or "")[:255],
            "description": str(target.get("description") or "")[:2_000],
            "titleFields": [str(item) for item in target.get("titleFields", []) if str(item).strip()][:32],
            "bodyFields": [str(item) for item in target.get("bodyFields", []) if str(item).strip()][:32],
            "metadataFields": [
                {
                    "logicalField": str(field.get("logicalField") or field.get("field") or "")[:255],
                    "physicalField": str(field.get("physicalField") or field.get("logicalField") or field.get("field") or "")[:255],
                    "storageType": str(field.get("storageType") or "keyword")[:32],
                }
                for field in metadata_fields[:100]
                if isinstance(field, dict)
            ],
        }

    @staticmethod
    def _planned_filters(raw_filters: Any, target: dict[str, Any]) -> dict[str, dict[str, Any]]:
        if raw_filters is None:
            return {}
        if not isinstance(raw_filters, list):
            raise ValueError("RAG planned filters must be a list")
        metadata_fields = target.get("metadataFields") if isinstance(target.get("metadataFields"), list) else []
        field_lookup: dict[str, dict[str, str]] = {}
        for field in metadata_fields:
            if not isinstance(field, dict):
                continue
            logical = str(field.get("logicalField") or field.get("field") or "").strip()
            physical = str(field.get("physicalField") or logical).strip()
            storage_type = str(field.get("storageType") or "keyword").strip().casefold()
            descriptor = {"logical": logical, "physical": physical, "storageType": storage_type}
            for key in {logical, physical}:
                if key:
                    field_lookup[key.casefold()] = descriptor
        normalized: dict[str, dict[str, Any]] = {}
        for item in raw_filters:
            if not isinstance(item, dict):
                raise ValueError("RAG planned filter is invalid")
            requested_field = str(item.get("field") or "").strip()
            descriptor = field_lookup.get(requested_field.casefold())
            if descriptor is None:
                raise ValueError("RAG query planner invented an unknown metadata field")
            operator = str(item.get("operator") or "")
            if operator not in {"eq", "gte", "gt", "lte", "lt"}:
                raise ValueError("RAG query planner returned an unsupported filter operator")
            storage_type = descriptor["storageType"]
            value = normalize_planned_filter_value(item.get("value"), storage_type)
            if operator != "eq" and storage_type not in {"number", "date"}:
                raise ValueError("RAG query planner returned a range filter for a non-range field")
            normalized[descriptor["logical"]] = {
                "operator": operator,
                "value": value,
                "storageType": storage_type,
                "physicalField": descriptor["physical"],
            }
        return normalized

    def _filter_relevant_sources(self, query: str, sources: list[dict[str, Any]], applied_filters: dict[str, Any]) -> tuple[list[dict[str, Any]], str, str]:
        candidates = [
            {
                "documentId": str(source.get("documentId") or ""),
                "datasetId": source.get("datasetId"),
                "title": str(source.get("title") or "")[:1_000],
                "body": truncate_tokens(str(source.get("body") or ""), 600),
                "metadata": source.get("metadata") if isinstance(source.get("metadata"), dict) else {},
            }
            for source in sources
            if str(source.get("documentId") or "").strip()
        ]
        if len(candidates) != len(sources):
            raise ValueError("RAG source is missing a document identifier")
        payload = self.gateway_client.judge_rag_relevance(
            request_id=str(uuid4()),
            query=query,
            candidates=candidates,
            applied_filters=applied_filters,
        )
        raw_judgments = payload.get("judgments") if isinstance(payload, dict) else None
        if not isinstance(raw_judgments, list):
            raise ValueError("RAG relevance output is missing")
        expected_ids = [candidate["documentId"] for candidate in candidates]
        judgments: dict[str, dict[str, Any]] = {}
        for item in raw_judgments:
            if not isinstance(item, dict):
                raise ValueError("RAG relevance judgment is invalid")
            document_id = str(item.get("documentId") or "")
            if document_id not in expected_ids or document_id in judgments:
                raise ValueError("RAG relevance judgment scope is invalid")
            score = float(item.get("score"))
            if not 0 <= score <= 1:
                raise ValueError("RAG relevance score is invalid")
            judgments[document_id] = {
                "relevant": item.get("relevant") is True,
                "score": score,
                "reason": str(item.get("reason") or "")[:500],
            }
        if list(judgments) != expected_ids:
            raise ValueError("RAG relevance judgments must preserve candidate order and coverage")
        accepted: list[dict[str, Any]] = []
        for source in sources:
            judgment = judgments[str(source["documentId"])]
            if not judgment["relevant"] or judgment["score"] < self.settings.rag_relevance_min_score:
                continue
            accepted.append({
                **source,
                "retrievalScore": source.get("score"),
                "score": judgment["score"],
                "relevanceReason": judgment["reason"],
            })
        accepted.sort(key=lambda item: (float(item.get("score") or 0), float(item.get("retrievalScore") or 0)), reverse=True)
        return (
            accepted,
            str(payload.get("model") or ""),
            str(payload.get("provider") or ""),
        )

    def _merge_parent_context(self, hits: list[dict[str, Any]], *, aliases: list[str], filter_clauses_by_alias: dict[str, list[dict[str, Any]]], final_k: int) -> list[dict[str, Any]]:
        groups: dict[str, list[dict[str, Any]]] = {}
        for hit in hits:
            source = hit.get("_source") if isinstance(hit.get("_source"), dict) else hit
            parent_id = str(source.get("parent_document_id") or source.get("document_id") or hit.get("_id") or "")
            groups.setdefault(parent_id, []).append(hit)
        results: list[dict[str, Any]] = []
        for parent_id, group in sorted(groups.items(), key=lambda item: max(float(hit.get("retrieval", {}).get("score", 0)) for hit in item[1]), reverse=True)[:final_k]:
            best = max(group, key=lambda hit: float(hit.get("retrieval", {}).get("score", 0)))
            chunks = list(group)
            best_source = best.get("_source") if isinstance(best.get("_source"), dict) else best
            try:
                best_chunk_index = int(best_source.get("chunk_index"))
            except (TypeError, ValueError):
                best_chunk_index = None
            source_aliases = list(dict.fromkeys(str(hit.get("_rag_alias") or "") for hit in group if hit.get("_rag_alias"))) or aliases
            for alias in source_aliases:
                query_filters = [{"term": {"parent_document_id": parent_id}}, *filter_clauses_by_alias.get(alias, [])]
                if best_chunk_index is not None:
                    query_filters.append({"range": {"chunk_index": {"gte": max(0, best_chunk_index - 2), "lte": best_chunk_index + 2}}})
                adjacent = self.search_client.search(alias, {"size": 9, "query": {"bool": {"filter": query_filters}}, "sort": [{"chunk_index": "asc"}]})
                known = {str((item.get("_source") or {}).get("chunk_document_id") or item.get("_id")) for item in chunks}
                chunks.extend(item for item in adjacent if str((item.get("_source") or {}).get("chunk_document_id") or item.get("_id")) not in known)
            ordered = sorted(chunks, key=lambda hit: int((hit.get("_source") or {}).get("chunk_index") or 0))
            primary = self._source(best)
            merged_body = self._merge_chunk_bodies(ordered, max_tokens=self.settings.rag_context_max_tokens)
            primary["body"] = merged_body or primary.get("body")
            chunk_sources = [self._source(item) for item in ordered]
            fallback_reasons = sorted({
                str(chunk.get("fallbackReason"))
                for chunk in chunk_sources
                if chunk.get("fallbackApplied") is True and str(chunk.get("fallbackReason") or "").strip()
            })
            primary["chunks"] = chunk_sources
            primary["chunkCount"] = len(ordered)
            primary["context"] = merged_body
            primary["fallbackApplied"] = any(chunk.get("fallbackApplied") is True for chunk in chunk_sources)
            primary["fallbackReasons"] = fallback_reasons
            primary["fallbackReason"] = ", ".join(fallback_reasons) or None
            primary["chunkingStrategies"] = sorted({
                str(chunk.get("chunkingStrategy"))
                for chunk in chunk_sources
                if str(chunk.get("chunkingStrategy") or "").strip()
            })
            results.append(primary)
        return results

    @staticmethod
    def _merge_chunk_bodies(chunks: list[dict[str, Any]], *, max_tokens: int | None = None, max_chars: int | None = None) -> str:
        """Merge adjacent chunk bodies without repeating overlap characters."""
        # max_chars is retained as a compatibility shim for existing callers;
        # production retrieval always supplies the configured token budget.
        budget = max_tokens if max_tokens is not None else max(1, int((max_chars or 24_000) / 4))
        if any(isinstance((hit.get("_source") if isinstance(hit.get("_source"), dict) else hit).get("body_blocks"), list) for hit in chunks):
            return RagSearchService._merge_structured_chunk_bodies(chunks, max_tokens=budget)
        parts: list[str] = []
        current_end: int | None = None
        for hit in chunks:
            source = hit.get("_source") if isinstance(hit.get("_source"), dict) else hit
            body = str(source.get("body") or "").strip()
            if not body:
                continue
            try:
                start = int(source.get("char_start"))
                end = int(source.get("char_end"))
            except (TypeError, ValueError):
                start = end = -1
            if current_end is not None and start >= 0 and start < current_end:
                body = body[max(0, current_end - start):]
            elif parts and start < 0 and body in parts[-1]:
                continue
            if body:
                parts.append(body)
                current_end = max(current_end or 0, end) if end >= 0 else None
            if count_tokens("\n\n".join(parts)) >= budget:
                break
        return truncate_tokens("\n\n".join(parts), budget)

    @staticmethod
    def _merge_structured_chunk_bodies(chunks: list[dict[str, Any]], *, max_tokens: int) -> str:
        """Merge field-labeled chunks using canonical fragment offsets.

        The displayed chunk body contains a repeated ``[BODY]`` wrapper and a
        repeated field label, so slicing it with the parent offset would be
        wrong.  The worker stores canonical fragment offsets alongside each
        block; those offsets let us remove overlap without losing labels.
        """
        by_field: dict[tuple[str, str], list[dict[str, Any]]] = {}
        order: dict[tuple[str, str], int] = {}
        for hit in chunks:
            source = hit.get("_source") if isinstance(hit.get("_source"), dict) else hit
            blocks = source.get("body_blocks") if isinstance(source.get("body_blocks"), list) else []
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                logical = str(block.get("logicalField") or "").strip()
                physical = str(block.get("physicalField") or logical).strip()
                text = str(block.get("text") or "")
                if not logical or not text:
                    continue
                try:
                    start = int(block.get("fragmentStart", block.get("valueStart", block.get("start", 0))))
                    end = int(block.get("fragmentEnd", block.get("valueEnd", block.get("end", start + len(text)))))
                except (TypeError, ValueError):
                    start, end = 0, len(text)
                key = (logical, physical)
                order.setdefault(key, start)
                try:
                    field_value_start = int(block.get("fieldValueStart", block.get("valueStart", 0)))
                except (TypeError, ValueError):
                    field_value_start = 0
                by_field.setdefault(key, []).append({"start": start, "end": end, "text": text, "fieldText": str(block.get("fieldText") or ""), "fieldValueStart": field_value_start})
        if not by_field:
            return ""
        rendered_fields: list[str] = []
        for key in sorted(by_field, key=lambda item: (order[item], item[0], item[1])):
            merged = ""
            cursor: int | None = None
            for fragment in sorted(by_field[key], key=lambda item: (item["start"], item["end"])):
                start, end, text = fragment["start"], fragment["end"], fragment["text"]
                if cursor is None:
                    merged = text
                    cursor = end
                    continue
                if start > cursor:
                    field_text = fragment.get("fieldText") or ""
                    field_start = int(fragment.get("fieldValueStart") or 0)
                    gap_start = max(0, cursor - field_start)
                    gap_end = max(gap_start, start - field_start)
                    if field_text and gap_end > gap_start:
                        merged += field_text[gap_start:gap_end]
                if start < cursor:
                    skip = min(len(text), cursor - start)
                    text = text[skip:]
                if text:
                    merged += text
                cursor = max(cursor, end)
            if merged:
                rendered_fields.append(f"{key[0]}: {merged}")
        if not rendered_fields:
            return ""
        return truncate_tokens("[BODY]\n" + "\n\n".join(rendered_fields) + "\n[/BODY]", max_tokens)

    @staticmethod
    def _source(hit: dict[str, Any]) -> dict[str, Any]:
        source = hit.get("_source") if isinstance(hit.get("_source"), dict) else hit
        return {
            "documentId": source.get("document_id") or hit.get("_id"),
            "chunkDocumentId": source.get("chunk_document_id") or source.get("document_id") or hit.get("_id"),
            "parentDocumentId": source.get("parent_document_id"),
            "datasetId": source.get("dataset_id"),
            "sourceRowId": source.get("source_row_id"),
            "title": source.get("title"),
            "body": source.get("body"),
            "metadata": source.get("metadata_display") or {},
            "sourceFields": source.get("source_fields") or [],
            "chunkIndex": source.get("chunk_index"),
            "chunkCount": source.get("chunk_count"),
            "charStart": source.get("char_start"),
            "charEnd": source.get("char_end"),
            "chunkingStrategy": source.get("chunking_strategy"),
            "chunkingVersion": source.get("chunking_version"),
            "embeddingModel": source.get("embedding_model"),
            "embeddingProvider": source.get("embedding_provider"),
            "embeddingDimensions": source.get("embedding_dimensions"),
            "fallbackApplied": source.get("fallback_applied") is True,
            "fallbackReason": source.get("fallback_reason"),
            "embeddingInputVersion": source.get("embedding_input_version"),
            "fieldRenderingVersion": source.get("field_rendering_version"),
            "retrievalAlias": hit.get("_rag_alias"),
            "score": hit.get("retrieval", {}).get("score"),
        }


def build_metadata_filter_clauses(filters: dict[str, Any]) -> list[dict[str, Any]]:
    """Build OpenSearch exact/range filters from typed metadata predicates.

    Field names are constrained to Catalog-like identifiers so a caller cannot
    smuggle query syntax through a metadata key.
    """
    clauses: list[dict[str, Any]] = []
    for field, predicate in filters.items():
        if not isinstance(predicate, dict) or not {"operator", "value"}.issubset(predicate):
            raise ValueError(f"RAG metadata filter for {field} must contain exactly operator and value")
        operator = predicate["operator"]
        value = predicate["value"]
        if operator not in {"eq", "gte", "gt", "lte", "lt"}:
            raise ValueError(f"Unsupported RAG metadata filter operator: {operator}")
        storage_type = str(predicate.get("storageType") or "").casefold()
        physical_field = str(predicate.get("physicalField") or field)
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", physical_field):
            raise ValueError(f"Invalid RAG metadata filter field: {field}")
        path = f"metadata_filter.{physical_field}"
        if operator == "eq":
            suffix = storage_type or ("date" if _looks_like_iso_date(value) else "keyword")
            normalized_value = value if suffix in {"number", "date", "boolean"} else str(value)
            clauses.append({"term": {f"{path}.{suffix}": normalized_value}})
        else:
            suffix = storage_type or ("date" if _looks_like_iso_date(value) else "number")
            if suffix not in {"date", "number"}:
                raise ValueError(f"Range filters require date or number metadata: {field}")
            clauses.append({"range": {f"{path}.{suffix}": {operator: value}}})
    return clauses


def normalize_planned_filter_value(value: Any, storage_type: str) -> Any:
    if storage_type == "number":
        if isinstance(value, bool):
            raise ValueError("Boolean is not a valid numeric RAG filter")
        try:
            parsed = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("RAG numeric filter is invalid") from exc
        if not math.isfinite(parsed):
            raise ValueError("RAG numeric filter is invalid")
        return int(parsed) if parsed.is_integer() else parsed
    if storage_type == "boolean":
        if isinstance(value, bool):
            return value
        normalized = str(value).strip().casefold()
        if normalized in {"true", "1", "yes", "y"}:
            return True
        if normalized in {"false", "0", "no", "n"}:
            return False
        raise ValueError("RAG boolean filter is invalid")
    if storage_type == "date":
        normalized = str(value or "").strip()
        if not _looks_like_iso_date(normalized):
            raise ValueError("RAG date filter must use ISO-8601")
        return normalized
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > 2_000:
        raise ValueError("RAG keyword filter is invalid")
    return normalized


def finite_float(value: Any) -> float:
    try:
        parsed = float(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return parsed if math.isfinite(parsed) else 0.0


def query_embedding_degradation_reason(error: Exception) -> str:
    message = str(getattr(error, "message", error)).casefold()
    if "serving embedding provider" in message and "missing" in message:
        return "serving_embedding_provider_missing"
    if "serving embedding model" in message and "missing" in message:
        return "serving_embedding_model_missing"
    if "serving embedding dimensions" in message and "missing" in message:
        return "serving_embedding_dimensions_missing"
    if "provenance" in message and "unavailable" in message:
        return "query_embedding_provenance_unavailable"
    if "provider" in message and "match" in message:
        return "query_embedding_provider_mismatch"
    if "model" in message and "match" in message:
        return "query_embedding_model_mismatch"
    if "dimension" in message and "match" in message:
        return "query_embedding_dimensions_mismatch"
    status_code = getattr(error, "status_code", None)
    if status_code == 504:
        return "query_embedding_timeout"
    if status_code == 503:
        return "query_embedding_service_unavailable"
    if status_code == 502:
        return "query_embedding_invalid_response"
    return "query_embedding_failed"


def _looks_like_iso_date(value: Any) -> bool:
    text = str(value or "").strip()
    if len(text) < 10 or text[4:5] != "-" or text[7:8] != "-":
        return False
    try:
        date.fromisoformat(text[:10])
    except ValueError:
        return False
    return True
