# 03. API Reference

이 문서는 AskLake API/interface 계약의 상위 진입점이다.
상세 request/response shape는 기존 문서인 `docs/api-contract.md`를 기준으로 한다.
백엔드 연결 범위와 남은 작업은 `docs/backend-integration-readiness.md`를 기준으로 한다.

## 1) 현재 상태

- 현재 Pair A Source/Schema/Create/Run 흐름은 mock/live adapter를 통해 동작한다.
- 기본 live API mode에서는 Source/Schema/Create/Run이 live backend API를 호출한다.
- mock mode(`VITE_USE_MOCK_API=true`)에서는 Source/Schema 연결 테스트도 backend 없이 mock `SourceConnectorAnalysis`를 반환한다.
- `frontend/src/services/apiClient.ts`가 API 호출 wrapper다.
- `frontend/src/services/pipelineApi.ts`가 create/run/query 호출 진입점이다.
- live backend mode에서 ETL job, catalog dataset, SQL run snapshot은 Postgres JSONB metadata tables에 저장된다.
- ETL/Catalog 초기 hydrate 결과가 Postgres에 비어 있으면 UI도 빈 목록으로 시작한다.

## 2) 환경 변수

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=false
VITE_DASHBOARD_ASSISTANT_API_PATH=/api/dashboards/assistant
DATABASE_URL=postgres://asklake:asklake_dev@127.0.0.1:54328/asklake
S3_ALLOWED_BUCKETS=asklake-output
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
TARGET_DATABASES=asklake,asklake_gold,analytics,marketing
```

- 개발 서버에서 `VITE_API_BASE_URL`을 생략하면 프론트는 같은 출처의 `/api`를 호출하고, Vite proxy가 FastAPI `http://127.0.0.1:8080`으로 전달한다.
- `VITE_USE_MOCK_API=false` 또는 미설정: live backend mode. Source connector, create/run/query/catalog/dashboard API를 실제 backend로 보낸다.
- `VITE_USE_MOCK_API=true`: frontend demo/mock mode. Source connector도 mock sample을 반환한다.
- `VITE_DASHBOARD_ASSISTANT_API_PATH`: 미설정 시 `/api/dashboards/assistant`를 사용한다. 다른 Assistant API origin 또는 경로가 필요할 때만 지정한다.
- `DATABASE_URL`: backend metadata DB. 미설정 시 `docker-compose.yml`의 local Postgres 기본값을 사용한다.
- Dashboard adapter는 FastAPI 응답을 우선하고, 이전 backend 호환을 위해 404 local/mock fallback을 유지한다.
- Target 저장경로 선택은 frontend가 S3를 직접 호출하지 않고 `GET /api/s3/buckets`, `GET /api/s3/prefixes` 서버 API를 통해 bucket/prefix만 조회한다. `S3_ALLOWED_BUCKETS` allowlist가 없으면 local demo 기본값으로 `asklake-output`을 사용한다.
- Target DB 선택은 `GET /api/target/databases` 서버 API를 통해 허용 DB 목록을 조회한다. `TARGET_DATABASES`가 없으면 local demo 기본값을 사용한다.
- Query AI live mode는 backend env의 `OPENAI_API_KEY`와 `OPENAI_QUERY_AI_MODEL`을 사용한다. 브라우저 env에는 OpenAI 키를 두지 않는다.
- Query AI 요청은 선택된 dataset id와 dataset metadata 전체를 함께 전달해 backend가 선택 context 안에서 JOIN SQL 초안을 생성할 수 있게 한다. live 응답이 선택 reference JOIN을 포함하지 않으면 frontend가 동일 metadata로 JOIN 초안 fallback을 적용한다.

## 3) 공통 규칙

- Base Path: `/api`
- Body format: JSON
- Response format: JSON
- ID type: opaque string
- Time format: ISO 8601 string
- Status values: API and frontend internal state use English canonical values. UI labels are translated in the frontend.
- Error envelope: `docs/api-contract.md`의 Error Envelope를 따른다.
- Authentication: local Phase 0는 httpOnly `asklake_session` cookie와 `/api/auth/session` actor 확인을 사용한다. 세션이 없을 때만 기존 `X-AskLake-*` actor header fallback을 사용하며, 운영 IdP/SSO는 후속 범위다.
- Schema type은 `String`, `Integer`, `Long`, `Double`, `Boolean`, `Timestamp`, `Date`, `JSON`을 canonical 값으로 사용한다. 기존 payload의 `Float`는 읽기 호환하되 새 source draft와 Transform UI는 `Double`로 저장한다.
- JSON/JSONL source는 native token을 기준으로 type을 추론한다. 숫자처럼 보이는 JSON string은 `String`, integer number는 `Long`, real number는 `Double`이며 timestamp string은 명시적 변환 전까지 `String`이다.
- `schemaColumns[].sourceName`은 `raw.reviewerID` 같은 원본 dotted path를 보존하고, `targetName`만 물리 컬럼 규칙에 맞게 별도로 정규화한다.

FastAPI schema 구현 기준:

- 공통 Pydantic schema는 `backend/app/schemas/common.py`에 둔다.
- 각 도메인 schema는 `CamelModel`을 상속해 Python 내부에서는 `snake_case`, API request/response에서는 `camelCase`를 사용한다.
- 실패 응답은 `ErrorResponse` / `ErrorDetail`을 사용하고, code 값은 `docs/api-contract.md`의 권장 에러 코드를 우선한다.
- 목록형 API는 필요에 따라 `PageRequest`, `PageMeta`, `PageResponse`, `CursorPageMeta`, `SortDirection`을 재사용한다.
- 모든 성공 응답을 하나의 envelope로 강제하지 않는다. 각 endpoint의 성공 response shape는 `docs/api-contract.md`의 상세 계약을 따른다.

Canonical status values:

| Resource | Field | Values |
| --- | --- | --- |
| Job | `status` | persisted legacy 값은 `scheduled`, `running`, `failed`, `paused`, `canceled`, `stopped`; 목록 UI는 `scheduled`, `running`, `stopped` 중심으로 표시하고 실패·취소는 최신 Run 결과로 표시 |
| Run | `status` | `queued`, `running`, `success`, `failed`, `canceled` |
| Dataset | `status` | `available`, `approval_required` |
| Dataset | `freshness` | `latest`, `stale`, `approval` |
| Dashboard | `status` | `draft`, `published` |

## 4) P0 API

| Method | Endpoint | Auth | 설명 | 상세 문서 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/auth/signup` | Public | 로컬 계정 생성 및 session cookie 발급 | `docs/api-contract.md` |
| `POST` | `/api/auth/login` | Public | 계정 검증 및 session cookie 발급 | `docs/api-contract.md` |
| `GET` | `/api/auth/session` | Cookie | 현재 session actor 조회 | `docs/api-contract.md` |
| `POST` | `/api/auth/logout` | Cookie | 현재 session 종료 | `docs/api-contract.md` |
| `GET` | `/api/users/me` | Session | 현재 actor의 프로필·그룹·권한 요약 조회 | `docs/api-contract.md` |
| `GET` | `/api/admin/users` | Admin | 사용자 목록 조회 | `docs/api-contract.md` |
| `GET` | `/api/admin/groups` | Admin | 그룹 목록 조회 | `docs/api-contract.md` |
| `GET/POST/PATCH/DELETE` | `/api/admin/permissions` | Admin | permission grant 관리 | `docs/api-contract.md` |
| `GET/PATCH` | `/api/admin/governance-controls` | Admin | principal block과 resource lock 관리 | `docs/api-contract.md` |
| `GET` | `/api/admin/audit-logs` | Admin | 감사 로그 필터 조회 | `docs/api-contract.md` |
| `GET` | `/api/etl/sources/defaults` | TBD | backend 실행 환경 기준 Source 기본값 반환 | `docs/api-contract.md` |
| `POST` | `/api/etl/sources/test` | TBD | Source 연결 테스트와 schema draft patch 반환 | `docs/api-contract.md` |
| `POST` | `/api/etl/schema-inference` | TBD | Source 테스트 결과 기반 schema 반환 | `docs/api-contract.md` |
| `POST` | `/api/etl/rules/preview` | Session | 최대 100개 샘플에 canonical Snapshot Rule을 실제 runtime으로 적용 | `docs/api-contract.md` |
| `POST` | `/api/etl/record-parsing/preview` | TBD | 이름 없는 TXT 제한 샘플을 연속 공백으로 구조화하고 필드 개수·컬럼 타입 초안 반환 | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs` | TBD | 새 수집/처리 job 생성 | `docs/api-contract.md` |
| `PATCH` | `/api/etl/jobs/{jobId}` | `manage` | 생성된 Job의 허용 설정 업데이트. source identity는 요청에 포함할 수 없음 | `docs/etl-job-edit-contract.md` |
| `POST` | `/api/etl/jobs/{jobId}/commands` | TBD | 실행, 재실행, 일시정지, 현재 Run 취소, 스케줄 중지 | `docs/api-contract.md` |
| `GET` | `/api/etl/kafka/replay-producer` | `manage` | 배포 환경 Kafka replay producer 상태/최근 로그 조회 | `docs/api-contract.md` |
| `POST` | `/api/etl/kafka/replay-producer` | `manage` | loop 또는 유한 Kafka review replay producer 시작 | `docs/api-contract.md` |
| `DELETE` | `/api/etl/kafka/replay-producer` | `manage` | 실행 중인 Kafka replay producer에 graceful stop 요청 | `docs/api-contract.md` |
| `POST` | `/api/internal/airflow/spark-runs/{runId}/execute` | Airflow service bearer token | 저장된 일반 배치 Job/Run을 재검증하고 PySpark 실행. 브라우저 호출 금지 | `docs/api-contract.md` |
| `POST` | `/api/internal/airflow/spark-runs/{runId}/catalog` | Airflow service bearer token | 저장된 성공 Spark manifest를 실제 Parquet와 대조하고 Catalog에 멱등 반영. 브라우저 호출 금지 | `docs/api-contract.md` |
| `POST` | `/api/etl/internal/airflow/jobs/{jobId}/runs/{runId}/execute` | Airflow internal token | 기존 단일 호출 Spark/Catalog 실행 경로의 호환 endpoint. 신규 DAG는 분리된 execute/catalog endpoint를 사용 | `docs/api-contract.md` |
| `POST` | `/api/etl/schedules/run-due` | TBD | due 상태의 반복 Job을 검사하고 실행 | 이 문서 |
| `POST` | `/api/etl/kafka/reviews/ingest` | TBD | Kafka snapshot range를 direct target에 저장하고 Catalog 등록 | 이 문서 |
| `POST` | `/api/query/runs` | TBD | read-only SQL 실행 | `docs/api-contract.md` |
| `GET` | `/api/query/runs/{runId}` | TBD | 저장된 SQL 실행 결과 snapshot 조회 | `docs/api-contract.md` |
| `POST` | `/api/query/ai-suggestions` | TBD | 선택 테이블 context 기반 Query AI SQL 초안 생성 | `docs/api-contract.md` |
| `POST` | `/api/catalog/derived-datasets` | TBD | SQL 결과 기반 Lake Dataset 생성 | `docs/api-contract.md` |

