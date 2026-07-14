from typing import Any
import re
from datetime import date

from app.core.auth_context import ActorContext
from app.core.config import Settings, settings
from app.services.ai_gateway_client import AiGatewayClient
from app.clients.opensearch_client import OpenSearchClient


def hybrid_rrf(lexical_hits: list[dict[str, Any]], vector_hits: list[dict[str, Any]], *, final_k: int = 8, vector_weight: float = 0.7, lexical_weight: float = 0.3, rrf_k: int = 60) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for rank, hit in enumerate(vector_hits, start=1):
        key = str(hit.get("_id") or hit.get("id") or hit.get("document_id"))
        item = merged.setdefault(key, {**hit, "_id": key, "retrieval": {}})
        item["retrieval"]["vectorRank"] = rank
        item["retrieval"]["score"] = item["retrieval"].get("score", 0) + vector_weight / (rrf_k + rank)
    for rank, hit in enumerate(lexical_hits, start=1):
        key = str(hit.get("_id") or hit.get("id") or hit.get("document_id"))
        item = merged.setdefault(key, {**hit, "_id": key, "retrieval": {}})
        item["retrieval"]["lexicalRank"] = rank
        item["retrieval"]["score"] = item["retrieval"].get("score", 0) + lexical_weight / (rrf_k + rank)
    return sorted(merged.values(), key=lambda item: item.get("retrieval", {}).get("score", 0), reverse=True)[:final_k]


class RagSearchService:
    def __init__(self, runtime_settings: Settings | None = None, *, search_client: OpenSearchClient | None = None, gateway_client: AiGatewayClient | None = None) -> None:
        self.settings = runtime_settings or settings
        self.search_client = search_client or OpenSearchClient(self.settings)
        self.gateway_client = gateway_client or AiGatewayClient(self.settings)

    def search(self, *, query: str, aliases: list[str], actor: ActorContext, filters: dict[str, Any] | None = None, embedding_model: str | None = None) -> dict[str, Any]:
        if not aliases or not self.settings.opensearch_base_url:
            return {"sources": [], "retrieval": {"mode": "hybrid", "status": "not_configured", "aliases": aliases}}
        vector = self.gateway_client.create_embeddings([query], model=embedding_model)[0]
        lexical_hits: list[dict[str, Any]] = []
        vector_hits: list[dict[str, Any]] = []
        filter_clauses = build_metadata_filter_clauses(filters or {})
        for alias in aliases:
            lexical_query: dict[str, Any] = {"must": {"multi_match": {"query": query, "fields": ["title^2", "body", "embedding_text"]}}}
            if filter_clauses:
                lexical_query["filter"] = filter_clauses
            lexical_hits.extend(self.search_client.search(alias, {"size": 30, "query": {"bool": lexical_query}}))
            knn: dict[str, Any] = {"vector": vector, "k": 30}
            if filter_clauses:
                knn["filter"] = {"bool": {"filter": filter_clauses}}
            vector_hits.extend(self.search_client.search(alias, {"size": 30, "query": {"knn": {"body_vector": knn}}}))
        hits = hybrid_rrf(lexical_hits, vector_hits, final_k=24)
        sources = self._merge_parent_context(hits, aliases=aliases, filter_clauses=filter_clauses, final_k=8)
        return {"sources": sources, "retrieval": {"mode": "hybrid", "status": "ready", "aliases": aliases, "filters": filters or {}, "vectorWeight": 0.7, "lexicalWeight": 0.3, "resultCount": len(sources)}}

    def _merge_parent_context(self, hits: list[dict[str, Any]], *, aliases: list[str], filter_clauses: list[dict[str, Any]], final_k: int) -> list[dict[str, Any]]:
        groups: dict[str, list[dict[str, Any]]] = {}
        for hit in hits:
            source = hit.get("_source") if isinstance(hit.get("_source"), dict) else hit
            parent_id = str(source.get("parent_document_id") or source.get("document_id") or hit.get("_id") or "")
            groups.setdefault(parent_id, []).append(hit)
        results: list[dict[str, Any]] = []
        for parent_id, group in sorted(groups.items(), key=lambda item: max(float(hit.get("retrieval", {}).get("score", 0)) for hit in item[1]), reverse=True)[:final_k]:
            best = max(group, key=lambda hit: float(hit.get("retrieval", {}).get("score", 0)))
            chunks = list(group)
            for alias in aliases:
                query_filters = [{"term": {"parent_document_id": parent_id}}, *filter_clauses]
                adjacent = self.search_client.search(alias, {"size": 5, "query": {"bool": {"filter": query_filters}}, "sort": [{"chunk_index": "asc"}]})
                known = {str((item.get("_source") or {}).get("chunk_document_id") or item.get("_id")) for item in chunks}
                chunks.extend(item for item in adjacent if str((item.get("_source") or {}).get("chunk_document_id") or item.get("_id")) not in known)
            ordered = sorted(chunks, key=lambda hit: int((hit.get("_source") or {}).get("chunk_index") or 0))
            primary = self._source(best)
            merged_body = "\n\n".join(str((item.get("_source") or {}).get("body") or "").strip() for item in ordered if str((item.get("_source") or {}).get("body") or "").strip())
            primary["body"] = merged_body or primary.get("body")
            primary["chunks"] = [self._source(item) for item in ordered]
            primary["chunkCount"] = len(ordered)
            primary["context"] = merged_body[:24_000]
            results.append(primary)
        return results

    @staticmethod
    def _source(hit: dict[str, Any]) -> dict[str, Any]:
        source = hit.get("_source") if isinstance(hit.get("_source"), dict) else hit
        return {"documentId": source.get("document_id") or hit.get("_id"), "chunkDocumentId": source.get("chunk_document_id") or source.get("document_id") or hit.get("_id"), "parentDocumentId": source.get("parent_document_id"), "datasetId": source.get("dataset_id"), "sourceRowId": source.get("source_row_id"), "title": source.get("title"), "body": source.get("body"), "metadata": source.get("metadata_display") or {}, "chunkIndex": source.get("chunk_index"), "chunkCount": source.get("chunk_count"), "charStart": source.get("char_start"), "charEnd": source.get("char_end"), "fallbackApplied": source.get("fallback_applied"), "fallbackReason": source.get("fallback_reason"), "score": hit.get("retrieval", {}).get("score")}


