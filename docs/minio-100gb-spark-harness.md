# MinIO 100GB And Spark Validation Harness

This document records the Pair A person-1 backend validation path for Source, Schema, and Create. The ETL list starts empty; MinIO data is used only as test input.

## 1. Implemented Files

- `backend/src/server.mjs`: local JSON API server
- `backend/src/connectors.mjs`: source connector runner
- `backend/src/minioDockerClient.mjs`: 로컬 MinIO Docker fallback의 object 목록·stat·bounded Range 실행 adapter
- `backend/src/s3.service.mjs`: Target 저장경로 picker용 S3 bucket/prefix 조회
- `backend/src/targetDatabase.service.mjs`: Target DB picker용 허용 DB 목록 조회
- `backend/src/profile.mjs`: CSV/TSV/JSON/JSONL/TXT parser and schema profiler
- `backend/src/prefixSampleValidation.mjs`: Prefix 대표 파일 우선 처리, bounded worker pool, 비중복 적응형 Range 샘플러
- `backend/src/createPipeline.mjs`: create `{ job, catalogTarget }`, run success `dataset` mapper
- `backend/scripts/prepare-minio-samples.mjs`: local 1GB-style sample preparation
- `backend/scripts/seed-minio-click-log.mjs`: whitespace-delimited raw click log 100-row fixture
- `backend/scripts/synthetic-commerce/convert_click_events_to_log.py`: local 또는 S3 click JSONL의 메모리 제한형 10필드 `.log`/manifest 변환
- `backend/scripts/synthetic-commerce/test_convert_click_events_to_log.py`: local atomic write와 S3 pagination·ETag·multipart abort 계약 검증
- `backend/scripts/verify-record-parsing-contract.py`: record parsing preview and row-width validation contract verifier
- `backend/scripts/verify-record-parsing-e2e.mjs`: real MinIO TXT -> FastAPI -> Airflow -> Spark -> Iceberg -> Catalog verifier
- `backend/scripts/start-spark-server.mjs`: Spark standalone master/worker startup
- `backend/scripts/spark_validate.py`: Spark validation and transform type checks
- `backend/scripts/verify-spark-job-run.mjs`: create -> run -> Spark -> DAG -> Catalog verifier
- `backend/scripts/verify-prefix-source-connector.mjs`: recursive Prefix filtering/schema contract verifier
- `backend/scripts/upload-synthetic-commerce.mjs`: synthetic v2/v3 manifest -> MinIO/S3 stream uploader and remote evidence verifier
- `backend/scripts/verify-prefix-spark-e2e.mjs`: real Prefix Preview -> Job -> Spark -> Iceberg -> Catalog -> SQL verifier
- `backend/scripts/verify-spark-iceberg-batch.py`: native Spark Iceberg replace/re-run/rollback live verifier
- `backend/scripts/verify-kafka-snapshot-iceberg.py`: Kafka fixed snapshot -> Spark Iceberg append -> Trino/Catalog -> offset commit/retry live verifier
- `backend/scripts/verify-spark-csv-quoting.mjs`: RFC 4180 comma/quote CSV -> Spark -> Parquet regression verifier
- `backend/scripts/verify-kafka-continuous-soak.mjs`: generated or JSONL/GZIP Kafka replay -> continuous Iceberg worker -> reconciliation/fault verifier
- `backend/scripts/verify-kafka-continuous-iceberg.py`: isolated Redpanda/Spark/Trino/MinIO append, pre-manifest fault, checkpoint restart verifier
- `backend/scripts/kafka_continuous_maintenance.py`: quarantine inspect/replay plus Iceberg data-file rewrite, snapshot expiration and orphan cleanup
- `backend/scripts/setup-source-fixtures.mjs`: PostgreSQL, MongoDB, and Redpanda fixtures
- `backend/scripts/verify-all-sources.mjs`: source connector verifier

## 2. Backend

```powershell
cd backend
npm install
npm run minio:seed-verify
npm run verify:prefix-source
npm run verify
npm run dev
```

