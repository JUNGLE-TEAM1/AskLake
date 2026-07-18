from unittest.mock import patch

import pytest
from fastapi import BackgroundTasks, status
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.errors import ApiError
from app.core.auth_context import ActorContext
from app.models.etl import ReviewAnalysisRunModel
from app.models.identity import AiGenerationUsageModel
from app.main import create_app, run_review_analysis_tick
from app.schemas.ai_generation import AiSqlGenerationRequest
from app.schemas.integration import ReviewAnalysisRunRequest
from app.services.ai_generation_service import AiGenerationService
from app.services.review_analysis_service import ReviewAnalysisService
from app.services.ai_gateway_client import AiGatewayClient
from app.services.ai_evidence import retain_used_rag_evidence
from app.api.sql_test import with_preview_limit


def test_unified_ai_and_review_routes_are_registered() -> None:
    app = create_app()
    paths = {route.path for route in app.routes}
    openapi_paths = app.openapi()["paths"]

    assert "/api/ai/generate-sql" in paths
    assert "/api/review-analysis/preview" in paths
    assert "/api/review-analysis/runs" in paths
    assert "/api/review-analysis/runs/{run_id}" in paths
    assert "202" in openapi_paths["/api/review-analysis/runs"]["post"]["responses"]
    assert "200" in openapi_paths["/api/review-analysis/cellphones/run"]["post"]["responses"]
    assert ReviewAnalysisRunRequest().limit == 25


def test_sql_transform_preview_enforces_outer_limit() -> None:
    preview_sql = with_preview_limit("SELECT * FROM input LIMIT 100", 5)

    assert preview_sql == "SELECT * FROM (SELECT * FROM input LIMIT 100) AS xflow_preview LIMIT 5"


def test_etl_ai_generation_delegates_to_gateway() -> None:
    request = AiSqlGenerationRequest.model_validate({
        "question": "상품명을 대문자로 바꿔줘",
        "promptType": "field_transform",
        "metadata": {"column": "product_name"},
        "engine": "spark",
    })
    with patch(
        "app.services.ai_generation_service.AiGatewayClient.generate_etl_transform",
        return_value={
            "sql": "upper(product_name)",
            "schemaContext": "product_name string",
            "model": "gateway-model",
            "provider": "openai_compatible",
        },
    ) as generate:
        response = AiGenerationService().generate_sql(request)

    assert response.sql == "upper(product_name)"
    assert response.model == "gateway-model"
    assert response.provider == "openai_compatible"
    assert generate.call_args.kwargs["prompt_type"] == "field_transform"


@pytest.mark.parametrize(
    "generated_sql",
    [
        "reflect('java.lang.Runtime', 'getRuntime')",
        "java_method('java.lang.System', 'getenv', 'SECRET')",
        "SELECT TRANSFORM(product_name) USING 'cat' AS (value) FROM input",
        "*",
    ],
)
def test_etl_ai_generation_rejects_unsafe_field_transform_output(generated_sql: str) -> None:
    request = AiSqlGenerationRequest.model_validate({
        "question": "상품명을 바꿔줘",
        "promptType": "field_transform",
        "metadata": {"column": "product_name"},
        "engine": "spark",
    })
    with patch(
        "app.services.ai_generation_service.AiGatewayClient.generate_etl_transform",
        return_value={"sql": generated_sql, "model": "gateway-model", "provider": "openai_compatible"},
    ), pytest.raises(ApiError):
        AiGenerationService().generate_sql(request)


def test_review_schema_suggestion_delegates_to_gateway() -> None:
    with patch(
        "app.services.review_analysis_service.AiGatewayClient.suggest_review_schema",
        return_value={"columns": [], "model": "gateway-model", "source": "ai-gateway", "status": "success"},
    ) as suggest:
        response = ReviewAnalysisService().suggest_schema({
            "sourceColumns": [{"name": "text", "type": "string"}],
            "sampleRows": [["great product"]],
        })

    assert response["source"] == "ai-gateway"
    assert suggest.call_args.kwargs["source_columns"][0]["name"] == "text"


