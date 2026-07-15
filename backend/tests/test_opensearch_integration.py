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
    source_field_mapping = {"type": "object", "dynamic": False, "properties": {"logicalField": {"type": "keyword"}, "physicalField": {"type": "keyword"}, "role": {"type": "keyword"}}}
    block_mapping = {"type": "object", "dynamic": False, "properties": {"logicalField": {"type": "keyword"}, "physicalField": {"type": "keyword"}, "text": {"type": "text"}, "fieldText": {"type": "text"}, "fieldValueStart": {"type": "integer"}, "start": {"type": "integer"}, "end": {"type": "integer"}, "valueStart": {"type": "integer"}, "valueEnd": {"type": "integer"}, "fragmentStart": {"type": "integer"}, "fragmentEnd": {"type": "integer"}}}
    mapping = {"settings": {"index": {"knn": True}}, "mappings": {"properties": {"document_id": {"type": "keyword"}, "parent_document_id": {"type": "keyword"}, "body": {"type": "text"}, "embedding_text": {"type": "text"}, "body_vector": {"type": "knn_vector", "dimension": 2}, "metadata_filter": {"type": "object", "dynamic": False, "properties": {"rating": {"type": "object", "dynamic": False, "properties": {"number": {"type": "double"}, "keyword": {"type": "keyword"}}}}}, "source_fields": source_field_mapping, "parent_source_fields": source_field_mapping, "title_blocks": block_mapping, "body_blocks": block_mapping, "embedding_input_version": {"type": "keyword"}, "field_rendering_version": {"type": "keyword"}, "chunk_index": {"type": "integer"}, "chunk_count": {"type": "integer"}, "char_start": {"type": "integer"}, "char_end": {"type": "integer"}, "embedding_model": {"type": "keyword"}, "embedding_dimensions": {"type": "integer"}}}}
    with httpx.Client(base_url=base_url.rstrip("/"), timeout=30, verify=verify, auth=auth) as client:
        try:
            created = client.put(f"/{index}", json=mapping)
            created.raise_for_status()
            lines = [
                '{"index":{"_index":"' + index + '","_id":"c1"}}',
                '{"document_id":"c1","parent_document_id":"p1","body":"delivery was late","embedding_text":"delivery was late","body_vector":[0.1,0.2],"metadata_filter":{"rating":{"number":3.0,"keyword":"3"}},"source_fields":[{"logicalField":"Review.Rating","physicalField":"review_rating","role":"metadata"}],"parent_source_fields":[{"logicalField":"Review.Rating","physicalField":"review_rating","role":"metadata"}],"embedding_input_version":"title_body_fields_v2","field_rendering_version":"field_blocks_v1","chunk_index":0,"chunk_count":1,"char_start":0,"char_end":17,"embedding_model":"test","embedding_dimensions":2}',
                "",
            ]
            bulk = client.post("/_bulk?refresh=wait_for", content="\n".join(lines), headers={"Content-Type": "application/x-ndjson"})
            bulk.raise_for_status()
            assert bulk.json().get("errors") is False
            count = client.post(f"/{index}/_count", json={"query": {"match_all": {}}})
            count.raise_for_status()
            assert count.json()["count"] == 1
            knn = client.post(f"/{index}/_search", json={"size": 1, "query": {"knn": {"body_vector": {"vector": [0.1, 0.2], "k": 1}}}})
            knn.raise_for_status()
            assert knn.json()["hits"]["hits"]
            filtered = client.post(f"/{index}/_search", json={"size": 1, "query": {"bool": {"filter": [{"range": {"metadata_filter.rating.number": {"gte": 3}}}]}}})
            filtered.raise_for_status()
            total = filtered.json()["hits"]["total"]
            assert (total.get("value") if isinstance(total, dict) else total) == 1
            alias = f"{index}-alias"
            switched = client.post("/_aliases", json={"actions": [{"add": {"alias": alias, "index": index}}]})
            switched.raise_for_status()
            alias_search = client.post(f"/{alias}/_search", json={"size": 1, "query": {"match_all": {}}})
            alias_search.raise_for_status()
            assert alias_search.json()["hits"]["hits"]
            client.post("/_aliases", json={"actions": [{"remove": {"alias": alias, "index": index}}]})
        finally:
            client.delete(f"/{index}")
