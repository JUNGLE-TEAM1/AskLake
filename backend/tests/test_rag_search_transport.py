from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.services.rag_search_service import RagSearchService
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