`GET /api/etl/sources/defaults`는 `{ "kafkaBroker": "..." }`를 반환한다. 새 Kafka Source 화면은 build-time 상수가 아니라 이 값을 사용하므로 `ASKLAKE_KAFKA_BROKER`를 바꾼 backend와 같은 endpoint를 기본 표시한다.

Kafka `POST /api/etl/sources/test`와 Snapshot ingest consumer는 uncompressed 및 Snappy-compressed record batch를 지원한다. Source test는 consumer 오류를 빈 metadata preview로 바꾸지 않는다. 첫 메시지 이후 최소 샘플 수에 도달하면 idle window로 종료하고, 도달하지 못해도 bounded settle window 뒤 현재 샘플을 반환한다.

`POST /api/etl/jobs/{jobId}/commands`의 일반 배치 `run`/`retry`는 Airflow 접수 직후 `queued` 또는 `running` 상태를 응답한다. Airflow의 `spark_process_write` task가 bearer token으로 FastAPI internal execution API를 호출해 실제 PySpark 처리를 수행하고, 최종 Run/DAG/Spark manifest는 `GET /api/etl/jobs/{jobId}` polling으로 반영한다.

PostgreSQL Snapshot Job의 `run`/`retry`는 생성 시 저장된 `schemaSampleRows`, `__Schema Sample Scope`, `__Sample Row Limit`을 실행 행 제한으로 사용하지 않는다. 내부 실행 API는 선택한 `DATASET OR TABLE SELECTOR` 기본 테이블을 repeatable-read cursor로 끝까지 export하고 Spark manifest의 `inputRows`/`outputRows`에 실제 전체 행 수를 기록한다. 연결 실패, 테이블 부재, 빈 테이블, export 실패는 Spark/Catalog 성공으로 처리하지 않는다.

내부 실행 API는 `AIRFLOW_EXECUTION_API_TOKEN`이 없으면 `503 AIRFLOW_EXECUTION_NOT_CONFIGURED`, token이 다르면 `401 AIRFLOW_EXECUTION_UNAUTHORIZED`, 저장된 Job/Run/Airflow DAG Run identity가 일치하지 않으면 `409 AIRFLOW_RUN_MISMATCH`를 반환한다. 성공/실패 Spark manifest는 `JobRunSummary.taskStates.sparkResult`에 보존되며, Phase 2에서는 Catalog Dataset을 생성하거나 materialization history를 갱신하지 않는다.

Phase 3의 `publish_run_result` task는 `POST /api/internal/airflow/spark-runs/{runId}/catalog`에 `{ "jobId": "..." }`를 보낸다. backend는 저장된 `sparkResult.status=success`, 실제 Parquet object, Job의 `datasetId`를 검증한 뒤 같은 Run의 materialization과 lineage를 `catalog_datasets.payload`에 저장한다. 성공 response는 `status`, `runId`, `reconciledAt`, `dataset`을 반환하고 `JobRunSummary.taskStates.catalogResult`에도 같은 식별자와 결과를 보존한다.

Catalog endpoint는 `runId` 기준으로 멱등하다. `publish_run_result`는 30초 간격으로 최대 2회 재시도하므로 최초 시도를 포함해 최대 3회 같은 `runId`의 Catalog reconciliation을 호출한다. 이 task retry는 upstream의 성공 Spark XCom과 저장된 `sparkResult`를 재사용해 Spark를 다시 실행하지 않으며, `materializationRuns`에는 같은 `runId`가 하나만 남아야 한다. 저장된 Spark 성공 결과가 없으면 `409 SPARK_RESULT_NOT_READY`, identity가 다르면 `409 AIRFLOW_RUN_MISMATCH`, 실제 output 확인 또는 Catalog transaction이 실패하면 `500 CATALOG_RECONCILIATION_FAILED`를 반환한다. 실패 응답은 재시도 소진 후 `publish_run_result` task와 DAG Run을 실패시키고, AskLake Run의 실패 단계는 `Catalog reconciliation`로 표시한다.

Airflow DAG Run은 Catalog endpoint가 성공한 뒤에만 `success`가 된다. frontend polling이 해당 terminal success 전환을 관찰하면 `GET /api/catalog/datasets`를 다시 호출해 새 dataset 또는 append history를 전체 새로고침 없이 반영한다.

`stopSchedule`/`resumeSchedule`은 배치에서는 자동 실행 중지/재개, 실시간에서는 수집 중지/재개로 해석한다. 실행 중인 실시간 Job을 중지하면 현재 Run도 `canceled`로 종료하고 중지 시각을 기록한다.

ETL 성공 dataset의 `lineageGraph`는 transform-aware column lineage를 사용한다. source node는 실제 transform input만 포함하고, 하나의 source `text`에서 여러 분류 컬럼을 파생하면 `text -> 각 output` edge를 각각 반환한다. Spark가 생성한 `_asklake_*` 컬럼은 job node에서 시작한다.

Issue #500은 같은 command endpoint에 `startContinuous`, `pauseContinuous`, `resumeContinuous`, `stopContinuous`를 추가한다. 이 명령은 `executionMode: "continuous"` Kafka Job에만 적용하며, Docker가 시작한 long-running Spark Structured Streaming worker를 제어한다. 사용자 화면은 checkpoint를 보존하는 `중지`와 `스트림 시작`만 제공한다. Continuous 생성은 일반 cron 스케줄 단계를 건너뛰며 request에는 `scheduleLabel: "스케줄링 건너뛰기"`와 스트림 lifecycle 설명을 저장한다. `pauseContinuous`/`resumeContinuous`는 기존 API 호환을 위해 유지하지만 별도 UI 흐름으로 노출하지 않는다. 응답의 `processingResult.controlPlaneOnly`는 `false`, `worker`는 `spark_structured_streaming`이다. `GET /api/etl/jobs/{jobId}`는 worker container liveness와 heartbeat를 검사해 runtime을 hydrate하며, 요청 없이 종료되거나 heartbeat가 만료된 active worker는 `failed`로 반영한다. `pausing`/`stopping`에서의 의도된 worker 종료는 각각 `paused`/`stopped`로 완료한다. Continuous Job은 장기 실행 Spark query와 checkpoint로 상태를 복원하므로 `run`/`retry` Snapshot command와 섞어 사용할 수 없다. 상세 request/response와 충돌 정책은 [Kafka Continuous Ingestion Contract](kafka-continuous-ingestion-contract.md)를 따른다.

