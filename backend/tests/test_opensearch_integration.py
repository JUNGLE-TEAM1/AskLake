import os
import uuid

import httpx
import pytest


@pytest.mark.integration
def test_opensearch_2191_rag_contract_when_enabled():
    base_url = os.environ.get("OPENSEARCH_INTEGRATION_URL")
    if not base_url:
        pytest.skip("set OPENSEARCH_INTEGRATION_URL to run the real OpenSearch integration test")
    username = os.environ.get("OPENSEARCH_USERNAME")
    password = os.environ.get("OPENSEARCH_PASSWORD", "")
    auth = (username, password) if username else None
    verify = os.environ.get("OPENSEARCH_VERIFY_TLS", "true").casefold() in {"1", "true", "yes"}
    index = f"asklake-rag-contract-{uuid.uuid4().hex[:10]}"
    mapping = {"settings": {"index": {"knn": True}}, "mappings": {"properties": {"document_id": {"type": "keyword"}, "parent_document_id": {"type": "keyword"}, "body": {"type": "text"}, "embedding_text": {"type": "text"}, "body_vector": {"type": "knn_vector", "dimension": 2}, "metadata_filter": {"type": "object", "dynamic": True}, "chunk_index": {"type": "integer"}, "chunk_count": {"type": "integer"}, "char_start": {"type": "integer"}, "char_end": {"type": "integer"}, "embedding_model": {"type": "keyword"}, "embedding_dimensions": {"type": "integer"}}}}
    with httpx.Client(base_url=base_url.rstrip("/"), timeout=30, verify=verify, auth=auth) as client:
        try:
            created = client.put(f"/{index}", json=mapping)
            created.raise_for_status()
            lines = [
                '{"index":{"_index":"' + index + '","_id":"c1"}}',
                '{"document_id":"c1","parent_document_id":"p1","body":"delivery was late","embedding_text":"delivery was late","body_vector":[0.1,0.2],"metadata_filter":{"rating":{"number":1,"keyword":"1"}},"chunk_index":0,"chunk_count":1,"char_start":0,"char_end":17,"embedding_model":"test","embedding_dimensions":2}',
                "",
            ]
            bulk = client.post("/_bulk", content="\n".join(lines), headers={"Content-Type": "application/x-ndjson"})
            bulk.raise_for_status()
            assert bulk.json().get("errors") is False
            count = client.post(f"/{index}/_count", json={"query": {"match_all": {}}})
            count.raise_for_status()
            assert count.json()["count"] == 1
            knn = client.post(f"/{index}/_search", json={"size": 1, "query": {"knn": {"body_vector": {"vector": [0.1, 0.2], "k": 1}}}})
            knn.raise_for_status()
            assert knn.json()["hits"]["hits"]
        finally:
            client.delete(f"/{index}")
