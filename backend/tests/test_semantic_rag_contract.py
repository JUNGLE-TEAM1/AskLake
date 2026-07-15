from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, permissions_for_actor
from app.models.base import Base
from app.models.identity import PermissionGrantModel
from app.models.semantic_rag import RagClassificationRunModel, RagColumnRecommendationModel, RagDatasetProfileModel, RagIndexJobModel
from app.schemas.semantic import SemanticModelCreate
from app.services.rag_document_service import build_documents
from app.services.rag_search_service import RagSearchService, build_metadata_filter_clauses, hybrid_rrf
from app.services.rag_service import RAG_TABLES, RagService
from app.services.semantic_model_service import SEMANTIC_TABLES, SemanticModelService


def test_document_preview_contains_vector_db_payload_and_is_deterministic() -> None:
    rows = [{"review_id": "RV-991", "review_text": "Fast delivery", "rating": 5, "sentiment": "positive"}]
    first = build_documents(dataset_id="reviews", dataset_name="customer_review_gold", rows=rows, columns=[], body_columns=["review_text"], metadata_columns=["rating", "sentiment"], target_index="asklake-rag-ds-reviews")
    second = build_documents(dataset_id="reviews", dataset_name="customer_review_gold", rows=rows, columns=[], body_columns=["review_text"], metadata_columns=["rating", "sentiment"], target_index="asklake-rag-ds-reviews")
    assert first == second
    assert first[0]["body"] == "[BODY]\nreview_text: Fast delivery\n[/BODY]"
    assert first[0]["filterTerms"] == {"rating": "5", "sentiment": "positive"}
    assert first[0]["targetIndex"] == "asklake-rag-ds-reviews"
    assert first[0]["embeddingStatus"] == "pending"


def test_policy_fingerprint_preserves_approved_field_order():
    dataset = {"id": "reviews", "schema": [{"name": "a", "dataType": "string"}, {"name": "b", "dataType": "string"}]}
    first = RagDatasetProfileModel(dataset_id="reviews", body_columns=["a", "b"], title_columns=[], metadata_columns=[], identifier_columns=["a"])
    second = RagDatasetProfileModel(dataset_id="reviews", body_columns=["b", "a"], title_columns=[], metadata_columns=[], identifier_columns=["a"])
    assert RagService._policy_fingerprint(dataset, first) != RagService._policy_fingerprint(dataset, second)


def test_preview_uses_physical_filter_fields_but_logical_text_labels():
    document = build_documents(
        dataset_id="reviews",
        dataset_name="reviews",
        rows=[{"Review.Rating": 10, "Review Text": " late ", "Review Id": "r-1", "Created At": "2026-07-15"}],
        columns=["Review.Rating", "Review Text", "Review Id", "Created At"],
        body_columns=["Review Text"],
        title_columns=[],
        metadata_columns=["Review.Rating", "Created At"],
        identifier_columns=["Review Id"],
        schema_types={"Review.Rating": "decimal", "Created At": "date"},
        physical_column_mapping={"Review.Rating": "review_rating", "Created At": "created_at", "Review Text": "review_text", "Review Id": "review_id"},
        target_index="reviews-v1",
    )[0]
    assert "Review Text: late" in document["body"]
    assert document["sourceFields"][0]["physicalField"] == "review_text"
    assert document["metadataFilter"]["review_rating"]["number"] == 10.0
    assert document["metadataFilter"]["created_at"]["date"] == "2026-07-15"
    assert document["metadataDisplay"] == {"Review.Rating": 10, "Created At": "2026-07-15"}


def test_hybrid_rrf_merges_vector_and_bm25_results() -> None:
    result = hybrid_rrf(
        [{"_id": "lexical-only", "_source": {"body": "lexical"}}, {"_id": "shared", "_source": {"body": "shared"}}],
        [{"_id": "shared", "_source": {"body": "shared"}}, {"_id": "vector-only", "_source": {"body": "vector"}}],
        final_k=3,
    )
    assert {item["_id"] for item in result} == {"lexical-only", "shared", "vector-only"}
    assert result[0]["_id"] == "shared"
    assert result[0]["retrieval"]["vectorRank"] == 1
    assert result[0]["retrieval"]["lexicalRank"] == 2