Issue #567 Phase 5부터 Continuous create/review/preview는 Snapshot conformance를 통과한 stateless canonical Rule을 허용한다. `GET /api/etl/jobs/{jobId}`의 `continuousRuntime`은 `ruleContractVersion`, `ruleFingerprint`, `runtimeFingerprint`, `ruleMetrics`, `lastRuleResult`를 추가로 반환한다. Worker report, batch manifest와 Catalog `materializationRuns`도 schema/rule/runtime fingerprint와 Transform/Quality 결과를 보존한다. 실행 중 processing contract 변경은 `409 CONTINUOUS_IMMUTABLE_CONFIG_ACTIVE`, checkpoint가 초기화된 뒤의 schema/Rule/physical target 변경은 `409 CONTINUOUS_CHECKPOINT_CONTRACT_IMMUTABLE`이며 Job copy와 새 checkpoint가 필요하다.

Continuous 운영 API는 `GET /api/etl/jobs/{jobId}/continuous/logs`, `GET /api/etl/jobs/{jobId}/continuous/sessions`, `GET /api/etl/jobs/{jobId}/continuous/sessions/{sessionId}`, `GET /api/etl/jobs/{jobId}/continuous/sessions/{sessionId}/batches?limit=100`, `GET /api/etl/jobs/{jobId}/continuous/quarantine`, `GET /api/etl/jobs/{jobId}/continuous/maintenance-runs`, `POST /api/etl/jobs/{jobId}/continuous/quarantine/replays`, `POST /api/etl/jobs/{jobId}/continuous/compactions`를 제공한다. session은 한 번의 stream start부터 terminal 전환까지를 나타내고 batch endpoint는 그 session에 속한 최근 micro-batch를 최신순으로 반환한다. session과 batch의 `dagSteps`는 Source, Schema, Transform, Quality, Target, Manifest/Checkpoint, Catalog 7단계 근거를 제공하며 Catalog cursor 확인 전 publication은 마지막 단계가 `pending`이다. manifest 전에 Rule이 실패한 batch도 `failed` 이력과 오류를 반환하고, 규칙이 없는 Transform/Quality 단계는 `pass-through`다. 세 조회 API는 worker report와 liveness를 먼저 동기화하므로 별도 새로고침 명령 없이 최신 durable 상태를 읽는다. 로그는 bounded/redacted response이고 replay/compaction은 checkpoint를 변경하지 않는 유한 maintenance run이다. Replay body는 `offsets?: string[]`와 `approveUnknownFields?: boolean`을 받는다. 기본값은 현재 schema evolution policy를 재적용하며, `approveUnknownFields: true`는 unknown field만 고정 projection으로 승인하는 `manage` 권한 작업으로 감사 로그와 result의 `policyOverride`를 남긴다. Maintenance run은 기본 900초 lease를 가지며 만료된 DB 상태와 Docker container를 다음 동기화에서 정리한다.

Kafka replay producer API는 Continuous worker와 분리된 테스트 입력 도구다. `POST /api/etl/kafka/replay-producer`는 `topic`, `rate`, `batchSize`, `loop`, `maxCycles?`, `maxMessages?`, `cycleDelayMs?`, `burstMinMessages?`, `burstMaxMessages?`, `burstIntervalSeconds?`, `inputPath?`를 받으며 한 번에 하나만 실행한다. burst 세 값은 함께 쓰며 loop mode에서 매 interval마다 min~max의 랜덤 건수를 rate 제한 없이 전송한다. loop 모드는 cycle별 고유 `event_id`와 증가하는 논리 `offset`을 만들고, 기존 topic을 삭제하지 않는다. `inputPath`는 배포 설정의 `ASKLAKE_REPLAY_INPUT_DIR` 아래 상대 경로만 허용한다.

`GET /api/etl/jobs/{jobId}`는 Job 상세, 실행 polling, 수정 화면 hydrate의 source of truth다. 응답은 source config, schema columns/fingerprint/sample/summary, transform/quality, schedule/retry/watermark, permission summary/roles, target database/metadata를 함께 유지한다.

`PATCH /api/etl/jobs/{jobId}`는 `manage` 권한이 필요하다. request는 source field를 허용하지 않으며, 실행 중인 Job은 `409`, 성공 Run이 있는 Snapshot Job의 target dataset/database/layer/format/storage identity 변경은 `422`로 차단한다. Continuous는 checkpoint contract 초기화 전까지만 schema/Rule/physical target을 수정할 수 있고, 초기화 후에는 위 전용 `409` 오류로 Job copy를 요구한다. update는 Kafka consumer group offset, Snapshot 경계 또는 Continuous checkpoint를 변경하지 않는다.

Kafka Source Job의 `run`/`retry`는 Airflow/Spark 대신 backend Kafka ingest bridge를 실행한다. bridge는 Job 시작 시 partition별 end offset snapshot을 고정하고, 해당 range만 consume한 뒤 `topic -> direct target object(jsonl) -> Catalog materializationRuns append -> consumer offset commit` 순서로 처리한다. 같은 consumer group을 쓰면 마지막 성공 snapshot의 end offset 이후만 target에 저장되고, lag가 없으면 0건 JSONL target run도 성공으로 남긴다.

### Kafka review ingest

`POST /api/etl/kafka/reviews/ingest`는 Kafka topic을 직접 읽어 선택 target에 저장하는 backend-only endpoint다. UI의 일반 실행 경로는 보통 `POST /api/etl/jobs/{jobId}/commands` 또는 scheduler tick을 사용하고, 이 endpoint는 fixture/debug/smoke 용도로 둔다.

Request:

```ts
type KafkaReviewIngestRequest = {
  broker?: string; // default ASKLAKE_KAFKA_BROKER, fallback "127.0.0.1:19092"
  topic?: string; // default "reviews.raw"
  consumerGroupId?: string;
  maxMessages?: number; // default 100, snapshot maximum per partition
  timeoutMs?: number; // default 10000
  offsetPolicy?: "earliest" | "latest";
  allowEmpty?: boolean;
  registerCatalog?: boolean;
  datasetId?: string;
  datasetName?: string;
  targetBucket?: string; // default "asklake-output"
  targetPrefix?: string; // default "{datasetName}/{targetLayer}"
  targetLayer?: "RAW" | "BRONZE" | "SILVER";
  targetFormat?: "jsonl"; // direct Kafka target currently supports JSONL only
  targetDescription?: string;
  schemaColumns?: SchemaColumnDraft[]; // Job에서 확정한 included/source/target schema
  outputSchema?: Array<[string, string]>; // compiler가 확정한 최종 output schema
  ruleContractVersion?: "1.0";
  rules?: CanonicalRuleDraft[]; // Job 실행의 source of truth
  transformSteps?: TransformStepDraft[]; // legacy/debug compatibility
  qualityRules?: QualityRuleDraft[]; // legacy/debug compatibility
  runId?: string;
  storageMode?: "local" | "s3";
  localLandingDir?: string;
  landingEndpoint?: string; // legacy name for the S3-compatible target endpoint
  landingBucket?: string; // deprecated compatibility fallback for targetBucket
  landingPrefix?: string; // deprecated compatibility fallback for targetPrefix
};
```

Response:

```ts
type KafkaReviewIngestResponse = {
  status: "success";
  runId: string;
  broker: string;
  topic: string;
  consumedCount: number;
  storedCount: number;
  failedCount: number;
  storageMode: "local" | "s3";
  storageFormat: "jsonl";
  storageLocation: string;
  targetLayer: "RAW" | "BRONZE" | "SILVER";
  transform?: { configuredStepCount: number; appliedStepCount: number; errorCount: number };
  quality?: { configuredRuleCount: number; invalidRowCount: number; droppedCount: number; quarantinedCount: number; quarantineLocation?: string; summary: string };
  metadataLocation: string;
  datasetId?: string;
  datasetName?: string;
  catalogDataset?: CatalogDataset;
  snapshot: {
    snapshotId: string;
    capturedAt: string;
    topic: string;
    consumerGroupId: string;
    offsetPolicy: "earliest" | "latest";
    partitions: Array<{
      partition: number;
      startOffset: string;
      highWatermark: string;
      endOffset: string; // exclusive
    }>;
  };
};
```

Kafka review message contract:

```ts
type KafkaReviewEvent = {
  event_id: string;
  review: string;
  offset: number;
  created_at: string;
  source?: string;
  schema_version?: string;
  raw?: Record<string, unknown>;
};
```

필수 필드는 `event_id`, `review`, `offset`, `created_at`이다. direct target object는 `s3://{targetBucket}/{targetPrefix}/snapshots/{snapshotId}/data.jsonl` 형태이며, metadata는 같은 snapshot directory의 `metadata.json`에 저장한다.

