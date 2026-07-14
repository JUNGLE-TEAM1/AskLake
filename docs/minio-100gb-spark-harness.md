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
- `backend/scripts/seed-minio-click-log.mjs`: whitespace-delimited raw click log 100-row fixture
- `backend/scripts/synthetic-commerce/convert_click_events_to_log.py`: local 또는 S3 click JSONL의 메모리 제한형 10필드 `.log`/manifest 변환
- `backend/scripts/synthetic-commerce/test_convert_click_events_to_log.py`: local atomic write와 S3 pagination·ETag·multipart abort 계약 검증
- `backend/scripts/verify-record-parsing-contract.py`: record parsing preview and row-width validation contract verifier
- `backend/scripts/verify-record-parsing-e2e.mjs`: real MinIO TXT -> FastAPI -> Airflow -> Spark -> Parquet -> Catalog verifier
- `backend/scripts/start-spark-server.mjs`: Spark standalone master/worker startup
- `backend/scripts/spark_validate.py`: Spark validation and transform type checks
- `backend/scripts/verify-spark-job-run.mjs`: create -> run -> Spark -> DAG -> Catalog verifier
- `backend/scripts/verify-spark-csv-quoting.mjs`: RFC 4180 comma/quote CSV -> Spark -> Parquet regression verifier
- `backend/scripts/verify-kafka-continuous-soak.mjs`: generated or JSONL/GZIP Kafka replay -> continuous worker -> reconciliation/fault/compaction verifier
- `backend/scripts/kafka_continuous_maintenance.py`: quarantine inspect/replay and staged Parquet compaction
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

이 문서의 MinIO harness는 로컬 회귀 전용이다. EC2 production은 MinIO를 띄우지 않고 AWS S3와 instance profile IAM Role을 사용한다. 서버 `deploy/.env`에는 최소 아래 값이 필요하다.

```text
ASKLAKE_OBJECT_STORAGE_PROVIDER=aws
AWS_REGION=ap-northeast-2
ASKLAKE_RAW_BUCKET=<raw-bucket>
ASKLAKE_SPARK_OUTPUT_MODE=s3a
ASKLAKE_SPARK_OUTPUT_BUCKET=<output-bucket>
S3_ENDPOINT=
S3_FORCE_PATH_STYLE=false
S3_ALLOWED_BUCKETS=<raw-bucket>,<output-bucket>
```

초기 object sample은 IAM 권한이 있는 로컬 shell 또는 EC2에서 AWS CLI로 업로드한다.

Production Spark master의 REST 6066, master 7077, UI 8080/8081은 Compose network 내부에서만 사용하고 host에 publish하지 않는다. Backend에는 Docker socket이나 Docker CLI를 제공하지 않고 Spark REST로 batch와 source inspect를 제출한다.

```bash
aws s3 cp /path/to/sample.csv s3://<raw-bucket>/asklake-fixtures/sample.csv
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

운영에서는 AWS SDK credential provider chain과 EC2 IAM Role을 사용한다. 브라우저나 `deploy/.env`에는 AWS access key / secret key를 넣지 않는다. 전체 EC2 절차는 `docs/deployment-runbook.md`를 따른다.

Spark CSV quoting 회귀는 원본 값을 바꾸지 않고 실제 Spark reader와 Parquet writer를 통과시켜 검증한다.

```bash
cd backend
npm run verify:spark-csv-quoting
```

## 3. Source Fixtures

```powershell
cd backend
npm run sources:fixtures
```

1.5단계 원시 레코드 구조화 개발에는 헤더가 없는 100줄 click event TXT fixture를 사용한다.

```powershell
cd backend
npm run minio:seed-click-log
```

기본 object는 `s3://m3-raw/asklake-fixtures/txt/click-events-whitespace-100.log`다. 한 줄은 하나의 이벤트이고 값은 공백 하나로 구분한다. 필드 순서는 `event_time`, `event_id`, `customer_id`, `session_id`, `event_type`, `page_path`, `element_id`, `device`, `region`, `latency_ms`이며 파일 본문에는 헤더를 넣지 않는다. 스크립트는 업로드 후 object를 다시 읽어 100줄과 행별 10개 필드를 검증한다. 같은 명령을 다시 실행하면 동일 key를 같은 결정적 fixture로 덮어쓴다.

