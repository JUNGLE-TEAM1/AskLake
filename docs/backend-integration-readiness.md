# AskLake Backend Integration Readiness

이 문서는 AskLake 프론트엔드와 백엔드 연결 상태, 남은 API 범위, 검증 기준을 정리한다. Pair A Source/Schema/Create/Run 흐름은 기본 live API mode에서 backend를 기준으로 검증하고, frontend-only QA에서만 `VITE_USE_MOCK_API=true` fallback을 사용한다.
FastAPI 전환의 공통 구조와 의사결정은 `docs/backend-fastapi-transition-plan.md`를 기준으로 한다.

상세 request/response shape는 `docs/api-contract.md`를 기준으로 한다.

## 1. 현재 연결 상태

| 영역 | 현재 상태 | 남은 범위 |
| --- | --- | --- |
| 수집/처리 목록 | `GET /api/etl/jobs` hydrate. `status` 반복 query, `scheduleKind=daily|weekly|monthly|realtime|none|other`, `owner`, `lastRunOutcome`으로 server-side 목록을 좁히고 status/최근 실행 결과 count와 owner facet을 함께 반환. Job 수정은 상세 response를 edit draft로 복원하고 source를 읽기 전용으로 표시하며, `PATCH /api/etl/jobs/{jobId}`가 같은 Job ID에 허용된 metadata를 저장 | 삭제 API, 서버 pagination/search, 복제 후 새 Job 생성 UX |
| 새 수집/처리 생성 | Source -> Schema -> Rule -> Schedule -> Permission -> Target -> Review -> Create가 `POST /api/etl/jobs`로 연결되고 `etl_jobs`에 저장. 응답의 `catalogTarget`은 pending identity이며 아직 Catalog row를 만들지 않음 | 중간 단계별 서버 저장 API는 후속 범위 |
| Target 저장경로 선택 | `GET /api/s3/buckets`, `GET /api/s3/prefixes`로 S3 bucket/prefix를 서버에서 lazy 조회하고 `target.storagePath` string에 반영. 로컬은 MinIO, EC2 prod compose는 실제 AWS S3와 instance profile IAM Role/default credential chain을 사용 | 서비스별 IAM 분리와 credential rotation 고도화 |
| Target DB 선택 | `GET /api/target/databases`로 허용 DB 목록을 조회하고 `target.databaseName` string에 반영. 테이블명 입력은 노출하지 않고 datasetName을 create payload 호환값으로 사용 | 운영 catalog DB 목록/권한 API |
| Source/Schema | mock/live mode 모두 연결 검증과 대상 선택을 분리한다. `POST /api/etl/sources/assets`가 S3 파일, PostgreSQL 테이블, MongoDB 컬렉션 후보를 반환하고, 사용자가 대상을 선택한 뒤에만 `POST /api/etl/sources/test`가 schema/sampleRows를 만든다. JSON/JSONL은 native token으로 `String`/`Long`/`Double`/`Boolean`/`JSON`을 구분하고 dotted source path와 물리 target alias를 분리한다. File / S3의 `.txt`/`.log` raw sample은 `POST /api/etl/record-parsing/preview`로 공백 구분 규칙과 필드 수를 검증하며, `npm run minio:seed-click-log`가 100줄 fixture를 준비한다 | Kafka Snapshot/Continuous 원시 TXT 구조화, 임의 정규식, 오류 행 quarantine·재처리, 다중 Parquet 파일의 통합 스키마 추론 |
| Rule | versioned canonical `rules[]` compiler, legacy transform/quality adapter, create/update/review 사전 검증, pass-through output schema와 bounded Rule Preview를 제공한다. Snapshot conformance를 통과한 stateless Rule은 Continuous `foreachBatch`와 replay에도 같은 Spark runtime으로 적용한다 | stateful join/aggregation과 engine-specific SQL은 후속 범위 |
| Job command | Kafka Snapshot Job은 fixed range ingest를 실행하고, non-Kafka Job은 Airflow DAG Run을 접수한다. Continuous Kafka Job은 long-running Spark worker를 제어하며, S3A checkpoint contract fingerprint, `_SUCCESS` + Rule/offset manifest, Catalog 복구, partition lag/throughput/schema/Rule report, quarantine replay와 compaction을 제공한다 | pause/cancel의 실제 Airflow/Spark interrupt, production soak, async Airflow maintenance scheduling, compaction retention switch |
| Run/DAG | local Airflow DAG는 일반 batch의 Spark/Catalog 단계를 관리한다. Continuous는 start-to-terminal session과 하위 micro-batch 이력에 Source부터 Catalog까지 7단계 증적을 영속화하고 active 실행 이력 화면을 자동 갱신한다 | Spark log object storage 분리, session history 장기 retention/pagination |
| Catalog | `GET /api/catalog/datasets` hydrate, `GET /api/catalog/datasets/{datasetId}/lineage`, `GET /api/catalog/datasets/{datasetId}/rows` 기반 최신 성공 materialization row pagination, SQL derived/Kafka 결과를 Postgres JSONB payload로 반영. 일반 Airflow/Spark batch의 멱등 reconciliation endpoint, transaction, final-task 연결, frontend terminal-success 1회 refresh, live E2E 구현 | 서버 검색/정렬 API 고도화 |
| SQL 분석 | DuckDB compatibility snapshot과 Trino Query Run을 분리 지원. Trino mode는 canonical `/api/query/validate`, idempotent submit, durable collector, signed-cursor 결과 page, server-side CSV, Iceberg CTAS 등록과 반복 full-refresh SQL Job을 제공한다. 실행 평가와 timeline은 기존 SQL editor를 변경하지 않고 결과 panel의 `실행 정보` view에 표시한다. | Spark/Kafka writer의 native Iceberg 전환, old SQL Job table retention/cleanup policy, org quota 고도화 |
| Dashboard | FastAPI dashboard card/list와 draft/published runtime API 연결. 프론트는 404 local fallback 유지. Dashboard 목록/runtime/title/draft/delete 권한 enforcement 연결 | 공유 링크/API, export API, cross-pair E2E QA |
| Permission/Governance | Create flow의 `owner`, `permissionSummary`, `permissionRoles`는 metadata로 저장/표시. Job/Dataset/Dashboard 응답은 optional identity/grant/permission metadata를 제공. Backend는 session 또는 local header fallback을 `ActorContext`로 읽고 공통 `can()`을 적용한다. Dashboard/Catalog/Job뿐 아니라 Trino Query Run submit/history/result/CSV/cancel/materialization도 현재 Dataset 권한, principal block, resource lock과 submitter identity를 재검사한다. Frontend 비활성화는 UX 보조이고 backend 403이 최종 경계다. | dataset 생성/삭제 전체로 permission check 확대 |
| Auth / Admin | httpOnly `asklake_session` cookie 기반 local login/signup/session/logout, 현재 사용자 profile, admin 사용자·그룹·permission grant·governance control API 연결. Frontend는 session actor 확인 이후 보호 route와 hydrate를 시작하고, admin actor에게만 관리 콘솔을 노출 | 운영 IdP/SSO, production session hardening, Alembic migration |
| Audit | `audit_events` table 기반 admin 조회/필터 UI + auth login/logout/login 실패 + permission grant 변경 + principal/resource control 변경 + Dataset/Job/Dashboard 403 접근 시도 기록 + frontend local 최근 호출 로그 | audit export/retention 정책 |