def test_structured_chunk_merge_removes_field_overlap_and_keeps_labels() -> None:
    merged = RagSearchService._merge_chunk_bodies([
        {"_source": {"body_blocks": [{"logicalField": "review_text", "physicalField": "review_text", "fragmentStart": 10, "fragmentEnd": 20, "text": "abcdefghij"}]}},
        {"_source": {"body_blocks": [{"logicalField": "review_text", "physicalField": "review_text", "fragmentStart": 15, "fragmentEnd": 28, "text": "fghijklmnopqr"}]}},
        {"_source": {"body_blocks": [{"logicalField": "seller_response", "physicalField": "seller_response", "fragmentStart": 40, "fragmentEnd": 49, "text": "follow-up"}]}},
    ], max_chars=10_000)
    assert merged == "[BODY]\nreview_text: abcdefghijklmnopqr\n\nseller_response: follow-up\n[/BODY]"


def test_structured_chunk_merge_restores_a_gap_from_canonical_field_text():
    merged = RagSearchService._merge_chunk_bodies([
        {"_source": {"body_blocks": [{"logicalField": "review_text", "physicalField": "review_text", "fragmentStart": 10, "fragmentEnd": 15, "fieldValueStart": 10, "fieldText": "abcdefghij", "text": "abcde"}]}},
        {"_source": {"body_blocks": [{"logicalField": "review_text", "physicalField": "review_text", "fragmentStart": 17, "fragmentEnd": 20, "fieldValueStart": 10, "fieldText": "abcdefghij", "text": "hij"}]}},
    ], max_chars=10_000)
    assert merged == "[BODY]\nreview_text: abcdefghij\n[/BODY]"


def test_rag_metadata_filters_are_exact_or_range_and_reject_query_syntax() -> None:
    clauses = build_metadata_filter_clauses({"rating": {"operator": "gte", "value": 4}, "sentiment": {"operator": "eq", "value": "positive"}})
    assert {"range": {"metadata_filter.rating.number": {"gte": 4}}} in clauses
    assert {"term": {"metadata_filter.sentiment.keyword": "positive"}} in clauses
    try:
        build_metadata_filter_clauses({"rating OR 1=1": {"operator": "eq", "value": "x"}})
    except ValueError as exc:
        assert "Invalid RAG metadata filter field" in str(exc)
    else:
        raise AssertionError("expected invalid metadata filter field")


def test_rag_metadata_filters_support_iso_date_ranges() -> None:
    clauses = build_metadata_filter_clauses({"created_at": {"operator": "gte", "value": "2026-01-01"}})
    assert clauses == [{"range": {"metadata_filter.created_at.date": {"gte": "2026-01-01"}}}]


def test_service_filter_validation_maps_logical_catalog_names_to_physical_fields(monkeypatch) -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=RAG_TABLES)
    dataset = {
        "id": "reviews",
        "name": "Reviews",
        "schema": [
            {"name": "Review.Rating", "dataType": "integer"},
            {"name": "Is Active", "dataType": "boolean"},
        ],
        "owner": "admin",
    }
    with Session(engine) as db:
        service = RagService(db)
        profile = RagDatasetProfileModel(dataset_id="reviews", review_state="approved", metadata_columns=["Review.Rating", "Is Active"])
        db.add(profile)
        db.commit()
        monkeypatch.setattr(service, "_dataset", lambda *args, **kwargs: dataset)
        result = service.validate_search_filters("reviews", ActorContext(name="admin", role="admin"), {
            "Review.Rating": {"operator": "gte", "value": 3},
            "Is Active": {"operator": "eq", "value": True},
        })
        assert result["Review.Rating"]["physicalField"] == "review_rating"
        assert result["Review.Rating"]["storageType"] == "number"
        assert result["Is Active"]["physicalField"] == "is_active"
        assert result["Is Active"]["storageType"] == "boolean"


