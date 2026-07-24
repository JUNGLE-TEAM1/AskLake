# Semantic/RAG v2 implementation audit

> **Document status — Evidence**
>
> This audit is tied to the branch below. Use [API Contract](api-contract.md) and [Backend Integration Readiness](backend-integration-readiness.md) for the current contract and readiness boundary.

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

## Implemented and verified in this working tree

- OpenSearch k-NN uses the 2.19.1-compatible `query.knn` request shape.
- Public metadata filters require `{operator, value}`. Backend validates approved columns, Catalog data types, and operators; invalid filters are rejected instead of ignored.
- `build_status` and `serving_status` are separate. A failed or running replacement build does not take down the previous active alias.
- Alias activation requires OpenSearch count, exact composite-aggregation parent count, mapping fields, vector dimension, BM25 sample, k-NN sample, and metadata filter smoke checks.
- Parent staging keeps only body/title/metadata/identifier role columns. Excluded columns never enter `normalized_row_json`.
- Chunk records include job/chunk counts, character offsets, title, semantic bindings, model/dimensions, fallback state/reason, and chunk-specific content hash.
- RRF results are grouped by parent and adjacent chunks are merged into bounded context.
- Source and embedding-model changes are eligible for reindex reconciliation. Schema or semantic-role changes mark the profile `needs_review` and block automatic activation until approval is repeated. Query embeddings use the active manifest model.
- RAG Spark jobs disable speculation. Worker checks existing OpenSearch document IDs before embedding, so retried batches skip already persisted chunks and report `skippedExistingCount`.
- Dataset activation is fenced by a database-backed generation. A late or superseded callback cannot replace the current serving index.
  - Physical validation evidence is persisted on the job and is required for activation; a callback boolean cannot bypass `/validate`.
  - Activation additionally requires the job to be in the persisted `validating` stage, so validation evidence cannot skip the state machine.
- Catalog schema changes block automatic indexing and move the profile to `needs_review`; source-only changes remain eligible for reconciliation.
- Catalog logical names are normalized once for physical storage/filter compilation, and normalization collisions are rejected at approval.
- The approved logical-to-physical mapping is persisted on the profile, job, and active manifest and is passed through Spark and Worker contracts.
- CSV/JSON source readers receive Catalog types instead of silently converting every metadata value to a string.
- A committed parent/chunk Iceberg table is reused after a Spark driver restart, so completed stages are resumed rather than re-calling the Chunker.
- Document preview reads the active OpenSearch index when one exists; the pre-index sample is explicitly a pending projection.
- Structured document rendering is now versioned as `rag-parent-v3`, `title_body_fields_v2`, `rag-chunk-v3`, and `field_blocks_v1`. Title/body fields render as labeled blocks with stable logical order; excluded fields are absent from normalized rows, metadata, and embedding input.
- Parent and chunk staging persist `title_blocks_json`, `body_blocks_json`, `metadata_display_json`, `source_fields_json`, and the field-rendering version. The final Worker document stores physical typed metadata separately from logical display metadata and keeps canonical body fragments for overlap-safe context merging.
- Each Dataset continues to own its alias and versioned physical index. Multi-alias search computes query embeddings and alias-local BM25/vector RRF independently, then performs parent deduplication.
- Parent diversification happens before the global retrieval budget is cut, so a long parent cannot consume all top-24 chunk slots and hide other parents.
- The Embedding Worker rejects writes to an existing target index when its vector dimension or stored embedding model conflicts with the request. Its `/ready` probe checks both OpenSearch and the AI Gateway.

## Quality verification

- `backend/app/services/rag_evaluation.py` now evaluates real API response payloads at parent and chunk level.
- Golden cases support query, typed filters, relevant parent/chunk IDs, graded relevance, and duplicate-parent measurement.
- `enforce_quality_gate` fails on recall/MRR/nDCG/filter-precision/dedup thresholds.
- `backend/scripts/run_rag_quality_gate.py` calls the live RAG search API and exits non-zero when the gate fails.
- `backend/scripts/verify_rag_opensearch.py` is a read-only deployment preflight for an already-built index.
- `backend/tests/test_opensearch_integration.py` runs against a real endpoint when `OPENSEARCH_INTEGRATION_URL` is set.
- `.github/workflows/rag-opensearch-integration.yml` runs that test with `opensearchproject/opensearch:2.19.1` on relevant changes.
  - The same workflow installs pinned test dependencies and runs the embedding-worker unit suite with `python -m pytest`.

## Database contract

Migration: `backend/alembic/versions/0007_rag_operational_controls.py` (after `0006_rag_physical_column_mapping.py`)

It adds persisted failed-row counts/rates/reports, retention metadata, and job-scoped staging locations. Previous migrations add activation generation fencing, approved schema/definition fingerprints, persisted physical-validation evidence, and the logical-to-physical column mapping.

## Local verification

```powershell
cd backend
$env:PYTHONPATH='.'
python -m pytest -q

cd ..\embedding-worker
$env:PYTHONPATH='.'
python -m pytest -q
```

## Operational completion controls

- Spark-to-worker requests carry canonical payload-hash idempotency keys. The worker persists successful responses in SQLite and the production compose mounts `/var/lib/asklake/embedding-worker` as a durable volume; deterministic document IDs remain the final write guard.
- Parent staging reports row count, failed count, failed rate, threshold, and the job-scoped parent table as the quarantine report. A threshold breach fails the job before chunking and the invalid rows remain queryable in that table with `row_status=failed`.
- `backend/scripts/cleanup-rag-artifacts.py` is dry-run by default and runs as a production cleanup service with `--apply --loop`. It removes retired OpenSearch indexes only after confirming the serving alias is not attached and, when Trino/Iceberg is enabled, drops the corresponding job-scoped parent/chunk tables. Retention days and previous-index count are configured in Settings.
- Production Compose enables OpenSearch TLS verification by default for both backend and worker; set `OPENSEARCH_CA_CERT` to a mounted CA bundle when the OpenSearch certificate is not in the runtime trust store.
- Retrieval context is capped by the configured token budget (`RAG_CONTEXT_MAX_TOKENS`) rather than a character-only cutoff. `run_rag_quality_gate.py --baseline ...` enforces the agreed maximum 5% relative Recall@8/MRR@8 drop.
- Production RAG runtime no longer creates tables implicitly. Alembic migration `0007_rag_operational_controls` is the production schema path; local/test bootstrap remains available through the local environment guard.
