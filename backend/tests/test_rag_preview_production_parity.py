from datetime import datetime, timezone

import pytest

from app.services.rag_document_service import build_documents
from scripts.rag_parent_contract import build_parent_document


def test_preview_matches_production_parent_for_composite_identifier_and_dual_roles() -> None:
    mapping = {
        "Tenant Id": "tenant_id",
        "Product Id": "product_id",
        "Product Name": "product_name",
        "Description": "description",
        "Category": "category",
        "Observed At": "observed_at",
    }
    raw_row = {
        "Tenant Id": "amazon-ko",
        "Product Id": 1001,
        "Product Name": "무선 이어폰",
        "Description": "노이즈 캔슬링 블루투스 이어폰",
        "Category": "오디오",
        "Observed At": datetime(2026, 7, 17, 9, 30, tzinfo=timezone.utc),
    }
    body_columns = ["Description", "Category", "Product Id"]
    title_columns = ["Product Name"]
    metadata_columns = ["Category"]
    identifier_columns = ["Tenant Id", "Product Id"]
    schema_types = {
        "Tenant Id": "string",
        "Product Id": "integer",
        "Product Name": "string",
        "Description": "string",
        "Category": "string",
        "Observed At": "timestamp",
    }

    preview = build_documents(
        dataset_id="amazon-products",
        dataset_name="Amazon products",
        rows=[raw_row],
        columns=list(raw_row),
        body_columns=body_columns,
        title_columns=title_columns,
        metadata_columns=metadata_columns,
        identifier_columns=identifier_columns,
        schema_types=schema_types,
        physical_column_mapping=mapping,
        target_index="asklake-rag-amazon-products-v1",
    )[0]

    physical_row = {mapping[column]: value for column, value in raw_row.items()}
    active_physical_columns = list(dict.fromkeys([
        *(mapping[column] for column in body_columns),
        *(mapping[column] for column in title_columns),
        *(mapping[column] for column in metadata_columns),
        *(mapping[column] for column in identifier_columns),
    ]))
    production = build_parent_document(
        dataset_id="amazon-products",
        source_fingerprint="source-fingerprint",
        row=physical_row,
        schema_columns=active_physical_columns,
        body_columns=[mapping[column] for column in body_columns],
        title_columns=[mapping[column] for column in title_columns],
        metadata_columns=[mapping[column] for column in metadata_columns],
        identifier_columns=[mapping[column] for column in identifier_columns],
        included_columns=active_physical_columns,
        semantic_bindings={},
        ordinal=0,
        job_id="ragjob-preview-parity",
        policy_fingerprint="policy-fingerprint",
        body_fields=[
            {"logicalField": column, "physicalField": mapping[column], "dataType": schema_types[column]}
            for column in body_columns
        ],
        title_fields=[
            {"logicalField": column, "physicalField": mapping[column], "dataType": schema_types[column]}
            for column in title_columns
        ],
        metadata_fields=[
            {"logicalField": column, "physicalField": mapping[column], "dataType": schema_types[column]}
            for column in metadata_columns
        ],
        identifier_fields=[
            {"logicalField": column, "physicalField": mapping[column], "dataType": schema_types[column]}
            for column in identifier_columns
        ],
        logical_to_physical=mapping,
    )

    assert preview["sourceRowId"] == production["source_row_id"]
    assert preview["parentDocumentId"] == production["parent_document_id"]
    assert preview["contentHash"] == production["content_hash"]
    assert preview["title"] == production["title"]
    assert preview["body"] == production["body"]
    assert preview["embeddingText"] == f"{production['title']}\n\n{production['body']}"
    assert preview["sourceColumns"] == list(dict.fromkeys([
        *body_columns,
        *title_columns,
        *metadata_columns,
        *identifier_columns,
    ]))


def test_preview_rejects_missing_part_of_composite_identifier() -> None:
    with pytest.raises(ValueError, match="RAG_SOURCE_IDENTIFIER_MISSING: product_id"):
        build_documents(
            dataset_id="amazon-products",
            dataset_name="Amazon products",
            rows=[{"tenant_id": "amazon-ko", "product_id": None, "description": "상품"}],
            columns=["tenant_id", "product_id", "description"],
            body_columns=["description"],
            metadata_columns=[],
            identifier_columns=["tenant_id", "product_id"],
            target_index="asklake-rag-amazon-products-v1",
        )
