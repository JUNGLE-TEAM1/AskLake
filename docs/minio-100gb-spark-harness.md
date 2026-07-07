# MinIO 100GB And Spark Validation Harness

This document records the Pair A person-1 backend validation path for Source, Schema, and Create. The ETL list starts empty; MinIO data is used only as test input.

## 1. Implemented Files

- `backend/src/server.mjs`: local JSON API server
- `backend/src/connectors.mjs`: source connector runner
- `backend/src/profile.mjs`: CSV/TSV/JSON/JSONL/TXT parser and schema profiler
- `backend/src/createPipeline.mjs`: create `{ job, catalogTarget }`, run success `dataset` mapper
- `backend/scripts/prepare-minio-samples.mjs`: local 1GB-style sample preparation
- `backend/scripts/start-spark-server.mjs`: Spark standalone master/worker startup
- `backend/scripts/spark_validate.py`: Spark validation and transform type checks
- `backend/scripts/verify-spark-job-run.mjs`: create -> run -> Spark -> DAG -> Catalog verifier
- `backend/scripts/setup-source-fixtures.mjs`: PostgreSQL, MongoDB, and Redpanda fixtures
- `backend/scripts/verify-all-sources.mjs`: source connector verifier

## 2. Backend

```powershell
cd backend
npm install
npm run verify
npm run dev
```

Initial endpoints:

```text
GET /api/etl/jobs -> []
GET /api/catalog/datasets -> []
```

## 3. Source Fixtures

```powershell
cd backend
npm run sources:fixtures
```

With Kafka:

```powershell
cd backend
$env:ASKLAKE_WITH_KAFKA = "true"
$env:ASKLAKE_RECREATE_KAFKA = "true"
npm run sources:fixtures
$env:ASKLAKE_VERIFY_KAFKA = "true"
npm run verify:sources
```

Verified source types:

- `File / S3`
- `REST API`
- `PostgreSQL`
- `MongoDB`
- `Data Lake`
- `Stream / Kafka`

## 4. Local 1GB-Style Samples

MinIO can reject new object writes when storage is near its minimum free threshold. To avoid changing existing user data, the harness creates local samples from existing MinIO objects:

```powershell
cd backend
npm run minio:prepare-samples
```

Default local directory:

```text
%TEMP%\asklake-1gb-samples
```

Prepared sample families:

- CSV from `nyc_taxi/csv/2019-Nov.csv`
- JSONL from Amazon reviews
- JSON from annotations
- TXT from available text files
- Parquet from NYC taxi Parquet files

TXT may be smaller than 1GB when the source files are smaller. Parquet is copied as whole files so row groups and footers stay valid.

## 5. Spark Server

```powershell
cd backend
npm run spark:start
```

Expected services:

```text
Spark master: spark://asklake-spark-master:7077
Master UI: http://127.0.0.1:18080
Worker UI: http://127.0.0.1:18081
```

The script recreates master and worker containers with the local sample directory mounted at `/opt/asklake-samples`, local Spark output mounted at `/work/output`, and the backend run report directory mounted at `/work/reports`. Connector-backed runs write bounded sample rows to `backend/tmp/spark-runs/*-source.jsonl`, so stale Spark containers are recreated when `/work/reports` points at an older backend path.

## 6. Spark Validation

```powershell
cd backend
npm run spark:validate
```

The validator checks:

- CSV schema and row read
- JSONL schema and row read
- JSON array schema and row read
- TXT row read
- Parquet physical read
- Transform type fixture: trim, int, long, double, bool, timestamp, JSON path extraction

Set `ASKLAKE_SPARK_FULL_COUNT=true` only when a full count is needed; default validation uses bounded reads for speed.

## 7. Create/Run Spark Pipeline Verification

```powershell
cd backend
npm run verify:spark-run
```

This verifier starts from an empty ETL/Catalog metadata state, creates one live job from a MinIO sample, submits a run command, verifies that the command response immediately returns `running`, then polls `GET /api/etl/jobs/{jobId}` until Spark writes Parquet output and the job returns to its final state. The create payload includes submitted `transformSteps`, `transformOutputColumns`, and `qualityRules`; the expected DAG includes Source, Schema, Spark source read, Transform, Quality, Parquet write, and Catalog update steps.

Connector-backed jobs such as REST, PostgreSQL, and MongoDB write bounded sample rows to `ASKLAKE_SPARK_REPORT_DIR` as JSONL before Spark reads them. `start-spark-server.mjs` mounts that same host directory into the submit, master, and worker containers at `ASKLAKE_SPARK_REPORT_CONTAINER_DIR` (`/work/reports` by default). If a Codex worktree or repo path changes, the Spark containers must be recreated with the new report mount before run command verification.

## 8. Frontend

```powershell
cd frontend
$env:VITE_API_BASE_URL = "http://localhost:8080"
npm run dev
```

The browser calls backend endpoints for source tests and create flow.