`verify:prefix-source`는 외부 MinIO 없이 Prefix 샘플러와 connector 계약을 검증한다. 실제 Prefix Preview는 사전식 대표 파일을 먼저 읽고 나머지를 `ASKLAKE_PREFIX_VALIDATION_CONCURRENCY` 기본 8개 worker로 처리한다. 파일별 읽기는 `ASKLAKE_PREFIX_INITIAL_SAMPLE_BYTES` 기본 64KiB에서 시작하며 완전한 샘플 행이 부족한 경우에만 이전 구간과 겹치지 않는 다음 Range를 요청한다. 기존 sample scope의 최대 byte, EOF 또는 행 제한에서 멈추며 모든 데이터 파일의 schema 호환성 검사는 생략하지 않는다.

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

위 `asklake-output` 응답은 설정이 없는 local MinIO demo의 fallback이다. AWS mode에서는 `ASKLAKE_SPARK_OUTPUT_BUCKET`이 목록 첫 번째에 오고 `S3_ALLOWED_BUCKETS`의 나머지 bucket이 뒤따른다. AWS에서 두 설정이 모두 비면 잘못된 local bucket을 반환하지 않고 `503 SERVICE_UNAVAILABLE`로 기동 설정 오류를 드러낸다.

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

이 변환기의 `click-events.log` 필드 순서는 `event_time`, `event_id`, `user_id`, `session_id`, `event_type`, `product_id`, `page_url`, `device_type`, `referrer`, `position`이다. Frontend 추천 스키마는 basename과 10필드 검증이 모두 맞을 때만 이 순서와 타입 초안을 채우며 backend Preview 검증을 생략하지 않는다. 위의 별도 `click-events-whitespace-100.log` fixture는 필드 의미가 다르므로 추천 대상이 아니다.

운영 AWS S3 또는 local MinIO prefix는 내려받기 없이 S3-to-S3로 변환한다. AWS S3에서는 endpoint 옵션을 생략하고 instance profile 또는 workload IAM credential chain을 사용한다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run synthetic-commerce:click-log -- \
  --input-s3-uri s3://raw-bucket/commerce/click_events/ \
  --output-s3-uri s3://raw-bucket/commerce/click-events.log
```

MinIO 검증은 `--s3-endpoint-url http://127.0.0.1:9000 --s3-force-path-style`을 추가한다. 입력 object는 key 순서와 ETag `If-Match`로 고정하고 결과는 multipart upload한다. 새 manifest를 먼저 저장하고 `.log`를 마지막에 commit하며 실패 시 upload abort와 manifest 복원/삭제로 기존 결과를 유지한다. 상세 IAM, manifest와 실패 복구 계약은 `backend/scripts/synthetic-commerce/README.md`를 따른다.

Preview 계약과 전체 runtime을 함께 검증할 때는 FastAPI, Airflow, MinIO, Spark가 같은 local Compose network를 사용하도록 한 뒤 아래 명령을 실행한다.

대용량 실행 중 Airflow가 재시작되면 orphan task는 backend의 기존 Spark 결과를 재조회하며, backend까지 재시작된 경우 이전 process owner의 실행 lease를 stale로 처리해 같은 Run을 다시 claim한다. 재시작 직후 `SPARK_RUN_ALREADY_EXECUTING`만으로 Run을 terminal 실패로 확정하면 안 된다. Backend 컨테이너가 교체되는 동안 Docker DNS 또는 연결이 잠시 끊겨도 `spark_process_write`는 15초부터 최대 2분까지 지수 backoff로 4회 재시도하고 같은 Run의 persisted result/lease를 재사용한다. Spark worker가 교체되어 driver state가 `FAILED`/`KILLED`/`ERROR`로 끝난 경우 다음 retry는 terminal state와 오래된 실패 report를 제거하고 새 driver를 제출한다. 성공한 `FINISHED` state/report는 재사용해 중복 출력을 만들지 않는다.

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

## 4.1 Synthetic Commerce 250MiB Prefix Harness

Amazon Electronics metadata를 기준으로 만든 synthetic v3 run은 `meta/`, `users/`, `click_events/`를 서로 다른 데이터셋 Prefix로 둔다. 다중 파일 검증은 같은 스키마의 `click_events/part-*.jsonl`을 대상으로 하며 세 Prefix를 한 Job에서 자동 조인하지 않는다. uploader와 Prefix E2E는 기존 v2 fixture 호환성도 유지한다.