실제 클릭 JSONL을 같은 1.5단계 입력으로 바꿀 때는 변환기를 사용한다. 고정 로컬 fixture는 다음 명령으로 변환·검증한다.

```bash
cd backend
npm run synthetic-commerce:click-log
npm run verify:synthetic-click-log
```

운영 AWS S3 또는 local MinIO prefix는 내려받기 없이 S3-to-S3로 변환한다. AWS S3에서는 endpoint 옵션을 생략하고 instance profile 또는 workload IAM credential chain을 사용한다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run synthetic-commerce:click-log -- \
  --input-s3-uri s3://raw-bucket/commerce/click_events/ \
  --output-s3-uri s3://raw-bucket/commerce/click-events.log
```

MinIO 검증은 `--s3-endpoint-url http://127.0.0.1:9000 --s3-force-path-style`을 추가한다. 입력 object는 key 순서와 ETag `If-Match`로 고정하고 결과는 multipart upload한다. 새 manifest를 먼저 저장하고 `.log`를 마지막에 commit하며 실패 시 upload abort와 manifest 복원/삭제로 기존 결과를 유지한다. 상세 IAM, manifest와 실패 복구 계약은 `backend/scripts/synthetic-commerce/README.md`를 따른다.

Preview 계약과 전체 runtime을 함께 검증할 때는 FastAPI, Airflow, MinIO, Spark가 같은 local Compose network를 사용하도록 한 뒤 아래 명령을 실행한다.

```powershell
cd backend
npm run verify:record-parsing
npm run verify:record-parsing:e2e
```

E2E는 Source API에서 원본을 `line_number`/`value` 100줄로 읽은 뒤 1.5단계에서 10필드로 구조화하고, 같은 저장 계약으로 Spark가 전체 오브젝트 100행을 Parquet로 기록하는지 확인한다. Catalog에는 10개 사용자 컬럼과 `_asklake_run_id`, `_asklake_ingested_at` 메타 컬럼만 있어야 한다. 실행 중인 Compose project가 `asklake-dev`라면 backend의 `ASKLAKE_DOCKER_NETWORK`는 `asklake-dev_default`여야 한다.

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

Snapshot schema contract를 변경한 뒤에는 `npm run verify:spark-schema-contract`를 실행한다. 이 검증은 필수 컬럼 1개와 10개에서 동일한 수의 내부 Spark job으로 null/cast 결과를 확인해, 필수 컬럼 수에 비례해 source scan action이 증가하는 회귀를 차단한다. JSON/JSONL reader는 승인된 schema와 dotted source path를 사용하므로 DataFrame 생성 시 inference action을 실행하지 않아야 한다.

Set `ASKLAKE_SPARK_FULL_COUNT=true` only when a full count is needed; default validation uses bounded reads for speed.

## 7. Create/Run Spark Pipeline Verification

```powershell
cd backend
npm run verify:spark-run
```

This verifier starts from an empty ETL/Catalog metadata state, creates one live job from a MinIO sample, submits a run command, verifies that the command response immediately returns `running`, then polls `GET /api/etl/jobs/{jobId}` until Spark writes Parquet output and the job returns to its final state. The create payload includes submitted `transformSteps`, `transformOutputColumns`, `qualityRules`, and the multi-column `partition` value; the verifier checks that Spark writes nested `event_type=.../category_id=...` partition directories. The expected DAG includes Source, Schema, Spark source read, Transform, Quality, Parquet write, and Catalog update steps.

