from unittest.mock import patch

import pytest

from app.core.errors import ApiError
from app.schemas.ai_generation import AiSqlGenerationRequest
from app.services.ai_generation_service import AiGenerationService
from app.services.review_analysis_service import ReviewAnalysisService


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
        },
    ) as generate:
        response = AiGenerationService().generate_sql(request)

    assert response.sql == "upper(product_name)"
    assert response.model == "gateway-model"
    assert generate.call_args.kwargs["prompt_type"] == "field_transform"


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


def test_review_run_defaults_to_gateway_runtime() -> None:
    service = ReviewAnalysisService()
    with patch.object(service, "_call_node", return_value={"status": "success"}) as call_node:
        response = service.run({"limit": 1})

    assert response["status"] == "success"
    assert call_node.call_args.args[1]["runtime"] == "gateway"


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


def test_review_scalable_runtime_accepts_bulk_rows() -> None:
    service = ReviewAnalysisService()
    with patch.object(service, "_call_node", return_value={"status": "success"}) as call_node:
        response = service.run({"limit": 50_000, "runtime": "scalable"})

    assert response["status"] == "success"
    assert call_node.call_args.args[1]["runtime"] == "scalable"