```bash
python3 backend/scripts/synthetic-commerce/generate.py \
  --source "$HOME/Downloads/meta_Electronics.jsonl" \
  --output-dir backend/tmp/synthetic-commerce \
  --run-id commerce-250mb-seed-20260711 \
  --target-total-size-mb 250 \
  --max-file-size-mb 64 \
  --products 10000 \
  --seed 20260711

python3 backend/scripts/synthetic-commerce/analyze.py \
  --data-dir backend/tmp/synthetic-commerce/commerce-250mb-seed-20260711

docker compose up -d minio postgres
cd backend
npm run synthetic-commerce:upload
npm run verify:prefix-spark-e2e
```

Uploader는 local bytes/SHA-256을 manifest와 대조하고 data part를 stream upload한 뒤 `HeadObject`와 원격 key set을 확인하며 `manifest.json`을 마지막에 게시한다. E2E는 실제 `/api/etl/sources/test` Prefix Preview 결과로 Job을 생성하고 `inputFileCount`, `inputBytes`, `inputRows`, `outputRows`를 manifest와 대조한다. 출력은 정확한 byte 크기가 아니라 Parquet 파일이 2개 이상인지 검증하며, Catalog 물리 경로에서 SQL `COUNT(*)`와 `event_type` 퍼널 분포까지 조회한다. Compose project 이름을 바꾸면 `ASKLAKE_DOCKER_NETWORK=<project>_default`를 함께 설정한다.

Issue #1050은 이 harness에 다음 두 시간 구간의 고정 fixture와 자동 검증을 추가한다. 상세 profile과 threshold는 `backend/scripts/synthetic-commerce/README.md`의 `Issue #1050 데모 데이터`가 기준이다.

- S3/MinIO: 고정 3,000 사용자 calibration과 250MiB 30일 기준선에서 카테고리별 clicks/carts/purchase_clicks, 날짜별 실제 건수와 전환율, 기존 planted pattern을 함께 검증
- Kafka: 검증된 baseline identity와 명시적 `anchorAt`으로 만든 bounded 5분 raw-text/Kafka JSONL fixture를 고유 topic/group/checkpoint에 one-shot replay하고, 기준선 대비 상승·유사·하락과 Catalog 반영 증거를 검증

현재 harness는 실제 최근 5분 sliding window나 조건부 `purchase_clicks / clicks` Dashboard 집계를 지원하거나 검증하지 않는다. Issue #1050은 격리된 5분 demo run을 선택했으며, 누적 Kafka 결과를 `최근 5분`이라고 판정하지 않는다.

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

Snapshot Rule runtime은 transform-only Job에서 빈 Quality 단계를 별도 Spark action으로 평가하지 않는다. Job runner는 확정 schema projection과 지원되는 row-preserving transform 선두 prefix를 만든 뒤 source file의 exact byte 합계로 실행 경계를 선택한다. file metadata 조회가 하나라도 실패하면 성공한 file의 부분 합계를 버리고 크기 미확인으로 처리한다. `ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES`가 양수이고 source가 그 이하이면 이 DataFrame을 원본 lineage 그대로 `MEMORY_AND_DISK`에 올려 schema count/null, Rule, Quality, sample과 target write에 재사용하며 `materializationMode=direct_source_cache`, `outputFrameCacheMode=direct_source_memory_and_disk`를 남긴다. 기본값 0, 크기 미확인과 한도 초과에서는 run 전용 Parquet를 만들고 새 staged DataFrame으로 후속 단계를 실행하며 `cacheStorageLevel=NONE`, `materializationMode=run_scoped_parquet_staging`, `outputFrameCacheMode=staged_parquet_reuse`를 남긴다. direct cache 준비 실패는 staging으로 묵시 fallback하지 않고 run을 실패시켜 같은 원본을 다시 읽는 동작을 숨기지 않는다. 같은 Spark type의 `String`/`Long`/`Boolean` identity cast·copy·rename과 승인된 row-preserving SQL로만 된 canonical transform 선두 prefix는 실행 경계 전에 적용하고 그 수를 `transform.preMaterializedTransformCount`로 남긴다. 직접 컬럼 복사와 `TRIM(CAST(<input> AS STRING))`으로 제한한 total·row-preserving SQL subset은 rule별 `count()` 없이 typed Column으로 컴파일하고 `transform.rowPreservingSqlExpressionCount`에 그 수를 남긴다. type-changing transform, 임의 SQL expression과 `SELECT`는 기존 validation action 및 오류 처리를 유지한다. legacy Quality rule은 전체 행·규칙별 실패·union 실패 수를 하나의 aggregate action으로 계산한다. `npm run verify:snapshot-rule-conformance`와 `npm run verify:spark-schema-contract`는 rule/필수 컬럼 수가 늘어도 action 수가 증가하지 않는지 확인한다. `npm run verify:snapshot-spark-pipeline`은 실제 JSONL 원본 물리 read가 direct cache와 staging에서 각각 정상 실행 기준 정확히 1회인지, direct path의 staging file이 0인지, staged Parquet가 생성되는지, success·quality failure·schema exception에서 staging이 정리되는지 검증한다. direct cache는 executor/cache block 유실 시 Spark lineage가 원본을 다시 읽을 수 있으므로 strict source isolation이 필요한 실행에는 staging을 사용한다.