FastAPI 1차 scaffold의 범위는 서버 실행, CORS, PostgreSQL 연결, 공통 error envelope, `/api/health` 확인이었다.
현재 브랜치는 ETL/Catalog/SQL live endpoint, Dashboard card/runtime, local session auth와 Phase 0 admin endpoint를 함께 포함한다.
FastAPI 공통 schema 기준은 `backend/app/schemas/common.py`에 두며, 각 Pair는 도메인별 schema 파일에서 `CamelModel`, `ErrorResponse`, pagination 관련 schema를 재사용한다.
Demo hydrate endpoint는 live ETL/Catalog API를 가리지 않도록 `/api/demo/etl/jobs`, `/api/demo/catalog/datasets`에 둔다.
Amazon review Kafka replay/ingest 병렬 개발은 `backend/fixtures/kafka/amazon-review-fixture.jsonl` 100건 mock fixture와 `npm run kafka:reviews-fixture`로 `reviews.raw` topic에 표준 JSON fixture를 넣어 시작한다. fixture를 다시 만들 때는 `npm run kafka:reviews-fixture:generate -- --count 100`을 사용한다. 실제 Amazon review JSONL/JSONL.gz 파일은 `npm run kafka:reviews-replay -- --input <path> --limit 100 --rate 100`으로 같은 메시지 계약에 맞춰 replay한다. `npm run kafka:reviews-loop -- --rate 2 --max-messages 500`는 cycle별 고유 event ID와 증가 offset을 갖는 Continuous 검증용 입력을 만든다. topic 재생성은 `--recreate-topic`을 명시한 경우에만 수행한다. 배포 환경은 `GET|POST|DELETE /api/etl/kafka/replay-producer`로 한 개의 producer subprocess를 관리하며, 대용량 파일은 `ASKLAKE_REPLAY_INPUT_DIR` mount 아래 상대 `inputPath`로만 지정한다. 이 스크립트는 Kafka 입력 계약 검증과 replay를 담당하며, Lake 적재 로직은 별도 ingest 작업 범위다.
Kafka Source Preview와 Snapshot bridge는 공통 KafkaJS Snappy codec을 등록한다. Source Preview는 최소 샘플/idle/settle bound로 실제 payload를 반환하고 consumer decode/run 오류를 metadata-only 성공으로 바꾸지 않는다. `GET /api/etl/sources/defaults`는 backend의 Kafka runtime 기본값을 frontend에 제공한다. `ASKLAKE_VERIFY_KAFKA=true npm run verify:fastapi-sources`는 3건의 임시 Snappy 토픽을 생성해 `event_id` schema/sample까지 검증한다.

Rule/target 변경의 빠른 검증은 `npm run verify:dataset-identity`, `npm run verify:rule-compiler`, `npm run verify:rule-preview`, `npm run verify:snapshot-spark-pipeline`, `npm run verify:kafka-target-projection`, `npm run verify:target-mode-contract` 순서로 실행한다. `verify:dataset-identity`는 서로 다른 한글/slug-collision target의 Job·dataset ID 분리와 정확히 같은 target의 append 재사용을 격리 SQLite metadata DB에서 확인한다. Kafka Snapshot Job bridge는 확정 schema와 compiler output schema를 전달하고 direct JSONL/Catalog metadata를 동일 projection으로 생성한다. `npm run verify:kafka-review-scheduled-ingest`는 실제 Job create/command, 물리 S3 JSONL, Catalog schema까지 이 계약을 end-to-end로 검증한다.

## 2. Pair A Live Contract

Pair A 생성 요청은 nested `draftPipeline`을 submit 직전에 flat `CreatePipelineRequest`로 변환한다.

Frontend baseline은 `VITE_USE_MOCK_API`가 미설정이면 live mode로 동작한다. frontend-only mock QA가 필요할 때는 `VITE_USE_MOCK_API=true`를 명시하며, 이때 `frontend/src/services/sourceConnectorService.ts`는 backend 호출 없이 source type별 mock `SourceConnectorAnalysis`를 반환한다.

필수 create payload:

- Source: `sourceType`, `sourceLabel`, `sourceConfig`
- Schema: `schemaColumns`, `schemaSampleRows`, `schemaSummary`, `schemaFingerprint`
- Rule: `ruleContractVersion`, canonical `rules`, compiler `transformOutputColumns`
- Snapshot runtime: canonical Rule 재compile, Spark/Kafka 공통 disposition, write 전 Fail Batch, physical quarantine evidence
- Legacy execution compatibility: `transformSteps`, `qualityRules`, `qualityScore`, `qualityStatus`, `qualityInvalidRows`
- Schedule/Permission/Target: `scheduleLabel`, `scheduleSummary`, `startDate`, optional `endDate`, `nextRunUtc`, `overlapPolicy`, `timezone`, `watermarkPolicy`, `retryPolicy`, `retryPolicySummary`, `runLimitSummary`, `owner`, `permissionSummary`, `targetDataset`, optional `targetDatabase`, `targetDescription`, `targetTags`, `targetLayer`, `targetFormat`, `storageType`, `storagePath`, `partition`, `partitionColumns`, `indexColumns`, `compression`

Schema type은 새 payload에서 `String`, `Integer`, `Long`, `Double`, `Boolean`, `Timestamp`, `Date`, `JSON`을 사용한다. 기존 `Float`는 읽기 호환하며 새 draft에서는 `Double`로 canonicalize한다. `sourceName`은 dotted source path를 그대로 유지하고 `targetName`만 물리 alias로 정규화한다. 사용자가 target 타입을 바꾸면 optional `sourceType`이 원본 타입을 보존하며, 기존 payload는 `sourceType`이 없을 때 `type`으로 fallback한다.

Schedule UI는 `직접 실행`, `반복 실행`을 사용하며 `직접 실행`을 payload의 `스케줄링 건너뛰기`로 저장한다. 즉시 실행은 스케줄 생성 옵션이 아니라 기존 Job command API의 `run` action으로 분리한다. 반복 실행을 선택한 때만 반복 주기, 실행 시각, IANA `timezone`, 겹침 처리를 노출하고, 재시도 설정은 사용 여부에 따라 상세 필드를 표시한다. `startDate`, 빈 값이면 종료일 없음으로 처리하는 `endDate`, watermark 수집 기준, 2배 지수 백오프 재시도 정책은 생성 payload와 Job hydrate 응답에 보존한다. 기본 겹침 처리는 `skip_if_running`이다. 현재 배치 Run 취소는 `cancelRun`으로 분리한다. 반복 예약 일시중지는 스케줄 설정을 보존하는 `stopSchedule`, 복원은 `resumeSchedule`을 사용한다. 실행 중인 실시간 Job의 `stopSchedule`은 UI에서 `수집 중지`로 표시하고 현재 Run을 `canceled`로 종료한다. 실시간 Job의 `수집 시작`은 `run` 또는 실패 후 `retry`로 실제 새 Run을 시작한다.

Target metadata는 Review에서 보이는 값과 create payload, Spark run 성공 후 Catalog dataset metadata가 같은 값을 사용해야 한다. `partition`은 기존 호환 문자열로 유지하고, 실제 선택 컬럼 목록은 `partitionColumns`에 보존한다.

Backend create response:

```ts
type CreateJobResponse = {
  job: JobRowData;
  catalogTarget: {
    id: string;
    name: string;
    layer: string;
    status: "pending_run";
  };
};
```

Job append identity는 저장된 `targetDataset` 표시명의 정확한 일치를 기준으로 판정한다. 새 dataset의 내부 ID는 안전한 소문자 ASCII 이름에는 `ds_<name>`을 유지하고, 한글·공백·특수문자·대소문자 변환처럼 ASCII slug에서 정보가 손실되면 원문 기반 12자리 안정 해시 suffix를 붙인다. 자동 storage prefix/checkpoint도 같은 충돌 방지 key를 사용한다. 서로 다른 표시명이 같은 slug로 축약돼도 기존 Job이나 자동 저장 경로를 공유하지 않아야 하며, frontend는 create/polling 응답을 `job.id` 기준으로 upsert해 동일 ID를 여러 목록 행으로 보존하지 않는다.

Backend command response:

```ts
type JobCommandResponse = {
  action: string;
  apiPath: string;
  job: JobRowData;
  run?: JobRunSummary;
  dagSteps?: JobDagStep[];
};
```

Backend update response:

```ts
type UpdatePipelineResponse = JobRowData;
```

수정 API는 source config를 받지 않으며 `manage` 권한을 확인한다. 실행 중인 Job과 성공 Run 이후의 target identity 변경을 차단하고, Kafka offset/snapshot state를 변경하지 않는다.

## 3. Metadata Persistence

