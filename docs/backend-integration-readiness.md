# Backend Integration Status

This branch has a local backend integration for the Pair A person-1 vertical slice. The frontend expects a backend API and does not provide a frontend-only source path.

## 1. Implemented

| Area | Status |
| --- | --- |
| Backend server | `backend/src/server.mjs` |
| Source connectors | MinIO/S3, REST, PostgreSQL, MongoDB, Data Lake object listing, Kafka metadata |
| Schema profiling | CSV, TSV, JSON, JSONL, TXT samples |
| Create response | `{ job, dataset }` from `CreatePipelineRequest` |
| Initial ETL state | `GET /api/etl/jobs` returns `[]` before create |
| Initial Catalog state | `GET /api/catalog/datasets` returns `[]` before create |
| Spark validation | Standalone Spark master/worker plus CSV/JSONL/JSON/TXT/Parquet checks |

## 2. Source Support Matrix

| Source | Local fixture | Verification |
| --- | --- | --- |
| File / S3 | MinIO bucket `m3-raw` | `npm run verify:sources` |
| REST API | `/api/harness/rest-sample` | `npm run verify:sources` |
| PostgreSQL | Docker `asklake-postgres-source` | `npm run sources:fixtures` |
| MongoDB | Docker `asklake-mongodb-source` | `npm run sources:fixtures` |
| Data Lake | MinIO object listing | `npm run verify:sources` |
| Stream / Kafka | Redpanda `asklake-redpanda-source` | `ASKLAKE_VERIFY_KAFKA=true npm run verify:sources` |

## 3. Current Limitations

- Job and dataset storage is in-memory.
- Data Lake connector lists objects; physical Parquet validation is handled by the Spark harness.
- Kafka connector verifies topic metadata; message payload schema sampling is a follow-up.
- Transform/Quality/Schedule/Permission/Target and run/history/DAG are Pair A person-2 ownership.
- Authentication, authorization, audit persistence, dashboard persistence, and RAG ingestion are outside this slice.

## 4. Required Local Checks

```powershell
cd backend
npm run verify
npm run sources:fixtures
$env:ASKLAKE_WITH_KAFKA = "true"
$env:ASKLAKE_RECREATE_KAFKA = "true"
npm run sources:fixtures
$env:ASKLAKE_VERIFY_KAFKA = "true"
npm run verify:sources
npm run minio:prepare-samples
npm run spark:start
npm run spark:validate
```

```powershell
cd frontend
$env:VITE_API_BASE_URL = "http://localhost:8080"
npm run build
```