실제 dev EKS의 10GB/100GB cache before와 staging after 결과, JVM heap·GC·spill·
cleanup 및 성능 trade-off는 [Spark cache-independent staging EKS
experiment](spark-cache-independent-staging-eks-experiment-2026-07-20.md)에
기록한다. 이 scale receipt는 고유 S3 Parquet output을 사용하며 공유
Iceberg/Catalog를 변경하지 않는다.

하이브리드 실험에서는 `ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES`를 실행마다
명시하고 `source.inputBytes`, `directCacheEligible`,
`directCacheDecisionReason`, `directCacheInitializationStatus`,
`directCacheFallbackCount`, `materializationMode`와 실제
`cacheStorageLevel`을 함께 수집한다. source byte와 executor cache 사용량은 같지
않으므로 10GiB 선택값이나 한 번의 elapsed time을 운영 기본 한도로 확정하지
않는다. 동일 image와 resource shape에서 10GB direct-cache와 100GB staging을
실행하고, 원본 정상 read 1회·행 수·정리 residue·JVM OOM/replacement를 먼저
통과한 결과에만 성능 비교를 적용한다.

실제 AWS S3 경로까지 확인할 때는 개발용 output bucket만 명시하고 아래 opt-in smoke를 실행한다. 이 검증은 3행 fixture를 `asklake-validation/issue-931/<고유 run>/`에 올린 뒤 같은 Spark runtime으로 S3A source read, run 전용 Parquet materialization, 정식 Parquet publish를 수행한다. 원본 물리 read 1회, staging 정리, 정식 Parquet 존재를 확인하고 `finally`에서 해당 run prefix의 현재 객체와 version/delete marker를 모두 삭제해 각각 residue 0을 검증한다. 공유 EKS 설정이나 SparkApplication은 변경하지 않는다.

EKS에서는 runtime package download를 사용하지 않으므로 S3A와 Iceberg 검증 전에 immutable Spark image에 `hadoop-aws`, Iceberg Spark runtime, PostgreSQL JDBC JAR이 bake됐는지 image build gate를 통과해야 한다. 이 계약이 없으면 `S3AFileSystem` 또는 Iceberg extension class 로드 단계에서 데이터 처리 전에 실패한다.

```bash
ASKLAKE_VERIFY_S3_STAGING_LIVE=true \
ASKLAKE_VERIFY_S3_STAGING_BUCKET=<dev-output-bucket> \
AWS_REGION=<dev-region> \
npm run verify:spark-s3-staging
```

canonical Quality의 `evaluatedRowCount - droppedCount - quarantinedCount`가 유효하면 final projection 뒤 `outputRows`도 이 counter를 재사용하고 `quality.outputRowCountSource=canonical_quality_counters`를 기록한다. counter가 없거나 잘못되면 `spark_count_fallback` 전체 count를 유지한다. 두 경로 모두 후속 action은 raw source가 아니라 staged Parquet를 읽으므로 raw source physical full read 1회 예산을 지킨다.

