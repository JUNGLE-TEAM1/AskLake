import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.models.base import Base
from app.models.semantic_rag import RagDatasetProfileModel, RagIndexJobModel
from app.schemas.semantic import RagApproveRequest
from app.services.rag_service import RAG_TABLES, RagService


def immutable_contract() -> dict:
    return RagService._job_request_contract(
        mode="reindex",
        source_fingerprint="source-v2",
        policy_fingerprint="policy-v3",
        embedding_provider="openai_compatible",
        embedding_model="text-embedding-3-small",
        embedding_dimensions=1536,
        roles={
            "bodyColumns": ["description", "category", "id"],
            "titleColumns": ["name"],
            "metadataColumns": ["category"],
            "identifierColumns": ["id"],
        },
        versions=RagService._contract_version_snapshot(),
    )


def stored_job(contract: dict) -> RagIndexJobModel:
    roles = contract["roles"]
    return RagIndexJobModel(
        id="ragjob_contract",
        dataset_id="products",
        requested_by="admin",
        target_index="products-v2",
        requested_mode=contract["mode"],
        source_fingerprint=contract["sourceFingerprint"],
        policy_fingerprint=contract["policyFingerprint"],
        embedding_provider_snapshot=contract["embeddingProvider"],
        embedding_model=contract["embeddingModel"],
        embedding_dimensions=contract["embeddingDimensions"],
        body_columns=roles["bodyColumns"],
        title_columns=roles["titleColumns"],
        metadata_columns=roles["metadataColumns"],
        identifier_columns=roles["identifierColumns"],
        contract_versions=contract["versions"],
        request_fingerprint=RagService._request_fingerprint(contract),
    )


def test_idempotency_fingerprint_covers_every_immutable_rag_input() -> None:
    contract = immutable_contract()
    job = stored_job(contract)
    fingerprint = RagService._request_fingerprint(contract)
    assert RagService._idempotency_mismatches(job, contract, fingerprint) == []

    variants = {
        "mode": {**contract, "mode": "index"},
        "sourceFingerprint": {**contract, "sourceFingerprint": "source-v3"},
        "policyFingerprint": {**contract, "policyFingerprint": "policy-v4"},
        "embeddingProvider": {**contract, "embeddingProvider": "another-provider"},
        "embeddingModel": {**contract, "embeddingModel": "another-model"},
        "embeddingDimensions": {**contract, "embeddingDimensions": 3072},
        "versions": {**contract, "versions": {**contract["versions"], "chunkingVersion": "rag-chunk-v4"}},
    }
    for expected_field, variant in variants.items():
        mismatch = RagService._idempotency_mismatches(job, variant, RagService._request_fingerprint(variant))
        assert expected_field in mismatch

    for role_name in contract["roles"]:
        variant = {**contract, "roles": {**contract["roles"], role_name: [*contract["roles"][role_name], "extra"]}}
        mismatch = RagService._idempotency_mismatches(job, variant, RagService._request_fingerprint(variant))
        assert role_name in mismatch


def test_stale_alias_cleanup_never_replaces_a_newer_serving_target() -> None:
    class Client:
        indices = ["products-old", "products-new"]

        def alias_indices(self, alias):
            return list(self.indices)

        def _request(self, method, path, *, json):
            assert (method, path) == ("POST", "_aliases")
            for action in json["actions"]:
                if "remove" in action:
                    self.indices.remove(action["remove"]["index"])
                elif "add" in action:
                    self.indices.append(action["add"]["index"])

    client = Client()
    assert RagService._cas_remove_stale_alias(client, "products", "products-old", "products-previous") == "removed"
    assert client.indices == ["products-new"]
    assert RagService._cas_activate_alias(client, "products", "products-old", "products-previous") == "pending"
    assert client.indices == ["products-new"]


def test_whole_document_approval_allows_256_unique_fields_but_not_257() -> None:
    columns = [f"field_{index}" for index in range(256)]
    approved = RagApproveRequest(
        bodyColumns=columns,
        metadataColumns=[columns[1]],
        identifierColumns=[columns[0]],
    )
    assert len(set(approved.body_columns)) == 256

    with pytest.raises(ValidationError):
        RagApproveRequest(
            bodyColumns=[*columns, "field_256"],
            identifierColumns=[columns[0]],
        )


def test_whole_document_preview_reports_each_source_column_once(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=RAG_TABLES)
    with Session(engine) as db:
        profile = RagDatasetProfileModel(
            dataset_id="products",
            review_state="approved",
            target_alias="products",
            body_columns=["description", "category", "id"],
            metadata_columns=["category"],
            identifier_columns=["id"],
        )
        db.add(profile)
        db.commit()
        service = RagService(db)
        dataset = {
            "id": "products",
            "name": "Products",
            "schema": [
                {"name": "description", "dataType": "string"},
                {"name": "category", "dataType": "string"},
                {"name": "id", "dataType": "string"},
            ],
            "sampleRows": [{"description": "wireless", "category": "audio", "id": "p-1"}],
        }
        monkeypatch.setattr(service, "_dataset", lambda *args, **kwargs: dataset)

        preview = service.preview("products", ActorContext(name="admin", role="admin"))

        assert preview.source_columns == ["description", "category", "id"]
        assert preview.documents[0].source_columns == ["description", "category", "id"]
