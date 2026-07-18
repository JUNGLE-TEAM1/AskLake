import os
import uuid

import httpx
import pytest


@pytest.mark.integration
def test_opensearch_2191_rag_contract_when_enabled(monkeypatch):
    base_url = os.environ.get("OPENSEARCH_INTEGRATION_URL")
    if not base_url:
        pytest.skip("set OPENSEARCH_INTEGRATION_URL to run the real OpenSearch integration test")
    username = os.environ.get("OPENSEARCH_USERNAME")
    password = os.environ.get("OPENSEARCH_PASSWORD", "")
    auth = (username, password) if username else None
    verify = os.environ.get("OPENSEARCH_VERIFY_TLS", "true").casefold() in {"1", "true", "yes"}
    index = f"asklake-rag-contract-{uuid.uuid4().hex[:10]}"
    replacement_index = f"{index}-replacement"
    source_field_mapping = {"type": "object", "dynamic": False, "properties": {"logicalField": {"type": "keyword"}, "physicalField": {"type": "keyword"}, "role": {"type": "keyword"}}}
    block_mapping = {"type": "object", "dynamic": False, "properties": {"logicalField": {"type": "keyword"}, "physicalField": {"type": "keyword"}, "text": {"type": "text"}, "fieldText": {"type": "text"}, "fieldValueStart": {"type": "integer"}, "start": {"type": "integer"}, "end": {"type": "integer"}, "valueStart": {"type": "integer"}, "valueEnd": {"type": "integer"}, "fragmentStart": {"type": "integer"}, "fragmentEnd": {"type": "integer"}}}
    metadata_field = lambda properties: {"type": "object", "dynamic": False, "properties": properties}
    mapping = {"settings": {"index": {"knn": True}}, "mappings": {"properties": {"document_id": {"type": "keyword"}, "parent_document_id": {"type": "keyword"}, "body": {"type": "text"}, "embedding_text": {"type": "text"}, "body_vector": {"type": "knn_vector", "dimension": 2}, "metadata_filter": {"type": "object", "dynamic": False, "properties": {"rating": metadata_field({"number": {"type": "double"}, "keyword": {"type": "keyword"}}), "category": metadata_field({"keyword": {"type": "keyword"}}), "created_at": metadata_field({"date": {"type": "date"}, "keyword": {"type": "keyword"}}), "active": metadata_field({"boolean": {"type": "boolean"}, "keyword": {"type": "keyword"}})}}, "source_fields": source_field_mapping, "parent_source_fields": source_field_mapping, "title_blocks": block_mapping, "body_blocks": block_mapping, "embedding_input_version": {"type": "keyword"}, "field_rendering_version": {"type": "keyword"}, "chunk_index": {"type": "integer"}, "chunk_count": {"type": "integer"}, "char_start": {"type": "integer"}, "char_end": {"type": "integer"}, "embedding_provider": {"type": "keyword"}, "embedding_model": {"type": "keyword"}, "embedding_dimensions": {"type": "integer"}}}}
    with httpx.Client(base_url=base_url.rstrip("/"), timeout=30, verify=verify, auth=auth) as client:
        try:
            created = client.put(f"/{index}", json=mapping)
            created.raise_for_status()
            lines = [
                '{"index":{"_index":"' + index + '","_id":"c1"}}',
                '{"document_id":"c1","parent_document_id":"p1","body":"delivery was late","embedding_text":"delivery was late","body_vector":[0.1,0.2],"metadata_filter":{"rating":{"type":"number","number":3.0,"keyword":"3"},"category":{"type":"string","keyword":"electronics"},"created_at":{"type":"date","date":"2026-07-15","keyword":"2026-07-15"},"active":{"type":"boolean","boolean":true,"keyword":"true"}},"source_fields":[{"logicalField":"Review.Rating","physicalField":"rating","role":"metadata"}],"parent_source_fields":[{"logicalField":"Review.Rating","physicalField":"rating","role":"metadata"}],"embedding_input_version":"title_body_fields_v2","field_rendering_version":"field_blocks_v1","chunking_version":"rag-chunk-v3","chunk_index":0,"chunk_count":1,"char_start":0,"char_end":17,"embedding_provider":"openai_compatible","embedding_model":"test","embedding_dimensions":2}',
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
            for field, clause in {
                "rating.number": {"range": {"metadata_filter.rating.number": {"gte": 3}}},
                "category.keyword": {"term": {"metadata_filter.category.keyword": "electronics"}},
                "created_at.date": {"range": {"metadata_filter.created_at.date": {"gte": "2026-01-01"}}},
                "active.boolean": {"term": {"metadata_filter.active.boolean": True}},
            }.items():
                response = client.post(f"/{index}/_search", json={"size": 1, "query": {"bool": {"filter": [clause]}}})
                response.raise_for_status()
                result_total = response.json()["hits"]["total"]
                assert (result_total.get("value") if isinstance(result_total, dict) else result_total) == 1, field
            for path in ("metadata_filter.rating.number", "metadata_filter.category.keyword", "metadata_filter.created_at.date", "metadata_filter.active.boolean"):
                response = client.post(f"/{index}/_search", json={"size": 0, "query": {"exists": {"field": path}}})
                response.raise_for_status()
                result_total = response.json()["hits"]["total"]
                assert (result_total.get("value") if isinstance(result_total, dict) else result_total) == 1, path
            # Exercise the real backend validation path against this same
            # OpenSearch instance, not only a hand-written REST smoke query.
            from sqlalchemy import create_engine
            from sqlalchemy.orm import Session
            from app.core.config import settings
            from app.models.base import Base
            from app.models.semantic_rag import RagIndexJobModel
            from app.services.rag_service import FILTER_CONTRACT_VERSION, RAG_TABLES, RagService

            monkeypatch.setattr(settings, "opensearch_base_url", base_url)
            monkeypatch.setattr(settings, "opensearch_verify_tls", verify)
            engine = create_engine("sqlite:///:memory:")
            Base.metadata.create_all(engine, tables=RAG_TABLES)
            with Session(engine) as db:
                job = RagIndexJobModel(id="ragjob-real-validation", dataset_id="reviews", requested_by="integration", target_index=index, status="validating", stage="validating", indexed_count=1, chunk_count=1, parent_count=1, embedding_provider="openai_compatible", embedding_dimensions=2, embedding_model="test", metadata_columns=["Review.Rating", "Category", "Created At", "Is Active"], metadata_types={"rating": "integer", "category": "string", "created_at": "date", "active": "boolean"}, physical_column_mapping={"Review.Rating": "rating", "Category": "category", "Created At": "created_at", "Is Active": "active"}, filter_contract_version=FILTER_CONTRACT_VERSION)
                db.add(job)
                db.commit()
                validation = RagService(db).validate_job(job.id)
                assert validation["validationPassed"] is True
                db.refresh(job)
                assert job.validation_status == "passed"
                assert job.validated_index == index
                assert job.validation_evidence_hash
            alias = f"{index}-alias"
            switched = client.post("/_aliases", json={"actions": [{"add": {"alias": alias, "index": index}}]})
            switched.raise_for_status()
            alias_search = client.post(f"/{alias}/_search", json={"size": 1, "query": {"match_all": {}}})
            alias_search.raise_for_status()
            assert alias_search.json()["hits"]["hits"]
            client.put(f"/{replacement_index}", json=mapping).raise_for_status()
            replacement_bulk = client.post("/_bulk?refresh=wait_for", content='{"index":{"_index":"' + replacement_index + '","_id":"c2"}}\n{"document_id":"c2","parent_document_id":"p2","body":"replacement","embedding_text":"replacement","body_vector":[0.2,0.1],"metadata_filter":{"rating":{"number":4.0,"keyword":"4"},"category":{"keyword":"electronics"},"created_at":{"date":"2026-07-15","keyword":"2026-07-15"},"active":{"boolean":true,"keyword":"true"}},"embedding_input_version":"title_body_fields_v2","field_rendering_version":"field_blocks_v1","chunk_index":0,"chunk_count":1,"char_start":0,"char_end":11,"embedding_provider":"openai_compatible","embedding_model":"test","embedding_dimensions":2}\n', headers={"Content-Type": "application/x-ndjson"})
            replacement_bulk.raise_for_status()
            switched = client.post("/_aliases", json={"actions": [{"remove": {"alias": alias, "index": index}}, {"add": {"alias": alias, "index": replacement_index}}]})
            switched.raise_for_status()
            alias_indices = client.get(f"/_alias/{alias}")
            alias_indices.raise_for_status()
            assert list(alias_indices.json()) == [replacement_index]
            alias_search = client.post(f"/{alias}/_search", json={"size": 10, "query": {"match_all": {}}})
            alias_search.raise_for_status()
            assert [hit["_id"] for hit in alias_search.json()["hits"]["hits"]] == ["c2"]
        finally:
            client.delete(f"/{index}")
            client.delete(f"/{replacement_index}")