Set `ASKLAKE_SPARK_FULL_COUNT=true` only when a full count is needed; default validation uses bounded reads for speed.

## 7. Create/Run Spark Pipeline Verification

```powershell
cd backend
npm run verify:spark-run
```

This verifier starts from an empty ETL/Catalog metadata state, creates one live job from a MinIO sample, submits a run command, verifies that the command response immediately returns `running`, then polls `GET /api/etl/jobs/{jobId}` until Spark commits an Iceberg snapshot and the job returns to its final state. The create payload includes submitted `transformSteps`, `transformOutputColumns`, `qualityRules`, and the multi-column `partition` value. Catalog success requires the same target/snapshot/fingerprint plus Trino-visible schema and physical data files; the warehouse data files remain Parquet.

The focused writer verifier uses a unique Iceberg table and checks full-replace re-runs and rollback without starting the AskLake API or Airflow. It proves that rollback restores the `$refs` `main` snapshot only when the writer's newly committed snapshot is still current, never rolls back an idempotently reused snapshot, and fails closed on concurrent `main` drift. With an existing current snapshot, it also injects a Quality `Fail Run` and verifies that no Iceberg commit is reported and the current snapshot, snapshot count, and row count are unchanged. It then commits once more and validates that runtime `outputFileCount`, `icebergCommit.dataFileCount`, and exact historical `total-data-files` agree with `$snapshots.summary`:

```bash
cd backend
ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:spark-iceberg-batch
```

Kafka Snapshot writer verifier는 고유 Redpanda topic, Spark cluster, Trino catalog와 Iceberg table을 격리해서 만든다. 첫 실행은 Iceberg/Catalog 성공 후 offset commit 직전에 테스트 전용 실패를 주입하고, retry가 같은 snapshot append를 재사용해 Trino row count와 Catalog materialization을 중복시키지 않는지 확인한다. 마지막 0건 Run은 새 data file 없이 성공해야 한다.

```bash
cd backend
ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-snapshot-iceberg
```

Connector-backed jobs such as REST, PostgreSQL, and MongoDB write bounded sample rows to `ASKLAKE_SPARK_REPORT_DIR` as JSONL before Spark reads them. `start-spark-server.mjs` mounts that same host directory into the submit, master, and worker containers at `ASKLAKE_SPARK_REPORT_CONTAINER_DIR` (`/work/reports` by default). If a Codex worktree or repo path changes, the Spark containers must be recreated with the new report mount before run command verification.

Text structuring runs must also verify `quality.reviewRowAnalysisChecks`, `textStructuring.execution`, `runHistory[].textStructuringExecution`, and Catalog `materializationRuns[].textStructuringExecution`. `one_of_values` columns without a compatible model fail preflight unless the column explicitly sets `fallbackAllowed: true`.

### 7.1 Retired Semantic RAG/OpenSearch Harness

RAG/OpenSearch/embedding worker data plane은 2026-07-20 제품 결정으로 폐기됐다. 전용 workflow, 테스트 fixture, 검증 script와 부분 worker 소스는 현재 검증 대상이 아니며 실행하지 않는다. 기존 migration, 삭제 receipt와 외부 volume/object는 호환·복구 이력으로 보존하고 별도 운영 승인 없이 물리 삭제하지 않는다. 공용 Spark runtime의 speculation 차단 계약은 RAG와 무관하게 `tests/test_runtime_script_contracts.py`에서 계속 검증한다.

## 8. Kafka Continuous Large-Data Soak

Continuous soak는 `ASKLAKE_RUN_KAFKA_CONTINUOUS_SOAK=true`일 때만 실행한다. `ASKLAKE_CONTINUOUS_SOAK_INPUT`을 생략하면 synthetic event를 만들고, 지정하면 `.jsonl` 또는 `.jsonl.gz`를 line streaming으로 읽는다. 전체 Electronics 파일은 CI가 아니라 수동 환경에서 실행하며, `ASKLAKE_CONTINUOUS_SOAK_COUNT`를 생략하면 파일 끝까지 replay한다.

