from app.clients.opensearch_client import OpenSearchClient
from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.services.rag_search_service import RagSearchService, build_metadata_filter_clauses


class FakeGateway:
    def __init__(self):
        self.model = None
        self.models = []
        self.plan_filters = {}
        self.semantic_query = None
        self.relevant = True

    def create_embeddings(self, inputs, *, model=None):
        self.model = model
        self.models.append(model)
        return [[0.1, 0.2]]

    def create_embeddings_with_metadata(self, inputs, *, model=None):
        return {
            "provider": "openai_compatible",
            "model": model,
            "dimensions": 2,
            "data": self.create_embeddings(inputs, model=model),
        }

    def plan_rag_query(self, *, request_id, query, datasets):
        return {
            "plans": [
                {
                    "datasetId": dataset["datasetId"],
                    "semanticQuery": self.semantic_query or query,
                    "inDomain": True,
                    "reason": "test",
                    "filters": self.plan_filters.get(dataset["datasetId"], []),
                }
                for dataset in datasets
            ],
            "model": "planner-test",
            "provider": "openai_compatible",
        }

    def judge_rag_relevance(self, *, request_id, query, candidates, applied_filters):
        return {
            "judgments": [
                {
                    "documentId": candidate["documentId"],
                    "relevant": self.relevant,
                    "score": 0.95 if self.relevant else 0.1,
                    "reason": "test judgment",
                }
                for candidate in candidates
            ],
            "model": "relevance-test",
            "provider": "openai_compatible",
        }


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
    result = service.search(
        query="slow delivery",
        aliases=["rag-reviews"],
        actor=ActorContext(name="analyst", role="viewer"),
        embedding_model="embedding-v2",
        targets=[{
            "alias": "rag-reviews",
            "datasetId": "rag-reviews",
            "embeddingProvider": "openai_compatible",
            "embeddingModel": "embedding-v2",
            "embeddingDimensions": 2,
        }],
    )
    assert result["retrieval"]["status"] == "no_matches"
    assert gateway.model == "embedding-v2"
    assert result["retrieval"]["queryPlannerProvider"] == "openai_compatible"
    assert result["retrieval"]["queryEmbeddings"]["rag-reviews"]["provider"] == "openai_compatible"
    knn_query = client.queries[1]
    assert "query" in knn_query and "knn" in knn_query["query"]
    assert "knn" not in knn_query


def test_multi_alias_search_creates_query_embedding_per_target_model():
    gateway = FakeGateway()
    client = FakeSearchClient()
    service = RagSearchService(Settings(opensearch_base_url="http://opensearch"), search_client=client, gateway_client=gateway)
    result = service.search(query="delivery", aliases=["rag-a", "rag-b"], actor=ActorContext(name="analyst", role="viewer"), targets=[{"alias": "rag-a", "embeddingProvider": "openai_compatible", "embeddingModel": "model-a", "embeddingDimensions": 2}, {"alias": "rag-b", "embeddingProvider": "openai_compatible", "embeddingModel": "model-b", "embeddingDimensions": 2}])
    assert result["retrieval"]["status"] == "no_matches"
    assert gateway.models == ["model-a", "model-b"]
    assert [query for query in client.queries if "knn" in query.get("query", {})]


def test_embedding_provider_mismatch_degrades_without_using_incompatible_vector():
    gateway = FakeGateway()
    client = FakeSearchClient()
    service = RagSearchService(Settings(opensearch_base_url="http://opensearch"), search_client=client, gateway_client=gateway)

    result = service.search(
        query="delivery",
        aliases=["rag-reviews"],
        actor=ActorContext(name="analyst", role="viewer"),
        targets=[{
            "alias": "rag-reviews",
            "datasetId": "reviews",
            "embeddingProvider": "openai_compatible_fallback",
            "embeddingModel": "embedding-v2",
            "embeddingDimensions": 2,
        }],
    )

    assert result["retrieval"]["status"] == "degraded_no_matches"
    assert result["retrieval"]["degradationReasons"] == ["query_embedding_provider_mismatch"]
    assert not [query for query in client.queries if "knn" in query.get("query", {})]


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


def test_source_exposes_embedding_and_chunking_provenance():
    source = RagSearchService._source({
        "_id": "chunk-1",
        "_rag_alias": "rag-products",
        "_source": {
            "document_id": "chunk-1",
            "parent_document_id": "parent-1",
            "chunking_strategy": "semantic_embedding_fallback",
            "chunking_version": "rag-chunk-v3",
            "embedding_model": "text-embedding-3-small",
            "embedding_provider": "openai_compatible",
            "embedding_dimensions": 1536,
            "fallback_applied": True,
            "fallback_reason": "gateway_timeout",
        },
        "retrieval": {"score": 0.25},
    })

    assert source["chunkingStrategy"] == "semantic_embedding_fallback"
    assert source["embeddingModel"] == "text-embedding-3-small"
    assert source["embeddingProvider"] == "openai_compatible"
    assert source["embeddingDimensions"] == 1536
    assert source["fallbackApplied"] is True
    assert source["fallbackReason"] == "gateway_timeout"


