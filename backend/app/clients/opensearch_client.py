from typing import Any

import httpx

from app.core.config import Settings, settings


class OpenSearchClient:
    """Small REST client so the backend does not own an OpenSearch SDK lifecycle."""

    def __init__(self, runtime_settings: Settings | None = None) -> None:
        self.settings = runtime_settings or settings

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any] | list[Any]:
        if not self.settings.opensearch_base_url:
            raise RuntimeError("OPENSEARCH_BASE_URL is not configured")
        auth = None
        if self.settings.opensearch_username:
            auth = (self.settings.opensearch_username, self.settings.opensearch_password or "")
        response = httpx.request(method, f"{self.settings.opensearch_base_url.rstrip('/')}/{path.lstrip('/')}", auth=auth, timeout=self.settings.opensearch_timeout_seconds, verify=self.settings.opensearch_verify_tls, **kwargs)
        response.raise_for_status()
        return response.json() if response.content else {}

    def create_index(self, index: str, *, dimensions: int) -> dict[str, Any] | list[Any]:
        return self._request("PUT", index, json={"settings": {"index": {"knn": True}}, "mappings": {"properties": {"document_id": {"type": "keyword"}, "chunk_document_id": {"type": "keyword"}, "parent_document_id": {"type": "keyword"}, "dataset_id": {"type": "keyword"}, "source_row_id": {"type": "keyword"}, "title": {"type": "text"}, "body": {"type": "text"}, "embedding_text": {"type": "text"}, "body_vector": {"type": "knn_vector", "dimension": dimensions}, "filter_terms": {"type": "object", "enabled": True}, "metadata_filter": {"type": "object", "dynamic": True}, "metadata_display": {"type": "object", "enabled": True}, "semantic_bindings": {"type": "object", "enabled": True}, "source_columns": {"type": "keyword"}, "chunk_index": {"type": "integer"}, "start_sentence": {"type": "integer"}, "end_sentence": {"type": "integer"}, "chunking_strategy": {"type": "keyword"}, "chunking_version": {"type": "keyword"}, "content_hash": {"type": "keyword"}}}})

    def bulk_index(self, index: str, documents: list[dict[str, Any]]) -> dict[str, Any] | list[Any]:
        lines: list[str] = []
        import json
        for document in documents:
            lines.extend([json.dumps({"index": {"_index": index, "_id": document["document_id"]}}), json.dumps(document, ensure_ascii=False)])
        return self._request("POST", "_bulk", content=("\n".join(lines) + "\n").encode("utf-8"), headers={"Content-Type": "application/x-ndjson"})

    def switch_alias(self, alias: str, index: str, old_index: str | None = None) -> dict[str, Any] | list[Any]:
        actions: list[dict[str, Any]] = []
        if old_index:
            actions.append({"remove": {"alias": alias, "index": old_index}})
        actions.append({"add": {"alias": alias, "index": index}})
        return self._request("POST", "_aliases", json={"actions": actions})

    def search(self, index: str, query: dict[str, Any]) -> list[dict[str, Any]]:
        payload = self._request("POST", f"{index}/_search", json=query)
        if not isinstance(payload, dict):
            return []
        hits = payload.get("hits", {}).get("hits", [])
        return hits if isinstance(hits, list) else []