Connector-backed jobs such as REST, PostgreSQL, and MongoDB write bounded sample rows to `ASKLAKE_SPARK_REPORT_DIR` as JSONL before Spark reads them. `start-spark-server.mjs` mounts that same host directory into the submit, master, and worker containers at `ASKLAKE_SPARK_REPORT_CONTAINER_DIR` (`/work/reports` by default). If a Codex worktree or repo path changes, the Spark containers must be recreated with the new report mount before run command verification.

Text structuring runs must also verify `quality.reviewRowAnalysisChecks`, `textStructuring.execution`, `runHistory[].textStructuringExecution`, and Catalog `materializationRuns[].textStructuringExecution`. `one_of_values` columns without a compatible model fail preflight unless the column explicitly sets `fallbackAllowed: true`.

## 8. Kafka Continuous Large-Data Soak

Continuous soak는 `ASKLAKE_RUN_KAFKA_CONTINUOUS_SOAK=true`일 때만 실행한다. `ASKLAKE_CONTINUOUS_SOAK_INPUT`을 생략하면 synthetic event를 만들고, 지정하면 `.jsonl` 또는 `.jsonl.gz`를 line streaming으로 읽는다. 전체 Electronics 파일은 CI가 아니라 수동 환경에서 실행하며, `ASKLAKE_CONTINUOUS_SOAK_COUNT`를 생략하면 파일 끝까지 replay한다.

```bash
cd backend
ASKLAKE_RUN_KAFKA_CONTINUOUS_SOAK=true \
ASKLAKE_CONTINUOUS_SOAK_INPUT="$HOME/Downloads/Electronics.jsonl.gz" \
ASKLAKE_CONTINUOUS_SOAK_RATE=1000 \
ASKLAKE_CONTINUOUS_SOAK_BATCH_SIZE=500 \
ASKLAKE_CONTINUOUS_SOAK_FAULT=worker \
ASKLAKE_CONTINUOUS_SOAK_COMPACT=true \
npm run verify:kafka-continuous-soak
```

`ASKLAKE_CONTINUOUS_SOAK_FAULT`는 `worker`, `backend`, `kafka`, `minio` 중 하나를 선택한다. Kafka/MinIO fault는 해당 Compose service를 잠시 pause한 뒤 반드시 unpause하고, worker가 실패 상태로 전이되면 checkpoint resume을 수행한다. Compaction 검증을 켜면 harness가 먼저 worker를 정상 중지해 checkpoint를 보존하고 단일 local Spark executor를 maintenance에 넘긴다. 결과에는 input/output row, file, byte, average file size와 reconciliation/lag/throughput/recovery/Catalog 지표가 포함된다. Compaction output은 `_compactions/run_id=*`에만 stage되며 원본 batch를 삭제하지 않는다.

`npm run verify:kafka-continuous-contract`는 같은 worker attempt의 실패 카운터 멱등성, 종료 worker의 manifest 기반 Catalog 복구, maintenance lease 정리를 검증한다. E2E는 기본 replay가 현재 schema policy를 다시 적용하는지, `approveUnknownFields` 관리자 예외만 unknown-field 행을 복구하는지, replay 이후 완료된 `batch_id` 경로를 표준 Spark `basePath` reader와 compaction이 함께 읽는지 확인한다. Stream batch manifest는 `_SUCCESS`가 있는 data/quarantine 경로와 topic/partition별 `[startOffset, endOffset)`을 포함해야 한다.

게시 경계 fault 검증은 backend에 `ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE=true`, E2E runner에 `ASKLAKE_CONTINUOUS_E2E_PUBLICATION_FAULT=true`를 설정한다. 첫 worker는 data `_SUCCESS` 뒤 manifest 전에 한 번 실패하고, harness가 resume한 뒤 같은 batch/offset을 중복 저장하지 않고 manifest와 Catalog를 복구해야 한다. 이 변수는 테스트 전용이며 운영에서는 반드시 `false`로 둔다.

## 9. Frontend

```powershell
cd frontend
$env:VITE_API_BASE_URL = "http://localhost:8080"
npm run dev
```

The browser calls backend endpoints for source tests and create flow.