def test_query_planner_translates_query_and_compiles_typed_metadata_filter():
    gateway = FakeGateway()
    gateway.semantic_query = "bluetooth speaker"
    gateway.plan_filters = {
        "products": [{"field": "average_rating", "operator": "gte", "value": 4}],
    }
    client = FakeSearchClient()
    service = RagSearchService(Settings(opensearch_base_url="http://opensearch"), search_client=client, gateway_client=gateway)

    result = service.search(
        query="rating 4 or higher bluetooth speaker",
        aliases=["rag-products"],
        actor=ActorContext(name="analyst", role="viewer"),
        targets=[{
            "alias": "rag-products",
            "datasetId": "products",
            "embeddingProvider": "openai_compatible",
            "embeddingModel": "embedding-v2",
            "embeddingDimensions": 2,
            "metadataFields": [{"logicalField": "average_rating", "physicalField": "average_rating", "storageType": "number"}],
        }],
    )

    assert result["retrieval"]["status"] == "no_matches"
    lexical_query = client.queries[0]["query"]["bool"]
    assert lexical_query["must"]["multi_match"]["query"] == "bluetooth speaker"
    assert {"range": {"metadata_filter.average_rating.number": {"gte": 4}}} in lexical_query["filter"]
    assert result["retrieval"]["filters"]["products"]["average_rating"]["value"] == 4


def test_relevance_gate_abstains_instead_of_returning_nearest_neighbor():
    class HitClient(FakeSearchClient):
        def search(self, index, query):
            self.queries.append(query)
            return [{
                "_id": "chunk-1",
                "_score": 1.0,
                "_source": {
                    "document_id": "chunk-1",
                    "chunk_document_id": "chunk-1",
                    "parent_document_id": "parent-1",
                    "dataset_id": "products",
                    "body": "Wireless headphones",
                    "chunk_index": 0,
                },
            }]

    gateway = FakeGateway()
    gateway.relevant = False
    service = RagSearchService(Settings(opensearch_base_url="http://opensearch"), search_client=HitClient(), gateway_client=gateway)

    result = service.search(
        query="medieval tax treaty",
        aliases=["rag-products"],
        actor=ActorContext(name="analyst", role="viewer"),
        targets=[{"alias": "rag-products", "datasetId": "products", "embeddingProvider": "openai_compatible", "embeddingModel": "embedding-v2", "embeddingDimensions": 2}],
    )

    assert result["sources"] == []
    assert result["retrieval"]["status"] == "no_relevant_evidence"
    assert result["retrieval"]["relevanceThreshold"] == 0.6
    assert result["retrieval"]["relevanceProvider"] == "openai_compatible"


def test_missing_serving_embedding_provider_degrades_to_lexical_without_knn():
    gateway = FakeGateway()
    client = FakeSearchClient()
    service = RagSearchService(Settings(opensearch_base_url="http://opensearch"), search_client=client, gateway_client=gateway)

    result = service.search(
        query="delivery",
        aliases=["rag-reviews"],
        actor=ActorContext(name="analyst", role="viewer"),
        targets=[{
            "alias": "rag-reviews",
            "datasetId": "reviews",
            "embeddingModel": "embedding-v2",
            "embeddingDimensions": 2,
        }],
    )

    assert result["retrieval"]["status"] == "degraded_no_matches"
    assert result["retrieval"]["degradationReasons"] == ["serving_embedding_provider_missing"]
    assert gateway.models == []
    assert not [query for query in client.queries if "knn" in query.get("query", {})]


def test_opensearch_failures_are_reported_by_retrieval_stage():
    class FailingByQueryClient(FakeSearchClient):
        def search(self, index, query):
            self.queries.append(query)
            if "multi_match" in str(query):
                raise RuntimeError("lexical offline")
            if "knn" in query.get("query", {}):
                raise RuntimeError("vector offline")
            return []

    gateway = FakeGateway()
    client = FailingByQueryClient()
    service = RagSearchService(Settings(opensearch_base_url="http://opensearch"), search_client=client, gateway_client=gateway)

    result = service.search(
        query="delivery",
        aliases=["rag-reviews"],
        actor=ActorContext(name="analyst", role="viewer"),
        targets=[{
            "alias": "rag-reviews",
            "datasetId": "reviews",
            "embeddingProvider": "openai_compatible",
            "embeddingModel": "embedding-v2",
            "embeddingDimensions": 2,
        }],
    )

    assert result["retrieval"]["status"] == "degraded_no_matches"
    assert result["retrieval"]["degradationReasons"] == [
        "lexical_search_unavailable",
        "vector_search_unavailable",
    ]