def build_metadata_filter_clauses(filters: dict[str, Any]) -> list[dict[str, Any]]:
    """Build OpenSearch exact/range filters from typed metadata predicates.

    Field names are constrained to Catalog-like identifiers so a caller cannot
    smuggle query syntax through a metadata key.
    """
    clauses: list[dict[str, Any]] = []
    for field, predicate in filters.items():
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", str(field)):
            raise ValueError(f"Invalid RAG metadata filter field: {field}")
        path = f"metadata_filter.{field}"
        if not isinstance(predicate, dict) or set(predicate) != {"operator", "value"}:
            raise ValueError(f"RAG metadata filter for {field} must contain exactly operator and value")
        operator = predicate["operator"]
        value = predicate["value"]
        if operator not in {"eq", "gte", "gt", "lte", "lt"}:
            raise ValueError(f"Unsupported RAG metadata filter operator: {operator}")
        if operator == "eq":
            suffix = "date" if _looks_like_iso_date(value) else "keyword"
            clauses.append({"term": {f"{path}.{suffix}": str(value)}})
        else:
            suffix = "date" if _looks_like_iso_date(value) else "number"
            clauses.append({"range": {f"{path}.{suffix}": {operator: value}}})
    return clauses


def _looks_like_iso_date(value: Any) -> bool:
    text = str(value or "").strip()
    if len(text) < 10 or text[4:5] != "-" or text[7:8] != "-":
        return False
    try:
        date.fromisoformat(text[:10])
    except ValueError:
        return False
    return True