Job command는 저장된 `ruleContractVersion`과 `rules`를 실행 직전에 다시 compile해 이 endpoint의 bridge payload로 전달한다. direct debug 호출에서 canonical 필드가 없을 때만 legacy `transformSteps`/`qualityRules`를 adapter로 변환한다. legacy의 빈 Regex, Accepted Values, Range 파라미터는 각각 기존 이메일 패턴, 국가 집합, 최소 0 기본값을 유지한다. schema가 `raw: JSON`을 선언하면 `raw.email` 같은 dotted Rule input도 유효하며, JSON root가 아닌 임의의 미등록 path는 계속 거절한다.

### Kafka snapshot direct target

Issue #455 Phase 3는 아래 direct target 계약을 구현한다. 저장 경로는 `s3://{targetBucket}/{targetPrefix}/snapshots/{snapshotId}/data.jsonl` 형식이며 중간 `kafka-landing/...` RAW object를 만들지 않는다.

```text
partition offset snapshot
  -> fixed-range consume with auto-commit disabled
  -> transform/quality
  -> selected target dataset write
  -> Catalog materialization run
  -> offset commit
```

현재 ingest 응답과 Kafka Job Run metadata는 `snapshotId`, `capturedAt`, `topic`, `consumerGroupId`, partition별 `startOffset`, `highWatermark`, exclusive `endOffset`을 가진다. target write 또는 Catalog 등록이 실패하면 offset을 commit하지 않으며, 같은 snapshot identity는 target object path와 Catalog materialization run deduplication key로 사용한다. `Batch Max Messages`의 후속 의미는 global count가 아니라 partition별 snapshot 최대 범위로 명시한다. post-target-write failure smoke hook은 production endpoint 계약에 포함하지 않으며 `ASKLAKE_ENABLE_KAFKA_TEST_HOOKS=true`인 test process에서만 활성화된다.

`Fail Run` 같은 Kafka bridge 오류가 일반 Job command에서 발생하면 API는 실패 Run을 정상 응답의 `run`으로 반환하며, `run.taskStates.kafkaSnapshot`과 `failedStage`를 보존한다. 직접 `POST /api/etl/kafka/reviews/ingest` 호출은 `502` error response를 반환하고 `error.details.bridge.snapshot` 및 `failedStage`로 동일 진단을 제공한다.

target dataset의 layer는 `RAW`, `BRONZE`, `SILVER`를 지원하며 기본값은 `BRONZE`, 물리 포맷은 `JSONL`이다. target layer는 Catalog/target metadata이며 Kafka bridge의 transform/quality 실행 여부를 임의로 바꾸지 않는다. bridge는 Job에 저장된 지원 field transform과 quality action을 적용한 뒤 compiled output schema로 projection하므로 rename 전 source field와 `included: false` field는 target JSONL, Catalog schema, sample에 남지 않는다. `Fail Run`은 offset commit 전에 실행을 실패시키며, `Quarantine`은 snapshot directory의 `quarantine.jsonl`로 분리한다. malformed payload도 raw payload와 Kafka context를 보존해 quarantine한다. `GOLD` join/aggregation과 범용 SQL expression runtime은 이 전환 범위에 포함하지 않는다. 상세 계약은 [Kafka Snapshot Direct Target Contract](kafka-snapshot-direct-target-contract.md)를 따른다.

### Scheduled job tick

`POST /api/etl/schedules/run-due`는 production scheduler 자체가 아니라, scheduler/cron이 호출할 수 있는 due job 실행 endpoint다.

Request:

```ts
type ScheduledJobRunRequest = {
  force?: boolean; // true면 due 여부와 무관하게 실행
  jobId?: string; // 특정 job만 검사
  kafkaOnly?: boolean; // default true
};
```

Response:

```ts
type ScheduledJobRunResponse = {
  checkedCount: number;
  triggeredCount: number;
  items: Array<{
    jobId: string;
    jobName: string;
    schedule: string;
    reason: "due" | "forced" | "not_due" | "not_scheduled" | "next_run_not_set" | "invalid_next_run" | "not_kafka_job" | "already_running" | "stopped";
    triggered: boolean;
    response?: JobCommandResponse;
  }>;
};
```

`reason`이 `due`인 실행이 성공하면 backend가 `schedulePolicy.nextRunUtc`와 `job.nextRun`을 다음 예약 시각으로 advance한다. 현재 지원하는 반복 label은 `매시간 NN분`, `매일 HH:mm`, `매주 ... HH:mm` 범위다. `force: true`는 수동 검증/운영 보정 용도이며 due 시각 advance를 강제하지 않는다.

## 5) P1 API

| Method | Endpoint | Auth | 설명 | 상세 문서 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/etl/jobs` | TBD | job 목록 hydrate, 상태/실행 유형 필터, status facet | `docs/api-contract.md` |
| `GET` | `/api/etl/jobs/{jobId}` | TBD | job 상세 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets` | TBD | dataset 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}` | TBD | dataset 상세 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}/lineage` | TBD | column-level lineage graph hydrate 또는 fallback | `docs/api-contract.md` |
| `DELETE` | `/api/catalog/datasets/{datasetId}/materialization-runs/{runId}` | TBD | dataset 안의 append/materialize 결과 metadata 삭제 및 부모 rows/size 재계산 | `docs/api-contract.md` |
| `GET` | `/api/s3/buckets` | TBD | Target 저장경로 선택용 허용 bucket 목록 | `docs/api-contract.md` |
| `GET` | `/api/s3/prefixes` | TBD | Target 저장경로 선택용 S3 prefix lazy 조회 | `docs/api-contract.md` |
| `GET` | `/api/target/databases` | TBD | Target 기본정보 DB 선택용 허용 DB 목록 | `docs/api-contract.md` |
| `POST` | `/api/catalog/derived-datasets` | TBD | SQL preview 결과 기반 dataset 생성 | `docs/api-contract.md` |

현재 P1 API의 `Auth` 값은 local session actor 또는 임시 actor header fallback을 기준으로 확장 중이다. Create flow의 Permission 입력값과 `owner` 표시는 governance/identity metadata이며, 실제 접근 제어는 `ActorContext`와 resource별 `permissionGrants`를 기준으로 판정한다. Catalog/SQL/Job/Dashboard runtime의 공통 권한 계약은 `docs/api-contract.md`의 Permission/Governance 용어를 따른다.

## 6) P2 / 확장 API

| Method | Endpoint | 설명 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 로컬 demo 계정 로그인, `asklake_session` 쿠키 발급 |
| `POST` | `/api/auth/signup` | 로컬 viewer 계정 생성 후 `asklake_session` 쿠키 발급 |
| `GET` | `/api/auth/session` | 현재 세션 사용자 조회. 세션 없으면 unauthenticated |
| `POST` | `/api/auth/logout` | 서버 session 삭제 및 쿠키 제거 |
| `GET` | `/api/dashboards` | dashboard 목록 조회 |
| `POST` | `/api/dashboards/query` | dashboard 검색, 소유자/태그 필터, 정렬, pagination 조회 |
| `POST` | `/api/dashboards` | dashboard card를 `draft` 상태로 생성 |
| `PATCH` | `/api/dashboards/{dashboardId}` | dashboard title 등 card metadata 수정 |
| `DELETE` | `/api/dashboards/{dashboardId}` | dashboard 삭제. admin/owner fallback 또는 `delete` grant 필요 |
| `GET` | `/api/dashboards/{dashboardId}/published` | published revision 기반 runtime 조회 |
| `POST` | `/api/dashboards/{dashboardId}/draft/ensure` | draft revision 조회 또는 생성 |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages` | draft page 추가 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page 이름 수정 |
| `DELETE` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page와 해당 page widgets 삭제 |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets` | draft page에 widget 추가 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/widgets/{widgetId}` | draft widget type/title/datasetId/config 수정 |
| `DELETE` | `/api/dashboards/{dashboardId}/draft/widgets/{widgetId}` | draft widget 삭제 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/layouts` | draft widget layout batch 저장 |
| `POST` | `/api/dashboards/{dashboardId}/publish` | dashboard 게시 |
| `GET` | `/api/users/me` | 현재 actor 프로필, role, group, 권한 요약 조회 |
| `GET` | `/api/admin/users` | 관리자 사용자 목록 조회. admin role 필요 |
| `GET` | `/api/admin/groups` | 관리자 그룹 목록 조회. admin role 필요 |
| `GET` | `/api/admin/permissions` | resource별 permission grant/현재 actor 권한 요약 조회. admin role 필요 |
| `POST` | `/api/admin/permissions` | permission grant 생성. admin role 필요 |
| `PATCH` | `/api/admin/permissions/{grantId}` | permission grant principal/actions 수정. admin role 필요 |
| `DELETE` | `/api/admin/permissions/{grantId}` | permission grant 삭제. admin role 필요 |
| `GET` | `/api/admin/governance-controls` | 사용자/그룹 차단과 resource lock 상태 조회. admin role 필요 |
| `PATCH` | `/api/admin/governance/principals` | 사용자 또는 그룹 차단/해제. admin role 필요 |
| `PATCH` | `/api/admin/governance/resource-locks` | Dataset/Job/Dashboard 잠금/해제. admin role 필요 |
| `GET` | `/api/admin/audit-logs` | 관리자 감사 로그 조회/검색. admin role 필요 |

