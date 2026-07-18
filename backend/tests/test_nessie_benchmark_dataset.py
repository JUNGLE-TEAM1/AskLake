from pathlib import Path

import pytest

from app.benchmarks.dataset import BenchmarkDatasetManifest, load_dataset_manifest, render_dataset_sql


MANIFEST = Path(__file__).parents[1] / "benchmarks/nessie-sql/dataset-manifest.v1.json"


def test_versioned_dataset_manifest_is_bounded_and_reproducible() -> None:
    manifest = load_dataset_manifest(MANIFEST)

    assert manifest.fixture_version == "1.0.0"
    assert manifest.generator_version == "trino-ctas-v1"
    assert manifest.seed == 9610718
    assert sum(table.row_count for table in manifest.tables) == 1_011_000
    assert next(table for table in manifest.tables if table.role == "fact").partition_spec == ["month(order_date)"]
    assert next(table for table in manifest.tables if table.role == "fact").column_statistics["order_id"]["distinct_count"] == 1_000_000
    assert len(manifest.canonical_hash()) == 64


def test_rendered_dataset_sql_has_pinned_distribution_and_partitioning() -> None:
    statements = render_dataset_sql(load_dataset_manifest(MANIFEST), replace=True)
    sql = "\n".join(statements)

    assert "DROP TABLE IF EXISTS" in sql
    assert "partitioning = ARRAY['month(order_date)']" in sql
    assert "sequence(1, 1000)" in sql
    assert "9610718" in sql
    assert "random()" not in sql.lower()


def test_manifest_rejects_duplicate_tables() -> None:
    payload = load_dataset_manifest(MANIFEST).model_dump(by_alias=True)
    payload["tables"].append(dict(payload["tables"][0]))

    with pytest.raises(ValueError, match="unique"):
        BenchmarkDatasetManifest.model_validate(payload)