Local backend metadata source of truth는 `DATABASE_URL`이 가리키는 Postgres다. 기본값은 `docker-compose.yml`의 `postgres://asklake:asklake_dev@127.0.0.1:54328/asklake`이다.

현재 backend는 API response shape를 유지하기 위해 아래 테이블에 JSONB payload를 저장한다.

- `etl_jobs(id, payload, created_at, updated_at)`
- `catalog_datasets(id, payload, created_at, updated_at)`
- `sql_runs(id, dataset_id, query, payload, created_at)`

`npm run verify`와 `npm run verify:spark-run`은 격리된 검증을 위해 spawned backend에 `ASKLAKE_RESET_METADATA_ON_START=true`를 주고 ETL/Catalog/SQL metadata를 비운 뒤 시작한다. 일반 `npm run dev`는 이 값을 주지 않으므로 생성한 Job과 Dataset이 서버 재시작 후에도 유지된다.

현재 demo에서는 Spark 재실행을 위해 job payload에 `sourceConfig`를 함께 저장한다. 실제 credential 저장 정책은 아직 별도 secret manager로 분리되지 않았으므로, 운영 전에는 credential redaction/secret reference 모델을 확정해야 한다.

## 4. Source Credential Handling

Backend connector 응답은 secret field를 redacted value로 내려준다. 프론트는 응답 metadata, schema, sampleRows는 반영하되 브라우저 세션에 사용자가 입력한 credential 값은 다음 connector 호출을 위해 유지해야 한다.

적용 기준:

- 첫 연결 테스트 성공 후 Schema 단계의 다시 확인이 credential 없이 실패하면 안 된다.
- 샘플 범위 변경 재호출도 같은 credential을 유지해야 한다.
- PR 본문, 로그, 문서에는 실제 credential 값을 쓰지 않는다.

## 5. Airflow-Orchestrated Run Path

`POST /api/etl/jobs/{jobId}/commands`는 run/retry 요청을 Airflow DAG Run으로 제출하고, `queued` 또는 `running` 상태의 run을 즉시 저장/응답한다. 프론트는 명령 응답을 먼저 Run History와 DAG modal에 반영하고, active run이 있는 동안 `GET /api/etl/jobs/{jobId}`를 polling해 Airflow DAG Run 및 Task Instance 상태를 동기화한다. Terminal 상태(`success`, `failed`, `canceled`)가 되면 polling 대상에서 제외된다.

현재 local `docker-compose.yml`에는 Postgres/MinIO와 함께 Airflow API server, scheduler, DAG processor, Airflow metadata Postgres가 포함되어 있다. `airflow/dags/asklake_etl_job.py`는 독립 smoke mode와 실제 Spark execution mode를 함께 지원한다. Airflow 설정이 없으면 backend는 `AIRFLOW_CONFIG_MISSING` 503 error envelope로 실패한다.

필수 Airflow 환경변수:

- `AIRFLOW_API_BASE_URL`: Airflow public API base URL, 예: `http://127.0.0.1:8081`
- `AIRFLOW_DAG_ID`: stable DAG id, 기본값 `asklake_etl_job`
- `AIRFLOW_UI_BASE_URL`: Airflow UI link 생성용 optional base URL
- `AIRFLOW_API_TOKEN` 또는 `AIRFLOW_USERNAME`/`AIRFLOW_PASSWORD`: Airflow API 인증
- `AIRFLOW_REQUEST_TIMEOUT_SECONDS`: API timeout, 기본값 `10`
- `AIRFLOW_EXECUTION_API_TOKEN`: Airflow task가 FastAPI internal Spark endpoint를 호출할 때 사용하는 shared bearer token. Airflow/FastAPI 양쪽 값이 같아야 한다.
- `AIRFLOW_INTERNAL_BASE_URL`, `AIRFLOW_INTERNAL_TOKEN`, `AIRFLOW_INTERNAL_TIMEOUT_SECONDS`: 기존 단일 호출 internal endpoint 호환 설정. 신규 DAG는 execution bearer endpoint를 우선 사용한다.

일반 배치 `run`/`retry`는 `executionMode=spark`로 DAG를 시작한다. `spark_process_write`가 FastAPI internal endpoint를 호출하면 FastAPI가 persisted Job/Run/Airflow identity를 확인하고 PySpark runner를 실행한다. Airflow에는 Docker socket과 MinIO credential을 직접 제공하지 않는다. Spark 실행 provider는 공통 Runtime 계약의 `batch`, `sourceInspect`, `continuous`, `maintenance` operation으로 분리되며 로컬 `docker`와 production `spark-rest`가 같은 선택기를 사용한다. Production backend도 Docker socket/CLI 없이 Spark Standalone REST create/status/kill API를 사용하며, `APP_ENV=production`에서 Docker Runtime 설정은 configuration error로 차단한다. `executionMode=smoke`는 backend 없이 DAG 성공/강제 실패만 검증할 때 사용한다.
`publish_run_result`는 성공 Spark manifest와 실제 Parquet를 검증한 뒤 Catalog dataset/materialization을 transaction으로 저장한다. Airflow terminal state만 성공이고 같은 `runId`의 Catalog evidence 또는 기존 persisted Spark result가 없으면 backend가 Run을 실패로 보정한다.

Spark runner 입력:

- File / S3, Data Lake: object path를 Spark source로 직접 사용
- CSV source와 source inspect: Spark reader에 `quote="`, `escape="`를 명시해 quoted comma와 doubled quote를 RFC 4180 field로 보존
- Target S3 picker: `S3_ALLOWED_BUCKETS` allowlist 안의 bucket만 선택 가능하며 prefix 조회는 backend AWS SDK v3 `ListObjectsV2`에서 처리한다. 프론트에는 AWS credential을 넣지 않는다.
- Object storage mode: local root Compose는 MinIO endpoint/static local credential/path-style을 사용한다. EC2 prod Compose는 실제 AWS S3만 사용하고 MinIO service나 static AWS key를 포함하지 않는다. Backend/Spark/DuckDB/Trino result storage가 EC2 instance profile IAM Role/default credential chain을 공유한다. 일반 ETL `spark_job_run.py`를 포함한 Spark entrypoint는 공통 provider-aware S3A builder를 사용한다. AWS Spark REST 실행은 MinIO credential resolution을 호출하지 않으며, MinIO REST 실행에서만 worker가 상속한 application credential 일치를 검증한다. `TRINO_ENABLED=false`에서는 Raw/Output readiness만 필요하고, `true`에서는 사전 생성한 Warehouse와 Query Result bucket의 read/write/delete readiness도 통과해야 backend와 Trino worker가 시작된다. Production frontend Target 기본값은 `ASKLAKE_SPARK_OUTPUT_BUCKET`에서 주입하며, 저장된 legacy `s3a://asklake-output/...` 경로는 실행과 Catalog 확정 시 현재 Output bucket으로 정규화하되 명시적인 custom bucket은 보존한다.
- Target DB picker: `TARGET_DATABASES` 또는 `ASKLAKE_TARGET_DATABASES` allowlist를 서버에서 읽어 허용 DB만 내려준다.
- PostgreSQL Snapshot connector: Preview scope와 무관하게 선택 base table 전체를 repeatable-read cursor로 배치 export한 Run 전용 JSONL을 Spark source로 사용. `ASKLAKE_POSTGRES_EXECUTION_BATCH_ROWS`는 메모리 batch 크기이며 전체 행 상한이 아니다.
- REST/MongoDB 등 나머지 connector source: bounded schema sample rows를 JSONL로 기록한 뒤 Spark source로 사용
- connector sample JSONL은 `ASKLAKE_SPARK_REPORT_DIR`에 쓰고 Spark submit/master/worker 모두 `ASKLAKE_SPARK_REPORT_CONTAINER_DIR` 기본값 `/work/reports`로 같은 host directory를 mount해야 한다. worktree가 바뀌면 Spark container는 mount source가 달라지므로 자동 재생성되어야 한다.
- `ASKLAKE_SPARK_TRANSFORM_STEPS`: create payload의 transform steps
- `ASKLAKE_SPARK_QUALITY_RULES`: create payload의 quality rules
- `ASKLAKE_SPARK_PARTITION_COLUMNS`: Target에서 선택한 다중 파티션 컬럼을 `/` 구분 문자열로 전달하며 Spark writer가 순서대로 `partitionBy`에 적용
- `ASKLAKE_SPARK_RUNTIME`: canonical 실행 provider. 로컬은 `docker`, production은 `spark-rest`; 기존 `ASKLAKE_SPARK_RUNNER=docker|rest`는 호환 alias