def test_generation_evidence_keeps_only_model_reported_sources() -> None:
    rag_context = {
        "sources": [
            {"documentId": "doc-used", "title": "used", "fallbackApplied": False},
            {"documentId": "doc-unused", "title": "unused", "fallbackApplied": True, "fallbackReasons": ["timeout"]},
        ],
        "retrieval": {"status": "ready", "resultCount": 2, "fallbackEvidenceCount": 1},
    }

    filtered = retain_used_rag_evidence(rag_context, ["doc-used"])

    assert [source["documentId"] for source in filtered["sources"]] == ["doc-used"]
    assert filtered["retrieval"]["candidateResultCount"] == 2
    assert filtered["retrieval"]["resultCount"] == 1
    assert filtered["retrieval"]["fallbackEvidenceCount"] == 0
    assert filtered["retrieval"]["evidenceStatus"] == "used"
    with pytest.raises(ValueError, match="outside"):
        retain_used_rag_evidence(rag_context, ["doc-invented"])


def test_generation_evidence_tolerates_malformed_candidate_count() -> None:
    filtered = retain_used_rag_evidence(
        {
            "sources": [{"documentId": "doc-used", "body": "evidence"}],
            "retrieval": {"resultCount": "not-a-count"},
        },
        ["doc-used"],
    )

    assert filtered is not None
    assert filtered["retrieval"]["candidateResultCount"] == 1


def test_review_preview_uses_gateway_rows_and_projects_only_requested_source_fields() -> None:
    with patch(
        "app.services.review_analysis_service.AiGatewayClient.analyze_review_row",
        side_effect=[
            {"values": [{"targetName": "sentiment", "value": "negative"}], "model": "gateway-model", "provider": "openai_compatible"},
            {"values": [{"targetName": "sentiment", "value": "positive"}], "model": "gateway-model", "provider": "openai_compatible"},
        ],
    ) as analyze:
        response = ReviewAnalysisService().preview({
            "rows": [
                {"text": "broken on arrival", "private_note": "do not send"},
                {"text": "works well", "private_note": "do not send"},
            ],
            "columns": [{
                "targetName": "sentiment",
                "sourceField": "text",
                "method": "one_of_values",
                "allowedValues": ["positive", "negative"],
                "instruction": "",
            }],
        })

    assert response == {
        "rows": [{"sentiment": "negative"}, {"sentiment": "positive"}],
        "model": "gateway-model",
        "provider": "openai_compatible",
        "models": ["gateway-model"],
        "providers": ["openai_compatible"],
        "runtime": "gateway",
        "status": "success",
    }
    assert analyze.call_count == 2
    assert analyze.call_args_list[0].kwargs["source_row"] == {"text": "broken on arrival"}


def test_review_preview_rejects_out_of_contract_gateway_value() -> None:
    with patch(
        "app.services.review_analysis_service.AiGatewayClient.analyze_review_row",
        return_value={"values": [{"targetName": "sentiment", "value": "invented"}], "model": "gateway-model"},
    ), pytest.raises(ApiError):
        ReviewAnalysisService().preview({
            "rows": [{"text": "unclear"}],
            "columns": [{
                "targetName": "sentiment",
                "sourceField": "text",
                "method": "one_of_values",
                "allowedValues": ["positive", "negative"],
                "instruction": "",
            }],
        })


def test_ai_gateway_usage_is_persisted_by_request_identity() -> None:
    engine = create_engine("sqlite:///:memory:")
    AiGenerationUsageModel.__table__.create(engine)
    session_factory = sessionmaker(bind=engine)
    payload = {
        "provider": "openai_compatible_fallback",
        "model": "fallback-model",
        "usage": {
            "inputTokens": 120,
            "outputTokens": 30,
            "totalTokens": 150,
            "estimatedCostUsd": 0.00125,
        },
    }

    with patch("app.services.ai_gateway_client.SessionLocal", session_factory):
        AiGatewayClient._persist_generation_usage(payload, request_id="request-usage-1", mode="query_sql")

    with Session(engine) as db:
        record = db.get(AiGenerationUsageModel, "request-usage-1")
        assert record is not None
        assert record.provider == "openai_compatible_fallback"
        assert record.model == "fallback-model"
        assert record.input_tokens == 120
        assert record.output_tokens == 30
        assert record.total_tokens == 150
        assert record.estimated_cost_usd == pytest.approx(0.00125)