```bash
cd backend
ASKLAKE_RUN_KAFKA_CONTINUOUS_SOAK=true \
ASKLAKE_CONTINUOUS_SOAK_INPUT="$HOME/Downloads/Electronics.jsonl.gz" \
ASKLAKE_CONTINUOUS_SOAK_RATE=1000 \
ASKLAKE_CONTINUOUS_SOAK_BATCH_SIZE=500 \
ASKLAKE_CONTINUOUS_SOAK_FAULT=worker \
npm run verify:kafka-continuous-soak
```

`ASKLAKE_CONTINUOUS_SOAK_FAULT`는 `worker`, `backend`, `kafka`, `minio` 중 하나를 선택한다. Kafka/MinIO fault는 해당 Compose service를 잠시 pause한 뒤 반드시 unpause하고, worker가 실패 상태로 전이되면 checkpoint resume을 수행한다. 결과에는 input/output row와 reconciliation/lag/throughput/recovery/Catalog 지표가 포함된다. `ASKLAKE_CONTINUOUS_SOAK_COMPACT=true`면 모든 입력 reconciliation 뒤 worker를 중지하고 Iceberg-native `rewrite_data_files`를 실행한 다음 Trino snapshot/file 검증 결과를 report의 `compaction`에 포함한다.

`npm run verify:kafka-continuous-contract`는 같은 worker attempt의 실패 카운터 멱등성, 종료 worker의 manifest 기반 Catalog 복구, Iceberg replay 경계, worker/maintenance 양방향 fencing, durable runner heartbeat 기반 lease 갱신과 stale cleanup 1회를 검증한다. E2E는 기본 replay가 현재 schema policy를 다시 적용하는지, `approveUnknownFields` 관리자 예외만 unknown-field 행을 복구하는지, replay snapshot이 Trino 검증 후 Catalog에 반영되는지, rewrite 결과가 같은 Iceberg target으로 Trino 재검증되는지 확인한다. Stream manifest는 deterministic source boundary, Iceberg snapshot/table URI와 topic/partition별 `[startOffset, endOffset)`을 포함해야 한다.

ACK backlog 검증에서는 publication window보다 많은 manifest를 만든 뒤 ACK를 전진시켜도 worker가 전체 이력을 매번 다시 Spark query로 읽지 않고 다음 window만 보충하는지 확인한다. 지연 검증 환경은 `ASKLAKE_CONTINUOUS_SPARK_SHUFFLE_PARTITIONS=4`와 `ASKLAKE_CONTINUOUS_SPARK_LOG_LEVEL=WARN`을 기본으로 사용하고, checkpoint가 과거 shuffle 수를 복원해도 각 `foreachBatch`에서 설정값을 다시 적용하는지 확인하며 `lastBatchDurationMs`와 각 DAG stage duration을 함께 기록한다. Catalog manifest 복구 검증은 `_SUCCESS`와 빈 `part-*`가 먼저 정렬돼도 실제 JSON이 든 part를 찾아 revision을 전진시켜야 한다.

```bash
cd backend
ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-continuous-iceberg
```

이 격리 검증은 정상 append 4행, manifest 전 fault로 commit된 3행의 중복 없는 재사용, checkpoint 재시작 후 신규 2행을 처리해 Trino count `4 -> 7 -> 9`를 확인한다. 마지막 append 중 반복 Trino read는 7 또는 9만 관찰해야 하며 부분 count나 감소를 실패 처리한다. worker 중지 후 Iceberg data-file rewrite와 보존기간 내 snapshot expiration/orphan cleanup을 실행하고, 현재 9행과 최초 4행 snapshot time-travel, checkpoint identity, maintenance history를 재검증한 뒤 생성한 table/container/metadata를 정리한다.

게시 경계 fault 검증은 backend에 `ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE=true`, E2E runner에 `ASKLAKE_CONTINUOUS_E2E_PUBLICATION_FAULT=true`를 설정한다. 첫 worker는 data `_SUCCESS` 뒤 manifest 전에 한 번 실패하고, harness가 resume한 뒤 같은 batch/offset을 중복 저장하지 않고 manifest와 Catalog를 복구해야 한다. 이 변수는 테스트 전용이며 운영에서는 반드시 `false`로 둔다.