Spark runner 결과:

- Text structuring `one_of_values` execution must record whether each column used `selected_model`, `auto_model`, `fallback_rule`, or `missing_model`. Model artifacts stay in the model registry (`/api/catalog/models`), while transformed rows stay as Catalog datasets/materialization runs.

- transformed Parquet output
- 선택된 컬럼이 있을 때 다중 partition directory를 포함한 Parquet output
- output schema
- input/output row count
- quality summary
- run status
- DAG step status

Airflow sync 결과:

- `JobRunSummary.airflowDagId`, `airflowDagRunId`, `airflowRunUrl`, `airflowState`
- `JobRunSummary.taskStates`, `lastSyncedAt`, `syncError`
- `JobRunSummary.taskStates.sparkResult`: input/output rows, outputPath, schema, quality, Spark failure stage/error manifest
- selected run 기준 `dagStepsByRunId`

### Phase 3 Catalog reconciliation target

Status: contract, FastAPI backend implementation, real-mode Airflow DAG call, frontend terminal-success Catalog refresh, and live end-to-end verification are complete on the current branch.

Phase 3에서는 `publish_run_result`가 `POST /api/internal/airflow/spark-runs/{runId}/catalog`를 호출한다. FastAPI는 bearer token과 저장된 Job/Run/Airflow identity를 다시 검증하고 `taskStates.sparkResult`에서만 실행 결과를 읽는다. 성공 Spark manifest와 실제 Parquet가 모두 확인된 경우에만 Catalog dataset을 create/upsert한다.

Transaction boundary:

- target dataset id는 `job.dataset_id`를 사용한다.
- 같은 `runId`의 `materializationRuns` 항목은 append가 아니라 replace되어 하나만 남는다.
- 서로 다른 성공 Run은 같은 dataset row의 history에 누적한다. 일반 full-refresh Run은 snapshot, Kafka 추가분은 delta로 기록하고 rows/bytes/latest/sourceRunId는 최신 snapshot과 그 이후 delta만 기준으로 다시 계산한다.
- target dataset row를 lock한 상태에서 payload를 read-modify-write한다.
- first create race는 dataset id/name unique constraint로 한 row만 허용하고 충돌한 요청이 그 row를 다시 읽어 run-keyed update를 적용한다.
- Catalog payload와 성공 `taskStates.catalogResult`를 같은 transaction으로 commit한다.
- physical output 또는 Catalog 저장 실패 시 partial Catalog write를 rollback한다.

Failure/recovery boundary:

- Spark failure는 `spark_process_write`에서 DAG를 실패시키며 Catalog endpoint를 호출하지 않는다.
- Catalog 실패는 성공 Parquet와 `sparkResult`를 남긴 채 `publish_run_result`를 실패시킨다. 실패 `catalogResult`에는 `runId`, `datasetId`, compact error, failed timestamp를 남긴다.
- `publish_run_result`는 30초 간격으로 최대 2회 재시도하며, 같은 Airflow DAG Run의 persisted manifest로 Catalog만 최대 3회 시도하고 Spark를 다시 실행하지 않는다.
- commit 뒤 response가 유실돼도 retry는 기존 성공 `catalogResult`를 읽어 같은 success를 반환한다.
- Catalog commit 전에는 Airflow DAG Run과 AskLake Run을 최종 `success`로 간주하지 않는다.
- polling sync는 Airflow 응답 뒤 Run row를 refresh/lock하고 task snapshot을 저장해 동시 commit된 Spark/Catalog evidence 유실을 막는다.
- terminal success를 처음 본 frontend poller는 `GET /api/catalog/datasets`를 재조회한다.

Phase 3 acceptance checks:

- real Spark success 뒤 dataset row 1개, materialization 1개, exact outputPath, Parquet format, positive byte size, manifest schema/quality, 3-node lineage
- 같은 reconciliation 2회 호출 뒤 같은 `runId` history 1개
- 두 번째 성공 Run 뒤 dataset row 1개와 서로 다른 history 2개
- Spark failure 뒤 Catalog 무변경
- injected Catalog failure 뒤 physical output 유지, `publish_run_result`/AskLake failure, partial Catalog 무변경
- failed final task retry 뒤 Spark output 추가 생성 없이 Catalog success
- browser에서 전체 새로고침 없이 Catalog 목록/lineage 확인

## 6. 검증 명령

Backend:

```powershell
cd backend
npm run verify
npm run verify:airflow-catalog-wiring
npm run verify:airflow-smoke
npm run verify:airflow-spark
PYTHONPATH=. .venv/bin/python scripts/verify-airflow-catalog-reconciliation.py
npm run verify:fastapi-pair2
npm run verify:permission-dataset
npm run verify:permission-job-dashboard
npm run verify:fastapi-etl-catalog
npm run verify:rule-compiler
npm run verify:trino-query-foundation
npm run verify:query-engine-registration
npm run verify:trino-query-history
npm run verify:trino-result-storage
npm run verify:trino-collector-resilience
npm run verify:trino-submission-guard
npm run verify:kafka-continuous-contract
npm run verify:kafka-continuous-rules
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-hydrate-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-update-contract.py
npm run verify:sources
npm run verify:spark-run
npm run verify:record-parsing
npm run verify:record-parsing:e2e
```

FastAPI Pair2 smoke:

- `npm run verify:fastapi-pair2`는 `orders_clean` demo dataset을 seed한 뒤 별도 포트에서 FastAPI를 띄운다.
- Catalog 목록/상세/lineage, legacy DuckDB compatibility snapshot, SQL read-only guard, derived dataset 생성/재조회/lineage를 한 번에 확인한다. Trino 전용 lifecycle은 `verify:trino-query-foundation`, `verify:query-engine-registration`, `verify:trino-result-storage`, `verify:trino-collector-resilience`, `verify:trino-submission-guard`가 분리 검증한다.
- 기본 포트는 `18084`이며 `ASKLAKE_FASTAPI_SMOKE_PORT`로 바꿀 수 있다.
- 이미 실행 중인 FastAPI를 대상으로 볼 때는 `ASKLAKE_FASTAPI_SMOKE_START_SERVER=false`와 `ASKLAKE_FASTAPI_SMOKE_BASE_URL`을 지정한다.
- `npm run verify:permission-dataset`는 권한 없는 viewer의 dataset 목록/상세/legacy DuckDB 실행 차단, user grant에 따른 view/query 허용, group grant에 따른 detail 허용, `delete` grant의 materialization-run 삭제 허용을 검증한다. Trino Query Run에도 같은 `query` enforcement를 적용한다. 기본 포트는 `18087`이며 `ASKLAKE_PERMISSION_DATASET_PORT`로 바꿀 수 있다.
- `npm run verify:trino-query-history`는 현재 user ID/name filter가 다른 사용자의 run을 반환하지 않는지 확인한다. `verify:trino-submission-guard`는 actor별 idempotency와 concurrent slot reservation을 실제 PostgreSQL session 경합으로 검증한다.
- `npm run verify:trino-production-readiness`는 `TRINO_ENABLED=true` production 배포에서 TLS/auth, query identity의 read-only 정책, materializer CTAS/`DESCRIBE`/drop, AWS S3 Warehouse/Query Result bucket round trip을 instance profile로 확인한다.
- `npm run verify:permission-job-dashboard`는 권한 없는 viewer의 Job command, Dashboard 목록/runtime/title/draft/delete 차단과 user grant 변경 후 즉시 허용되는 흐름을 검증한다. 기본 포트는 `18088`이며 `ASKLAKE_PERMISSION_JOB_DASHBOARD_PORT`로 바꿀 수 있다.
- `npm run verify:airflow-smoke`는 실행 중인 Airflow API에서 `asklake_etl_job` 발견, import error 0건, smoke 성공 Run의 4개 task 성공, `forceFail` Run의 `spark_process_write` 실패를 확인한다. 기본 API는 `http://127.0.0.1:8081`이며 `AIRFLOW_*`와 `ASKLAKE_AIRFLOW_SMOKE_*` 환경변수로 바꿀 수 있다.
- `npm run verify:airflow-catalog-wiring`은 Airflow runtime 없이 실제 mode의 Catalog endpoint 경로, bearer token, `jobId` body, 최소 XCom 결과, smoke 우회, Run identity mismatch, Catalog HTTP 실패 전파를 확인한다.
- `npm run verify:airflow-spark`는 ETL Job 생성, Airflow 비동기 접수, authenticated FastAPI internal execution, 실제 PySpark 2행 처리, MinIO Parquet object, terminal Run/task/Spark manifest 동기화를 확인한다. `ASKLAKE_FASTAPI_ETL_EXPECT_SPARK_FAILURE=true`를 주면 Quality `Fail Run`의 Spark/Airflow/AskLake 실패 전파를 검사한다.
- `npm run verify:fastapi-etl-catalog`는 같은 script의 기존 호환 이름이다. Airflow URL이 없으면 내장 mock 계약을 확인하고, 실제 Airflow URL을 사용하면 Spark 성공 뒤 `catalogResult`, Catalog dataset, materialization, physical size, lineage까지 검사한다.
- `npm run verify:etl-lineage`는 text source 하나가 `text`, `sentiment`, `severity`로 파생되는 경우 source node가 `text`만 갖고 one-to-many transform edge를 만들며 `_asklake_*` metadata에 가짜 source edge를 만들지 않는지 확인한다. 또한 Parquet source를 `SOURCE · PARQUET`, Spark Job을 `PROCESS · SPARK`, 현재 Spark physical output을 요청 포맷과 무관하게 실제 `PARQUET` engine으로 표시하는지 검증한다.
- `npm run verify:rule-compiler`는 공통 JSON fixture로 Python FastAPI와 local Node backend의 version/policy/parameter 판정을 비교하고, canonical Rule 생성·수정·조회 영속성 및 legacy fallback까지 확인한다. 프론트는 `cd frontend && npm run verify:rule-compiler`로 같은 fixture와 falsy/null parameter 왕복을 검증한다.
- `npm run verify:kafka-continuous-contract`는 Continuous config/runtime, Rule payload/fingerprint, Catalog 근거와 checkpoint 불변 정책을 프로젝트 가상환경에서 검증한다. `npm run verify:kafka-continuous-rules`는 Docker Spark 4에서 Transform/Quality, Rule quarantine, replay 재검증, final projection과 checkpoint fingerprint mismatch를 실행한다.
- `npm run verify:spark-runtime-contract`는 canonical/legacy Runtime 선택, production Docker 차단, capability, 배치·source inspection·Continuous·maintenance dispatcher 연결을 확인한다. `npm run verify:spark-rest-client`, `npm run verify:kafka-continuous-rest`, `npm run verify:production-spark-contract`는 REST lifecycle, zero-Docker backend, Compose 경계를 이어서 검증한다.
- `PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-hydrate-contract.py`는 저장된 Kafka source/schema/rule/permission/target metadata가 `JobRowData` hydrate 응답에서 손실되지 않는지, explicit canonical empty가 legacy Rule을 되살리지 않는지 확인한다.
- `PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-update-contract.py`는 실제 DB session에서 canonical Rule 저장을 확인하고 source config 보존, 성공 Run 뒤 target identity 변경 `422`, 실행 중 update `409`를 검증한다.
- `npm run verify:record-parsing`은 공백 구분 규칙의 10필드 추론, 타입 추론, 사용자 컬럼명 반영, 필드 개수가 다른 행의 line/count 오류 계약을 FastAPI service 수준에서 확인한다.
- `npm run verify:record-parsing:e2e`는 `s3://m3-raw/asklake-fixtures/txt/click-events-whitespace-100.log`를 실제 Source API로 읽고 Preview 100/100, Job 계약 저장, Airflow/Spark input/output 100행, MinIO Parquet, Catalog의 10개 사용자 컬럼을 확인한다. 실행 중인 FastAPI/Airflow와 올바른 `ASKLAKE_DOCKER_NETWORK`가 필요하다.

Frontend:

```powershell
cd frontend
npm run build
```

Browser smoke:

- backend server를 켠다.
- frontend dev server를 켠다.
- 수집/처리 목록이 처음에는 비어 있는지 확인한다.
- 새 수집/처리 생성에서 Source 연결, Schema 확인, Rule 적용, Review, Create를 진행한다.
- Airflow API가 연결된 상태에서 생성된 Job을 실행한다.
- Run History에 새 run이 즉시 보이고, 선택 Run 실행 흐름이 Airflow DAG Run/Task Instance 상태를 반영하는지 확인한다.
- Airflow terminal 상태 도달 후 polling이 멈추는지 확인한다.

Live Airflow verification through 2026-07-11:

- Airflow metadata database, scheduler, DAG processor health: pass
- `asklake_etl_job` discovery and DAG import error 0건: pass
- `npm run verify:airflow-smoke`: pass, success and forced-failure DAG Runs verified
- live `npm run verify:fastapi-etl-catalog`: pass, queued submit through terminal success and four task states verified
- `npm run verify:airflow-spark`: pass, real PySpark input/output 2 rows and MinIO Parquet verified
- expected Spark Quality failure: pass, `sparkResult`, Airflow DAG Run, AskLake Run/Job all failed
- invalid internal execution token: pass, `401 AIRFLOW_EXECUTION_UNAUTHORIZED`
- FastAPI Catalog reconciliation contract: pass in local PostgreSQL with cleaned unique fixtures, including idempotent same-Run retry, second Snapshot Run replacement, missing output, transaction rollback, stale polling concurrency, and preserved failure evidence
- Python S3 physical inspection against `s3a://asklake-output/customer_review_gold/gold/run_d783b7d326e1`: pass, Parquet 1 object / 3,882 bytes
- Airflow `publish_run_result` -> Catalog endpoint: pass, real Spark/MinIO output published with matching Run id/path, positive bytes, one materialization, and 3-node lineage
- concurrent polling evidence preservation: pass, stale session could not erase committed `sparkResult`
- frontend terminal-success Catalog refresh: 기존 polling/hydrate 경로 pass. Snapshot 재실행의 현재 행 수는 `verify:materialization-projection`과 갱신된 Catalog reconciliation fixture에서 최신 snapshot 기준으로 검증한다.

## 7. 완료 기준

- ETL/Catalog 초기 목록은 서버가 비어 있으면 빈 상태로 표시된다.
- Source/Schema/Create/Run 흐름에서 seed나 fixture job을 사용자 화면에 표시하지 않는다.
- Source credential은 connector 응답의 redacted config로 덮어쓰이지 않는다.
- Transform/Quality는 summary 문자열만이 아니라 실행 가능한 payload로 create request에 들어간다.
- 일반 Spark Snapshot과 Kafka Snapshot은 같은 canonical fixture 결과를 만들고, `Fail Batch`는 target publication 또는 Kafka offset commit 전에 중단된다.
- Airflow run 후 선택 Run 실행 흐름은 Airflow DAG Run 접수와 Task Instance 상태를 selected run 기준으로 표시한다.
- 실패 상태는 실제 실패 단계와 원인을 표시하고, 고정된 fake failed flow를 보여주지 않는다.

## 8. Catalog/SQL 연결 범위