Dataset 기반 widget 생성은 top-level `datasetId`, `type`, type별 `config`를 함께 전송한다. 지원 runtime widget type은 `metric`, `table`, ApexCharts 차트 8종(`bar_chart`, `line_chart`, `area_chart`, `donut_chart`, `pie_chart`, `radial_bar_chart`, `heatmap_chart`, `treemap_chart`)으로 둔다. Draft runtime 응답은 각 widget의 `queryId`, `datasetId`, `type`, `config`, `data` snapshot을 유지해야 한다.

Profile/Admin Console API는 `asklake_session` 쿠키가 있으면 session actor를 우선 사용하고, 세션이 없으면 임시 actor header(`X-AskLake-User`, `X-AskLake-Role`, `X-AskLake-Groups`) fallback으로 동작한다. `/api/users/me`는 모든 actor가 호출할 수 있고, `/api/admin/*`는 admin role이 아니면 `403 FORBIDDEN`을 반환한다. 관리 콘솔 권한 편집 API는 `dataset`, `etl_job`, `dashboard` resource에 대해 `user`, `group`, `role`, `public` principal grant를 저장할 수 있다. 지원 action은 `view`, `query`, `run`, `manage`, `delete`, `share`이며, 운영 UI의 기본 흐름은 group grant와 user 예외 grant를 우선 사용한다. Admin 권한은 resource 접근 그룹이 아니라 `role=admin`으로 부여되며, 로컬 demo admin 계정은 groups를 비워 둔다. `role`/`public` grant는 계약상 지원하지만 운영 위험이 크므로 관리 콘솔의 기본 추가 옵션으로 노출하지 않는다. Governance controls는 user/group principal을 `blocked`로 전환하거나 resource를 잠글 수 있다. 관리 콘솔에서는 user 차단은 사용자 탭, group 차단은 그룹 탭, resource lock은 권한 탭의 선택 resource action으로 배치한다. 차단/잠금 사유는 관리자 내부 표시와 감사 로그용이며 일반 사용자-facing 메시지에는 노출하지 않는다. 차단된 actor는 grant가 있어도 resource 접근/실행에서 403을 받고, 잠긴 resource는 view를 제외한 `query/run/manage/delete/share` action을 403으로 차단한다.

Dashboard FastAPI 구현은 두 lane으로 나눈다.

| Lane | 목적 | Endpoint 범위 | Backend 파일 기준 |
| --- | --- | --- | --- |
| Card/List | 랜딩 페이지 목록, 생성, 제목 수정, 삭제 | `GET /api/dashboards`, `POST /api/dashboards/query`, `POST /api/dashboards`, `PATCH /api/dashboards/{dashboardId}`, `DELETE /api/dashboards/{dashboardId}` | `backend/app/schemas/dashboard.py`, `api/dashboard_card.py`, `services/dashboard_card_service.py`, `repositories/dashboard_card_repository.py` |
| Runtime | 내부 조회/편집, page, widget, layout, publish | `GET /api/dashboards/{dashboardId}/published`, `POST /api/dashboards/{dashboardId}/draft/ensure`, draft page/widget/layout/publish APIs | `backend/app/schemas/dashboard.py`, `api/dashboard_runtime.py`, `services/dashboard_runtime_service.py`, `repositories/dashboard_runtime_repository.py` |

Card/List lane은 `DashboardCard`와 `DashboardListResponse`를 기준으로 한다.
Runtime lane은 `DashboardRuntimeResponse`와 `DashboardRuntimeWidget`을 기준으로 한다.
두 lane은 `dashboardId`와 `publishedRevisionId`만 공유하고, 자세한 table 경계는 `docs/api-contract.md`의 Dashboard FastAPI 구현 경계를 따른다.

## 7) 화면별 데이터 계약

| 화면 | 현재 데이터 | Future API |
| --- | --- | --- |
| 수집/처리 목록 | Postgres JSONB-backed live backend hydrate | `GET /api/etl/jobs` |
| 수집/처리 상세 | selected job state | `GET /api/etl/jobs/{jobId}` |
| 생성 flow | `DraftPipeline` state | `POST /api/etl/jobs` |
| Target 저장경로 | S3 bucket/prefix picker가 `target.storagePath` string을 갱신 | `GET /api/s3/buckets`, `GET /api/s3/prefixes`, `POST /api/etl/jobs` |
| Target DB 선택 | DB picker가 `target.databaseName` string을 갱신하고 hidden tableName은 datasetName을 사용 | `GET /api/target/databases`, `POST /api/etl/jobs` |
| Source/Schema 연결 | `testSourceConnector` mock/live adapter | `POST /api/etl/sources/test` |
| 조건부 레코드 구조화 | Source에서 선택한 `.txt`/`.log` raw preview와 `DraftPipeline.recordParsing` | `POST /api/etl/record-parsing/preview` |
| 카탈로그 | Postgres JSONB-backed live backend hydrate | `GET /api/catalog/datasets` |
| 카탈로그 상세 | selected dataset state | `GET /api/catalog/datasets/{datasetId}` |
| Lineage | `LineageGraph` mock/fallback | `GET /api/catalog/datasets/{datasetId}/lineage` |
| SQL 분석 | `executeQueryPreview` mock/live, `executeQueryDraft` 호환 wrapper | `POST /api/query/runs` preview mode |
| Query AI 생성 | mock mode는 선택 metadata 기반 로컬 JOIN 초안 fallback, live mode는 선택 metadata를 포함해 FastAPI/OpenAI 호출 후 선택 JOIN 누락 시 로컬 fallback | `POST /api/query/ai-suggestions` |
| SQL 결과 Dataset 생성 | UI는 SQL 내부 다단계 모달에서 스케줄·거버넌스·저장 설정을 완료하고 `createSqlDatasetJob`으로 명시적 draft를 제출; backend direct materialize API는 `createDerivedDatasetFromSql` 호환 유지 | `POST /api/etl/jobs`, `POST /api/catalog/derived-datasets` |
| 대시보드 | FastAPI dashboard adapter, 404 local/mock fallback | `GET /api/dashboards`, `POST /api/dashboards/query`, draft/published runtime APIs |
| 감사 로그 | 서버 `audit_events` 조회 + local/localStorage 최근 호출 | `GET /api/admin/audit-logs` |

SQL 화면은 한국어/공백 dataset·column 표시명을 금지하지 않는다. 자동완성, 기본 쿼리, 컬럼 삽입, JOIN 초안 생성은 SQL 실행명으로 `"월별 매출 데이터"`처럼 double-quoted identifier를 사용한다. 사용자가 따옴표 없이 한글/공백 table reference를 직접 입력하면 frontend preflight가 실행 전에 감지하고 quoted identifier 자동 보정을 제안한다. backend table context 검증은 표시명 문자열만 믿지 않고 `baseDatasetId`와 `referenceDatasetIds`로 선택된 dataset 범위를 계속 source of truth로 사용한다.

Schedule UI는 `직접 실행`과 `반복 실행` 두 선택지만 사용하며, `직접 실행`은 payload의 `스케줄링 건너뛰기` label로 정규화한다. 스케줄링을 건너뛰면 사용자가 `POST /api/etl/jobs/{jobId}/commands`의 `run` command action으로 필요할 때 1회 Run을 만든다. 반복 실행을 선택한 때만 반복 주기, 실행 시각, IANA `timezone`, `overlapPolicy`를 노출하며 재시도 상세값은 재시도 사용 시에만 표시한다. `startDate`, `endDate`, `nextRunUtc`, `watermarkPolicy`는 create request에 보존하되 UI에서는 기본값을 사용한다. 기본 `overlapPolicy`는 `skip_if_running`이며, 재시도는 다음 예약 시각 계산을 밀지 않고 현재 Run 안에서 2배 지수 백오프 정책으로 처리한다.

SQL 분석 UI는 Preview 행 수를 10~100 범위에서 10행 단위로 선택하고, 선택값을 기존 `executeQueryPreview(..., { limit })` 옵션으로 전달한다. API request/response shape는 바뀌지 않으며 응답 `previewLimit`은 실제 실행된 제한값을 유지한다.

Catalog의 `storageLocation`이 `s3://` 또는 `s3a://` Parquet이면 `POST /api/query/runs`는 backend S3/MinIO credential로 object를 query-scoped 임시 cache에 읽어 DuckDB에 등록한다. 원격 파일 합계는 `ASKLAKE_SQL_PREVIEW_MAX_REMOTE_BYTES` 기본 512 MiB로 제한하며, 연결·인증·object 오류를 빈 Preview로 숨기지 않고 `SQL_STORAGE_ERROR`로 반환한다.

