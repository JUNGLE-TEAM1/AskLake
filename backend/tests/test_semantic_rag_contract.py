from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, permissions_for_actor
from app.models.base import Base
from app.models.identity import PermissionGrantModel
from app.models.semantic_rag import RagClassificationRunModel, RagColumnRecommendationModel, RagDatasetProfileModel
from app.schemas.semantic import SemanticModelCreate
from app.services.rag_document_service import build_documents
from app.services.rag_search_service import build_metadata_filter_clauses, hybrid_rrf
from app.services.rag_service import RAG_TABLES, RagService
from app.services.semantic_model_service import SEMANTIC_TABLES, SemanticModelService


def test_document_preview_contains_vector_db_payload_and_is_deterministic() -> None:
    rows = [{"review_id": "RV-991", "review_text": "Fast delivery", "rating": 5, "sentiment": "positive"}]
    first = build_documents(dataset_id="reviews", dataset_name="customer_review_gold", rows=rows, columns=[], body_columns=["review_text"], metadata_columns=["rating", "sentiment"], target_index="asklake-rag-ds-reviews")
    second = build_documents(dataset_id="reviews", dataset_name="customer_review_gold", rows=rows, columns=[], body_columns=["review_text"], metadata_columns=["rating", "sentiment"], target_index="asklake-rag-ds-reviews")
    assert first == second
    assert first[0]["body"] == "Fast delivery"
    assert first[0]["filterTerms"] == {"rating": "5", "sentiment": "positive"}
    assert first[0]["targetIndex"] == "asklake-rag-ds-reviews"
    assert first[0]["embeddingStatus"] == "pending"


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


def test_rag_metadata_filters_are_exact_or_range_and_reject_query_syntax() -> None:
    clauses = build_metadata_filter_clauses({"rating": {"gte": 4}, "sentiment": "positive"})
    assert {"range": {"metadata_filter.rating.number": {"gte": 4}}} in clauses
    assert {"term": {"metadata_filter.sentiment.keyword": "positive"}} in clauses
    try:
        build_metadata_filter_clauses({"rating OR 1=1": "x"})
    except ValueError as exc:
        assert "Invalid RAG metadata filter field" in str(exc)
    else:
        raise AssertionError("expected invalid metadata filter field")


def test_rag_metadata_filters_support_iso_date_ranges() -> None:
    clauses = build_metadata_filter_clauses({"created_at": {"gte": "2026-01-01"}})
    assert clauses == [{"range": {"metadata_filter.created_at.date": {"gte": "2026-01-01"}}}]


def test_rag_search_contract_exposes_query_and_filters() -> None:
    from app.schemas.semantic import RagSearchRequest

    request = RagSearchRequest.model_validate({"query": "배송 지연", "filters": {"rating": {"gte": 3}}})
    assert request.query == "배송 지연"
    assert request.filters["rating"]["gte"] == 3


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
        run = RagClassificationRunModel(
            id="ragcr_test",
            dataset_id="reviews",
            status="running",
            model="test",
            input_snapshot={"schema": [{"name": "review_text"}, {"name": "rating"}]},
        )
        profile = RagDatasetProfileModel(dataset_id="reviews")
        db.add_all([run, profile])
        db.flush()
        service._apply_classification(run, profile, {
            "classification": "review",
            "confidence": 0.9,
            "roles": [
                {"columnName": "review_text", "role": "body", "confidence": 0.9, "reason": "text"},
                {"columnName": "not_in_schema", "role": "body", "confidence": 0.9, "reason": "invalid"},
                {"columnName": "rating", "role": "unsupported", "confidence": 0.9, "reason": "invalid"},
            ],
        })
        db.commit()
        assert profile.body_columns == ["review_text"]
        assert profile.review_state == "candidate"
        assert run.error is not None
        recommendations = db.query(RagColumnRecommendationModel).filter_by(dataset_id="reviews").all()
        assert [item.column_name for item in recommendations] == ["review_text"]
