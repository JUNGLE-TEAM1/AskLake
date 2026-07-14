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

    def search(self, *, query: str, aliases: list[str], actor: ActorContext, filters: dict[str, Any] | None = None) -> dict[str, Any]:
        if not aliases or not self.settings.opensearch_base_url:
            return {"sources": [], "retrieval": {"mode": "hybrid", "status": "not_configured", "aliases": aliases}}
        vector = self.gateway_client.create_embeddings([query])[0]
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
            vector_hits.extend(self.search_client.search(alias, {"size": 30, "knn": {"body_vector": knn}}))
        hits = hybrid_rrf(lexical_hits, vector_hits)
        sources = [self._source(hit) for hit in hits]
        return {"sources": sources, "retrieval": {"mode": "hybrid", "status": "ready", "aliases": aliases, "filters": filters or {}, "vectorWeight": 0.7, "lexicalWeight": 0.3, "resultCount": len(sources)}}

    @staticmethod
    def _source(hit: dict[str, Any]) -> dict[str, Any]:
        source = hit.get("_source") if isinstance(hit.get("_source"), dict) else hit
        return {"documentId": source.get("document_id") or hit.get("_id"), "chunkDocumentId": source.get("chunk_document_id") or source.get("document_id") or hit.get("_id"), "parentDocumentId": source.get("parent_document_id"), "datasetId": source.get("dataset_id"), "sourceRowId": source.get("source_row_id"), "title": source.get("title"), "body": source.get("body"), "metadata": source.get("metadata_display") or {}, "chunkIndex": source.get("chunk_index"), "startSentence": source.get("start_sentence"), "endSentence": source.get("end_sentence"), "score": hit.get("retrieval", {}).get("score")}


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
        if isinstance(predicate, dict):
            if "eq" in predicate:
                suffix = "date" if _looks_like_iso_date(predicate["eq"]) else "keyword"
                clauses.append({"term": {f"{path}.{suffix}": str(predicate["eq"])}})
            for operator in ("gte", "gt", "lte", "lt"):
                if operator in predicate:
                    suffix = "date" if _looks_like_iso_date(predicate[operator]) else "number"
                    clauses.append({"range": {f"{path}.{suffix}": {operator: predicate[operator]}}})
        else:
            suffix = "date" if _looks_like_iso_date(predicate) else "keyword"
            clauses.append({"term": {f"{path}.{suffix}": str(predicate)}})
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