### Catalog

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| 목록 | live mode에서는 `GET /api/catalog/datasets`, mock mode에서는 fixture 표시 | `GET /api/catalog/datasets` |
| 검색/태그/필터 | 프론트 이벤트 로그 중심 | `GET /api/catalog/datasets?q=&tag=&layer=` |
| 상세 | selectedDataset 표시 | `GET /api/catalog/datasets/{datasetId}` |
| 스키마 | dataset.schema 표시 | 상세 포함 또는 `/schema` |
| 샘플 row | 최신 성공 materialization의 실제 row를 총행 수/현재 범위와 함께 page로 표시. 스키마 상세 modal에서도 같은 viewer 사용 | `GET /api/catalog/datasets/{datasetId}/rows?offset=&limit=` |
| 리니지 | `LineageGraph` contract를 React Flow로 렌더링, 없으면 upstream fallback | `GET /api/catalog/datasets/{datasetId}/lineage` |
| SQL로 열기 | SQL 화면 이동 | 없음, datasetId 유지 |

### SQL 분석

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| SQL 점검 | frontend parser는 빠른 오타/식별자 안내를 담당하고, Trino Dataset은 debounced `POST /api/query/validate` 성공 전 실행을 비활성화한다. Trino 확장 문법은 backend parser/compiler가 최종 판정한다. | `POST /api/query/validate` |
| SQL 실행 | `TRINO_ENABLED=true`이면 idempotent full Query Run을 접수하고 durable collector 상태를 polling한다. `false`/mock만 DuckDB compatibility result를 사용한다. | `POST /api/query/runs`, `GET /api/query/runs/{runId}` |
| 실행 정보 | SQL editor는 기존 높이와 단일 scroll을 유지한다. 평가와 `쿼리 실행`, `첫 결과 준비`, `전체 결과 수집` timeline을 결과 panel의 세 번째 view에서 표시한다. 실제 분자/분모가 없으면 progress를 만들지 않는다. | `POST /api/query/estimates`, Query Run response |
| Query AI 생성 | 선택 테이블 context와 자연어 prompt로 SQL 초안을 요청한다. frontend는 체크된 모든 dataset metadata를 전달하며, live mode에서는 FastAPI가 backend env의 OpenAI key로 제안 생성, 선택 reference JOIN 누락 시 프론트 로컬 JOIN SQL fallback 사용 | `POST /api/query/ai-suggestions` |
| Base Dataset 변경 | SQL 화면 내부 base dataset 상태를 바꾸고 query/result를 해당 dataset 기준으로 reset | 없음, `datasetId` 유지 또는 SQL context API |
| 참조 테이블 | SQL 화면 내부에서 여러 참조 dataset id를 선택하고 editor context에 표시 | `POST /api/query/runs` payload에 `baseDatasetId`, `referenceDatasetIds`, `query` 포함 |
| 테이블 검색/자동완성 | 검색 사이드바는 접근 가능한 mock dataset을 보여주고, editor autocomplete는 base/reference context의 table/column과 SQL keyword만 후보로 표시 | `GET /api/catalog/datasets?q=` 또는 권한 필터링된 SQL context API |
| SQL 저장 | 현재 SQL 화면에서는 제외 | `POST /api/query/saved` |
| 결과 Lake 저장 | DuckDB compatibility는 기존 ETL Job handoff를 유지한다. Trino 결과 화면은 반복 full-refresh SQL Job만 노출하며 1회성 Iceberg CTAS API는 별도 운영 경로로 유지한다. | `POST /api/etl/jobs`, `POST /api/etl/sql-jobs`, `POST /api/catalog/trino-runs/{runId}/materializations` |
| CSV 다운로드 | 완료된 private object page를 backend가 읽어 SQL 재실행 없이 stream한다. | `GET /api/query/runs/{runId}/exports/csv` |
| 대시보드 생성 | 후속 Pair C handoff에서 재연결 | `POST /api/dashboards` |
| 새 Lake Dataset 저장 | compatibility 결과만 Preview row 기반 기존 경로를 유지한다. Trino 결과는 page row를 복사하지 않고 반복 `trino_sql_materialization` Job으로 분리한다. | `POST /api/etl/jobs`, `POST /api/etl/sql-jobs` |

한국어 identifier UX는 frontend에서 먼저 방어한다. Dataset/column 표시명은 한국어와 공백을 허용하되, 기본 쿼리·자동완성·컬럼 삽입·JOIN 초안은 double-quoted identifier를 사용한다. 사용자가 따옴표 없이 한글/공백 table reference를 입력하면 preflight가 실행 전에 감지하고 자동 보정 액션을 제공한다. Backend는 이후에도 selected dataset id context를 기준으로 SQL table scope를 재검증한다.

Mock mode에서는 수집/처리 pipeline 생성 dataset과 backend direct SQL derived dataset이 같은 stored catalog dataset fallback(`asklake.catalogDatasets`)을 사용합니다. 현재 SQL 화면의 처리 Job 생성 UI는 direct dataset write 대신 ETL Review draft를 만들고, Review 생성 이후 pipeline 생성 dataset 경로를 사용합니다. SQL Result source로 생성된 mock dataset은 Preview schema, sample rows, sourceRunId, query summary를 Catalog metadata에 보존합니다. 기존 `asklake.derivedDatasets`는 읽기 호환만 유지합니다. Live API mode에서는 localStorage fallback을 쓰지 않고 backend catalog persistence와 `GET /api/catalog/datasets` hydrate를 source of truth로 둡니다. SQL Result 처리 Job은 생성 직후 Job 목록에 먼저 반영되고, run 성공 후 backend가 반환/저장한 Catalog dataset이 hydrate됩니다.

FastAPI Catalog persistence는 `catalog_datasets.payload`를 canonical dataset 계약으로 사용합니다. Spark run 성공으로 생성된 ETL dataset과 SQL derived dataset은 같은 payload shape로 저장하며, payload가 없는 기존 컬럼 기반 row는 목록/상세 조회에서 payload shape로 변환해 읽기 호환만 유지합니다. 두 생성 경로 모두 `size`는 표시용 저장 크기 문자열로 사용하고, 물리 저장 정보는 `storageLocation`, `storageFormat`, `storageSizeBytes`에 둡니다. ETL dataset은 source -> Spark job -> target 기본 `lineageGraph`를 저장하고, SQL derived dataset은 source dataset lineage를 이어받아 source -> derived column edge를 저장합니다. 같은 Job 또는 같은 `targetDataset` 결과는 새 Catalog row를 만들지 않고 `materializationRuns` history에 idempotent하게 누적합니다. 일반 full-refresh는 `snapshot`, Kafka 추가분은 `delta`로 기록하며 부모 dataset의 `rows`, `size`, `storageSizeBytes`, `lastUpdated`, `sourceRunId`는 최신 성공 snapshot과 그 이후 성공 delta만 기준으로 계산합니다.

SQL 실행 백엔드는 반드시 read-only guard를 둬야 합니다. frontend preflight는 사용성 보조이며 backend가 Trino 제출 전에 AST, selected Dataset mapping, 권한과 governance를 재검증합니다. Query Run은 `baseDatasetId`/`referenceDatasetIds`의 검증된 `queryEngineTable`만 physical table로 치환하고 직접 physical reference와 table function을 차단합니다. 결과 행 전체를 frontend에 적재하지 않고 submit 시 고정한 signed-cursor page로 조회합니다. Query AI SQL도 같은 guard와 scope 검증을 통과해야 합니다. lifecycle, retention, materialization 기준은 [Trino Query Run Contract](trino-query-run-contract.md)를 따릅니다.

`TRINO_ENABLED=false` DuckDB compatibility mode는 전체 결과를 `backend/tmp/spark-output/sql-runs/{runId}.parquet`(또는 `LOCAL_LAKE_STORAGE_DIR` 하위)에 저장하고 기존 `offset`/`limit` pagination을 유지한다. 이 snapshot은 Trino full Query Run이나 S3 cursor storage로 해석하지 않는다.

Trino Query Run의 일반 result page는 private S3-compatible gzip object로 저장하고 PostgreSQL에는 metadata/checksum/manifest만 둔다. 로컬은 MinIO, production은 사전 생성한 AWS S3 Query Result bucket과 EC2 instance profile을 사용한다. collector는 API request와 분리된 lease/generation worker이며 cancel/takeover 뒤 stale worker가 page나 run state를 덮어쓰지 못한다. frontend는 현재 page와 cursor history만 유지한다.