### 8.1 Kafka Continuous 대시보드 revision/result 검증

대시보드 리비전은 Spark가 Iceberg data file을 쓴 시점이 아니라 backend가 immutable `manifestPath`의 `_SUCCESS`, 유효한 `[startOffset, endOffset)` 범위, 일치하는 source boundary와 exact Iceberg snapshot/table을 확인하고 Trino 검증과 Catalog materialization을 끝낸 뒤에만 증가해야 한다.

```text
Kafka offset range
↓
batch_id=<id> Parquet + _SUCCESS + manifest
↓
Catalog materializationRuns
↓
dataset_revision_commits(manifest, commit_kind, source fingerprint 포함)
↓
dataset_kafka_partition_cursors(topic/partition next_offset)
↓
dataset_freshness.latest_revision
```

실제 PostgreSQL schema와 transaction 결과는 다음 opt-in verifier로 확인한다.

```powershell
# repository root
docker compose up -d postgres

cd backend
$env:ASKLAKE_VERIFY_DASHBOARD_POSTGRES = "true"
$env:DATABASE_URL = "postgresql+psycopg://asklake:asklake_dev@localhost:54328/asklake"
npm run verify:dashboard-live-postgres
```

스크립트는 실제 PostgreSQL에 임시 Catalog dataset을 만들고 다음을 확인한 뒤 해당 fixture를 삭제한다.

- `dataset_freshness`, `dataset_revision_commits`, `dataset_kafka_partition_cursors`, `dashboard_widget_results` table/index/constraint
- 같은 `run_id`를 두 번 저장해도 revision이 한 번만 증가하고, 다른 metadata로 재사용하면 거절
- 같은 stream offset fingerprint를 다른 `run_id`로 보내도 한 번만 반영하고 부분 겹침은 거절
- 원본 stream watermark와 자체 완료 manifest를 가진 quarantine replay의 offset namespace 분리
- revision과 S3·manifest 위치, row count, topic/partition/[startOffset, endOffset) `source_ranges`와 fingerprint 연결
- widget `result_payload`, `calculation_state`, `applied_revision`, `calculation_mode` 저장·재조회

기존 Continuous 계약과 frontend polling 선택 로직은 별도로 검증한다.

`npm run verify:kafka-continuous-contract`는 `manifestPath`가 없거나 batch identity·기존 run 근거가 다른 non-empty publication이 Catalog와 revision을 올리지 않는지, PostgreSQL partition cursor가 worker 시작에 전달되는지, 축약되거나 이미 ack된 종료 report window를 S3 committed manifest 목록으로 끝까지 복구하는지, 마지막 manifest가 불완전하면 ACK를 멈추는지, replay Catalog 실패 결과와 runtime 카운터가 다음 reconciliation에서 함께 복구되는지도 확인한다. 로컬 replay result가 없을 때 S3 `_SUCCESS` manifest를 `runId`로 복구하는지, 404 외의 접근·파싱·identity 오류를 실패로 유지하는지, 미반영 replay가 남은 start/resume을 `409`로 막는지도 포함한다. Unit test는 전체 중복 offset 무게시, partial overlap suffix, Spark raw batch ID와 분리된 durable publication 순번, exact snapshot Run 행 수, replay manifest 실패 rollback을 확인한다. 실제 E2E에서는 manifest `_SUCCESS`, exact Iceberg commit/Trino 검증과 replay 최대 1,000행 batch 경계를 함께 본다. 위젯은 최초에 Catalog `icebergSnapshotId`로 고정한 전체 기준값을 만들고, 이후 전체 누적 `count`/`sum`/`avg`/`ratio`만 `_asklake_run_id`로 revision 한 개씩 증분 합산한다. backfill/legacy/non-delta, `min`/`max`, table 집계는 전체 재계산하며 최근 N분·슬라이딩 시간창은 이번 범위에서 검증하거나 지원하지 않는다.

```powershell
cd backend
npm run verify:kafka-continuous-contract

cd ..\frontend
npm run test:dashboard-widget-data-state
```