SQL 위젯 생성은 별도 AI/API 호출 없이 현재 `SqlResultDraft` 또는 선택한 `CatalogDataset.sampleRows`를 `DashboardDatasetOption`으로 변환한다. 왼쪽 `차트 생성하기`는 Dashboard runtime의 `WidgetConfigPanel`을 재사용해 동일한 위젯 유형, 필드, 집계, 색상 설정을 제공하고, 명시적으로 생성한 뒤 기존 `WidgetRenderer`로 오른쪽 `차트 보기`에 렌더링한다. `데이터 미리보기`는 원본 SQL 표를 유지한다. 위젯 설정은 SQL 화면 메모리에만 유지하며 SQL 결과 toolbar에서는 Dashboard 저장 또는 `대시보드 만들기` action을 노출하지 않는다.

## 8) Pair Handoff Contracts

Pair 간 전달 객체는 API field name을 사용한다.
ID field는 camelCase로 고정하고, 화면 표시용 한국어 상태값을 전달 객체에 넣지 않는다.

### Dashboard Runtime Contract

Dashboard 상세/편집 runtime은 dashboard card metadata와 revision snapshot을 분리한다.

```ts
type DashboardRuntimeWidgetType =
  | "metric"
  | "table"
  | "bar_chart"
  | "line_chart"
  | "area_chart"
  | "donut_chart"
  | "pie_chart"
  | "radial_bar_chart"
  | "heatmap_chart"
  | "treemap_chart";
type DashboardWidgetAggregation = "sum" | "avg" | "count" | "min" | "max";
type DashboardWidgetDateUnit = "day" | "month" | "year";
type DashboardWidgetFormat = "number" | "currency" | "percent";
type DashboardWidgetSortDirection = "asc" | "desc";

type DashboardWidgetColorConfig = {
  colors: string[];
};

type DashboardWidgetConfigBase = {
  body?: string;
  description?: string;
  error?: string;
  errorMessage?: string;
  placeholderKind?: "visualization_request" | "text";
  prompt?: string;
};

type MetricWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  format?: DashboardWidgetFormat;
  valueKey: string;
};

type TableWidgetConfig = DashboardWidgetConfigBase & {
  columns: string[];
  limit?: number;
  sortDirection?: DashboardWidgetSortDirection;
  sortKey?: string;
};

type BarChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  groupKey?: string;
  orientation?: "vertical" | "horizontal";
  xKey: string;
  yKey: string;
};

type LineChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  curve?: "smooth" | "straight" | "stepline";
  dateUnit?: DashboardWidgetDateUnit;
  seriesKey?: string;
  xKey: string;
  yKey: string;
};

type AreaChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  dateUnit?: DashboardWidgetDateUnit;
  seriesKey?: string;
  stacked?: boolean;
  xKey: string;
  yKey: string;
};

type DonutChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  centerLabel?: string;
  labelKey: string;
  valueKey: string;
};

type PieChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  labelKey: string;
  valueKey: string;
};

type RadialBarChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  format?: DashboardWidgetFormat;
  labelKey?: string;
  max?: number;
  min?: number;
  valueKey: string;
};

type HeatmapChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  valueKey: string;
  xKey: string;
  yKey: string;
};

type TreemapChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  labelKey: string;
  valueKey: string;
};

type DashboardRuntimeWidget = {
  id: string;
  pageId: string;
  type: DashboardRuntimeWidgetType;
  title: string | null;
  layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number };
  config:
    | MetricWidgetConfig
    | TableWidgetConfig
    | BarChartWidgetConfig
    | LineChartWidgetConfig
    | AreaChartWidgetConfig
    | DonutChartWidgetConfig
    | PieChartWidgetConfig
    | RadialBarChartWidgetConfig
    | HeatmapChartWidgetConfig
    | TreemapChartWidgetConfig;
  data: Array<Record<string, unknown>>;
  queryId?: string | null;
  datasetId?: string | null;
};

type DashboardRuntimeResponse = {
  dashboard: {
    id: string;
    title: string;
    status: "draft" | "published";
    hasPublishedRevision: boolean;
    updatedAt: string;
  };
  mode: "published" | "draft";
  revision: {
    id: string;
    kind: "published" | "draft";
    version: number;
    publishedAt?: string | null;
  } | null;
  pages: Array<{
    id: string;
    title: string;
    orderIndex: number;
  }>;
  widgetsByPageId: Record<string, DashboardRuntimeWidget[]>;
  filters: Array<{ id: string; label: string; value: unknown }>;
};
```

`POST /api/dashboards`는 랜딩 페이지의 새 대시보드 생성 버튼에서 사용한다. 생성 즉시 `status: "draft"` dashboard card를 DB에 저장하고, 프론트는 응답받은 `dashboard.id`로 `/dashboards/{dashboardId}` 조회 화면에 진입한다. 편집용 draft revision/page/widget은 `위젯 편집` 이후 `POST /api/dashboards/{dashboardId}/draft/ensure`에서 준비한다.

`GET /api/dashboards/{dashboardId}/published`는 published revision이 없으면 `revision: null`, `pages: []`, `widgetsByPageId: {}`를 반환한다. `POST /api/dashboards/{dashboardId}/draft/ensure`는 idempotent이며 draft가 없으면 published snapshot 또는 새 revision과 기본 page를 만든다.

Widget 생성 API는 `datasetId`가 있고 명시적 `data`가 없을 때 catalog dataset의 rows 또는 sample rows를 column name 기반 object row로 변환해 widget `data` snapshot에 저장한다. Runtime widget renderer는 `widget.data`와 type별 `config`를 기준으로 `metric`, `table`, ApexCharts 차트 8종 표시값을 계산한다.

`DELETE /api/dashboards/{dashboardId}`는 dashboard card/list row와 runtime revision/page/widget snapshot을 함께 삭제한다.

### Pair A -> Pair B

```ts
type CreateJobResponse = {
  job: JobRowData;
  dataset: CatalogDataset;
};
```

Create/update/review request의 Rule source of truth는 `ruleContractVersion: "1.0"`과 `rules[]`다. Backend는 저장 전에 canonical Rule을 검증하고 `ruleCompilation.status`, 정확한 `issues[]`, 결정된 `outputSchema`를 반환하며 create/append/update에서 version과 Rule JSON을 그대로 영속화한다. `1.0 + []`는 source schema 그대로의 명시적 pass-through이고 legacy 필드를 되살리지 않는다. canonical 컬럼이 없는 기존 Job만 `transformSteps`, `transformOutputColumns`, `qualityRules`에서 Rule을 재구성하며, 이 호환 표현의 `canonicalParameters`는 `0`, `false`, 빈 문자열, `null`을 손실 없이 보존한다. `fail_batch`와 `quarantine`은 `failureDisposition: "keep"`만 허용하고, `warn`은 `keep`, `drop_row`, `set_null`을 사용할 수 있다. 버전 누락/불일치, 잘못된 kind·오류 정책·severity, 지원하지 않는 parameter는 각각 구조화된 `RULE_*` issue로 거절한다. Continuous는 Snapshot conformance를 통과한 stateless 공통 operation을 허용하고 임의 SQL/stateful operation만 `RULE_EXECUTION_MODE_UNSUPPORTED`로 거절한다.

Schema Transform UI는 원본 `SchemaColumnDraft.sourceType`과 target `type`을 별도로 보존한다. 컬럼명, 타입, 기본값, NOT NULL 변경은 각각 `rename`, `cast`, `default_value`, `null_guard` Rule로 순서대로 직렬화한다. `POST /api/etl/rules/preview`는 canonical Rule을 다시 compile한 뒤 portable Rule은 bounded 공통 runtime, 일반 Snapshot SQL expression은 bounded Spark runtime에 적용하므로 브라우저 전용 변환 해석을 사용하지 않는다. Preview는 최대 100개 sample만 처리하며 target, Catalog, source progress를 변경하지 않는다. Continuous도 streaming-safe Visual Transform과 Preview를 사용하며 임의 SQL은 노출하거나 실행하지 않는다. Regex pattern, Accepted Values, Range bounds, mask policy, timestamp format은 compiler가 실행 전에 검증하며 V1 mask는 phone, timestamp는 ISO-8601(`UTC` legacy alias 포함)만 지원한다.

필수 확인:

- `dataset.id`, `dataset.name`, `dataset.schema`, `dataset.sampleRows`, `dataset.rows`, `dataset.size`가 있어야 SQL context를 만들 수 있다.
- `dataset.lineageGraph`가 있으면 Catalog lineage modal은 생성 직후 이 그래프를 우선 사용한다.
- `dataset.upstream`이 있으면 Catalog lineage modal의 source/upstream -> current fallback을 만들 수 있다.
- `dataset.downstream`은 SQL, dashboard, mart 같은 영향도/소비처 context에 사용할 수 있다.
- 생성 후 ETL 목록과 Catalog 목록에 같은 `job.id`와 `dataset.id` 기준 결과가 보여야 한다.
- 같은 Job 또는 표시명이 정확히 같은 `targetDataset`으로 생성/실행한 결과는 새 Catalog row를 늘리지 않고 기존 dataset의 `materializationRuns`에 append한다. append 대상 판정은 손실 가능한 slug가 아니라 저장된 `targetDataset` 표시명으로 수행한다. 새 dataset의 내부 `datasetId`는 안전한 소문자 ASCII 이름이면 `ds_<name>`, 그 외에는 `ds_<slug>_<stable-hash>` 형식이므로 서로 다른 한글·공백·특수문자 이름이 같은 ID로 합쳐지지 않는다. Catalog 목록 row는 하나만 보이고, row 펼침에서 append history를 최대 5개씩 pagination으로 표시한다.
- Target draft의 `storageType`, `partition`, `partitionColumns`, `indexColumns`, `compression`, `storagePath`, `targetDatabase`, `targetDescription`, `targetTags`는 `targetDataset`, `targetLayer`, `targetFormat`과 함께 create request에 전달된다. 다중 파티션 컬럼은 선택 순서를 유지한 `partitionColumns` 배열과 `/`로 연결한 하위 호환용 `partition` 문자열로 함께 전송한다. SQL 결과 처리 Job wizard도 같은 target metadata를 구성한 뒤 기존 create request로 변환한다.
- Target 화면은 모든 Source에서 `targetLayer`를 명시적으로 선택한다. Kafka Snapshot은 `RAW/BRONZE/SILVER + JSONL`, Kafka Continuous는 Parquet 포맷만 노출하고 backend review/create/update도 같은 조합을 검증한다.
- `rag` 필드는 호환을 위해 create request에 남아 있지만, 현재 Target 화면에서는 노출하지 않고 frontend 기본값은 `false`다.
- Target 화면은 기본정보, 태그, 파티션 단위로 구성되며 태그/파티션 섹션은 접고 펼칠 수 있다.
- Source/schema sample이 `data` JSON 단일 컬럼으로 들어오면 frontend가 JSON을 dot-path 컬럼으로 펼쳐 `schemaRules`와 preview를 만든다. 원본 JSON 보존용 `raw_data` 컬럼은 기본 미사용 optional 컬럼으로 제공한다.
- Target 화면 저장은 backend API가 없는 현 범위에서 `window.localStorage["asklake.targetConfigDraft"]`에 `{ metadata, tags, partitionColumns, indexColumns, schemaRules, previewRows, lineage, lastTestRun }` 형태로 저장한다. Review 생성 요청과 Spark run 성공 후 Catalog dataset metadata는 같은 Target draft 값을 사용해야 한다.

Mock mode에서는 Pair A pipeline 생성 dataset과 backend direct SQL derived dataset을 모두 `window.localStorage["asklake.catalogDatasets"]`에 저장하고 앱 로드시 mock catalog dataset 앞에 병합한다. 현재 SQL 화면의 `처리 Job 생성` UI는 직접 localStorage에 dataset을 쓰지 않고, 모달에서 만든 설정을 SQL Result 기반 `DraftPipeline`으로 변환해 기존 Job 생성 경로를 사용한다. 이때 접근 범위는 권한 요약과 역할 metadata에 동기화하고, 스케줄·DB·파일 포맷·압축·다중 파티션·태그·저장 경로·설명은 mock Job과 dataset에도 보존한다. 기존 `asklake.derivedDatasets` 값은 읽기 호환만 유지한다. Live API mode에서는 localStorage fallback을 사용하지 않고 backend catalog persistence와 `GET /api/catalog/datasets` 응답을 source of truth로 둔다.

Catalog dataset의 `materializationRuns` 항목은 `runId`, `jobId`, `status`, `createdAt`, `rowCount`, `storageSizeBytes`, `storageLocation`, `sourceKind`, `sourceLabel`을 포함한다. Kafka Continuous materialization은 추가로 `sourceRanges`, `publicationManifest`, schema/rule/runtime fingerprint, `transform`, `quality` 실행 결과를 반환하며 replay에도 같은 Rule 실행 정체성을 유지한다. 부모 dataset의 `rows`, `size`, `storageSizeBytes`, `lastUpdated`, `sourceRunId`는 삭제되지 않은 성공 append 결과 기준 합산/최신값으로 계산한다.

### Pair A -> Pair C

```ts
type JobCommandResponse = {
  action: "etl.run.requested" | "etl.run.retry_requested" | "etl.job.pause_requested" | "etl.run.cancel_requested" | "etl.schedule.stop_requested" | "etl.schedule.resume_requested";
  apiPath: string;
  job?: JobRowData;
  run?: {
    runId: string;
    jobId: string;
    status: "queued" | "running" | "success" | "failed" | "canceled";
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
  };
  dagSteps?: Array<{
    completedAt?: string;
    duration?: string;
    id: string;
    title: string;
    status: "pending" | "running" | "success" | "failed" | "blocked";
  }>;
  datasetPatch?: Partial<CatalogDataset>;
  processingResult?: DataProcessingResult;
};
```

필수 확인:

- `job`이 있으면 프론트는 해당 응답을 기준으로 Job 상태를 갱신한다.
- `run.runId`가 있으면 Dashboard의 `sourceRunId`까지 이어진다.
- `processingResult.runId`와 `processingResult.datasetId`는 Run, Catalog, SQL, Dashboard에서 같아야 한다.

프론트 Run 상태 계약:

```ts
type RunsByJobId = Record<string, JobRunSummary[]>;
type SelectedRunIdByJobId = Record<string, string>;
type DagStepsByRunId = Record<string, JobDagStep[]>;
```

필수 규칙:

- `runsByJobId[job.id]`는 최신 Run을 앞에 둔다.
- 같은 `run.runId`가 다시 들어오면 기존 Run을 교체한다.
- 새 Run이 들어오면 `selectedRunIdByJobId[job.id]`를 그 `run.runId`로 갱신한다.
- `dagSteps`는 별도 `runId` 필드를 요구하지 않고, 같은 응답의 `run.runId` 기준으로 `dagStepsByRunId`에 저장한다.
- 완료된 단계는 가능하면 `duration`과 `completedAt`을 함께 제공한다. 진행·대기 단계에서 아직 확정되지 않은 값은 생략할 수 있다.
- Run History 안의 실행 흐름 카드는 `runs[0]`이 아니라 `selectedRunIdByJobId[job.id]` 기준으로 단계를 찾는다.
- History는 `selectRunForJob(jobId, runId)` action으로만 선택 Run을 바꾼다.
- 초기 hydrate 시 `job.runHistory`는 `runsByJobId[job.id]`로 옮기고, `job.dagSteps`는 최신 Run의 `runId`에 묶는다.
- PR1 optimistic 실행 상태는 API request에 `clientRunId`를 추가하지 않고 frontend temp id `client:<jobId>:<timestamp>`를 만든 뒤, 서버 응답의 `run.runId`로 교체한다.

### Pair B -> Pair C

```ts
type QueryRunResponse = SqlResultDraft;
```

필수 확인:

- `columns`와 `rows`가 Table Widget의 데이터가 된다.
- `runId`는 Dashboard `sourceRunId`가 된다.
- `datasetId`는 Dashboard `datasetId`와 같아야 한다.
- `mode: "preview"`와 `previewLimit`이 있으면 전체 materialize가 아니라 SQL Preview 결과로 취급한다.
- Dashboard route가 `dash_<baseDatasetId>_<runId>` 형태로 직접 열리면 프론트는 `GET /api/query/runs/{runId}`로 SQL result snapshot을 복구한다.

### Pair B -> Pair C: Lineage Context

```ts
type LineageContext = {
  datasetId: string;
  nodes: Array<{
    id: string;
    label: string;
    role: "upstream" | "current" | "downstream";
  }>;
  edges: Array<{
    from: string;
    to: string;
  }>;
  selectedNodeId: string;
};
```

정식 Catalog lineage modal은 `LineageGraph` contract를 React Flow node/edge로 변환해 표시한다.
ETL graph의 source는 `SOURCE · <fileFormat|connectorType>`, 가운데 Job은 `PROCESS · SPARK`, target은 `<targetLayer> LAYER · <persistedFormat>`으로 표시한다. 현재 Spark runner는 physical output을 Parquet로 저장하므로 요청 `targetFormat`과 무관하게 target engine은 `PARQUET`이다. 따라서 Parquet source에서 GOLD로 처리한 결과는 `SOURCE · PARQUET -> PROCESS · SPARK -> GOLD LAYER · PARQUET`이며 Job을 BRONZE dataset이나 ICEBERG target으로 추정하지 않는다. 화면의 상위 데이터셋 수에는 `PROCESS` node를 포함하지 않는다.
Lineage API가 없으면 `CatalogDataset.upstream`으로 mock fallback graph를 만들고, `CatalogDataset.downstream`은 별도 영향도 context로 분리할 수 있다.

