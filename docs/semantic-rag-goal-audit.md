# Semantic/RAG v2 implementation audit

Branch: `feature/rag-v2-goal-audit`

## Current pipeline

```text
Catalog sourceManifest
  -> Backend RAG profile/job
  -> Airflow
  -> Spark parent staging
  -> Spark chunk staging -> Chunker API
  -> Spark index dispatch -> Embedding Worker
  -> versioned OpenSearch index
  -> backend physical validation
  -> alias switch
  -> active manifest / serving
```

## Fixed P0/P1 defects

- OpenSearch k-NN uses the 2.19.1-compatible `query.knn` request shape.
- Public metadata filters require `{operator, value}`. Backend validates approved columns, Catalog data types, and operators; invalid filters are rejected instead of ignored.
- `build_status` and `serving_status` are separate. A failed or running replacement build does not take down the previous active alias.
- Alias activation requires OpenSearch count, exact composite-aggregation parent count, mapping fields, vector dimension, BM25 sample, k-NN sample, and metadata filter smoke checks.
- Parent staging keeps only body/title/metadata/identifier role columns. Excluded columns never enter `normalized_row_json`.
- Chunk records include job/chunk counts, character offsets, title, semantic bindings, model/dimensions, fallback state/reason, and chunk-specific content hash.
- RRF results are grouped by parent and adjacent chunks are merged into bounded context.
- Source, schema/policy, semantic binding, and embedding model changes trigger reindex reconciliation. Query embeddings use the active manifest model.
- RAG Spark jobs disable speculation. Worker checks existing OpenSearch document IDs before embedding, so retried batches skip already persisted chunks and report `skippedExistingCount`.

## Quality verification

- `backend/app/services/rag_evaluation.py` now evaluates real API response payloads at parent and chunk level.
- Golden cases support query, typed filters, relevant parent/chunk IDs, graded relevance, and duplicate-parent measurement.
- `enforce_quality_gate` fails on recall/MRR/nDCG/filter-precision/dedup thresholds.
- `backend/scripts/run_rag_quality_gate.py` calls the live RAG search API and exits non-zero when the gate fails.
- `backend/scripts/verify_rag_opensearch.py` is a read-only deployment preflight for an already-built index.
- `backend/tests/test_opensearch_integration.py` runs against a real endpoint when `OPENSEARCH_INTEGRATION_URL` is set.
- `.github/workflows/rag-opensearch-integration.yml` runs that test with `opensearchproject/opensearch:2.19.1` on relevant changes.

## Database contract

Migration: `backend/alembic/versions/0004_rag_validation_contract.py`

It records failed rows, fallback counts/reasons, schema fingerprint, and semantic-binding fingerprint on jobs/manifests.

## Local verification

```powershell
cd backend
$env:PYTHONPATH='.'
pytest -q

cd ..\embedding-worker
$env:PYTHONPATH='.'
pytest -q
```

## Remaining operational caveats

1. The local Docker stack used during development did not have a running OpenSearch 2.19.1 endpoint, so the real HTTP integration test was skipped locally. CI and deployment preflight provide the execution path.
2. Concurrent duplicate Spark attempts can still race before the existing-ID check. OpenSearch `_id` writes remain deterministic and idempotent; a distributed batch lease would be the next hardening step if speculative/concurrent retries are observed.
3. The sample golden fixture is illustrative. Each production Dataset still needs curated cases and an agreed threshold profile before publishing a quality gate as a release blocker.
