from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.main import create_app


def test_gateway_classifies_dataset_columns_and_generates_embeddings() -> None:
    settings = Settings(internal_auth_token=SecretStr("test-token"), provider="mock")
    client = TestClient(create_app(settings=settings))
    headers = {"Authorization": "Bearer test-token"}
    classification = client.post("/v1/generate", headers=headers, json={"mode": "classify_dataset", "request_id": "run-1", "prompt": "classify", "context": {"schema": [{"name": "review_text"}, {"name": "rating"}]}})
    assert classification.status_code == 200
    output = classification.json()["output"]
    assert output["classification"] == "review"
    assert {item["role"] for item in output["roles"]} == {"body", "metadata"}
    embeddings = client.post("/v1/embeddings", headers=headers, json={"model": "text-embedding-3-small", "input": ["fast delivery", "slow delivery"]})
    assert embeddings.status_code == 200
    assert embeddings.json()["dimensions"] == 1536
    assert len(embeddings.json()["data"]) == 2


def test_gateway_returns_boundary_only_document_segmentation() -> None:
    settings = Settings(internal_auth_token=SecretStr("test-token"), provider="mock")
    client = TestClient(create_app(settings=settings))
    response = client.post(
        "/v1/generate",
        headers={"Authorization": "Bearer test-token"},
        json={
            "mode": "segment_document",
            "request_id": "segment-1",
            "prompt": "refine boundaries",
            "context": {
                "sentences": [
                    {"index": 0, "text": "첫 문장"},
                    {"index": 1, "text": "둘째 문장"},
                    {"index": 2, "text": "셋째 문장"},
                    {"index": 3, "text": "넷째 문장"},
                ],
                "candidateBoundaries": [1],
            },
        },
    )
    assert response.status_code == 200
    assert response.json()["mode"] == "segment_document"
    assert response.json()["output"]["segments"] == [
        {"startSentence": 0, "endSentence": 1},
        {"startSentence": 2, "endSentence": 3},
    ]
