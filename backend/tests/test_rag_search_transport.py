from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.services.rag_search_service import RagSearchService, build_metadata_filter_clauses
from app.clients.opensearch_client import OpenSearchClient


class FakeGateway:
    def __init__(self):
        self.model = None

    def create_embeddings(self, inputs, *, model=None):
        self.model = model
        return [[0.1, 0.2]]


class FakeSearchClient:
    def __init__(self):
        self.queries = []

    def search(self, index, query):
        self.queries.append(query)
        return []


def test_opensearch_knn_query_uses_query_knn_shape_and_pins_model():
    gateway = FakeGateway()
    client = FakeSearchClient()
    service = RagSearchService(Settings(opensearch_base_url="http://opensearch"), search_client=client, gateway_client=gateway)
    result = service.search(query="배송 지연", aliases=["rag-reviews"], actor=ActorContext(name="analyst", role="viewer"), embedding_model="embedding-v2")
    assert result["retrieval"]["status"] == "ready"
    assert gateway.model == "embedding-v2"
    knn_query = client.queries[1]
    assert "query" in knn_query and "knn" in knn_query["query"]
    assert "knn" not in knn_query


def test_distinct_parent_count_uses_composite_pages_instead_of_approximate_cardinality():
    class CompositeClient(OpenSearchClient):
        def __init__(self):
            super().__init__(Settings(opensearch_base_url="http://opensearch"))
            self.calls = 0

        def search_raw(self, index, query):
            self.calls += 1
            if self.calls == 1:
                return {"aggregations": {"distinct_values": {"buckets": [{"key": {"value": "p1"}}, {"key": {"value": "p2"}}], "after_key": {"value": "p2"}}}}
            return {"aggregations": {"distinct_values": {"buckets": [{"key": {"value": "p3"}}]}}}

    client = CompositeClient()
    assert client.distinct_count("rag-reviews", "parent_document_id", page_size=2) == 3
    assert client.calls == 2


def test_metadata_filter_compiler_uses_catalog_storage_type_and_physical_name():
    clauses = build_metadata_filter_clauses({
        "Review.Rating": {"operator": "eq", "value": 3, "storageType": "number", "physicalField": "review_rating"},
        "Is Active": {"operator": "eq", "value": True, "storageType": "boolean", "physicalField": "is_active"},
    })
    assert {"term": {"metadata_filter.review_rating.number": 3}} in clauses
    assert {"term": {"metadata_filter.is_active.boolean": True}} in clauses


def test_context_merge_uses_chunk_offsets_to_remove_overlap():
    merged = RagSearchService._merge_chunk_bodies([
        {"_source": {"body": "abcdef", "char_start": 0, "char_end": 6}},
        {"_source": {"body": "defghi", "char_start": 3, "char_end": 9}},
    ], max_chars=100)
    assert merged == "abcdef\n\nghi"