def test_ai_gateway_usage_rejects_nonfinite_cost_and_never_breaks_generation() -> None:
    engine = create_engine("sqlite:///:memory:")
    AiGenerationUsageModel.__table__.create(engine)
    session_factory = sessionmaker(bind=engine)
    payload = {
        "provider": "openai_compatible",
        "model": "model",
        "usage": {"estimatedCostUsd": float("inf")},
    }

    with patch("app.services.ai_gateway_client.SessionLocal", session_factory):
        AiGatewayClient._persist_generation_usage(payload, request_id="request-finite", mode="query_sql")

    with Session(engine) as db:
        assert db.get(AiGenerationUsageModel, "request-finite").estimated_cost_usd == 0.0

    with patch("app.services.ai_gateway_client.SessionLocal", side_effect=RuntimeError("telemetry unavailable")):
        AiGatewayClient._persist_generation_usage(payload, request_id="request-fail-open", mode="query_sql")


def test_ai_gateway_usage_batch_persists_unique_valid_review_calls() -> None:
    engine = create_engine("sqlite:///:memory:")
    AiGenerationUsageModel.__table__.create(engine)
    session_factory = sessionmaker(bind=engine)
    records = [
        {
            "requestId": "review-row-1",
            "provider": "openai_compatible",
            "model": "review-model",
            "usage": {"inputTokens": 10, "outputTokens": 2, "totalTokens": 12, "estimatedCostUsd": 0.001},
        },
        {
            "requestId": "review-row-2",
            "provider": "openai_compatible_fallback",
            "model": "review-fallback",
            "usage": {"inputTokens": 20, "outputTokens": 3, "totalTokens": 23, "estimatedCostUsd": 0.002},
        },
        {
            "requestId": "review-row-2",
            "provider": "duplicate-must-be-ignored",
            "model": "duplicate",
            "usage": {},
        },
        {"requestId": "invalid-without-provenance", "usage": {}},
    ]

    with patch("app.services.ai_gateway_client.SessionLocal", session_factory):
        AiGatewayClient.persist_generation_usage_batch(records, mode="review_row")

    with Session(engine) as db:
        rows = db.query(AiGenerationUsageModel).order_by(AiGenerationUsageModel.request_id).all()
        assert [row.request_id for row in rows] == ["review-row-1", "review-row-2"]
        assert [row.provider for row in rows] == ["openai_compatible", "openai_compatible_fallback"]
        assert sum(row.total_tokens for row in rows) == 35


def test_review_run_defaults_to_gateway_runtime() -> None:
    service = ReviewAnalysisService()
    with (
        patch.object(service, "_call_node", return_value={"status": "success"}) as call_node,
        patch("app.services.review_analysis_service.AiGatewayClient.persist_generation_usage_batch") as persist_usage,
    ):
        response = service.run({"limit": 1})

    assert response["status"] == "success"
    assert call_node.call_args.args[1]["runtime"] == "gateway"
    persist_usage.assert_called_once_with([], mode="review_row")


def test_review_run_persists_each_gateway_row_usage_and_hides_internal_records() -> None:
    service = ReviewAnalysisService()
    usage_records = [{
        "requestId": "review-row-1",
        "provider": "openai_compatible",
        "model": "review-model",
        "usage": {"inputTokens": 10, "outputTokens": 2, "totalTokens": 12, "estimatedCostUsd": 0.001},
    }]
    with (
        patch.object(
            service,
            "_call_node",
            return_value={"status": "success", "__gatewayUsage": usage_records},
        ),
        patch("app.services.review_analysis_service.AiGatewayClient.persist_generation_usage_batch") as persist_usage,
    ):
        response = service.run({"limit": 1})

    assert "__gatewayUsage" not in response
    persist_usage.assert_called_once_with(usage_records, mode="review_row")


def test_review_run_trains_only_from_private_gateway_labeled_rows() -> None:
    service = ReviewAnalysisService()
    private_rows = [{"text": "works", "labels": {"sentiment": "positive"}}]
    private_columns = [{"targetName": "sentiment", "method": "one_of_values", "allowedValues": ["positive", "negative"]}]
    with (
        patch.object(
            service,
            "_call_node",
            return_value={
                "status": "success",
                "runId": "review-training",
                "analysis": {"models": ["gateway-model"]},
                "__trainingRows": private_rows,
                "__trainingColumns": private_columns,
            },
        ),
        patch.object(service, "_train_models", return_value={"status": "success", "artifacts": []}) as train,
    ):
        response = service.run({"limit": 1, "trainModels": True})

    assert "__trainingRows" not in response
    assert "__trainingColumns" not in response
    assert response["modelTraining"]["status"] == "success"
    assert train.call_args.kwargs["training_rows"] == private_rows
    assert train.call_args.kwargs["training_columns"] == private_columns