### Optional Large-Scale Evidence Extension

```ts
type DataProcessingResult = {
  runId: string;
  datasetId: string;
  inputBytes: number;
  inputRows: number;
  outputBytes?: number;
  outputPath: string;
  outputFiles?: number;
  durationMs: number;
  status: "success" | "failed";
  retryCount: number;
  scaleLabel: "sample" | "500MB" | "1GB";
  caveat?: string;
};
```

`DataProcessingResult`는 대용량 처리 증거가 필요할 때만 쓰는 optional demo evidence 확장 객체다.
정식 persistence API가 생기기 전에는 `JobCommandResponse.processingResult` 또는 fixture로 전달한다.

### Dashboard Assistant UI Hook

대시보드 draft editor의 AskLake 보조 패널과 시각화 요청 위젯은 `POST /api/dashboards/assistant` FastAPI endpoint에 연결할 수 있다.
이 endpoint는 `OPENAI_API_KEY`가 설정되어 있고 `OPENAI_ASSISTANT_ENABLED=true`이면 OpenAI Responses API를 호출한다.
서버는 요청의 `dashboardId`/`pageId`를 기준으로 DB에서 draft 우선, 없으면 published runtime을 읽고,
대시보드에서 사용할 수 있는 available catalog dataset, 현재 page widget, 지원 가능한 widget type/config option만 OpenAI 컨텍스트에 넣는다.
단, `selectedWidgetId` 또는 `widgetId`가 있으면 해당 위젯 하나만 context/수정 후보로 제한한다.
OpenAI 응답은 backend guard가 한 번 더 검증하며, 없는 dataset/widget/column 또는 지원하지 않는 widget type/config는 action에서 제외하고 `warnings`에 이유를 담는다.
OpenAI 설정이 없거나 호출이 실패하면 응답 `message`/`warnings`에 `mock fallback`을 명시한 fallback 응답을 반환한다.
프론트는 기본 경로 `/api/dashboards/assistant`로 `POST` 요청을 보내며, `VITE_DASHBOARD_ASSISTANT_API_PATH`로 다른 경로 또는 origin을 지정할 수 있다.

프론트 요청 payload:

```ts
type DashboardAssistantRequest = {
  dashboardId?: string;
  mode: "dashboard_question" | "visualization_request";
  pageId?: string | null;
  prompt: string;
  selectedWidgetId?: string | null;
  widgetId?: string | null;
  widgets: Array<{
    id: string;
    title: string;
    type: DashboardRuntimeWidgetType;
    datasetId: string | null;
    layout: DashboardWidgetLayout;
    config: Record<string, unknown>;
    dataSample: Array<Record<string, unknown>>;
  }>;
};
```

권장 응답 payload:

```ts
type DashboardAssistantResponse = {
  message: string;
  actions: Array<
    | {
        type: "create_widget";
        widget: {
          title: string;
          type: DashboardRuntimeWidgetType;
          datasetId: string;
          config: DashboardRuntimeWidgetConfig;
        };
      }
    | {
        type: "update_widget";
        widgetId: string;
        patch: {
          title?: string | null;
          type?: DashboardRuntimeWidgetType;
          datasetId?: string | null;
          config?: Record<string, unknown>;
        };
      }
    | {
        type: "report";
        markdown: string;
      }
  >;
  warnings: string[];
  // 현재 visualization request 위젯 호환용 임시 필드.
  configPatch?: Record<string, unknown>;
  widgetPatch?: {
    title?: string | null;
    type?: DashboardRuntimeWidgetType;
    datasetId?: string | null;
    config?: Record<string, unknown>;
  };
};
```

`dashboard_question` 모드는 리포트/분석 결과를 `actions: [{ type: "report", markdown }]` 형태로 받을 수 있다.
`visualization_request` 모드는 장기적으로 `actions`의 `create_widget` 또는 `update_widget`을 적용한다.
현재 시각화 요청 위젯은 기존 구현과의 호환을 위해 `configPatch` 또는 `widgetPatch.config`가 내려오면 현재 위젯 config에 병합한다.
`VITE_DASHBOARD_ASSISTANT_API_PATH`가 없으면 기본 경로 `/api/dashboards/assistant`를 사용한다.
`widgets`는 구버전/테스트 호환 fallback payload로 유지하지만, `dashboardId`가 있으면 서버 DB runtime 컨텍스트가 우선이다.
`selectedWidgetId` 또는 `widgetId`가 있으면 서버는 해당 위젯만 `update_widget` 대상에 포함한다.
서버 guard는 Assistant가 없는 컬럼이나 문자열 값축을 반환하면 catalog schema/sample rows 기준으로 보정한다. 차원-only 요청은 `count` 집계 차트로 보정하고, `revenue`/`total_amount` 같은 금액 alias는 실제 dataset 컬럼에 맞춰 정규화한다. OpenAI 응답에서 적용 가능한 action이 남지 않으면 서버가 요청 문장과 available dataset 기준의 기본 막대 차트 `create_widget`/`update_widget` action을 생성할 수 있다.

## 8.1) ETL Review Snapshot

`POST /api/etl/review`는 생성 직전 Review 화면에서 사용할 단일 snapshot을 반환합니다.

- 요청은 `POST /api/etl/jobs`와 같은 pipeline draft 계약에 `sourceConnectionStatus`를 추가합니다.
- live mode에서는 source status가 `success`일 때 backend가 source connector를 다시 확인하고, 실패하면 Review의 소스 연결 상태를 `확인 필요`로 반환합니다.
- 응답은 `basicInformation`, `schema`, `destination`, `permission`, `validation`, `canCreate`를 포함합니다.
- frontend는 이 응답만 화면에 표시하며, 생성 버튼은 `canCreate`가 `true`일 때만 활성화합니다.
- mock mode는 같은 응답 shape의 fixture를 반환하며, live API를 호출하지 않습니다.

## 9) 변경 규칙

- Endpoint, request, response, status code, error code가 바뀌면 이 문서와 `docs/api-contract.md`를 함께 업데이트한다.

## 10) ETL Permission 옵션 및 grant 저장

`GET /api/etl/permission-options`는 ETL 생성 화면에서 선택할 수 있는 조직 그룹과 사용자를 반환한다. 직접 사용자·그룹 권한을 설정하는 기능이므로 현재 actor의 `role`이 `admin`이어야 하며, 그렇지 않으면 `403 FORBIDDEN`을 반환한다. 이 응답은 권한 요약이나 전체 resource 목록을 계산하지 않는 경량 디렉터리 조회다.

```ts
type PermissionOptionsResponse = {
  groups: Array<{
    id: string;
    name: string;
    description?: string;
    actions: Array<"view" | "query" | "run" | "manage" | "delete" | "share">;
  }>;
  users: Array<{
    id: string;
    name: string;
    email: string;
    initials: string;
    role: string;
  }>;
};
```

`POST /api/etl/jobs`와 `PATCH /api/etl/jobs/{jobId}`는 기존 `permissionGrants?: PermissionGrant[]` 계약을 실제 저장 경로로 사용한다. 전달된 grant는 해당 Job의 `permission_ui` source 행으로 저장되며, 수정 시 기존 `permission_ui` 행만 교체한다. 관리 콘솔에서 생성한 `admin` source grant는 유지한다. 생성·수정 응답의 `permissionGrants`와 actor별 `permissions`에는 저장 결과가 즉시 반영된다.
- Mock/live 전환 순서가 바뀌면 `docs/backend-integration-readiness.md`를 업데이트한다.
- Frontend 타입이 바뀌면 관련 `frontend/src/types/`와 문서를 함께 업데이트한다.
## Text Structuring Runtime Contract

- `GET /api/catalog/models` and `GET /api/text-structuring/models` return model artifacts separately from Catalog datasets.
- `POST /api/text-structuring/training-runs` trains portable `one_of_values` text models from labeled rows. Only models that pass the internal quality gate are saved as reusable runtime artifacts.
- The Text Structuring schema editor stores `method`, `allowedValues`, `modelSelectionPolicy`, `modelArtifact`, `fallbackAllowed`, and `requireModel` per output column.
- `Auto select` means automatic compatible model selection. Rule fallback is a separate explicit policy: `fallbackAllowed: true` and `requireModel: false`.
- Spark run results include `textStructuring.definition` and `textStructuring.execution`; job runs, Catalog datasets, and materialization runs preserve `textStructuringExecution`.
- Column execution records must distinguish `executionMode: "selected_model"`, `executionMode: "auto_model"`, `executionMode: "fallback_rule"`, and `executionMode: "missing_model"` so fallback output is not presented as a model result.
- Model dropdowns must filter by `targetColumn`, `method: "one_of_values"`, and exact `allowedValues` compatibility for the edited output column.