실제 Kafka/MinIO/Spark/Catalog 경로는 기존 opt-in `npm run verify:kafka-continuous-e2e`를 사용한다. 이 검증은 published metric 생성, 최초 결과 저장, 새 revision 뒤 widget result 증가까지 포함한다. production compose에서는 관리자 session을 만들 수 있도록 `ASKLAKE_CONTINUOUS_E2E_EMAIL/PASSWORD` 또는 `ASKLAKE_CONTINUOUS_E2E_SESSION_COOKIE`를 전달한다. 대시보드 viewer는 `/dashboards/{dashboardId}` published route에서만 Continuous dataset을 polling하고, 평소에는 서버 권장주기 `clamp(triggerIntervalSeconds * 500, 1000, 60000)`을 따른다. 여러 revision을 따라잡을 때는 응답이 실제 전진한 경우에만 250ms 뒤 다음 revision을 요청한다.

운영 로그에서는 다음 event를 확인한다.

```text
dashboard_dataset_revision_committed
dashboard_dataset_revision_backfilled
dashboard_widget_result_calculated
dashboard_widget_result_failed
```

실제 화면 지연은 `다음 Spark trigger까지 남은 시간 + Spark/S3 + backend reconciliation 0~1초 + polling 0~nextCheckAfterMs(+ dataset ID 기반 0~10% jitter) + widget 계산`이다. 2~5초 반영을 항상 보장하지 않는다.

### 8.2 Spark Resource Planner 이력 backtest

100GB executor `1/2/4` 실행 결과는
`backend/benchmarks/spark-resource-planner/reference-100gb.v1.json`의 redacted fixture로
정규화한다. 동일 입력 byte, `standard-v1` profile, 결과 정합성과 S3 Gateway Endpoint
활성 조건만 보존하며 실제 AWS 식별자와 output prefix는 저장하지 않는다. 이 fixture는
정책 회귀 테스트용이고 production RDS에 history seed로 적재하지 않는다.

```bash
cd backend
python -m pytest -q tests/test_spark_resource_plan.py
node --test scripts/spark-kubernetes-client.test.mjs
```

backtest는 executor `1`이 30분을 넘고 `2`와 `4`가 통과할 때, 가장 빠른 `4`가 아니라
`executor-seconds`가 작은 `2`를 선택해야 통과한다. 실제 EKS 승격은 이 fixture만으로
완료하지 않으며 같은 immutable image의 10GB·100GB Shadow, 100GB Enforce와 `off/1`
복구를 별도로 증명한다.

## 9. Frontend

```powershell
cd frontend
$env:VITE_API_BASE_URL = "http://localhost:8080"
npm run dev
```

The browser calls backend endpoints for source tests and create flow.

## 10. 통합 E2E·장애 복구 프로필

개별 Kafka E2E/soak 명령은 `backend/scripts/etl-e2e-recovery-scenarios.json`에서 full-stack 복구 시나리오로 묶는다. PR은 Spark 없는 application/ephemeral 계약, release는 fake Spark REST actual process와 Docker UID 185 mount, nightly는 격리 Kafka/Spark/object storage와 headless browser를 실행한다.

```bash
cd backend
npm run verify:etl-e2e-recovery
npm run verify:etl-e2e-recovery:release

# isolated self-hosted stack only
ASKLAKE_E2E_ISOLATED_ENV=true \
ASKLAKE_CONTINUOUS_E2E_BASE_URL=http://127.0.0.1:8080 \
ASKLAKE_E2E_FRONTEND_URL=http://127.0.0.1:5174 \
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python \
npm run verify:etl-e2e-recovery:nightly
```

nightly는 worker/backend/Kafka/MinIO pause·restart와 publication fault를 기존 opt-in script로 주입하고, 각 scenario가 `missingCount=0`, `duplicateCount=0`, monotonic checkpoint/cursor와 idempotent Catalog/Dashboard identity를 증명해야 한다. production URL, static AWS/MinIO credential과 공유 topic/table에는 실행하지 않는다. 상세 결과 형식과 Go/No-Go는 [ETL E2E·복구 하네스 계약](refactor-2026/contracts/etl-e2e-recovery-harness.md)을 따른다.