def test_review_run_is_queued_and_persisted_without_blocking_request() -> None:
    engine = create_engine("sqlite:///:memory:")
    ReviewAnalysisRunModel.__table__.create(engine)
    session_factory = sessionmaker(bind=engine)
    actor = ActorContext(name="analyst", role="viewer", id="user-1")

    with Session(engine) as db:
        queued = ReviewAnalysisService(db).enqueue(
            {
                "limit": 2,
                "runtime": "gateway",
            },
            actor,
            BackgroundTasks(),
        )

    assert queued["status"] == "queued"
    assert queued["runId"].startswith("review_")
    with (
        patch("app.services.review_analysis_service.SessionLocal", session_factory),
        patch.object(
            ReviewAnalysisService,
            "_call_node",
            return_value={"status": "success", "processedRows": 2, "rows": []},
        ) as call_node,
    ):
        ReviewAnalysisService.execute_queued_run(queued["runId"])
        ReviewAnalysisService.execute_queued_run(queued["runId"])

    assert call_node.call_count == 1

    with Session(engine) as db:
        completed = ReviewAnalysisService(db).get_status(actor, queued["runId"])

    assert completed["status"] == "success"
    assert completed["result"]["processedRows"] == 2


def test_review_run_rejects_arbitrary_object_source_for_non_admin() -> None:
    engine = create_engine("sqlite:///:memory:")
    ReviewAnalysisRunModel.__table__.create(engine)
    actor = ActorContext(name="analyst", role="viewer", id="user-1")

    with Session(engine) as db, pytest.raises(ApiError) as raised:
        ReviewAnalysisService(db).enqueue(
            {
                "limit": 2,
                "runtime": "gateway",
                "source": {"bucket": "private", "key": "secrets/input.jsonl"},
            },
            actor,
            BackgroundTasks(),
        )

    assert raised.value.status_code == status.HTTP_403_FORBIDDEN


def test_review_worker_tick_recovers_queued_runs_and_expires_stale_leases() -> None:
    with (
        patch.object(ReviewAnalysisService, "fail_stale_runs", return_value=1) as fail_stale,
        patch.object(ReviewAnalysisService, "process_next_queued_run", return_value=True) as process_next,
    ):
        run_review_analysis_tick()

    fail_stale.assert_called_once_with()
    process_next.assert_called_once_with()


def test_etl_ai_generation_rejects_unknown_metadata_column() -> None:
    request = AiSqlGenerationRequest.model_validate({
        "question": "uppercase the product name",
        "promptType": "field_transform",
        "metadata": {"columnName": "product_name"},
        "engine": "spark",
    })
    with patch(
        "app.services.ai_generation_service.AiGatewayClient.generate_etl_transform",
        return_value={"sql": "upper(secret_column)", "model": "gateway-model"},
    ), pytest.raises(ApiError):
        AiGenerationService().generate_sql(request)


def test_etl_ai_generation_rejects_external_relation() -> None:
    request = AiSqlGenerationRequest.model_validate({
        "question": "transform product names",
        "promptType": "sql_transform",
        "metadata": {"columns": [{"name": "product_name", "type": "string"}]},
        "engine": "spark",
    })
    with patch(
        "app.services.ai_generation_service.AiGatewayClient.generate_etl_transform",
        return_value={"sql": "SELECT product_name FROM external_table", "model": "gateway-model"},
    ), pytest.raises(ApiError):
        AiGenerationService().generate_sql(request)


def test_review_gateway_runtime_rejects_bulk_row_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASKLAKE_REVIEW_AI_MAX_ROWS", "10")
    with pytest.raises(ApiError):
        ReviewAnalysisService().run({"limit": 11, "runtime": "gateway"})


def test_review_rule_runtime_is_rejected_instead_of_masquerading_as_ai() -> None:
    with pytest.raises(ApiError, match="only the configured AI Gateway"):
        ReviewAnalysisService().run({"limit": 50_000, "runtime": "scalable"})