Catalog row viewer는 `GET /api/catalog/datasets/{datasetId}/rows?offset=&limit=`로 최신 성공 materialization의 물리 dataset을 DuckDB `COUNT(*)`/`LIMIT`/`OFFSET`로 읽는다. 한 page는 최대 500행이고, dataset `view`와 `query` 권한을 모두 검사한다. Catalog 상세와 스키마 상세 modal은 같은 page viewer를 사용한다.

MinIO/S3-backed Parquet Preview의 query-scoped cache/byte limit은 DuckDB compatibility 경로로만 유지한다. Trino mode는 검증된 Iceberg physical mapping을 사용하며 Spark/Kafka writer가 mapping을 증명하지 못한 Dataset은 `queryEngineStatus=unavailable`로 차단한다.

Pair2 FastAPI 5단계 완료 기준:

- `npm run verify:fastapi-pair2`가 통과한다.
- live mode frontend는 `VITE_USE_MOCK_API=false`에서 Catalog 목록을 hydrate한다.
- Catalog 상세에서 lineage modal이 `GET /api/catalog/datasets/{datasetId}/lineage` 결과로 열린다.
- Catalog 상세와 스키마 상세 modal에서 `GET /api/catalog/datasets/{datasetId}/rows`로 최신 성공 materialization의 첫/중간/마지막 page를 탐색한다.
- DuckDB compatibility 실행은 기존 `POST /api/query/runs` snapshot/offset pagination 회귀를 유지한다.
- Trino 실행은 `POST /api/query/validate` 성공 뒤 `202` Query Run을 접수하고 durable 상태를 polling한다.
- Trino 결과는 `GET /api/query/runs/{runId}/results` signed cursor로 현재 page만 반환하며 server CSV는 저장 page를 stream한다.
- 결과 panel은 SQL editor를 변경하지 않고 `차트 보기`, `데이터 미리보기`, `실행 정보`를 같은 높이 안에서 전환한다. `실행 정보`는 평가와 세 단계 timeline을 포함한다.
- Query AI 생성은 `POST /api/query/ai-suggestions`로 SQL 초안을 받고, 선택 dataset metadata 전체를 request에 포함하며, 자동 실행 없이 editor 적용 후 기존 점검을 다시 거친다.
- DuckDB compatibility 처리 Job은 기존 `POST /api/etl/jobs` 흐름을 유지하고, Trino 결과는 `POST /api/etl/sql-jobs` 반복 full-refresh recipe로 연결한다.
- Direct Lake Dataset 생성 API는 `POST /api/catalog/derived-datasets` 응답 dataset을 Catalog에 반영하고, 재조회 후에도 유지된다.
- 생성 dataset의 `lineageGraph`는 원본 dataset -> derived dataset 관계를 표시한다.

## 9. 대시보드

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| 목록 조회 | DB-backed dashboard card 목록 조회, 검색/소유자/태그/정렬/pagination 서버 처리 | `GET /api/dashboards`, `POST /api/dashboards/query` |
| 새 대시보드 생성 | `draft` 상태 dashboard card를 DB에 먼저 저장하고 조회 화면으로 이동 | `POST /api/dashboards` |
| 목록 삭제 | 확인 후 dashboard와 runtime snapshot 삭제 API 호출 | `DELETE /api/dashboards/{id}` |
| Dashboard title 수정 | dashboard card title 수정 | `PATCH /api/dashboards/{id}` |
| Published 조회 | published revision snapshot을 조회. 없으면 빈 runtime 응답 표시 | `GET /api/dashboards/{id}/published` |
| Draft 조회/생성 | 편집 진입 시 draft revision/page 준비 | `POST /api/dashboards/{id}/draft/ensure` |
| Page 추가 | DB-backed draft page 추가 | `POST /api/dashboards/{id}/draft/pages` |
| Page 이름 수정 | DB-backed draft page title 수정 | `PATCH /api/dashboards/{id}/draft/pages/{pageId}` |
| Page 삭제 | DB-backed draft page와 하위 widgets 삭제 | `DELETE /api/dashboards/{id}/draft/pages/{pageId}` |
| 위젯 추가 | selected dataset과 type별 config로 draft widget 생성 | `POST /api/dashboards/{id}/draft/pages/{pageId}/widgets` |
| 위젯 수정 | draft widget title/type/datasetId/config 수정 | `PATCH /api/dashboards/{id}/draft/widgets/{widgetId}` |
| 위젯 삭제 | draft widget 삭제 | `DELETE /api/dashboards/{id}/draft/widgets/{widgetId}` |
| Layout 저장 | drag/resize 종료 시 layout batch 저장 | `PATCH /api/dashboards/{id}/draft/layouts` |
| Publish | 현재 draft revision을 published revision으로 복사 | `POST /api/dashboards/{id}/publish` |
| Dashboard Assistant | AskLake 보조 패널/시각화 요청 위젯에서 DB runtime/catalog 컨텍스트 기반 OpenAI 응답 생성. 대시보드에서 사용할 수 있는 available catalog dataset만 위젯 생성/수정 후보로 허용한다. OpenAI 설정이 없거나 실패하면 `mock fallback` 명시 응답 반환 | `POST /api/dashboards/assistant` |
| Share | 프론트에서 runtime 링크 복사 feedback 표시 | 별도 share API는 현재 없음 |
| 내보내기 | local snapshot JSON 다운로드와 감사 로그 기록 | `GET /api/dashboards/{id}/export` |
| 전체화면/차트 확대 | 프론트 모달 표시 | 백엔드 불필요 |

프론트 dashboard adapter는 FastAPI가 404를 반환하는 이전 backend에서도 화면을 깨지 않도록 local/mock fallback을 유지한다. 현재 병합 기준에서는 FastAPI dashboard endpoint가 우선 source of truth다.

Dataset 기반 widget 생성 API는 `metric`, `table`, `bar_chart`, `line_chart`, `donut_chart` runtime type만 받는다. Backend save/read response는 `frontend/src/types/dashboard.ts`의 type별 config 계약을 보존해야 한다. `datasetId`가 있고 명시적 `data`가 없으면 catalog dataset의 rows 또는 sample rows를 column name 기반 object row로 변환해 widget `data` snapshot에 저장한다.

Dashboard runtime service는 실제 `catalog_datasets.payload`를 우선 조회해 `datasetId -> widget.data snapshot`을 만든다. demo catalog는 오래된 demo dataset id 또는 로컬 seed가 빠진 smoke 상황을 위한 fallback으로만 유지한다. 새 ETL/SQL derived dataset은 catalog `schema`와 `sampleRows`를 column name 기반 object row로 변환해 widget `data` snapshot에 저장한다. 로컬 PostgreSQL에서 대시보드 사이드바와 Assistant가 같은 demo 데이터를 보려면 `app.seed.seed_dashboard_demo`로 demo dataset을 `catalog_datasets`에 저장한다.
`seed_dashboard_demo`에는 커머스 데모용 원본 dataset 2개(`commerce_orders_daily`, `commerce_marketing_spend_daily`)와 조인 결과처럼 보이는 `gold_commerce_channel_roi` GOLD dataset이 포함된다.

Runtime table 보강 코드는 Alembic migration 도입 전까지 로컬 PostgreSQL smoke를 막지 않기 위한 임시 안전장치다. `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets`에 `created_at`, `updated_at`, JSON snapshot 컬럼이 빠져 있으면 repository에서 `ADD COLUMN IF NOT EXISTS`로 보강하지만, 장기 운영 기준의 source of truth는 후속 Alembic migration으로 옮겨야 한다.

Dashboard FastAPI 구현은 아래 순서와 파일 경계로 유지한다.

1. Dashboard 계약/schema skeleton 정리: `backend/app/schemas/dashboard.py`
2. Card/List API: 목록, 검색/필터/정렬, 생성, 제목 수정, 삭제
3. Runtime 조회 API: published 조회, draft ensure
4. Draft page API: page 추가/이름 수정/삭제
5. Draft widget/layout/publish API: widget 생성/수정/삭제, layout 저장, publish
6. Frontend adapter E2E: `frontend/src/services/dashboardApi.ts`, `frontend/src/services/dashboardRuntimeApi.ts`