def test_vector_document_preview_uses_persisted_index_shape() -> None:
    document = RagService._preview_document_from_index_hit({
        "_id": "chunk-1",
        "_source": {
            "document_id": "chunk-1",
            "parent_document_id": "parent-1",
            "chunk_index": 2,
            "dataset_id": "reviews",
            "source_row_id": "review-1",
            "body": "배송이 늦었습니다.",
            "title": "무선 이어폰",
            "metadata_filter": {"rating": {"type": "number", "number": 3}},
            "metadata_display": {"rating": 3},
            "body_vector": [0.1, 0.2],
            "embedding_text": "무선 이어폰\n\n배송이 늦었습니다.",
            "chunking_strategy": "semantic_embedding",
            "chunking_version": "rag-chunk-v3",
        },
    }, dataset_name="Reviews", target_index="rag-reviews-v2")
    assert document["document_id"] == "chunk-1"
    assert document["chunk_index"] == 2
    assert document["embedding_status"] == "ready"
    assert document["embedding_text"].startswith("무선 이어폰")


def test_rag_search_contract_exposes_query_and_filters() -> None:
    from app.schemas.semantic import RagSearchRequest

    request = RagSearchRequest.model_validate({"query": "배송 지연", "filters": {"rating": {"operator": "gte", "value": 3}}})
    assert request.query == "배송 지연"
    assert request.filters["rating"].operator == "gte"
    assert request.filters["rating"].value == 3


def test_publish_permission_is_exposed_separately() -> None:
    actor = ActorContext(name="analyst", role="viewer")
    permissions = permissions_for_actor(actor, grants=[{"principalType": "user", "principalId": "analyst", "actions": ["view", "publish"]}], enforced=True)
    assert permissions.can_view is True
    assert permissions.can_publish is True
    assert permissions.can_manage is False


def test_semantic_model_can_publish_a_valid_connected_definition() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[*SEMANTIC_TABLES, PermissionGrantModel.__table__])
    with Session(engine) as db:
        service = SemanticModelService(db)
        actor = ActorContext(name="admin", role="admin")
        model = service.create(SemanticModelCreate.model_validate({"name": "Commerce Sales", "datasets": [{"datasetId": "orders_clean"}], "metrics": [{"name": "revenue", "label": "Revenue", "expression": "sum(order_total)", "datasetId": "orders_clean"}]}), actor)
        published = service.publish(model.id, actor)
        assert published.published_version == 2
        assert published.model.status == "published"
        assert published.model.datasets[0].dataset_id == "orders_clean"


def test_invalid_ai_rag_roles_are_discarded_and_old_recommendations_replaced() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=RAG_TABLES)
    with Session(engine) as db:
        service = RagService(db)
        run = RagClassificationRunModel(id="ragcr_test", dataset_id="reviews", status="running", model="test", input_snapshot={"schema": [{"name": "review_text"}, {"name": "rating"}]})
        profile = RagDatasetProfileModel(dataset_id="reviews")
        db.add_all([run, profile])
        db.flush()
        service._apply_classification(run, profile, {"classification": "review", "confidence": 0.9, "roles": [{"columnName": "review_text", "role": "body", "confidence": 0.9, "reason": "text"}, {"columnName": "not_in_schema", "role": "body", "confidence": 0.9, "reason": "invalid"}, {"columnName": "rating", "role": "unsupported", "confidence": 0.9, "reason": "invalid"}]})
        db.commit()
        assert profile.body_columns == ["review_text"]
        assert profile.review_state == "candidate"
        assert run.error is not None
        recommendations = db.query(RagColumnRecommendationModel).filter_by(dataset_id="reviews").all()
        assert [item.column_name for item in recommendations] == ["review_text"]


def test_failed_job_records_completion_and_keeps_activation_guard(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=RAG_TABLES)
    with Session(engine) as db:
        service = RagService(db)
        profile = RagDatasetProfileModel(dataset_id="reviews", review_state="approved", target_alias="rag-reviews")
        job = RagIndexJobModel(id="ragjob_failure", dataset_id="reviews", requested_by="admin", target_index="rag-reviews-v2")
        db.add_all([profile, job])
        db.commit()
        monkeypatch.setattr(service, "job", lambda *args, **kwargs: None)
        service.complete_job(job.id, {"status": "failed", "error": "validation failed"})
        db.refresh(job)
        db.refresh(profile)
        assert job.completed_at is not None
        assert profile.last_error == "validation failed"
        assert profile.active_index is None


