# MinIO 100GB And Spark Validation Harness

This document records the Pair A person-1 backend validation path for Source, Schema, and Create. The ETL list starts empty; MinIO data is used only as test input.

## 1. Implemented Files

- `backend/src/server.mjs`: local JSON API server
- `backend/src/connectors.mjs`: source connector runner
- `backend/src/s3.service.mjs`: Target 저장경로 picker용 S3 bucket/prefix 조회
- `backend/src/targetDatabase.service.mjs`: Target DB picker용 허용 DB 목록 조회
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
npm run minio:seed-verify
npm run verify
npm run dev
```

로컬 MinIO가 없다면 먼저 repo root에서 실행한다.

```powershell
docker compose up -d minio
```

EC2 prod deploy에서는 MinIO가 `deploy/docker-compose.prod.yml`의 `minio` service로 실행된다. 서버 `deploy/.env`에는 최소 아래 값이 필요하다.

```text
MINIO_ENDPOINT=http://minio:9000
MINIO_ENDPOINT_IN_DOCKER=http://minio:9000
MINIO_ACCESS_KEY=<server-only value>
MINIO_SECRET_KEY=<server-only value>
MINIO_BUCKET=m3-raw
S3_ENDPOINT=http://minio:9000
S3_FORCE_PATH_STYLE=true
S3_ALLOWED_BUCKETS=m3-raw,asklake-output
```

초기 object sample은 EC2 backend container에서 준비한다.

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml exec backend npm run minio:seed-verify
```

Initial endpoints:

```text
GET /api/etl/jobs -> []
GET /api/catalog/datasets -> []
GET /api/s3/buckets -> { "buckets": ["asklake-output"] }
GET /api/s3/prefixes?bucket=asklake-output&prefix= -> folder prefixes
GET /api/target/databases -> { "databases": [{ "name": "asklake", "description": "..." }] }
```

Target S3 picker 환경변수:

```powershell
$env:S3_ALLOWED_BUCKETS = "asklake-output"
$env:S3_ENDPOINT = "http://localhost:9000"
$env:S3_FORCE_PATH_STYLE = "true"
$env:TARGET_DATABASES = "asklake,asklake_gold,analytics,marketing"
```

운영에서는 AWS SDK credential provider chain 또는 IAM role을 사용한다. 브라우저에는 AWS access key / secret key를 넣지 않는다.

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
npm run kafka:reviews-fixture
$env:ASKLAKE_VERIFY_KAFKA = "true"
npm run verify:sources
```

`npm run kafka:reviews-fixture`는 Amazon review replay/ingest 병렬 개발용 `reviews.raw` topic을 준비한다. 기존 source connector smoke는 기본 `asklake-source-events` topic을 검증한다. review fixture topic을 connector smoke로 확인하려면 `ASKLAKE_KAFKA_TOPIC=reviews.raw`를 함께 지정한다.

Verified source types:

- `File / S3`
- `REST API`
- `PostgreSQL`
- `MongoDB`
- `Data Lake`
- `Stream / Kafka`

`File / S3`에서 사용자가 `.parquet` 객체를 직접 선택하면 해당 객체는 Data Lake와 같은 Spark Parquet reader로 스키마와 제한 샘플을 읽는다. 단순 버킷 연결이나 폴더 목록은 데이터 스키마가 아니므로, 프런트는 실제 파일의 샘플 스키마가 확인되기 전에는 Schema 단계로 진행시키지 않는다. 선택한 Parquet의 스키마 추론이 실패하면 객체 메타데이터를 데이터 컬럼처럼 반환하지 않고 연결 오류로 처리한다. 로컬 Spark cold start를 고려한 기본 검사 제한은 `ASKLAKE_SOURCE_INSPECT_TIMEOUT_MS=90000`이며, 샘플을 읽는 동안 같은 파일 선택 요청을 중복 실행하지 않는다.

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

This verifier starts from an empty ETL/Catalog metadata state, creates one live job from a MinIO sample, submits a run command, verifies that the command response immediately returns `running`, then polls `GET /api/etl/jobs/{jobId}` until Spark writes Parquet output and the job returns to its final state. The create payload includes submitted `transformSteps`, `transformOutputColumns`, `qualityRules`, and the multi-column `partition` value; the verifier checks that Spark writes nested `event_type=.../category_id=...` partition directories. The expected DAG includes Source, Schema, Spark source read, Transform, Quality, Parquet write, and Catalog update steps.

Connector-backed jobs such as REST, PostgreSQL, and MongoDB write bounded sample rows to `ASKLAKE_SPARK_REPORT_DIR` as JSONL before Spark reads them. `start-spark-server.mjs` mounts that same host directory into the submit, master, and worker containers at `ASKLAKE_SPARK_REPORT_CONTAINER_DIR` (`/work/reports` by default). If a Codex worktree or repo path changes, the Spark containers must be recreated with the new report mount before run command verification.

## 8. Frontend

```powershell
cd frontend
$env:VITE_API_BASE_URL = "http://localhost:8080"
npm run dev
```

The browser calls backend endpoints for source tests and create flow.
