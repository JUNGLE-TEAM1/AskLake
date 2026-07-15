from typing import Any
import re
from datetime import date

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

    def search(self, *, query: str, aliases: list[str], actor: ActorContext, filters: dict[str, Any] | None = None, embedding_model: str | None = None, targets: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        if not aliases or not self.settings.opensearch_base_url:
            return {"sources": [], "retrieval": {"mode": "hybrid", "status": "not_configured", "aliases": aliases}}
        filter_clauses = build_metadata_filter_clauses(filters or {})
        requested_targets = targets or [{"alias": alias, "embeddingModel": embedding_model} for alias in aliases]
        candidates: list[dict[str, Any]] = []
        degraded = False
        for target in requested_targets:
            alias = str(target.get("alias") or "")
            if not alias:
                continue
            model = target.get("embeddingModel") or embedding_model
            lexical_query: dict[str, Any] = {"must": {"multi_match": {"query": query, "fields": ["title^2", "body", "embedding_text"]}}}
            if filter_clauses:
                lexical_query["filter"] = filter_clauses
            lexical_hits = self.search_client.search(alias, {"size": 30, "query": {"bool": lexical_query}})
            try:
                vector = self.gateway_client.create_embeddings([query], model=model)[0]
                expected_dimensions = target.get("embeddingDimensions")
                if expected_dimensions and len(vector) != int(expected_dimensions):
                    raise ValueError("Query embedding dimensions do not match the serving manifest")
                knn: dict[str, Any] = {"vector": vector, "k": 30}
                if filter_clauses:
                    knn["filter"] = {"bool": {"filter": filter_clauses}}
                vector_hits = self.search_client.search(alias, {"size": 30, "query": {"knn": {"body_vector": knn}}})
            except Exception:
                vector_hits = []
                degraded = True
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
        sources = self._merge_parent_context(hits, aliases=aliases, filter_clauses=filter_clauses, final_k=8)
        return {"sources": sources, "retrieval": {"mode": "hybrid", "status": "degraded" if degraded else "ready", "aliases": aliases, "filters": filters or {}, "vectorWeight": 0.7, "lexicalWeight": 0.3, "resultCount": len(sources)}}

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
            best_source = best.get("_source") if isinstance(best.get("_source"), dict) else best
            try:
                best_chunk_index = int(best_source.get("chunk_index"))
            except (TypeError, ValueError):
                best_chunk_index = None
            source_aliases = list(dict.fromkeys(str(hit.get("_rag_alias") or "") for hit in group if hit.get("_rag_alias"))) or aliases
            for alias in source_aliases:
                query_filters = [{"term": {"parent_document_id": parent_id}}, *filter_clauses]
                if best_chunk_index is not None:
                    query_filters.append({"range": {"chunk_index": {"gte": max(0, best_chunk_index - 2), "lte": best_chunk_index + 2}}})
                adjacent = self.search_client.search(alias, {"size": 9, "query": {"bool": {"filter": query_filters}}, "sort": [{"chunk_index": "asc"}]})
                known = {str((item.get("_source") or {}).get("chunk_document_id") or item.get("_id")) for item in chunks}
                chunks.extend(item for item in adjacent if str((item.get("_source") or {}).get("chunk_document_id") or item.get("_id")) not in known)
            ordered = sorted(chunks, key=lambda hit: int((hit.get("_source") or {}).get("chunk_index") or 0))
            primary = self._source(best)
            merged_body = self._merge_chunk_bodies(ordered, max_tokens=self.settings.rag_context_max_tokens)
            primary["body"] = merged_body or primary.get("body")
            primary["chunks"] = [self._source(item) for item in ordered]
            primary["chunkCount"] = len(ordered)
            primary["context"] = merged_body
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
                by_field.setdefault(key, []).append({"start": start, "end": end, "text": text})
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
        return {"documentId": source.get("document_id") or hit.get("_id"), "chunkDocumentId": source.get("chunk_document_id") or source.get("document_id") or hit.get("_id"), "parentDocumentId": source.get("parent_document_id"), "datasetId": source.get("dataset_id"), "sourceRowId": source.get("source_row_id"), "title": source.get("title"), "body": source.get("body"), "metadata": source.get("metadata_display") or {}, "sourceFields": source.get("source_fields") or [], "chunkIndex": source.get("chunk_index"), "chunkCount": source.get("chunk_count"), "charStart": source.get("char_start"), "charEnd": source.get("char_end"), "fallbackApplied": source.get("fallback_applied"), "fallbackReason": source.get("fallback_reason"), "embeddingInputVersion": source.get("embedding_input_version"), "fieldRenderingVersion": source.get("field_rendering_version"), "score": hit.get("retrieval", {}).get("score")}


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


def _looks_like_iso_date(value: Any) -> bool:
    text = str(value or "").strip()
    if len(text) < 10 or text[4:5] != "-" or text[7:8] != "-":
        return False
    try:
        date.fromisoformat(text[:10])
    except ValueError:
        return False
    return True