def test_successful_job_without_physical_validation_cannot_activate(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=RAG_TABLES)
    with Session(engine) as db:
        service = RagService(db)
        profile = RagDatasetProfileModel(dataset_id="reviews", review_state="approved", target_alias="rag-reviews")
        job = RagIndexJobModel(id="ragjob_unvalidated", dataset_id="reviews", requested_by="admin", target_index="rag-reviews-v2")
        db.add_all([profile, job])
        db.commit()
        monkeypatch.setattr(service, "job", lambda *args, **kwargs: None)
        service.complete_job(job.id, {"status": "success", "activeIndex": "rag-reviews-v2"})
        db.refresh(job)
        assert job.status == "failed"
        assert "validation" in str(job.error)


def test_physical_validation_evidence_cannot_skip_validating_state(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=RAG_TABLES)
    with Session(engine) as db:
        service = RagService(db)
        profile = RagDatasetProfileModel(dataset_id="reviews", review_state="approved", target_alias="rag-reviews")
        job = RagIndexJobModel(
            id="ragjob_state_guard",
            dataset_id="reviews",
            requested_by="admin",
            target_index="rag-reviews-v2",
            status="queued",
            stage="queued",
            indexed_count=1,
            chunk_count=1,
            parent_count=1,
            embedding_dimensions=2,
            validation_status="passed",
            validated_index="rag-reviews-v2",
            validated_document_count=1,
            validated_parent_count=1,
            validated_dimensions=2,
        )
        db.add_all([profile, job])
        db.commit()
        monkeypatch.setattr(service, "job", lambda *args, **kwargs: None)
        service.complete_job(job.id, {"status": "success", "activeIndex": "rag-reviews-v2"})
        db.refresh(job)
        assert job.status == "failed"
        assert "validation" in str(job.error)


def test_validation_evidence_is_persisted_and_required_for_activation(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=RAG_TABLES)
    with Session(engine) as db:
        service = RagService(db)
        profile = RagDatasetProfileModel(dataset_id="reviews", review_state="approved", target_alias="rag-reviews")
        job = RagIndexJobModel(id="ragjob_validated", dataset_id="reviews", requested_by="admin", target_index="rag-reviews-v2", status="validating", stage="validating", indexed_count=1, chunk_count=1, parent_count=1, embedding_dimensions=2)
        db.add_all([profile, job])
        db.commit()

        class FakeOpenSearch:
            def count(self, index):
                return 1

            def distinct_count(self, index, field):
                return 1

            def mapping(self, index):
                return {index: {"mappings": {"properties": {
                    "document_id": {}, "parent_document_id": {}, "body": {}, "embedding_text": {}, "body_vector": {"dimension": 2}, "metadata_filter": {}, "chunk_index": {}, "chunk_count": {}, "char_start": {}, "char_end": {}, "embedding_model": {}, "embedding_dimensions": {}, "source_fields": {}, "parent_source_fields": {}, "embedding_input_version": {}, "field_rendering_version": {},
                }}}}

            def search_raw(self, index, query):
                return {"hits": {"hits": [{"_source": {"body_vector": [0.1, 0.2], "metadata_filter": {}, "source_fields": [], "parent_source_fields": [], "embedding_input_version": "title_body_fields_v2", "field_rendering_version": "field_blocks_v1", "chunking_version": "rag-chunk-v3"}}]}}

            def search(self, index, query):
                return []

            def switch_alias(self, alias, index, old_index=None):
                return {}

        monkeypatch.setattr("app.clients.opensearch_client.OpenSearchClient", lambda settings: FakeOpenSearch())
        monkeypatch.setattr("app.core.config.settings.opensearch_base_url", "http://opensearch")
        validation = service.validate_job(job.id)
        db.refresh(job)
        assert validation["validationPassed"] is True
        assert job.validation_status == "passed"
        assert job.validated_index == job.target_index
        assert job.validation_evidence_hash

        monkeypatch.setattr(service.catalog, "get_dataset_payload", lambda dataset_id: {"sourceManifest": {}})
        monkeypatch.setattr(service, "job", lambda *args, **kwargs: None)
        service.complete_job(job.id, {"status": "success", "validationPassed": False})
        db.refresh(job)
        assert job.status == "ready"