Card/List API는 `dashboards`, `dashboard_tags`를 우선 소유한다.
Runtime API는 `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets`를 우선 소유한다.
두 흐름은 `dashboardId`와 `publishedRevisionId`만 공유하고, published 화면은 draft revision을 직접 읽지 않는다.
Dashboard 삭제 API는 card/list row 삭제와 함께 runtime revision/page/widget snapshot도 삭제한다.

Catalog dataset materialization 보완 기준:

- 같은 Job 또는 같은 `targetDataset`의 성공 결과는 새 Catalog row를 만들지 않고 기존 dataset payload의 `materializationRuns` history에 추가한다. 일반 full-refresh는 snapshot으로 이전 snapshot을 rebaseline하고 Kafka delta만 누적한다.
- `materializationRuns`가 없는 기존 payload는 빈 history로 읽기 호환한다.
- `DELETE /api/catalog/datasets/{datasetId}/materialization-runs/{runId}`는 metadata history만 삭제하고 active snapshot/delta 기준으로 부모 rows/size/latest/storageLocation을 재계산한다. 물리 lake 파일 삭제는 후속 범위다.
- Catalog UI는 dataset row 펼침에서 version history를 5개씩 표시하며, 5개 이하일 때는 실제 개수만큼만 높이가 늘어난다.
구현 기록과 Card/List merge 시 확인할 접점은 `docs/dashboard-runtime-api-implementation.md`를 따른다.

## 10. 아직 실제 저장되지 않는 기능

아래 기능은 현재 UI 반응과 감사 로그만 있고, 서버 저장은 없습니다.

| 영역 | 기능 |
| --- | --- |
| 수집/처리 | 삭제, 상세 수정 저장, 필터 조건 저장 |
| 생성 플로우 | Source 중간 테스트 결과, Schema 승인, Rule 추가/검증 |
| 카탈로그 | 상세/lineage 고도화, 저장소 보관 기준 확정, 태그/필터 서버 검색 |
| SQL | 쿼리 저장, CSV 다운로드 |
| 대시보드 | 권한 기반 공유, 내보내기 API, 장기 운영용 권한/감사 로그 |
| 공통 | 운영 IdP/SSO 연동, session hardening, 외부 감사 저장소 연동 |

Permission/Governance 기준으로, 프로필/만든 사람 표시는 identity metadata 작업이고 실제 권한 판정은 `ActorContext`와 resource별 grant 작업이다. 현재 로컬 auth/session은 계정 actor를 결정하기 위한 demo-grade 구현이며, 외부 IdP/SSO, refresh token, 비밀번호 재설정, 이메일 인증, 권한 정책 고도화 UI, auth/permission table Alembic migration은 후속 범위다. `owner` 문자열만으로 권한을 판단하면 이름 변경, 그룹 소유, 대리 생성, 외부 공유 같은 edge case가 생기므로 backend는 payload grant와 `permission_grants` table row를 병합해 판정하고, admin API와 관리 콘솔로 table grant를 편집한다.

## 11. 백엔드 팀에 넘길 최소 구현 범위

최소 데모 연동만 목표라면 아래 5개면 충분합니다.

1. `POST /api/etl/jobs`
2. `POST /api/etl/jobs/{jobId}/commands`
3. `GET /api/etl/jobs`
4. `GET /api/etl/jobs/{jobId}`
5. `GET /api/catalog/datasets`
6. `POST /api/query/runs`

대시보드 실제 저장 API는 현재 병합 기준에서 추가되어 있으며 아래 endpoint를 유지합니다.

1. `GET /api/dashboards`
2. `POST /api/dashboards/query`
3. `POST /api/dashboards`
4. `PATCH /api/dashboards/{dashboardId}`
5. `DELETE /api/dashboards/{dashboardId}`
6. `GET /api/dashboards/{dashboardId}/published`
7. `POST /api/dashboards/{dashboardId}/draft/ensure`
8. `POST /api/dashboards/{dashboardId}/draft/pages`
9. `PATCH /api/dashboards/{dashboardId}/draft/pages/{pageId}`
10. `DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`
11. `POST /api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets`
12. `PATCH /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`
13. `DELETE /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`
14. `PATCH /api/dashboards/{dashboardId}/draft/layouts`
15. `POST /api/dashboards/{dashboardId}/publish`
16. `POST /api/dashboards/assistant`

## 12. 프론트에서 다음에 할 작업

백엔드 API가 준비되기 전 프론트에서 미리 할 수 있는 작업입니다.

| 순서 | 작업 | 파일 |
| --- | --- | --- |
| 1 | `getJobs`, `getDatasets`, `getDatasetLineageGraph` API adapter 추가 | `frontend/src/services/mockApi.ts` |
| 2 | 초기 hydrate loading/error 상태 추가 | `frontend/src/hooks/useAskLakeData.ts` |
| 3 | dashboard list/runtime adapter와 FastAPI fallback 경로 확인 | `frontend/src/services/mockApi.ts`, `frontend/src/services/dashboardApi.ts`, `frontend/src/services/dashboardRuntimeApi.ts` |
| 4 | audit export/retention 정책 정의 | docs/admin console |
| 5 | 삭제/저장/게시 실패 시 rollback 처리 | `frontend/src/hooks/useAskLakeData.ts`, dashboard page |

## 13. 인수 기준

백엔드 연결이 끝났다고 판단하려면 아래를 통과해야 합니다.

- `.env`에서 `VITE_USE_MOCK_API=false`로 실행해도 앱이 정상 로딩됩니다.
- 새 수집/처리 생성 후 목록과 카탈로그에 서버 응답 데이터가 표시됩니다.
- 즉시 실행/재실행/일시정지/현재 Run 취소/스케줄 중지 버튼이 서버 상태 전이를 반영합니다.
- SQL 실행 결과는 compatibility mode의 current snapshot page 또는 Trino signed-cursor current page 그대로 표시됩니다.
- Trino 실행 정보는 editor 아래로 튀어나오지 않고 결과 panel의 세 번째 view에서 평가와 timeline을 표시합니다.
- Trino 결과 page를 전체 Query Run 또는 persistent Dashboard source로 저장하지 않습니다.
- 새로고침 후에도 저장된 대시보드/작업/데이터셋이 유지됩니다.
- 실패 응답은 토스트와 감사 로그에 남습니다.
- 콘솔에 React key/layout 관련 error가 없어야 합니다.

## Review Snapshot 연결

- `/etl/review`는 `POST /api/etl/review` 응답을 source of truth로 사용한다.
- live mode는 source 연결 성공 상태를 backend connector로 재검증하고, source/schema/target/permission/schedule 값을 하나의 snapshot으로 반환한다.
- mock mode는 같은 `ReviewSnapshot` 계약을 fixture로 반환해 화면과 API 타입이 갈라지지 않게 한다.
- Review 생성 버튼은 snapshot의 `canCreate`가 true일 때만 활성화한다.

## 14. 남은 작업

- Kafka schema evolution approval/restart workflow
- 다중 Parquet 파일의 통합 스키마 추론
- Worker log 장기 object storage 및 metric alerting
- 삭제/수정 API persistence
- Trino 운영 quota/old table retention 고도화
- Dashboard 권한/공유/export API
- Audit log server persistence
## ETL Permission create-flow readiness

- [x] `GET /api/etl/permission-options` 그룹·사용자 경량 조회
- [x] admin actor guard와 `403 FORBIDDEN`
- [x] create/update `permissionGrants` validation
- [x] `permission_ui` grant 저장 및 교체
- [x] admin source grant 보존
- [x] 생성·수정 응답과 접근 판정에 persisted grant 병합
- [x] `backend/scripts/verify-permission-create-flow-contract.py` 생성·교체 계약 검증
- [ ] Docker/PostgreSQL 기반 `verify:permission-job-dashboard` 전체 스모크는 metadata DB가 응답 가능한 환경에서 실행
