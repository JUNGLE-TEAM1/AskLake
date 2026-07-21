Warning: truncated output (original token count: 34950)
Total output lines: 1380

# 03. API Reference

> RAG Dataset API(`/api/catalog/datasets/{datasetId}/rag/*`)는 2026-07-20에 제거됐다. SQL AI와 Dashboard Assistant의 retrieval 응답은 `mode=disabled`, `status=disabled`, 빈 `sources`를 반환한다.

Query AI 내부 Gateway/MCP 계약은 [ai-gateway-mcp-rollout.md](./ai-gateway-mcp-rollout.md)에 정리되어 있다. Frontend 공개 계약은 기존 `/api/query/ai-suggestions`를 유지한다.

이 문서는 AskLake API/interface 계약의 상위 진입점이다.
상세 request/response shape는 기존 문서인 `docs/api-contract.md`를 기준으로 한다.
백엔드 연결 범위와 남은 작업은 `docs/backend-integration-readiness.md`를 기준으로 한다.

## 1) 현재 상태

- Source/Schema/Create/Run/Catalog/SQL/Dashboard 흐름은 live backend API만 호출한다.
- API 실패는 화면의 오류·재시도 상태로 표시하며 local fixture로 성공을 가장하지 않는다.
- 결정론적 AI provider는 `APP_ENV=test|testing`의 격리 테스트에서만 허용된다.
- `frontend/src/services/apiClient.ts`가 API 호출 wrapper다.
- `frontend/src/services/pipelineApi.ts`가 ETL create/run 호출 진입점이고, `frontend/src/services/sqlQueryApi.ts`가 SQL Query Run·검증·estimate·result 호출 진입점이다. `pipelineApi.ts`의 기존 SQL export는 import 호환을 위해 재수출한다.
- live backend mode에서 ETL job, catalog dataset과 SQL run metadata는 PostgreSQL에 저장된다. Trino 결과 행은 private S3-compatible page object에 두고 PostgreSQL에는 manifest/page metadata만 저장한다.
- ETL/Catalog 초기 hydrate 결과가 Postgres에 비어 있으면 UI도 빈 목록으로 시작한다.
- Issue #488은 local Compose의 Trino 482 + Iceberg JDBC catalog baseline, canonical Query Run, signed-cursor result storage와 Iceberg CTAS Dataset 등록을 제공한다. `/api/query/runs`는 `TRINO_ENABLED`에 따라 Trino runtime과 DuckDB compatibility runtime을 전환한다.

## 2) 환경 변수

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_DASHBOARD_ASSISTANT_API_PATH=/api/dashboards/assistant
VITE_OBJECT_STORAGE_PROVIDER=minio
VITE_S3_REGION=us-east-1
DATABASE_URL=postgres://asklake:asklake_dev@127.0.0.1:54328/asklake
AUTH_SESSION_COOKIE_SECURE=true
ASKLAKE_OBJECT_STORAGE_PROVIDER=minio
S3_ALLOWED_BUCKETS=asklake-output
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
ASKLAKE_DASHBOARD_MAX_REMOTE_BYTES=536870912
ASKLAKE_DASHBOARD_MAX_REMOTE_OBJECTS=256
ASKLAKE_DASHBOARD_QUERY_TIMEOUT_SECONDS=15
TARGET_DATABASES=asklake,asklake_gold,analytics,marketing
TRINO_ENABLED=false
TRINO_BASE_URL=http://localhost:8088
TRINO_CATALOG=iceberg
TRINO_SCHEMA=asklake
TRINO_USER=asklake-api
TRINO_ICEBERG_WAREHOUSE_BUCKET=asklake-warehouse
TRINO_ICEBERG_WAREHOUSE_PREFIX=warehouse
TRINO_QUERY_TIMEOUT_SECONDS=300
TRINO_MAX_RESPONSE_BYTES=20000000
TRINO_RESULT_RETENTION_SECONDS=86400
TRINO_MAX_CONCURRENT_RUNS_PER_USER=2
TRINO_RESULT_STORAGE_BUCKET=asklake-query-results
TRINO_RESULT_STORAGE_PREFIX=query-results
TRINO_RESULT_STORAGE_AUTO_CREATE_BUCKET=false
TRINO_RESULT_CURSOR_SECRET=<server-only random secret>
TRINO_QUERY_CONFIRMATION_SECRET=<server-only random secret>
TRINO_QUERY_CONFIRMATION_TTL_SECONDS=300
TRINO_QUERY_WARNING_BYTES=1073741824
TRINO_QUERY_MAX_ESTIMATED_BYTES=0
TRINO_QUERY_ESTIMATED_THROUGHPUT_BYTES_PER_SECOND=268435456
TRINO_COLLECTOR_LEASE_SECONDS=60
TRINO_COLLECTOR_PAGES_PER_LEASE=100
TRINO_COLLECTOR_POLL_SECONDS=1
TRINO_PROGRESS_POLL_SECONDS=0.5
TRINO_PROGRESS_TIMEOUT_SECONDS=1
TRINO_CLEANUP_POLL_SECONDS=3600
DASHBOARD_SYNC_MODE=sse
DASHBOARD_AUTO_REFRESH_ENABLED=false
REALTIME_EVENTS_ENABLED=true
CONTINUOUS_SQL_JOIN_ENABLED=true
CONTINUOUS_SQL_SERVING_MODE=iceberg
CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=false
CLICKHOUSE_REALTIME_V2_ENABLED=false
KAFKA_CONNECT_SINK_ENABLED=false
CLICKHOUSE_REALTIME_CONSUMER_OWNER=disabled
KAFKA_CONNECT_URL=http://kafka-connect-v2:8083
CLICKHOUSE_URL=http://clickhouse:8123
CLICKHOUSE_USER=asklake
CLICKHOUSE_PASSWORD=<server-only secret>
CLICKHOUSE_DATABASE=asklake
CLICKHOUSE_QUERY_TIMEOUT_SECONDS=60
CLICKHOUSE_STATIC_LOAD_MAX_ROWS=15000000
CLICKHOUSE_INSERT_BATCH_ROWS=20000
LATEST_STATIC_PER_BATCH_ENABLED=false
STATIC_CHANGE_BACKFILL_ENABLED=false
CONTINUOUS_SQL_STATIC_BROADCAST_MAX_ROWS=100000
CONTINUOUS_SQL_MAX_OUTPUT_ROWS_PER_INPUT=10
REALTIME_EVENT_RETENTION_SECONDS=86400
REALTIME_EVENT_PAYLOAD_MAX_BYTES=8192
REALTIME_REPLAY_LIMIT=500
REALTIME_SUBSCRIBER_QUEUE_SIZE=128
REALTIME_CONNECTION_LIMIT_PER_ACTOR=5
REALTIME_HEARTBEAT_SECONDS=15
REALTIME_DISPATCH_POLL_SECONDS=0.5
REALTIME_CLEANUP_INTERVAL_SECONDS=3600
REALTIME_SSE_SEND_TIMEOUT_SECONDS=10
```

로컬 root Compose는 Query Result/Warehouse bucket을 MinIO에 만들고 로컬 전용 credential을 사용한다. Production은 endpoint와 장기 access key/secret을 두지 않고 사전 생성한 AWS S3 Warehouse/Query Result bucket과 EC2 instance profile default credential chain을 사용한다. 최대 100행 Trino preview는 PostgreSQL inline page로 저장하고, 사용자 요청형 full result만 private gzip page object와 PostgreSQL manifest/page metadata로 저장한다. `trino-result-cleanup` worker는 terminal run을 keyset batch로 순회한다.

EKS와 EC2 delivery는 모두 `dev`를 source branch로 사용하고 각 release는 실제 배포 SHA를 별도 receipt에 고정한다. EC2 Compose는 필요할 때만 ClickHouse V2/Kafka Connect 프로필을 opt-in하고, EKS는 Realtime V1-only 프로필에서 해당 서비스와 API mode를 금지한다. Continuous owner는 `deploy/control-plane-ownership.json`에서 정확히 하나여야 한다.

- `VITE_API_BASE_URL`을 생략하거나 빈 문자열로 두면 개발·production build 모두 같은 출처의 `/api`를 호출한다. Realtime event URL도 같은 규칙을 사용한다. Vite는 이를 `VITE_DEV_PROXY_TARGET` 또는 기본 `http://127.0.0.1:8080`으로 전달하고, frontend container의 Nginx는 Compose `backend:8080`으로 전달하되 `/api/realtime/events`는 SSE buffering을 끈다.
- SQL Query AI, Dashboard Assistant, ETL transform, 리뷰 분석 frontend client는 세션을 포함한 live API만 호출한다. 개발 전용 `VITE_USE_MOCK_API` 호환 모드는 이 AI client들에 적용되지 않으며, production에서는 계속 비활성화된다.
- Legacy demo 계정은 production에서 기본 생성·복구되지 않는다. 재배포는 기존 `auth_users.status`와 session을 보존한다. 공개 demo 배포는 `AUTH_LEGACY_DEMO_USERS_ENABLED=true`와 `VITE_AUTH_LEGACY_DEMO_USERS_ENABLED=true`를 함께 명시할 때만 누락 계정을 만들거나 disabled 계정을 복구하고 로그인 안내를 활성화한다. preflight는 두 플래그의 lowercase boolean 및 일치를 강제하며, 일반 운영 로그인은 bootstrap admin 또는 승인된 IdP/session 경로를 사용한다.
- `AUTH_SESSION_COOKIE_SECURE`는 운영 세션 쿠키의 `Secure` 속성을 제어하며 기본값은 운영에서 `true`다. HTTPS가 없는 제한된 dev HTTP ALB에서만 `false`를 명시하고, HTTPS 전환 즉시 `true`로 복구한다. 이 설정은 header-auth fallback이나 public signup을 활성화하지 않는다.
- `VITE_DASHBOARD_ASSISTANT_API_PATH`: 미설정 시 `/api/dashboards/assistant`를 사용한다. 다른 Assistant API origin 또는 경로가 필요할 때만 지정한다.
- `DASHBOARD_SYNC_MODE`: `polling`, `hybrid`, `sse` 중 하나다. invalid 값 또는 event backbone 비활성 조합은 effective `polling`으로 fail closed한다.
- `DASHBOARD_AUTO_REFRESH_ENABLED`: backend 호환 설정으로만 남는다. 현재 Dashboard frontend는 값과 관계없이 자동 갱신 토글·EventSource·polling을 시작하지 않고 수동 새로고침만 사용한다.
- `REALTIME_EVENTS_ENABLED`: durable event/SSE 경로의 총괄 kill switch다. Production Compose 기본값은 `true`다.
- `CONTINUOUS_SQL_JOIN_ENABLED`: Continuous SQL create/start 경로의 kill switch다. Production Compose 기본값은 `true`이며 기존 Kafka Continuous ingestion과 정적 SQL에는 영향을 주지 않는다.
- `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED`: Kafka Engine V1 worker의 kill switch다. Production Compose는 V2의 단일 consumer ownership을 위해 기본값을 `false`로 둔다.
- `CLICKHOUSE_REALTIME_V2_ENABLED`, `KAFKA_CONNECT_SINK_ENABLED`: EC2 Production Compose의 opt-in V2 프로필에서 application과 Kafka Connect sink를 함께 활성화한다. 두 값과 consumer owner가 모두 V2일 때 일반 Kafka Continuous `startContinuous`도 Spark bridge 대신 Kafka Connect raw sink를 요청한다. 기본값과 EKS 값은 모두 `false`다.
- `CLICKHOUSE_REALTIME_CONSUMER_OWNER`: 기본값과 EKS 값은 `disabled`다. EC2 V2 프로필에서만 `kafka_connect_v2`를 명시하며, 같은 Job generation에서 `kafka_engine_v1`과 동시에 사용할 수 없다.
- `KAFKA_CONNECT_URL`: production private origin `http://kafka-connect-v2:8083`을 사용한다.
- `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE`: backend가 private ClickHouse HTTP endpoint를 호출할 때 쓰는 서버 전용 연결값이다. password는 frontend와 API 응답에 노출하지 않는다.
- `CLICKHOUSE_QUERY_TIMEOUT_SECONDS`, `CLICKHOUSE_STATIC_LOAD_MAX_ROWS`, `CLICKHOUSE_INSERT_BATCH_ROWS`: Dashboard 질의 timeout, 시작 시 S3/Iceberg 정적 snapshot 적재 상한, 적재 batch 크기다.
- `LATEST_STATIC_PER_BATCH_ENABLED`, `STATIC_CHANGE_BACKFILL_ENABLED`: Continuous SQL이 활성화된 경우에만 effective true가 될 수 있는 advanced mode opt-in이다.
- `CONTINUOUS_SQL_STATIC_BROADCAST_MAX_ROWS`: Catalog row 통계가 이 값 이하인 static relation만 broadcast 후보가 된다. 통계가 없으면 broadcast하지 않는다.
- `CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS`: Catalog row 통계가 이 값 이하인 static snapshot만 worker memory/disk cache 후보가 된다. 기본값은 5,000,000이고, 통계가 없거나 값이 0이면 cache하지 않는다.
- `CONTINUOUS_SQL_MAX_OUTPUT_ROWS_PER_INPUT`: micro-batch JOIN output 증폭 hard limit이다.
- `REALTIME_EVENT_*`, `REALTIME_REPLAY_LIMIT`: durable event retention, payload byte limit, replay page의 안전 경계다.
- `REALTIME_SUBSCRIBER_QUEUE_SIZE`, `REALTIME_CONNECTION_LIMIT_PER_ACTOR`: process memory와 actor별 multi-tab 연결을 제한한다.
- `REALTIME_HEARTBEAT_SECONDS`, `REALTIME_DISPATCH_POLL_SECONDS`, `REALTIME_CLEANUP_INTERVAL_SECONDS`, `REALTIME_SSE_SEND_TIMEOUT_SECONDS`: heartbeat, NOTIFY 유실 catch-up, retention cleanup, slow-send 종료 경계다.
- `DATABASE_URL`: backend metadata DB. 미설정 시 `docker-compose.yml`의 local Postgres 기본값을 사용한다.
- Object storage local mode는 `ASKLAKE_OBJECT_STORAGE_PROVIDER=minio`, MinIO endpoint/static local credential, `S3_FORCE_PATH_STYLE=true`를 사용한다.
- EC2 production mode는 `ASKLAKE_OBJECT_STORAGE_PROVIDER=aws`, `AWS_REGION`, `S3_FORCE_PATH_STYLE=false`를 사용한다. `S3_ENDPOINT`와 장기 AWS access key/secret은 비워 두고 EC2 instance profile IAM Role/default credential chain을 사용한다.
- AWS Source 화면은 발표용 호환 레이아웃을 위해 Endpoint URL, Access Key, Secret Key 입력을 표시하지만 세 값은 선택 입력이며 연결 동작에는 사용하지 않는다. Frontend adapter는 값의 내용과 관계없이 API 요청과 pipeline draft에서 세 필드를 비우고 provider, region, bucket/prefix만 전송한다. 실제 인증은 EC2 instance profile IAM Role/default credential chain을 사용하며 AWS credential을 browser 밖으로 전송하거나 저장하지 않는다.
- Dashboard adapter는 FastAPI 응답을 우선하고, 이전 backend 호환을 위해 404 local/mock fallback을 유지한다.
- Target 저장경로 선택은 frontend가 S3를 직접 호출하지 않고 `GET /api/s3/buckets`, `GET /api/s3/prefixes` 서버 API를 통해 bucket/prefix만 조회한다. 목록은 `ASKLAKE_SPARK_OUTPUT_BUCKET`을 첫 번째로 반환하고 나머지 `S3_ALLOWED_BUCKETS`를 뒤에 합친다. local MinIO demo만 설정이 없을 때 `asklake-output`을 사용하며, AWS mode의 설정 누락은 `503 SERVICE_UNAVAILABLE`이다.
- Dashboard 원격 widget scan은 `S3_ALLOWED_BUCKETS`와 runtime 응답 전체에서 공유하는 `ASKLAKE_DASHBOARD_MAX_REMOTE_BYTES`/`ASKLAKE_DASHBOARD_MAX_REMOTE_OBJECTS` 예산을 적용한다. DuckDB 기본 경계는 query당 15초, memory/temp 각 256 MiB, 2 threads이며 `ASKLAKE_DASHBOARD_QUERY_TIMEOUT_SECONDS`, `ASKLAKE_DASHBOARD_DUCKDB_MEMORY_BYTES`, `ASKLAKE_DASHBOARD_DUCKDB_TEMP_BYTES`, `ASKLAKE_DASHBOARD_DUCKDB_THREADS`로 더 낮거나 제한된 운영값을 지정할 수 있다.
- Target DB 선택은 `GET /api/target/databases` 서버 API를 통해 허용 DB 목록을 조회한다. `TARGET_DATABASES`가 없으면 local demo 기본값을 사용한다.
- 모든 AI 생성은 backend가 private `ai-server` Gateway를 호출한다. provider key는 `AI_PROVIDER_API_KEY`로 AI Gateway 컨테이너에만 주입하며 브라우저와 FastAPI에는 provider key를 두지 않는다. FastAPI는 Gateway service token과 MCP context signing secret만 사용한다.
- Query AI 요청은 선택된 dataset ID만 전달한다. Backend가 actor의 `query` 권한과 governance를 확인하고 짧은 수명의 단일 사용 signed context를 발급하며, Gateway는 내부 MCP로 bounded/redacted Catalog context를 읽는다. Backend는 read-only·Dataset scope뿐 아니라 prompt의 명시적 집계/그룹화 의도도 검증하고, 위반 시 한 번만 교정 재요청한다. Frontend는 선택 Dataset·query·dialog context가 달라진 요청을 취소하고 stale 응답을 적용하지 않는다. Provider 실패 시 frontend가 로컬 SQL이나 근거를 대신 만들지 않으며 retrieval compatibility는 항상 disabled/empty다.
- `TRINO_ENABLED=false`에서는 `/api/query/runs`가 DuckDB compatibility response를 유지한다. `true`이면 같은 endpoint가 최대 100행 Trino preview Query Run을 `202 Accepted`로 접수한다. 전체 보기/CSV는 `/api/query/runs/{previewRunId}/full-results`의 별도 full run, cursor 결과, CSV export lifecycle을 사용한다. `POST /api/query/estimates`는 Iceberg metadata 또는 plan/Catalog fallback으로 스캔량을 추정하고 `POST /api/query/validate`가 canonical Trino 문법·Dataset context·권한을 판정한다.
- Trino 전환 시 backend만 coordinator continuation URL을 보관한다. `trino-result-collector`만 continuation을 소비하고 상태/결과 API는 persisted state만 읽는다. QueryInfo 샘플링은 진행 통계를 보강하되 result page를 소비하지 않는다.
- `clientRequestId`는 actor 범위 idempotency key다. 같은 key/fingerprint는 기존 run을 반환하고 다른 요청에 같은 key를 쓰면 `409`, actor별 동시 실행 slot을 넘으면 `429`다.
- signed cursor는 storage page index와 row offset을 숨기고 submit 시 고정한 API page size를 유지한다. run 재열기, 결과 조회, 취소, materialization은 현재 Dataset 권한과 governance control을 다시 검사한다.

## 3) 공통 규칙

- Base Path: `/api`
- Body format: JSON
- Response format: JSON
- ID type: opaque string
- Time format: ISO 8601 string
- Status values: API and frontend internal state use English canonical values. UI labels are translated in the frontend.
- Error envelope: `docs/api-contract.md`의 Error Envelope를 따른다.
- Authentication: local Phase 0는 httpOnly `asklake_session` cookie와 `/api/auth/session` actor 확인을 사용한다. 세션이 없을 때만 test runtime의 기존 `X-AskLake-*` actor header fallback을 사용한다. Production은 bootstrap admin을 요구하고 legacy demo 계정을 기본 생성·복구하지 않으며, 기존 계정 상태는 DB 값을 보존한다. 명시적 paired demo opt-in은 알려진 demo 계정만 생성·복구하며 header fallback이나 public signup을 열지 않는다. 운영 IdP/SSO는 후속 범위다.
- Schema type은 `String`, `Integer`, `Long`, `Double`, `Boolean`, `Timestamp`, `Date`, `JSON`을 canonical 값으로 사용한다. 기존 payload의 `Float`는 읽기 호환하되 새 source draft와 Transform UI는 `Double`로 저장한다.
- JSON/JSONL source는 native token을 기준으로 type을 추론한다. 숫자처럼 보이는 JSON string은 `String`, integer number는 `Long`, real number는 `Double`이며 timestamp string은 명시적 변환 전까지 `String`이다.
- `GET /api/etl/jobs/statuses`의 각 Job status 항목은 Continuous Job일 때 선택적으로 `continuousRuntime`을 포함한다. 이 값은 Job detail의 동일 runtime contract이며 `stateRevision`, desired/observed/public 상태, heartbeat와 counter를 포함한다. 클라이언트는 낮은 `stateRevision`의 응답으로 현재 상태를 되돌리면 안 된다.
- `POST /api/etl/jobs/{jobId}/commands`의 Continuous start/pause/resume/stop은 production에서 durable intent를 먼저 기록한다. `processingResult.controlPlaneOnly=true`이면 별도 control-plane worker가 Spark side effect를 수행한다. 이 응답은 worker 시작 완료를 뜻하지 않는다. `stopping`/`stopped` 상태의 중복 `stopContinuous`는 revision을 증가시키거나 worker side effect를 중복 생성하지 않고 `processingResult.idempotent=true`를 반환한다. terminal runner 상태가 `unknown`이면 상태를 성공으로 추측하지 않고 `errorDetail.code=terminal_worker_state_unknown`, `retryable=true`를 유지하며 reconciler가 동일 fencing token으로 stop을 재확인한다.
- `schemaColumns[].sourceName`은 `raw.reviewerID` 같은 원본 dotted path를 보존하고, `targetName`만 물리 컬럼 규칙에 맞게 별도로 정규화한다.

FastAPI schema 구현 기준:

- 공통 Pydantic schema는 `backend/app/schemas/common.py`에 둔다.
- 각 도메인 schema는 `CamelModel`을 상속해 Python 내부에서는 `snake_case`, API request/response에서는 `camelCase`를 사용한다.
- 실패 응답은 `ErrorResponse` / `ErrorDetail`을 사용하고, code 값은 `docs/api-contract.md`의 권장 에러 코드를 우선한다.
- 목록형 API는 필요에 따라 `PageRequest`, `PageMeta`, `PageResponse`, `CursorPageMeta`, `SortDirection`을 재사용한다.
- 모든 성공 응답을 하나의 envelope로 강제하지 않는다. 각 endpoint의 성공 response shape는 `docs/api-contract.md`의 상세 계약을 따른다.

### Catalog Dataset 삭제

| Method | Path | Response | 설명 |
| --- | --- | --- | --- |
| `GET` | `/api/catalog/datasets/{datasetId}/deletion-impact` | `CatalogDatasetDeletionImpact` | 삭제 blocker, 관리 물리 artifact, 보존 resource를 계산한다. |
| `DELETE` | `/api/catalog/datasets/{datasetId}?confirmName={datasetName}` | `202 CatalogDatasetDeletionAcceptedResponse` | 이름 확인, `delete` 권한과 최신 impact를 다시 검사하고 durable 삭제 작업을 접수한다. |
| `GET` | `/api/catalog/dataset-deletions/{deletionId}` | `CatalogDatasetDeletionStatusResponse` | `queued`, `validating`, `purging`, `metadata_cleanup`, `succeeded`, `failed` 상태와 실패 정보를 조회한다. |

목록 UI는 Dataset 이름 재입력 확인 후 `DELETE`를 호출하고 `succeeded`일 때만 row를 제거한다. blocker가 있으면 `409 CATALOG_DATASET_DELETE_BLOCKED`, 이미 삭제 중이거나 완료 fence가 있으면 `409 CATALOG_DATASET_DELETION_EXISTS`, 관리 물리 데이터 정리가 실패하면 작업 상태가 `failed`가 되며 Catalog row는 유지된다.

`CATALOG_DELETION_WORKER_ENABLED`는 재시작 뒤 남은 queued 삭제 작업을 처리하는 embedded recovery worker를 제어하며 기본값은 `true`다. `CATALOG_DELETION_WORKER_INTERVAL_SECONDS`의 기본값은 2초다. API Background Task는 즉시 처리를 kick하지만 durable receipt와 worker가 복구의 source of truth다.

### Realtime runtime config

`GET /api/realtime/config`는 인증된 actor에게 frontend와 backend가 공유할 effective deployment mode를 반환한다.

```json
{
  "dashboardSyncMode": "polling",
  "dashboardAutoRefreshEnabled": false,
  "realtimeEventsEnabled": false,
  "continuousSqlJoinEnabled": false,
  "continuousSqlServingMode": "iceberg",
  "clickhouseContinuousJoinEnabled": false,
  "clickhouseRealtimeV2Enabled": false,
  "kafkaConnectSinkEnabled": false,
  "clickhouseRealtimeConsumerOwner": "disabled",
  "latestStaticPerBatchEnabled": false,
  "staticChangeBackfillEnabled": false,
  "featureScope": "deployment",
  "fallbackReason": null,
  "heartbeatSeconds": 15,
  "reconnectRetryMs": 3000,
  "safetyPollAfterMs": 60000
}
```

`dashboardAutoRefreshEnabled`는 backend 호환 응답 필드다. 현재 Dashboard frontend는 이 값이 true여도 자동 갱신 토글, SSE 구독 또는 polling을 시작하지 않고 명시적 Widget query만 수행한다. `continuousSqlServingMode`는 이 배포에서 새 Continuous SQL Job에 허용하는 `iceberg | clickhouse` 실행 모드다. `clickhouseRealtimeConsumerOwner`는 `disabled | kafka_engine_v1 | kafka_connect_v2`다. V2와 sink field는 설정 검증 결과를 보여줄 뿐 connector가 등록되거나 ready라는 뜻이 아니다. `fallbackReason`은 `invalid_dashboard_sync_mode` 또는 `realtime_events_disabled`일 수 있다. 이 endpoint는 Connect URL, connector name, secret이나 raw env 값을 반환하지 않는다.

V2 owner가 활성화된 Continuous SQL validate/create는 streaming Dataset의 active ClickHouse binding을 fact relation으로 해석한다. streaming relation은 `queryEngineStatus=unavailable`이어도 `storageFormat=clickhouse`, 완전한 `clickhouseTable`, 동일한 active `physicalBindings`가 모두 있어야 한다. static JOIN relation은 기존처럼 available Iceberg query-engine table과 committed snapshot이 필요하다.

### Realtime Dashboard stream

`GET /api/realtime/events?dashboardId=<id>&datasetIds=<id,id>&cursor=<eventCursor>`는 인증된 `text/event-stream` endpoint다. `asklake_session` cookie를 사용하고 Dashboard `view`와 모든 Dataset `query` 권한을 검사한다. reconnect에서는 `Last-Event-ID`와 query cursor 중 큰 값을 사용한다.

Domain event는 `id`, `event`, JSON `data`를 가지며 `dataset.revision.committed`와 `dashboard.published`를 지원한다. `stream.ready`, `system.heartbeat`, `system.resync_required`, `system.authorization_changed`는 client control event다. response는 `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`이며 cursor retention gap 또는 bounded queue overflow에서는 resync를 지시하고 연결을 닫는다.

Published Dashboard `GET /api/dashboards/{dashboardId}/published` 응답에는 snapshot 작성 시작 시점의 `eventCursor`가 포함된다. frontend는 이 cursor 이후를 구독하므로 snapshot fetch와 EventSource 연결 사이의 event도 replay된다.

상세 envelope, replay, proxy, rollback 계약은 `docs/realtime-2026/contracts/realtime-event-v1.md`와 `docs/realtime-2026/sse-operations.md`를 따른다.

### Continuous SQL Job

`CONTINUOUS_SQL_JOIN_ENABLED=true`일 때 다음 API를 사용한다. 모든 JSON field는 camelCase다.

| Method | Path | 설명 |
| --- | --- | --- |
| POST | `/api/query/continuous-jobs/validate` | SQL·relation·권한·schema·key를 검증하고 versioned plan 반환 |
| POST | `/api/query/continuous-jobs` | stopped Job 생성. `clientRequestId` idempotency 지원 |
| GET | `/api/query/continuous-jobs` | admin은 전체, 일반 actor는 소유 Job 목록 |
| GET | `/api/query/continuous-jobs/{jobId}` | 상태 조회 및 active worker reconcile |
| POST | `/api/query/continuous-jobs/{jobId}/commands` | `start|pause|resume|stop|recover`, `commandId` 필수 |
| GET | `/api/query/continuous-jobs/{jobId}/batches?limit=100` | generation/batch 내림차순 publication lineage |

정적 JOIN key 증적이 없으면 UI는 다음 Catalog API를 자동 호출한 뒤 Continuous SQL validate를 재시도한다.

| Method | Path | 설명 |
| --- | --- | --- |
| POST | `/api/catalog/datasets/{datasetId}/unique-keys/verify-and-register` | `manage` 권한으로 정적 Iceberg 전체 key를 exact scan하고 null·빈 값·중복이 없을 때만 `uniqueKeySets` 등록 |

요청은 `{ "columns": ["user_id"] }`이고 응답은 `verified`, `totalRows`, `invalidKeyRows`, `distinctKeys`, 갱신된 `dataset`을 포함한다. 실패는 `CATALOG_UNIQUE_KEY_VERIFICATION_FAILED`와 동일 count를 반환하며 SQL 문에 별도 metadata 구문을 넣지 않는다.

validate/create request는 `query`, distinct `relationDatasetIds`, `staticBindingPolicy`, `triggerIntervalSeconds`를 사용한다. `triggerIntervalSeconds`는 1~3,600초이고 새 Continuous SQL request의 기본값은 10초다. 기존 Trino JOIN 결과를 증분 기준점으로 사용할 때 create에 `baselineDatasetId`를 보내며, 이 값은 append할 `output.datasetId`와 같아야 한다. create는 `name`, `clientRequestId`와 아래 두 output mode 중 하나를 추가한다.

- 기본 `servingMode=iceberg`: `storagePath`와 append `icebergTarget`을 함께 보내거나 둘 다 생략한다. 생략하면 backend가 배포 output bucket과 Trino catalog/schema에서 target·checkpoint를 생성한다.
- opt-in `servingMode=clickhouse`: `clickhouseTarget: { engine: "clickhouse", database, table }`만 사용한다. `storagePath`, `icebergTarget`, `checkpointPath`를 함께 보내면 `422`다. 정적 S3/Iceberg relation은 Job 시작 때 참조 열만 Trino page로 읽어 snapshot-scoped ClickHouse local table에 고정하고, 같은 snapshot은 resume에서 재사용한다. Kafka Engine은 메시지를 `RawBLOB`으로 받고 Dataset의 `recordParsing/schemaColumns`에 따라 typed raw table로 변환한 뒤 JOIN output table에 연속 반영한다. 이 mode는 `PINNED_AT_START`만 지원한다.

Job 응답은 `servingMode`와 mode별 `outputTarget`을 반환한다. ClickHouse 결과 Dataset은 Catalog에 `storageFormat=clickhouse`와 `clickhouseTable`을 기록하며 Dataset row와 Dashboard widget API는 output table을 `FINAL`로 읽는다. 일반 Trino SQL mapping은 만들지 않는다. plan relation의 `cacheHint`는 서버가 Catalog 통계와 안전 한도로 계산한 실행 hint이며 client가 임의로 지정하는 입력이 아니다. active Run 응답은 generation과 `fencingTokenHash`만 포함하며 fencing token 원문은 반환하지 않는다.

SQL 분석 frontend는 stopped Job create가 성공하면 별도 `start` command를 즉시 한 번 전송한다. start 실패는 create transaction을 rollback하지 않으며 생성된 Job ID와 상태를 유지하고 `Job은 생성됐지만 시작에 실패`한 부분 성공으로 안내한다.

지원 SQL, Catalog relation metadata, lifecycle, error stage와 publication 계약은 `docs/realtime-2026/contracts/continuous-sql-v1.md`를 따른다. 기능 비활성은 `409 CONTINUOUS_SQL_DISABLED`, SQL/metadata validation은 안정적인 `CONTINUOUS_SQL_*` code와 `422`, 잘못된 transition/idempotency 충돌은 `409`다.

SQL 분석 frontend는 선택 관계가 Kafka streaming 1개와 static 1개 이상일 때 `실시간 JOIN 만들기` action을 표시한다. action은 `GET /api/realtime/config`의 `continuousSqlJoinEnabled`와 `continuousSqlServingMode`를 확인하고, 현재 editor SQL과 선택 Dataset ID 전체로 validate를 먼저 호출한다. static key 증적만 없으면 위 exact Trino verification API를 자동 호출하고 validate를 재시도한다. 성공하면 배포 mode, `layer=GOLD`, `staticBindingPolicy=PINNED_AT_START`로 Job을 생성하고 별도 `start` command를 전송한다. API 호환용 trigger 값은 10초지만 SQL UI는 Kafka trigger/offset 설정을 노출하지 않고 producer Job 설정을 따른다. Iceberg mode는 Spark JOIN·Iceberg commit·Catalog Dataset revision publication을 사용하며, Dashboard Widget은 사용자가 수동 새로고침할 때 그 revision을 조회한다.

#### Issue #1117 실행 트리 확장

Phase 1 persistence에 이어 Phase 2 producer resolution/create 계약이 적용됐다.

- Catalog Dataset response는 optional `producerJobId`, `producerJobKind`, `executionMode`, `sourceKind`, `relationMode`, `runtimeStatus`를 제공한다. 새 Dataset publication부터 저장하며 기존 Dataset은 추정 backfill하지 않는다.
- validate와 Continuous SQL Job response는 backend가 resolve한 `dependencyBindings[]`를 제공한다. 각 항목은 nullable `sqlJobId`, `inputDatasetId`, nullable `childJobId`, `inputType`, `executionPolicy`, `required`를 가진다. validate에서는 아직 Job이 없어 `sqlJobId=null`, create/GET에서는 durable Job ID다.
- streaming Dataset은 `relationMode=streaming`, `producerJobId`, `producerJobKind`, `executionMode=continuous`, `sourceKind=kafka`가 실제 Dataset-producing Kafka Continuous Job과 일치해야 한다. static producer metadata도 실제 Dataset-producing Job과 일치해야 하며 producer가 없는 queryable static snapshot은 `reuse_snapshot`으로 허용한다.
- `relationMode`가 없는 기존 Dataset은 이름, tag, source 문자열이나 materialization 이력으로 추정하지 않는다. frontend도 같은 Catalog field만 사용한다.
- frontend create/validate request는 계속 `relationDatasetIds`만 보내고 producer Job ID를 보내지 않는다.

`CONTINUOUS_SQL_REALTIME_PRODUCER_REQUIRED`는 streaming producer가 없거나 Dataset에 정확히 연결되지 않은 경우, `CONTINUOUS_SQL_INPUT_RELATION_UNSUPPORTED`는 producer metadata 불일치나 V1 input 범위 위반에 사용한다. 현재 runtime은 기존 direct Kafka consumer를 유지한다. producer child orchestration, revision 확정과 direct consumer 제거는 후속 Phase이며 Dashboard Binding과 자동 감시는 다시 추가하지 않는다.

Phase 3부터 dependency가 있는 Job의 `start`/`recover`는 외부 worker 호출 전에 parent와 모든 producer child lock을 원자적으로 획득하고 `activeTreeRun`을 반환한다. `executionTree`에는 `activeTreeRunId`, `lockedJobIds`, `lockConflict`가 있고 tree run에는 node run, lock generation, lease expiry, hash 처리한 fencing token, 아직 비어 있을 수 있는 `inputDatasetRevisions`가 포함된다. 원문 fencing token은 API에 노출하지 않는다. active standalone child 또는 다른 tree lock과 충돌하면 `409 CONTINUOUS_SQL_DEPENDENCY_CONFLICT`, producer Job이 사라졌으면 `409 CONTINUOUS_SQL_DEPENDENCY_UNAVAILABLE`이며 tree/부분 lock은 남지 않는다. tree가 소유한 ETL Job의 standalone command/update/delete도 동일 conflict로 거절한다.

Phase 4에서는 parent가 lock commit 뒤 batch child `run`, realtime child `startContinuous`를 batch → realtime 순서로 internal command path에서 요청하고, node의 `producerRunId`와 status를 응답 `activeTreeRun`에 반영한다. child command는 matching tree run ID와 fencing token이 없으면 여전히 `409 CONTINUOUS_SQL_DEPENDENCY_CONFLICT`다. child start 실패는 이번 tree run의 realtime child를 역순 `stopContinuous`로 보상하고 tree lock/node run을 failed로 종료한다. dependency-managed Job은 `executionInputMode=dataset_revision`으로 생성되고 SQL-owned Kafka 설정을 plan에 남기지 않는다. revision commit의 exact Iceberg `snapshotId`가 준비되면 in-process runner가 `FOR VERSION AS OF` transform을 수행하고 verified output Dataset revision을 게시한다. snapshot이 아직 없으면 Job은 `starting`으로 유지하고 sync loop가 재시도한다. legacy Job(`executionInputMode=legacy_kafka`)만 기존 direct consumer를 유지한다.

SQL 분석의 Continuous SQL dialog는 이 API가 반환한 authoritative `dependencyBindings`와 `activeTreeRun`만 표시한다. Kafka broker, consumer group, trigger 또는 max-offset 값을 SQL Job 생성 화면에서 수정하거나 제출하지 않는다.

상세 target contract는 [SQL Job 실행 트리 V1 계약](realtime-2026/contracts/sql-job-execution-tree-v1.md)을 따른다.

지원 SQL, Catalog relation metadata, lifecycle, error stage와 publication 계약은 `docs/realtime-2026/contracts/continuous-sql-v1.md`를 따른다. 기능 비활성은 `409 CONTINUOUS_SQL_DISABLED`, SQL/metadata validation은 안정적인 `CONTINUOUS_SQL_*` code와 `422`, 잘못된 transition/idempotency 충돌은 `409`다.

Canonical status values:

| Resource | Field | Values |
| --- | --- | --- |
| Job | `status` | persisted legacy 값은 `scheduled`, `running`, `failed`, `paused`, `canceled`, `stopped`; 목록 UI는 `scheduled`, `running`, `stopped` 중심으로 표시하고 실패·취소는 최신 Run 결과로 표시 |
| Run | `status` | `queued`, `running`, `success`, `failed`, `canceled` |
| Dataset | `status` | `preparing`, `available`, `approval_required` |
| Dataset | `freshness` | `latest`, `realtime`, `stale`, `approval` |
| Dataset | `queryEngineStatus` | `pending`, `available`, `registration_failed`, `unavailable` |
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
| `POST` | `/api/etl/sources/assets` | TBD | Source 연결 검증 후 탐색 가능한 파일·폴더·테이블·컬렉션 목록 반환. 폴더 열기는 탐색이며 데이터셋 선택과 분리 | `docs/api-contract.md` |
| `POST` | `/api/etl/sources/test` | TBD | 사용자가 명시적으로 선택한 단일 Source 대상 또는 같은 형식 파일의 prefix 데이터셋에 대한 제한 샘플과 schema draft patch 반환. Prefix는 `datasetSummary` 포함 | `docs/api-contract.md` |
| `POST` | `/api/etl/schema-inference` | TBD | Source 테스트 결과 기반 schema 반환 | `docs/api-contract.md` |
| `POST` | `/api/etl/record-parsing/preview` | TBD | 이름 없는 TXT 제한 샘플을 연속 공백으로 구조화하고 필드 개수·컬럼 타입 초안 반환 | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs` | TBD | 새 수집/처리 job 생성 | `docs/api-contract.md` |
| `GET` | `/api/etl/jobs` | `view` | 저장된 작업 목록·최신 Run 요약·facet 조회. 외부 runtime probe나 상태 write 없이 관련 DB 자료를 일괄 조회 | `docs/api-contract.md` |
| `GET` | `/api/etl/jobs/statuses?jobId={jobId}` | `view` | 요청한 Job들의 저장된 상태·진행률·최신 Run·DAG 단계만 일괄 조회. 최대 100개, 외부 runtime 호출과 상태 write 없음 | `docs/api-contract.md` |
| `GET` | `/api/etl/jobs/{jobId}` | `view` | 한 작업의 저장된 상세·전체 실행 이력 조회. 외부 runtime 호출과 상태 write 없음 | `docs/api-contract.md` |
| `POST` | `/api/etl/sql-jobs` | source Query Run submitter/admin | 성공한 Trino Query Run에서 stopped 반복 full-refresh SQL Job 생성. SQL 분석 UI는 성공 뒤 별도 `run` command 호출 | `docs/trino-query-run-contract.md` |
| `PATCH` | `/api/etl/jobs/{jobId}` | `manage` | 생성된 Job의 허용 설정 업데이트. source identity는 요청에 포함할 수 없음 | `docs/etl-job-edit-contract.md` |
| `DELETE` | `/api/etl/jobs/{jobId}` | `delete` | Job 및 해당 Job이 게시한 Catalog Dataset 등록을 같은 transaction에서 제거. 물리 lake data 삭제는 포함하지 않음 | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs/{jobId}/commands` | TBD | 실행, 재실행, 일시정지, 현재 Run 취소, 스케줄 중지 | `docs/api-contract.md` |
| `GET` | `/api/etl/kafka/replay-producer` | `manage` | 배포 환경 Kafka replay producer 상태/최근 로그 조회 | `docs/api-contract.md` |
| `POST` | `/api/etl/kafka/replay-producer` | `manage` | JSON envelope 또는 원문 줄 단위 Kafka replay producer 시작 | `docs/api-contract.md` |
| `DELETE` | `/api/etl/kafka/replay-producer` | `manage` | 실행 중인 Kafka replay producer에 graceful stop 요청 | `docs/api-contract.md` |
| `POST` | `/api/internal/airflow/spark-runs/{runId}/execute` | Airflow service bearer token | 저장된 일반 배치 Job/Run을 재검증하고 PySpark 실행. 동일 process의 active Run은 409, 재기동 뒤 stale lease는 재claim. 브라우저 호출 금지 | `docs/api-contract.md` |
| `POST` | `/api/internal/airflow/spark-runs/{runId}/catalog` | Airflow service bearer token | 저장된 성공 Spark manifest를 실제 Parquet와 대조하고 Catalog에 멱등 반영. 브라우저 호출 금지 | `docs/api-contract.md` |
| `POST` | `/api/etl/internal/airflow/jobs/{jobId}/runs/{runId}/execute` | Airflow internal token | 기존 단일 호출 Spark/Catalog 실행 경로의 호환 endpoint. 신규 DAG는 분리된 execute/catalog endpoint를 사용 | `docs/api-contract.md` |
| `POST` | `/api/etl/schedules/run-due` | TBD | due 상태의 반복 Job을 검사하고 실행 | 이 문서 |
| `POST` | `/api/etl/kafka/reviews/ingest` | TBD | Kafka snapshot range를 direct target에 저장하고 Catalog 등록 | 이 문서 |
| `POST` | `/api/query/runs` | `query` | Trino mode에서는 idempotent reservation 뒤 read-only Query Run 접수, compatibility mode에서는 DuckDB snapshot 첫 page 반환 | `docs/trino-query-run-contract.md` |
| `GET` | `/api/query/runs` | session | 현재 actor가 제출한 Trino 실행 이력 조회 | `docs/trino-query-run-contract.md` |
| `GET` | `/api/query/runs/{runId}` | `query` | Trino lifecycle/statistics 또는 legacy DuckDB snapshot 조회 | `docs/trino-query-run-contract.md` |
| `GET` | `/api/query/runs/{runId}/results` | `query` | Trino SQL 결과 signed-cursor page 조회 | `docs/trino-query-run-contract.md` |
| `GET` | `/api/query/runs/{runId}/exports/csv` | `query` | 완료된 Trino 결과를 재실행 없이 CSV stream으로 다운로드 | `docs/trino-query-result-storage-contract.md` |
| `POST` | `/api/query/runs/{runId}/cancel` | `query` | queued/running Trino run 취소 | `docs/trino-query-run-contract.md` |
| `POST` | `/api/query/estimates` | `query` | 실행 전 Iceberg 참조 컬럼 스캔량·위험도 추정 | `docs/trino-query-run-contract.md` |
| `POST` | `/api/query/validate` | `query` | 실행 없이 canonical Trino 문법·Dataset context·권한 검증 | `docs/trino-query-run-contract.md` |
| `POST` | `/api/query/ai-suggestions` | 모든 선택 Dataset의 `query` | signed MCP context, published Semantic Model, Catalog cost metadata 기반 SQL 초안 생성. retrieval compatibility evidence는 disabled/empty이며 intent/cost 공용 최대 1회 교정 횟수와 generator/prompt version 반환 | `docs/api-contract.md` |
| `POST` | `/api/ai/generate-sql` | authenticated actor | ETL field/SQL transform용 Gateway SQL 생성 후 relation·column·read-only 검증 | 이 문서 |
| `GET` | `/api/catalog/datasets/{datasetId}/rows` | `view` + `query` | 최신 성공 materialization의 실제 row를 최대 500행 page로 조회. V2 raw ClickHouse Dataset은 Trino mapping 없이 topic 범위와 저장된 JSON/공백 `recordParsing` projection으로 조회 | `docs/api-contract.md` |
| `POST` | `/api/catalog/derived-datasets` | TBD | SQL 결과 기반 Lake Dataset 생성 | `docs/api-contract.md` |
| `POST` | `/api/catalog/trino-runs/{runId}/materializations` | source run submitter/admin | 완료된 Trino run의 1회성 Iceberg CTAS 등록 시작. SQL 결과 toolbar에는 노출하지 않음 | `docs/trino-query-run-contract.md` |
| `GET` | `/api/catalog/trino-materializations/{materializationId}` | submitter/admin + current `query` access | persisted CTAS/등록 상태 조회 | `docs/trino-query-run-contract.md` |

### AI SQL transform 생성

`POST /api/ai/generate-sql`은 `{ question, promptType, metadata, context?, engine }`을 받고 `{ sql, schemaContext, model, provider }`를 반환한다. `promptType`은 `query_page`, `field_transform`, `sql_transform`, `partition`, `general` 중 하나다. `field_transform`은 scalar expression만, `sql_transform` 또는 SELECT 응답은 단일 read-only query만 허용한다. Backend는 Gateway 출력에서 supplied metadata 밖의 column/relation, wildcard field transform, Spark script transform과 `reflect`/`java_method` 계열 위험 함수를 거부한다. Gateway 미설정·timeout·invalid provenance·invalid SQL은 성공 초안으로 대체하지 않고 공통 error envelope로 반환한다.

`GET /api/etl/sources/defaults`는 `{ "kafkaBroker": "...", "kafkaTopic": "...", "s3Bucket": "...", "s3Prefix": "..." }`를 반환한다. 새 빈 Kafka/S3 Source draft만 build-time 상수 대신 이 값을 한 번 채우며 저장된 설정과 사용자가 편집한 값은 보존한다. 응답에는 access key, secret, token 같은 인증 정보를 포함하지 않는다.

Iceberg Dataset rows에서 Trino coordinator가 응답하지 않으면 HTTP 502 `SQL_STORAGE_ERROR`를 반환하고 `details.reason`은 원래 `ErrorCode`의 wire value인 `BACKEND_TIMEOUT`처럼 정규화한다. Python enum 표현, 내부 endpoint, query나 credential marker를 응답에 포함하지 않는다.

Kafka `POST /api/etl/sources/test`와 Snapshot ingest consumer는 uncompressed 및 Snappy-compressed record batch를 지원한다. Source test는 consumer 오류를 빈 metadata preview로 바꾸지 않는다. 첫 메시지 이후 최소 샘플 수에 도달하면 idle window로 종료하고, 도달하지 못해도 bounded settle window 뒤 현재 샘플을 반환한다. 응답의 `rawPreviewLines`는 broker에서 읽은 Kafka `value` 문자열을 순서대로 보존하며 JSON envelope의 nested field를 공백 로그로 재구성하지 않는다. JSON/JSONL이면 `requiresRecordParsing=false`로 Schema 단계로 이동하고, 실제 raw text value일 때만 `detectedFormat=TXT`, `requiresRecordParsing=true`로 레코드 구조화 단계를 연다.

`POST /api/etl/jobs/{jobId}/commands`의 일반 배치 `run`/`retry`는 Airflow 접수 직후 `queued` 또는 `running` 상태를 응답한다. Airflow의 `spark_process_write` task가 bearer token으로 FastAPI internal execution API를 호출해 실제 PySpark 처리를 수행한다. Backend는 `AIRFLOW_RUN_SYNC_INTERVAL_SECONDS`(기본 5초)마다 active Snapshot Run을 Airflow와 동기화해 DB에 저장하고, Jobs 화면은 `GET /api/etl/jobs/statuses` 한 요청으로 여러 Job의 최종 Run/DAG/Spark 상태를 읽는다.

`spark_process_write`는 backend 컨테이너 교체 중 발생하는 Docker DNS, connection refused, timeout 같은 transport 실패를 15초부터 최대 2분까지 지수 backoff로 4회 재시도한다. 같은 `runId` 재호출은 저장된 성공 Spark 결과를 재사용하고 active execution은 대기한다. Spark worker 교체로 REST driver가 `FAILED`/`KILLED`/`ERROR`가 된 경우에는 다음 task retry가 terminal submission state와 실패 report를 폐기하고 같은 논리 Run의 새 driver를 제출한다. Catalog Dataset 삭제 receipt는 receipt보다 먼저 생성된 Run의 late publication만 차단하고, receipt 뒤 새로 생성된 Run의 정상 재적재 publication은 허용한다.

`jobKind=trino_sql_materialization` Job의 `run`/`retry`/`cancelRun`은 Airflow/Spark가 아니라 Trino materializer와 durable collector를 사용한다. 매 Run은 고유 Iceberg table에 full-refresh CTAS하고 `DESCRIBE` 성공 후 안정적인 Catalog Dataset mapping을 교체한다. 실패·취소는 이전 정상 mapping을 변경하지 않는다.

PostgreSQL Snapshot Job의 `run`/`retry`는 생성 시 저장된 `schemaSampleRows`, `__Schema Sample Scope`, `__Sample Row Limit`을 실행 행 제한으로 사용하지 않는다. 내부 실행 API는 선택한 `DATASET OR TABLE SELECTOR` 기본 테이블을 repeatable-read cursor로 끝까지 export하고 Spark manifest의 `inputRows`/`outputRows`에 실제 전체 행 수를 기록한다. 연결 실패, 테이블 부재, 빈 테이블, export 실패는 Spark/Catalog 성공으로 처리하지 않는다.

File / S3 Prefix Job의 `run`/`retry`는 저장된 `Path / Prefix` 아래에서 Preview와 같은 형식·비데이터 제외 규칙을 다시 적용한다. `_SUCCESS`, `manifest.json`, 숨김 객체와 다른 형식 객체는 Spark 입력이 아니며, 실제 처리 근거는 Spark manifest의 `inputFileCount`, `inputBytes`, `inputRows`, `outputFileCount`, `outputRows`로 반환한다. Iceberg target의 `outputFileCount`는 commit된 exact snapshot summary의 `total-data-files`이고, `icebergCommit.dataFileCount` 및 Catalog reconciliation의 같은 snapshot file count와 일치해야 한다.

내부 실행 API는 `AIRFLOW_EXECUTION_API_TOKEN`이 없으면 `503 AIRFLOW_EXECUTION_NOT_CONFIGURED`, token이 다르면 `401 AIRFLOW_EXECUTION_UNAUTHORIZED`, 저장된 Job/Run/Airflow DAG Run identity가 일치하지 않으면 `409 AIRFLOW_RUN_MISMATCH`를 반환한다. 성공/실패 Spark manifest는 `JobRunSummary.taskStates.sparkResult`에 보존된다. 일반 non-Kafka batch 성공 manifest의 `outputPath`는 `iceberg://...`이고 `icebergCommit`에 snapshot ID, warehouse location, exact data-file count, target, schema/rule fingerprint, source boundary가 포함된다. `phaseTimings`는 `sourceValidation`, 선택된 경우의 `materializationStaging`, `ruleEvaluation`, `qualityAggregation`, `sourcePostValidation`, `targetPublish`를 반환한다. `sparkResources`는 actual `cacheStorageLevel`, `materializationMode`, `materializationFileCount`, nullable `materializationBytes`, `materializationSizeStatus`, cleanup 상태, `executionStrategyPolicy=max_source_bytes`, `directCacheMaxSourceBytes`, `directCacheEligible`, `directCacheDecisionReason`, `directCacheFailureMode`, `directCacheFallbackCount`, `outputFrameCacheMode`를 additive 실행 근거로 반환한다. 직접 cache 경로는 `materializationMode=direct_source_cache`, `cacheStorageLevel=MEMORY_AND_DISK`, `outputFrameCacheMode=direct_source_memory_and_disk`이고 staging 파일과 `materializationStaging` timing이 없다. staging 경로는 `run_scoped_parquet_staging`, `NONE`, `staged_parquet_reuse`다.

같은 `runId`의 internal Spark execute 재호출은 저장된 `sparkResult.status=success`가 있으면 SparkApplication을 조회·생성하지 않고 그 manifest를 그대로 반환한다. 미완료 Run에 저장된 `sparkExecution.kubernetesExecution`이 있으면 RDS의 namespace/name/UID가 복구 기준이며 provider는 Kubernetes `POST` 전에 기존 object를 `GET`한다. object 부재, UID 교체 또는 run/job/image identity drift에서는 새 object를 만들지 않고 실패한다. 동일 Kafka snapshot boundary가 Iceberg에 이미 기록된 경우 commit은 새 snapshot 대신 기존 snapshot을 `operation=reuse`로 반환한다.

`publish_run_result` task는 `POST /api/internal/airflow/spark-runs/{runId}/catalog`에 `{ "jobId": "..." }`를 보낸다. 일반 batch에서는 backend가 저장된 `sparkResult.status=success`, persisted `icebergTarget`, snapshot/fingerprint identity, Trino `DESCRIBE`/`$snapshots`/`$files`, Job의 `datasetId`를 검증한 뒤 같은 Run의 materialization과 lineage를 `catalog_datasets.payload`에 저장한다. Spark가 보고한 exact snapshot file count와 Trino snapshot summary가 다르면 reconciliation은 fail-closed 한다. EKS bounded fixture는 RDS Run의 `expectedCount`와 Trino가 같은 snapshot에서 확인한 `_asklake_run_id=runId` 행 수가 같아야 한다. 성공 response는 `status`, `runId`, `reconciledAt`, `dataset`을 반환하고 `JobRunSummary.taskStates.catalogResult`에도 snapshot ID, data-file count, storage location, reconciliation 시간을 보존한다.

Catalog endpoint는 `runId` 기준으로 멱등하다. `publish_run_result`는 30초 간격으로 최대 2회 재시도하므로 최초 시도를 포함해 최대 3회 같은 `runId`의 Catalog reconciliation을 호출한다. 이 task retry는 upstream의 성공 Spark XCom과 저장된 `sparkResult`를 재사용해 Spark를 다시 실행하지 않으며, `materializationRuns`에는 같은 `runId`가 하나만 남아야 한다. 저장된 Spark 성공 결과가 없으면 `409 SPARK_RESULT_NOT_READY`, identity가 다르면 `409 AIRFLOW_RUN_MISMATCH`, 실제 output 확인 또는 Catalog transaction이 실패하면 `500 CATALOG_RECONCILIATION_FAILED`를 반환한다. 실패 응답은 재시도 소진 후 `publish_run_result` task와 DAG Run을 실패시키고, AskLake Run의 실패 단계는 `Catalog reconciliation`로 표시한다.

검증된 Spark Catalog publication은 `sourceManifest`를 함께 저장한다. Iceberg Dataset의 manifest는 `manifestVersion`, `datasetId`, `sparkPath`, `format=iceberg`, `fingerprint`, `expiresAt`, `runId`, `icebergSnapshotId`를 포함하며 downstream 검증과 복구가 table 최신 상태가 아니라 이 snapshot identity를 사용하게 한다. snapshot 증적이 없는 Iceberg 결과에는 manifest를 발급하지 않는다.

Airflow DAG Run은 Catalog endpoint가 성공한 뒤에만 `success`가 된다. Jobs 화면의 상태 조회는 Job 상태만 갱신하며 Catalog 목록을 함께 요청하지 않는다. Catalog·SQL·AI 화면에 들어갈 때 해당 화면의 loader가 최신 Catalog 목록을 읽는다.

`stopSchedule`/`resumeSchedule`은 배치에서는 자동 실행 중지/재개, 실시간에서는 수집 중지/재개로 해석한다. 실행 중인 실시간 Job을 중지하면 현재 Run도 `canceled`로 종료하고 중지 시각을 기록한다.

ETL 성공 dataset의 `lineageGraph`는 transform-aware column lineage를 사용한다. source node는 실제 transform input만 포함하고, 하나의 source `text`에서 여러 분류 컬럼을 파생하면 `text -> 각 output` edge를 각각 반환한다. Spark가 생성한 `_asklake_*` 컬럼은 job node에서 시작한다.

Issue #567 Phase 5부터 Continuous create/review/preview는 Snapshot conformance를 통과한 stateless canonical Rule을 허용한다. `GET /api/etl/jobs/{jobId}`의 `continuousRuntime`은 `ruleContractVersion`, `ruleFingerprint`, `runtimeFingerprint`, `ruleMetrics`, `lastRuleResult`를 추가로 반환한다. Worker report, batch manifest와 Catalog `materializationRuns`도 schema/rule/runtime fingerprint와 Transform/Quality 결과를 보존한다. 실행 중 processing contract 변경은 `409 CONTINUOUS_IMMUTABLE_CONFIG_ACTIVE`, checkpoint가 초기화된 뒤의 schema/Rule/physical target 변경은 `409 CONTINUOUS_CHECKPOINT_CONTRACT_IMMUTABLE`이며 Job copy와 새 checkpoint가 필요하다.

Continuous 운영 API는 `GET /api/etl/jobs/{jobId}/continuous/logs`, `GET /api/etl/jobs/{jobId}/continuous/sessions`, `GET /api/etl/jobs/{jobId}/continuous/sessions/{sessionId}`, `GET /api/etl/jobs/{jobId}/continuous/sessions/{sessionId}/batches?limit=100`, `GET /api/etl/jobs/{jobId}/continuous/quarantine`, `GET /api/etl/jobs/{jobId}/continuous/maintenance-runs`, `POST /api/etl/jobs/{jobId}/continuous/quarantine/replays`, `POST /api/etl/jobs/{jobId}/continuous/compactions`, `POST /api/etl/jobs/{jobId}/continuous/iceberg-maintenance`를 제공한다. session은 한 번의 stream start부터 terminal 전환까지를 나타내고 batch endpoint는 그 session에 속한 최근 micro-batch를 최신순으로 반환한다. batch는 `sourceBoundary`, `icebergSnapshotId`, `icebergTableUri`를 추가로 반환한다. session과 batch의 `dagSteps`는 Source, Schema, Transform, Quality, Target, Manifest/Checkpoint, Catalog 7단계 근거를 제공하며 Catalog cursor 확인 전 publication은 마지막 단계가 `pending`이다. manifest 전에 Rule이 실패한 batch도 `failed` 이력과 오류를 반환하고, 규칙이 없는 Transform/Quality 단계는 `pass-through`다. 조회 API는 worker report와 liveness를 먼저 동기화하므로 별도 새로고침 명령 없이 최신 durable 상태를 읽는다. Replay body는 `offsets?: string[]`와 `approveUnknownFields?: boolean`을 받고 현재 policy/Rule을 적용한 성공 행을 같은 Iceberg table에 append한 뒤 Trino 검증 성공 시 `catalogApplied=true`를 남긴다. `approveUnknownFields: true`는 unknown field만 고정 projection으로 승인하는 `manage` 권한 작업이다. `compactions`는 `targetFileSizeMb`(128~512)를 받아 Iceberg `rewrite_data_files`를 실행한다. `iceberg-maintenance`는 rewrite와 선택적 snapshot expiration/orphan cleanup을 조합하며 삭제성 작업은 `manage` 권한이 필요하다. 모든 maintenance는 worker가 paused/stopped일 때 Job/runtime row lock 순서로 worker start/resume과 상호 배제되고, 완료 snapshot과 파일 지표를 Trino로 검증한다. Maintenance run은 기본 900초 lease를 가지며 durable REST runner heartbeat가 fresh이면 lease를 갱신하고 stale/absent runner만 정리한다.

Kafka replay producer API는 Continuous worker와 분리된 테스트 입력 도구다. `POST /api/etl/kafka/replay-producer`는 `topic`, `rate`, `batchSize`, `loop`, `maxCycles?`, `maxMessages?`, `cycleDelayMs?`, `burstMinMessages?`, `burstMaxMessages?`, `burstIntervalSeconds?`, `inputPath?`, `payloadMode?`를 받으며 한 번에 하나만 실행한다. `payloadMode` 기본값은 `json_envelope`이고 기존 fixture를 유지한다. `raw_text`이면 `inputPath`가 필수이며 `.txt`, `.log`, `.jsonl` 파일의 비어 있지 않은 각 줄을 JSON 변환 없이 Kafka value로 보낸다. burst 세 값은 함께 쓰며 loop mode에서 매 interval마다 min~max의 랜덤 건수를 rate 제한 없이 전송한다. JSON envelope loop 모드는 cycle별 고유 `event_id`와 증가하는 논리 `offset`을 만들고, 기존 topic을 삭제하지 않는다. `inputPath`는 배포 설정의 `ASKLAKE_REPLAY_INPUT_DIR` 아래 상대 경로만 허용한다.

`GET /api/etl/jobs/{jobId}`는 Job 상세·전체 실행 이력·수정 화면 hydrate의 read-only source of truth다. 주기적인 실행 상태 갱신은 `GET /api/etl/jobs/statuses`가 담당한다. 상세 응답은 source config, schema columns/fingerprint/sample/summary, transform/quality, schedule/retry/watermark, permission summary/roles, target database/metadata를 함께 유지한다.

`PATCH /api/etl/jobs/{jobId}`는 `manage` 권한이 필요하다. request는 source field를 허용하지 않으며, 실행 중인 Job은 `409`, 성공 Run이 있는 Snapshot Job의 target dataset/database/layer/format/storage identity 변경은 `422`로 차단한다. Continuous는 checkpoint contract 초기화 전까지만 schema/Rule/physical target을 수정할 수 있고, 초기화 후에는 위 전용 `409` 오류로 Job copy를 요구한다. update는 Kafka consumer group offset, Snapshot 경계 또는 Continuous checkpoint를 변경하지 않는다.

`DELETE /api/etl/jobs/{jobId}`는 `delete` 권한과 idle 상태 검증을 통과한 뒤, `producerJobId`가 해당 Job ID인 Catalog Dataset 등록과 그 Dataset의 permission/lock metadata를 같은 transaction에서 제거한다. 따라서 삭제된 Job이 만든 Dataset은 Catalog 목록과 SQL 분석의 Dataset 선택 목록에서 즉시 사라진다. 이 경로는 Iceberg/S3/ClickHouse의 물리 데이터 삭제를 수행하지 않으며, 물리 purge는 별도 Catalog Dataset 삭제 API만 수행한다.

Kafka Source Snapshot Job의 `run`/`retry`는 Airflow 대신 backend Kafka ingest bridge와 Spark Iceberg writer를 실행한다. Job 시작 시 partition별 end offset snapshot을 고정하고 해당 range만 consume한 뒤 `topic -> transform/quality -> Iceberg append -> Trino physical verification -> Catalog materialization -> consumer offset commit` 순서로 처리한다. 같은 consumer group을 쓰면 마지막 성공 snapshot의 end offset 이후만 target에 저장된다. lag가 없으면 새 Iceberg data file이나 materialization 없이 0건 Run으로 성공한다. 같은 durable snapshot 재시도는 Iceberg source marker와 Catalog snapshot identity를 재사용해 중복 append하지 않는다.
Kafka Source Snapshot Job의 `run`/`retry`는 기본적으로 Airflow 대신 backend Kafka ingest bridge와 Spark Iceberg writer를 실행한다. Job 시작 시 partition별 end offset snapshot을 고정하고 해당 range만 consume한 뒤 `topic -> transform/quality -> Iceberg append -> Trino physical verification -> Catalog materialization -> consumer offset commit` 순서로 처리한다. 같은 consumer group을 쓰면 마지막 성공 snapshot의 end offset 이후만 target에 저장된다. lag가 없으면 새 Iceberg data file이나 materialization 없이 0건 Run으로 성공한다. 같은 durable snapshot 재시도는 Iceberg source marker와 Catalog snapshot identity를 재사용해 중복 append하지 않는다.

EKS MVP bounded fixture Snapshot은 이 기본 경로의 좁은 예외다. `sourceConfig`에 exact topic `asklake.eks-mvp.fixture.v1`, `ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON`에 등록된 exact consumer group, 내부 `__EKS MVP Fixture Batch ID`, `__EKS MVP Expected Count`가 있고 MSK endpoint가 IAM `9098`, runtime이 `ASKLAKE_SPARK_RUNNER=kubernetes`일 때만 `run`/`retry`를 Airflow에 예약한다. slot 설정이 없으면 기존 `asklake-eks-mvp-spark-v1 → eks_mvp_fixture` 한 쌍만 허용한다. exact topic/default group 또는 fixture 내부 필드 중 하나라도 보이면 fixture 의도로 간주하므로, 나머지 값이 잘못되거나 누락된 요청은 `409 EKS_MVP_FIXTURE_REQUIRES_KUBERNETES` 또는 `422 EKS_MVP_FIXTURE_CONTRACT_INVALID`로 거부되고 기존 Kafka bridge로 fallback하지 않는다. slot JSON 자체가 잘못되면 `503 EKS_MVP_FIXTURE_SLOTS_INVALID`, 같은 group/table slot에 active Run이 있으면 `409 EKS_MVP_FIXTURE_SLOT_ACTIVE`로 executor 호출 전에 실패한다.

예약 transaction은 Airflow 호출 전에 `taskStates.eksMvpFixture.sourceBoundary`와 선택된 `icebergTable`을 contract version 2 RDS Run에 고정한다. Airflow DAG conf와 `POST /api/internal/airflow/spark-runs/{runId}/execute` body의 `sourceBoundary`는 이 값을 그대로 사용해야 한다. FastAPI는 RDS 값과 exact match를 확인하고 현재 slot mapping도 예약 table과 같을 때만 RDS boundary를 Spark payload에 넣는다. 불일치·누락은 `409 AIRFLOW_SOURCE_BOUNDARY_MISMATCH`, 손상 또는 slot mapping drift는 `409 EKS_MVP_FIXTURE_RUN_BOUNDARY_INVALID`로 Spark 제출 전에 거부한다. 동적 SparkApplication driver env와 job manifest에는 같은 topic/group/batch/count/output/checkpoint와 canonical slot JSON이 들어가고 metadata annotation `asklake.io/fixture-batch-id`로 batch를 관찰할 수 있다. group별 Iceberg table은 server-side slot mapping으로 정하며 group/table은 둘 다 중복될 수 없다. Spark는 batch filter 뒤 count를 `expectedCount`와 비교하고 다르면 Iceberg commit 전에 실패한다. 성공 report도 exact `sourceBoundary`, input/output count, mapped Iceberg target, commit Job/Run/snapshot identity가 모두 맞아야 하며, 아니면 `502 EKS_MVP_FIXTURE_RESULT_INVALID`로 RDS 성공 저장을 거부한다.

### Kafka review ingest

`POST /api/etl/kafka/reviews/ingest`는 Kafka topic을 직접 읽어 선택 target에 저장하는 backend-only compatibility endpoint다. UI의 일반 실행 경로는 `POST /api/etl/jobs/{jobId}/commands` 또는 scheduler tick을 사용하며, 이 경로만 backend-owned `icebergTarget`과 commit/Catalog/offset 순서를 적용한다. Job identity가 없는 직접 호출은 fixture/debug/smoke를 위한 기존 JSONL target 계약을 유지한다.

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

Job identity 없이 이 direct compatibility endpoint를 호출할 때의 필수 필드는 `event_id`, `review`, `offset`, `created_at`이다. 일반 Kafka Snapshot Job은 저장된 included `schemaColumns`와 compiled output schema를 범용 JSON object 계약으로 사용하므로 review 필드를 강제하지 않는다. 직접 debug endpoint의 target object는 `s3://{targetBucket}/{targetPrefix}/snapshots/{snapshotId}/data.jsonl` 형태다. Kafka Snapshot Job은 target data를 이 JSONL object에 쓰지 않고 Iceberg warehouse의 Parquet data file로 commit하며, snapshot directory의 `metadata.json`과 optional `quarantine.jsonl`만 보조 증적으로 유지한다.

Job command는 저장된 `ruleContractVersion`과 `rules`를 실행 직전에 다시 compile해 이 endpoint의 bridge payload로 전달한다. direct debug 호출에서 canonical 필드가 없을 때만 legacy `transformSteps`/`qualityRules`를 adapter로 변환한다. legacy의 빈 Regex, Accepted Values, Range 파라미터는 각각 기존 이메일 패턴, 국가 집합, 최소 0 기본값을 유지한다. schema가 `raw: JSON`을 선언하면 `raw.email` 같은 dotted Rule input도 유효하며, JSON root가 아닌 임의의 미등록 path는 계속 거절한다.

### Kafka Snapshot Iceberg target

Issue #678 Phase 3는 Kafka Snapshot Job의 final target을 Iceberg table로 승격한다. 중간 `kafka-landing/...` RAW object와 snapshot별 target `data.jsonl`은 만들지 않는다.

```text
partition offset snapshot
  -> fixed-range consume with auto-commit disabled
  -> transform/quality
  -> Spark Iceberg append or same-snapshot reuse
  -> Trino snapshot/schema/data-file verification
  -> Catalog materialization run deduplication
  -> offset commit
```

현재 ingest 응답과 Kafka Job Run metadata는 `snapshotId`, `capturedAt`, `topic`, `consumerGroupId`, partition별 `startOffset`, `highWatermark`, exclusive `endOffset`을 가진다. Iceberg commit 또는 Trino/Catalog 검증이 실패하면 offset을 commit하지 않는다. 같은 snapshot identity는 Iceberg 내부 source marker와 Catalog materialization deduplication key로 사용한다. `Batch Max Messages`의 후속 의미는 global count가 아니라 partition별 snapshot 최대 범위다. post-commit failure smoke hook은 production endpoint 계약에 포함하지 않으며 `ASKLAKE_ENABLE_KAFKA_TEST_HOOKS=true`인 test process에서만 활성화된다.

`Fail Run` 같은 Kafka bridge 오류가 일반 Job command에서 발생하면 API는 실패 Run을 정상 응답의 `run`으로 반환하며, `run.taskStates.kafkaSnapshot`과 `failedStage`를 보존한다. 직접 `POST /api/etl/kafka/reviews/ingest` 호출은 `502` error response를 반환하고 `error.details.bridge.snapshot` 및 `failedStage`로 동일 진단을 제공한다.

target dataset의 layer는 `RAW`, `BRONZE`, `SILVER`를 지원하며 기본값은 `BRONZE`다. 기존 create/update payload의 `targetFormat=jsonl`은 UI와 저장 row의 읽기 호환값으로 유지하지만 Job의 최종 물리 포맷은 `Iceberg (Parquet)`이고 Catalog는 `storageFormat=iceberg`, 검증된 `queryEngineTable`을 기록한다. target layer는 Catalog metadata이며 Kafka bridge의 transform/quality 실행 여부를 바꾸지 않는다. bridge는 Job에 저장된 included source schema가 있으면 범용 JSON object를 입력으로 사용하고, 지원 field transform과 quality action을 적용한 뒤 compiled output schema로 projection한다. 따라서 rename 전 source field와 `included: false` field는 Iceberg target schema/sample에 남지 않는다. schema가 없는 legacy direct endpoint는 review 필수 필드 정규화를 유지한다. `Fail Run`은 Iceberg commit과 offset commit 전에 실행을 실패시키며, `Quarantine`은 snapshot directory의 `quarantine.jsonl`로 분리한다. malformed payload도 raw payload와 Kafka context를 보존해 quarantine한다. `GOLD` join/aggregation과 범용 SQL expression runtime은 이 전환 범위에 포함하지 않는다. 상세 계약은 [Kafka Snapshot Direct Target Contract](kafka-snapshot-direct-target-contract.md)를 따른다.

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
| `GET` | `/api/catalog/datasets/{datasetId}/rows?limit=&offset=` | `query` | 최신 성공 materialization의 실제 행을 bounded page로 조회 | `docs/api-contract.md` |
| `GET` | `/api/catalog/datasets/{datasetId}/lineage` | TBD | column-level lineage graph hydrate 또는 fallback | `docs/api-contract.md` |
| `DELETE` | `/api/catalog/datasets/{datasetId}/materialization-runs/{runId}` | TBD | dataset 안의 append/materialize 결과 metadata 삭제 및 부모 rows/size 재계산 | `docs/api-contract.md` |
| `GET` | `/api/s3/buckets` | TBD | Target 저장경로 선택용 허용 bucket 목록 | `docs/api-contract.md` |
| `GET` | `/api/s3/prefixes` | TBD | Target 저장경로 선택용 S3 prefix lazy 조회 | `docs/api-contract.md` |
| `GET` | `/api/target/databases` | TBD | Target 기본정보 DB 선택용 허용 DB 목록 | `docs/api-contract.md` |
| `POST` | `/api/catalog/derived-datasets` | TBD | DuckDB compatibility 결과 기반 dataset 생성 | `docs/api-contract.md` |

현재 P1 API의 `Auth` 값은 local session actor 또는 임시 actor header fallback을 기준으로 확장 중이다. Create flow의 `owner` 표시는 identity metadata이면서 backend owner fallback의 기준이고, `permissionGrants`는 실제 Job 접근 제어 입력이다. `permissionSummary`와 `permissionRoles`는 호환용 요약 값이다. Catalog/SQL/Job/Dashboard runtime의 공통 권한 계약은 `docs/api-contract.md`의 Permission/Governance 용어를 따른다.

## 6) P2 / 확장 API

> Dashboard Job Binding API와 worker는 제거됐다. `/api/dashboard-job-bindings`는 더 이상 OpenAPI에 노출되지 않으며 호출하면 `404`다. Dashboard는 보기·편집 모드 진입 및 사용자의 현재 페이지 새로고침에서 Widget query를 실행한다.

| Method | Endpoint | 설명 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 활성 상태인 계정 로그인과 `asklake_session` 쿠키 발급. Demo 계정의 생성·복구 및 UI 기본값 노출은 paired opt-in으로 제어 |
| `POST` | `/api/auth/signup` | 로컬 viewer 계정 생성 후 `asklake_session` 쿠키 발급 |
| `GET` | `/api/auth/session` | 현재 세션 사용자 조회. 세션 없으면 unauthenticated |
| `POST` | `/api/auth/logout` | 서버 session 삭제 및 쿠키 제거 |
| `GET` | `/api/dashboards` | dashboard 목록 조회 |
| `POST` | `/api/dashboards/query` | dashboard 검색, 소유자/태그 필터, 정렬, pagination 조회 |
| `POST` | `/api/dashboards` | dashboard card를 `draft` 상태로 생성 |
| `PATCH` | `/api/dashboards/{dashboardId}` | dashboard title 등 card metadata 수정 |
| `DELETE` | `/api/dashboards/{dashboardId}` | dashboard 삭제. admin/owner fallback 또는 `delete` grant 필요 |
| `GET` | `/api/dashboards/{dashboardId}/published` | published revision runtime 조회. `includeData=false`이면 shell만 반환 |
| `POST` | `/api/dashboards/{dashboardId}/draft/ensure` | draft revision 조회/생성. `includeData=false`이면 shell만 반환 |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages` | draft page 추가 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page 이름 수정 |
| `DELETE` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page와 해당 page widgets 삭제 |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets` | draft page에 widget 추가 후 저장된 widget 한 개 반환 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/widgets/{widgetId}` | draft widget 수정 후 저장된 widget 한 개 반환 |
| `DELETE` | `/api/dashboards/{dashboardId}/draft/widgets/{widgetId}` | draft widget 삭제 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/layouts` | draft widget layout batch 저장 |
| `POST` | `/api/dashboards/{dashboardId}/publish` | dashboard 게시 |
| `POST` | `/api/dashboards/assistant` | Dashboard 질문/시각화 요청을 private Gateway로 처리하고 검증된 action·실사용 근거 반환 |
| `POST` | `/api/review-analysis/schema-suggestion` | bounded source schema/sample 기반 review output schema 제안 |
| `POST` | `/api/review-analysis/preview` | 최대 10개 실제 row를 Gateway로 분석해 요청 컬럼만 반환 |
| `POST` | `/api/review-analysis/runs` | bounded review analysis run을 `202 queued`로 저장·실행 |
| `GET` | `/api/review-analysis/runs/latest` | 현재 actor의 최신 review analysis run 조회 |
| `GET` | `/api/review-analysis/runs/{runId}` | 현재 actor 또는 admin이 지정 run 조회 |
| `GET` | `/api/catalog/models` | provenance·quality gate·digest를 통과해 게시된 portable model 조회 |
| `GET` | `/api/datasets/{datasetId}/freshness` | Continuous dataset의 최신 revision과 권장 재확인 시간 조회 |
| `POST` | `/api/datasets/freshness/query` | 대시보드가 사용하는 dataset freshness를 최대 100개까지 묶음 조회 |
| `POST` | `/api/dashboards/{dashboardId}/widgets/query` | `mode`의 선택 widget만 계산·조회. published는 `view`, draft는 `manage` 필요 |
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
Draft page/widget mutation은 변경된 resource를 응답하므로 frontend가 mutation 직후 전체 draft runtime을 다시 조회하지 않는다. 마지막 page 삭제 시에는 backend가 만든 기본 `replacementPage`를 함께 반환한다.
Dashboard 화면은 runtime shell을 먼저 그리고 선택 page의 `dataStatus=pending` widget만 dataset별로 요청한다. `dataStatus`는 `pending`, `ready`, `error`이며 요청 중 `loading`은 frontend local 상태다.

Profile/Admin Console API는 `asklake_session` 쿠키가 있으면 session actor를 우선 사용하고, 세션이 없으면 임시 actor header(`X-AskLake-User`, `X-AskLake-Role`, `X-AskLake-Groups`) fallback으로 동작한다. `/api/users/me`는 모든 actor가 호출할 수 있고, `/api/admin/*`는 admin role이 아니면 `403 FORBIDDEN`을 반환한다. 관리 콘솔 권한 편집 API는 `dataset`, `etl_job`, `dashboard` resource에 대해 `user`, `group`, `role`, `public` principal grant를 저장할 수 있다. 지원 action은 `view`, `query`, `run`, `manage`, `delete`, `share`이며, 운영 UI의 기본 흐름은 group grant와 user 예외 grant를 우선 사용한다. Admin 권한은 resource 접근 그룹이 아니라 `role=admin`으로 부여되며, 로컬 demo admin 계정은 groups를 비워 둔다. `role`/`public` grant는 계약상 지원하지만 운영 위험이 크므로 관리 콘솔의 기본 추가 옵션으로 노출하지 않는다. Governance controls는 user/group principal을 `blocked`로 전환하거나 resource를 잠글 수 있다. 관리 콘솔에서는 user 차단은 사용자 탭, group 차단은 그룹 탭, resource lock은 권한 탭의 선택 resource action으로 배치한다. 차단/잠금 사유는 관리자 내부 표시와 감사 로그용이며 일반 사용자-facing 메시지에는 노출하지 않는다. 차단된 actor는 grant가 있어도 resource 접근/실행에서 403을 받고, 잠긴 resource는 view를 제외한 `query/run/manage/delete/share` action을 403으로 차단한다.

관리자 감사 로그의 대상 타입에는 SQL/Trino 실행 이력을 나타내는 `query_run`이 포함되며, 저장소 필터와 응답 직렬화는 동일한 백엔드 타입 계약을 사용한다. 계약 밖의 레거시 값은 목록 전체를 실패시키지 않고 `unknown`으로 반환하며 원래 타입은 `metadata.rawTargetType` 진단 근거로 보존한다.

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
| 조건부 레코드 구조화 | Source에서 선택한 File/S3 `.txt`/`.log` 또는 Kafka raw text preview와 `DraftPipeline.recordParsing` | `POST /api/etl/record-parsing/preview` |
| 카탈로그 | Postgres JSONB-backed live backend hydrate | `GET /api/catalog/datasets` |
| 카탈로그 상세 | selected dataset state | `GET /api/catalog/datasets/{datasetId}` |
| Dashboard 필터값 | 선택 Dataset의 bounded distinct 값과 앞선 조건 context | `POST /api/catalog/datasets/{datasetId}/filter-values/query` |
| Lineage | `LineageGraph` mock/fallback | `GET /api/catalog/datasets/{datasetId}/lineage` |
| SQL 분석 | 최대 100행 Trino preview Query Run 제출, 상태 polling, on-demand 전체 결과 run, signed-cursor page와 server CSV. 사용자별 실행 이력 조회·재열기 endpoint는 backend 계약으로 유지하며 이번 화면에는 별도 이력 선택 목록을 노출하지 않음 | Query lifecycle endpoints |
| Query AI 생성 | 선택 Dataset ID와 prompt를 FastAPI에 보내고 private Gateway + 단일 사용 MCP context + published Semantic Model + Catalog cost metadata로 초안을 생성한다. join-aware v3는 게시된 Semantic relationship과 검증된 Catalog unique key만 `allowedRelationship`으로 만들고 생성 SQL의 equality key·column·type·alias를 AST로 재검사한다. retrieval compatibility evidence는 disabled/empty이며 backend JOIN/cost/intent guard가 공통 최대 1회 교정하고 로컬 SQL fallback은 없다. | `POST /api/query/ai-suggestions` |
| SQL 결과 Dataset 생성 | UI는 SQL 내부 다단계 모달에서 스케줄·거버넌스·저장 설정을 완료하고 `createSqlDatasetJob`으로 명시적 draft를 제출; backend direct materialize API는 `createDerivedDatasetFromSql` 호환 유지 | `POST /api/etl/jobs`, `POST /api/catalog/derived-datasets` |
| 대시보드 | FastAPI dashboard adapter와 draft/published runtime. Assistant 시각화는 검증된 widget action만 적용하며 local/mock chart fallback 없음 | `GET /api/dashboards`, `POST /api/dashboards/query`, draft/published runtime APIs |
| 감사 로그 | 서버 `audit_events` 조회 + local/localStorage 최근 호출 | `GET /api/admin/audit-logs` |

SQL 화면은 한국어/공백 dataset·column 표시명을 금지하지 않는다. 자동완성, 기본 쿼리, 컬럼 삽입, JOIN 초안 생성은 SQL 실행명으로 `"월별 매출 데이터"`처럼 double-quoted identifier를 사용한다. 사용자가 따옴표 없이 한글/공백 table reference를 직접 입력하면 frontend preflight가 실행 전에 감지하고 quoted identifier 자동 보정을 제안한다. backend table context 검증은 표시명 문자열만 믿지 않고 `baseDatasetId`와 `referenceDatasetIds`로 선택된 dataset 범위를 계속 source of truth로 사용한다.
  topic: st…4950 tokens truncated…면 frontend preflight가 실행 전에 감지하고 quoted identifier 자동 보정을 제안한다. backend table context 검증은 표시명 문자열만 믿지 않고 `baseDatasetId`와 `referenceDatasetIds`로 선택된 dataset 범위를 계속 source of truth로 사용한다.

Schedule UI는 `직접 실행`과 `반복 실행` 두 선택지만 사용하며, `직접 실행`은 payload의 `스케줄링 건너뛰기` label로 정규화한다. 스케줄링을 건너뛰면 사용자가 `POST /api/etl/jobs/{jobId}/commands`의 `run` command action으로 필요할 때 1회 Run을 만든다. 반복 실행을 선택한 때만 반복 주기, 실행 시각, IANA `timezone`, `overlapPolicy`를 노출하며 재시도 상세값은 재시도 사용 시에만 표시한다. `startDate`, `endDate`, `nextRunUtc`, `watermarkPolicy`는 create request에 보존하되 UI에서는 기본값을 사용한다. 기본 `overlapPolicy`는 `skip_if_running`이며, 재시도는 다음 예약 시각 계산을 밀지 않고 현재 Run 안에서 2배 지수 백오프 정책으로 처리한다.

SQL 분석 UI의 SQL editor 높이·toolbar·textarea scroll은 기존 계약을 유지한다. Trino 기본 실행은 `mode=preview`, `limit=100`이며 실행 평가와 `쿼리 실행`, `첫 결과 준비` timeline은 결과 panel의 세 번째 `실행 정보` view에 표시한다. `전체 보기`/`CSV 다운로드`는 `POST /api/query/runs/{previewRunId}/full-results`로 별도 전체 결과 run을 시작하거나 재사용한다. DuckDB compatibility mode는 기존 snapshot pagination을 유지한다.

Catalog의 `storageLocation`이 `s3://` 또는 `s3a://` Parquet이면 `POST /api/query/runs`는 backend S3/MinIO credential로 object를 query-scoped 임시 cache에 읽어 DuckDB에 등록한다. 원격 파일 합계는 `ASKLAKE_SQL_PREVIEW_MAX_REMOTE_BYTES` 기본 512 MiB로 제한하며, 연결·인증·object 오류를 빈 Preview로 숨기지 않고 `SQL_STORAGE_ERROR`로 반환한다.

SQL 위젯 생성은 별도 AI/API 호출 없이 bounded `SqlResultDraft`, 현재 로드된 Trino 논리 결과 page, 또는 선택한 `CatalogDataset.sampleRows`를 `DashboardDatasetOption`으로 변환한다. Trino page 기반 차트는 현재 page 범위만 임시로 시각화하며 전체 Query Run 또는 persistent Dashboard source를 의미하지 않는다. 왼쪽 `차트 생성하기`는 Dashboard runtime의 `WidgetConfigPanel`을 재사용하고 오른쪽 `차트 보기`에 렌더링한다. `데이터 미리보기`는 원본 SQL 표를, `실행 정보`는 평가와 timeline을 유지한다. SQL 결과 toolbar에서는 Dashboard 저장 또는 1회성 Dataset materialization action을 노출하지 않는다.

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
type DashboardWidgetDateUnit = "minute" | "hour" | "day" | "month" | "year";
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
  appliedRevision?: number | null;
  calculationVersion?: string | null;
  calculatedAt?: string | null;
  liveRefresh?: boolean;
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

`BarChartWidgetConfig`의 키 역할은 `orientation`과 무관하다. `xKey`는 분류·그룹 기준이고 `yKey`는 집계할 숫자 값이다. `orientation: "vertical"`에서는 분류를 X축, 숫자 값을 Y축에 표시하고, `orientation: "horizontal"`에서는 분류를 Y축, 숫자 값을 X축에 표시한다. 가로 막대를 만들기 위해 `xKey`와 `yKey`를 교환하거나 문자열을 `yKey`로 전송하지 않는다.

`POST /api/dashboards`는 랜딩 페이지의 새 대시보드 생성 버튼에서 사용한다. 생성 즉시 `status: "draft"` dashboard card를 DB에 저장하고, 프론트는 응답받은 `dashboard.id`로 `/dashboards/{dashboardId}` 조회 화면에 진입한다. 편집용 draft revision/page/widget은 `위젯 편집` 이후 `POST /api/dashboards/{dashboardId}/draft/ensure`에서 준비한다.

`GET /api/dashboards/{dashboardId}/published`는 published revision이 없으면 `revision: null`, `pages: []`, `widgetsByPageId: {}`를 반환한다. `POST /api/dashboards/{dashboardId}/draft/ensure`는 idempotent이며 draft가 없으면 published snapshot 또는 새 revision과 기본 page를 만든다.

Catalog `datasetId`를 연결한 Widget은 browser가 보낸 `data`와 Catalog `sampleRows`를 저장 데이터로 사용하지 않는다. Runtime 조회 시 backend는 actor의 dataset `query` permission과 governance를 storage 접근 전에 검사한다. Iceberg Dataset은 Catalog의 `icebergSnapshotId`에 `FOR VERSION AS OF`를 적용한 Trino query로 읽고, 전환 전 CSV/JSON/JSONL/Parquet segment만 DuckDB에 등록한다. `materializationMode`가 명시되면 그 값을 우선하고, 미지정 Kafka run은 `delta`, 그 외 run은 `snapshot`으로 판정한다. 원격 file segment는 allowlist와 누적 byte/object 예산을 통과해야 하고 모든 query는 resource/timeout 경계 안에서 실행한다. chart/metric은 최대 500개 그룹으로 집계하며 table은 최대 500행 preview만 반환한다. 응답 `config.sourceConfig`는 편집 원본을, `dataMode`는 `server_aggregated` 또는 `server_preview`를 나타낸다. 권한이 없으면 `DASHBOARD_DATA_FORBIDDEN`, 삭제된 Catalog dataset 또는 물리 데이터를 읽을 수 없으면 `DASHBOARD_DATA_UNAVAILABLE` error config와 빈 data를 해당 widget에 반환한다. `queryId`가 있는 bounded SQL snapshot은 Catalog payload가 없어도 최대 500행을 유지한다.

위젯 `config.filters`는 최대 5개의 AND 조건이다. 문자열 컬럼은 `eq`, `in`, `contains`, 숫자·날짜 컬럼은 `eq`, `gt`, `gte`, `lt`, `lte`, `between`, 모든 타입은 `is_null`, `is_not_null`을 사용한다. Backend는 Dataset schema의 컬럼·타입과 허용 연산자를 대조하고 값만 안전한 SQL literal로 컴파일하며 raw SQL filter를 받지 않는다. 같은 filter predicate를 table, aggregate, Continuous baseline/delta에 적용하고 `sourceConfig` 계산 hash에 포함한다.

```http
POST /api/catalog/datasets/{datasetId}/filter-values/query
Content-Type: application/json

{
  "column": "subcategory",
  "search": "watch",
  "limit": 50,
  "contextFilters": [
    {
      "id": "category-filter",
      "column": "category",
      "operator": "eq",
      "value": "Wearable Technology"
    }
  ]
}
```

응답은 `{ datasetId, column, values: [{ label, value }], truncated }`다. `limit`은 `1..100`이고 Dataset `view`와 `query` 권한이 모두 필요하다. `contextFilters`는 최대 5개이며 먼저 적용되므로 category 선택 뒤 subcategory 후보를 전용 계층 metadata 없이 동적으로 좁힐 수 있다. 요청 변경 시 frontend는 이전 요청을 취소하고 300ms debounce 뒤 최신 요청만 적용한다. 물리 값 조회가 실패하면 frontend는 오류와 직접 입력 fallback을 표시하며 Catalog `sampleRows`를 실제 후보로 사용하거나 storage 오류를 숨기지 않는다.

`DELETE /api/dashboards/{dashboardId}`는 dashboard card/list row와 runtime revision/page/widget snapshot을 함께 삭제한다.

### Kafka Continuous Dashboard Refresh Contract

```ts
type DatasetFreshness = {
  datasetId: string;
  isContinuous: boolean;
  latestRevision: number;
  updatedAt: string | null;
  nextCheckAfterMs: number;
};
```

`GET /api/datasets/{datasetId}/freshness`는 한 dataset을 조회한다. Dataset `query` 권한이 필요하며 없는 dataset은 `404`, 권한이 없으면 `403`을 반환한다.

```http
POST /api/datasets/freshness/query
Content-Type: application/json

{
  "datasetIds": ["clickstream_events", "commerce_orders"]
}
```

```json
{
  "datasets": [
    {
      "datasetId": "clickstream_events",
      "isContinuous": true,
      "latestRevision": 105,
      "updatedAt": "2026-07-14T12:00:05+00:00",
      "nextCheckAfterMs": 1000
    }
  ]
}
```

`datasetIds`는 1~100개다. Frontend는 같은 dataset을 쓰는 여러 widget을 dataset ID 하나로 묶어 freshness를 한 번만 확인한다.

묶음 조회는 dataset별로 권한과 metadata를 검사한다. 한 항목이 `403`, `404`, `503` 조건이면 그 항목은 응답에서 제외하고 나머지 정상 dataset은 계속 반환한다. 단건 GET은 기존 오류 상태를 그대로 반환한다.

Backend의 권장 polling 주기는 다음과 같다.

```text
nextCheckAfterMs = clamp(triggerIntervalSeconds × 500, 1,000, 60,000)
```

1~2초 trigger는 1초, 10초 trigger는 5초, 30초 trigger는 15초, 5분 trigger는 60초다. Frontend는 같은 시각에 요청이 몰리지 않도록 dataset ID로 정한 0~10% deterministic jitter를 더한다. 실제 지연은 `다음 Spark trigger까지 남은 시간 + Spark/S3 + backend reconciliation 0~1초 + polling 0~nextCheckAfterMs(+ jitter) + widget 계산`이므로 2~5초를 항상 보장하지 않는다.

```http
POST /api/dashboards/{dashboardId}/widgets/query
Content-Type: application/json

{
  "widgetIds": ["dashwidget_click_count"]
}
```

`widgetIds`는 1~100개다. Dashboard `view`와 각 Dataset `query` 권한을 재검사하고, 현재 published revision에 없는 widget ID가 포함되면 `404`를 반환한다. published runtime의 초기 `GET`은 저장된 결과만 읽으므로, 결과가 없는 새 widget은 `pending`으로 응답할 수 있다. 이 `POST`는 그 pending widget을 실제로 계산·저장하고 `ready` 또는 `error`로 전이시키는 bounded 계산 경로이며, 단순 cache read가 아니다. 응답은 `widgets: DashboardRuntimeWidget[]`이며 Continuous widget은 `liveRefresh=true`, `appliedRevision`, `calculationVersion`, `calculatedAt`을 포함한다.

`calculationVersion`은 `contractVersion + datasetId + widgetType + sourceConfig + schemaIdentity`를 canonical JSON으로 만든 SHA-256이다. `schemaIdentity`는 Catalog `schemaFingerprint`를 우선하고 없으면 schema 전체를 사용한다.

`count`/`sum`/`avg`/`min`/`max`/`ratio` 위젯은 고정 Iceberg snapshot으로 기준값을 한 번 만든 뒤 `_asklake_run_id = commit.run_id`인 delta만 병합한다. 날짜 차원과 `windowDays`가 있으면 최신 bucket 기준 범위 밖 상태를 제거한다. table, revision gap, legacy table, 고카디널리티만 전체 재기준화 대상이다.

Frontend는 보기·편집 모드 모두에서 최초 `pending` Widget과 사용자가 상단 새로고침을 누른 현재 페이지의 Dataset Widget을 `widgets/query`로 요청한다. 자동 갱신 토글, SSE revision event 구독, polling과 background prefetch는 사용하지 않는다. draft에서는 응답의 data·revision 결과만 병합해 사용자가 편집 중인 title/config/layout/선택 상태를 바꾸지 않는다. 응답 revision이 현재 값보다 낮거나 Widget signature가 달라지면 폐기한다. route unmount에서는 in-flight 요청을 정리하고 갱신 실패 시 이전 widget result를 유지한다.

### Pair A -> Pair B

```ts
type CreateJobResponse = {
  job: JobRowData;
  dataset: CatalogDataset;
};
```

Create/update/review request의 Rule source of truth는 `ruleContractVersion: "1.0"`과 `rules[]`다. Backend는 저장 전에 canonical Rule을 검증하고 `ruleCompilation.status`, 정확한 `issues[]`, 결정된 `outputSchema`를 반환하며 create/append/update에서 version과 Rule JSON을 그대로 영속화한다. `1.0 + []`는 source schema 그대로의 명시적 pass-through이고 legacy 필드를 되살리지 않는다. canonical 컬럼이 없는 기존 Job만 `transformSteps`, `transformOutputColumns`, `qualityRules`에서 Rule을 재구성하며, 이 호환 표현의 `canonicalParameters`는 `0`, `false`, 빈 문자열, `null`을 손실 없이 보존한다. `fail_batch`와 `quarantine`은 `failureDisposition: "keep"`만 허용하고, `warn`은 `keep`, `drop_row`, `set_null`을 사용할 수 있다. 버전 누락/불일치, 잘못된 kind·오류 정책·severity, 지원하지 않는 parameter는 각각 구조화된 `RULE_*` issue로 거절한다. Continuous는 Snapshot conformance를 통과한 stateless 공통 operation을 허용하고 임의 SQL/stateful operation만 `RULE_EXECUTION_MODE_UNSUPPORTED`로 거절한다.

Schema Transform UI는 원본 `SchemaColumnDraft.sourceType`과 target `type`을 별도로 보존한다. 컬럼명, 타입, 누락 시 기본값, 필수값 변경은 각각 `rename`, `cast`, `default_value`, `null_guard` Rule로 순서대로 직렬화한다. 명시적 필수값의 `null_guard`는 기본값 적용 뒤에도 값이 비어 있으면 `Fail Run`으로 실행을 중단한다. 필수 필드에는 중복 `quality:not_null`을 새로 만들지 않고, 누락값 검사에는 이미 NULL인 값을 다시 NULL로 만드는 `set_null` 처리를 노출하지 않는다. `severity`는 V1 계약 호환 metadata로 저장되지만 현재 runtime action을 결정하지 않으므로 UI에서 편집하지 않는다. 처리 단계의 결과 미리보기와 중복되는 별도 Rule Preview API는 제공하지 않는다. canonical Rule은 review/create와 실제 실행 경로에서 다시 compile되며, Continuous는 streaming-safe Visual Transform만 허용하고 임의 SQL은 노출하거나 실행하지 않는다. Regex pattern, Accepted Values, Range bounds, mask policy, timestamp format은 compiler가 실행 전에 검증하며 V1 mask는 phone, timestamp는 ISO-8601(`UTC` legacy alias 포함)만 지원한다.

필수 확인:

Mock mode에서는 Pair A pipeline 생성 dataset과 backend direct SQL derived dataset을 모두 `window.localStorage["asklake.catalogDatasets"]`에 저장하고 앱 로드시 mock catalog dataset 앞에 병합한다. 현재 SQL 화면의 `처리 Job 생성` UI는 직접 localStorage에 dataset을 쓰지 않고, 모달에서 만든 설정을 SQL Result 기반 `DraftPipeline`으로 변환해 기존 Job 생성 경로를 사용한다. 이때 접근 범위는 권한 요약과 역할 metadata에 동기화하고, 스케줄·DB·파일 포맷·압축·다중 파티션·태그·저장 경로·설명은 mock Job과 dataset에도 보존한다. 기존 `asklake.derivedDatasets` 값은 읽기 호환만 유지한다. Live API mode에서는 localStorage fallback을 사용하지 않고 backend catalog persistence와 `GET /api/catalog/datasets` 응답을 source of truth로 둔다.

EKS Realtime V1-only 프로필이나 V2가 비활성인 배포에서 기존 Catalog payload의 `physicalBindings`에는 사용할 수 없는 `serving/clickhouse` entry가 남을 수 있다. 해당 read path는 원본 JSONB를 수정하지 않고 유효한 `archive/trino` binding만 응답에 투영한다. 비활성 binding, 형식이 잘못된 entry, list가 아닌 legacy 값은 Dataset 전체 조회를 실패시키지 않으며, `queryEngineTable`이 유효하면 기존 `archive/trino` fallback을 유지한다. EC2 V2 프로필의 새 publication 계약은 이 호환 read 정규화와 별도로 feature/profile gate를 통과해야 한다.

Catalog dataset의 `materializationRuns` 항목은 `runId`, `jobId`, `status`, `createdAt`, `materializationMode`, `rowCount`, `storageSizeBytes`, `storageLocation`, `sourceKind`, `sourceLabel`을 포함한다. Kafka Continuous materialization은 추가로 `sourceBoundary`, `sourceRanges`, `icebergCommittedAt`, `icebergSnapshotId`, `queryEngineTable`, `publicationManifest`, schema/rule/runtime fingerprint, `transform`, `quality` 실행 결과를 반환하며 replay에도 같은 Rule 실행 정체성을 유지한다. history는 `icebergCommittedAt`, fallback `createdAt` 기준 newest-first로 정렬한다. 늦게 복구된 과거 snapshot은 history/합계만 보강하고 현재 schema/sample/quality/physical mapping을 되돌리지 않는다. 부모 dataset의 `rows`, `size`, `storageSizeBytes`, `lastUpdated`, `sourceRunId`는 newest-first 성공 history에서 첫 `snapshot`까지의 active segment 기준으로 계산한다. mode가 없는 legacy Kafka Run은 `delta`, 그 외 Run은 `snapshot`으로 해석한다.

- Catalog row page와 Dashboard physical widget은 검증된 Iceberg Dataset을 `queryEngineTable`의 Trino table로 읽는다. Dashboard Widget request/config는 Catalog 표기 field name을 유지하지만, backend는 Trino `DESCRIBE` 결과와 case-insensitive 일대일 매핑한 정확한 physical field name으로 SQL을 생성한다. case-insensitive collision은 `DASHBOARD_DATA_UNAVAILABLE`으로 안전하게 거절한다. Iceberg warehouse data file 직접 scan은 금지하며 legacy file-backed Dataset만 DuckDB compatibility path를 사용한다.
- Iceberg-backed materialization run 삭제는 물리 snapshot 불일치를 막기 위해 `422 ICEBERG_MATERIALIZATION_DELETE_UNAVAILABLE`로 거절한다. legacy file-backed run metadata 삭제만 기존 재계산 계약을 유지한다.

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
type QueryRunResponse = TrinoQueryRunResponse | SqlResultDraft;
```

필수 확인:

- Trino 결과 행은 `GET /api/query/runs/{runId}/results`의 current cursor page에서만 읽는다.
- `runId`는 Dashboard `sourceRunId`가 된다.
- `datasetId`는 Dashboard `datasetId`와 같아야 한다.
- Trino current page 차트는 SQL 화면의 임시 시각화이고 전체 Query Run 또는 persistent Dashboard source가 아니다. publish/반복 사용은 materialized Dataset을 사용한다.
- `mode: "preview"`와 `previewLimit`이 있는 legacy 응답은 DuckDB compatibility 결과로 취급한다.

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
ETL API graph의 source는 `SOURCE · <fileFormat|connectorType>`, 가운데 Job은 `PROCESS · SPARK`, target은 `<targetLayer> LAYER · <persistedFormat>`을 유지한다. 현재 Spark runner는 physical output을 Parquet로 저장하므로 요청 `targetFormat`과 무관하게 target engine은 `PARQUET`이다. Catalog 화면은 실행 provenance용 `PROCESS` payload를 변경하지 않고, 같은 PROCESS 컬럼으로 이어지는 source-to-job과 job-to-target edge를 source-to-target edge로 축약해 `SOURCE · PARQUET -> GOLD LAYER · PARQUET`처럼 표시한다. matching 입력 edge가 없는 `_asklake_*` 실행 컬럼에는 가짜 source edge를 만들지 않는다. 화면의 상위 데이터셋 수에도 `PROCESS` node를 포함하지 않는다.
Lineage API가 unavailable이면 화면은 오류와 재시도를 표시한다. `CatalogDataset.upstream`/`downstream` fixture를 실제 lineage로 대신 표시하지 않는다.

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
endpoint는 인증 actor를 요구하며 `dashboardId`가 있으면 Assistant 실행 전에 dashboard `view` 권한을 검사한다. 익명 운영 요청은 `401`, dashboard별 접근 권한이 없으면 `403`이다.
이 endpoint는 FastAPI가 private AI Gateway를 호출한다. `AI_PROVIDER_API_KEY`는 Gateway에만 두고 FastAPI는 `AI_GATEWAY_SERVICE_TOKEN`을 사용한다.
서버는 요청의 `dashboardId`/`pageId`를 기준으로 DB에서 draft 우선, 없으면 published runtime을 읽고,
대시보드에서 사용할 수 있는 available catalog dataset, 현재 page widget, 지원 가능한 widget type/config option만 Gateway 컨텍스트에 넣는다.
단, `selectedWidgetId` 또는 `widgetId`가 있으면 해당 위젯 하나만 context/수정 후보로 제한한다.
Gateway 응답은 backend guard가 한 번 더 검증하며, 없는 dataset/widget/column 또는 지원하지 않는 widget type/config는 action에서 제외하고 `warnings`에 이유를 담는다.
프론트는 `그걸로`, `랜덤으로 진행해줘` 같은 후속 실행 표현이 최근 사용자 발화의 Dataset/field/column 단서를 참조할 때만 최근 사용자 발화 최대 2건을 `prompt`에 명시적으로 결합하고 `visualization_request`로 분류한다. 단서 없는 독립적인 모호한 입력은 Gateway를 호출하지 않고 구체화 요청으로 종료한다. Gateway가 502 provider contract 오류를 반환하면 backend는 mode별 strict action 지침을 덧붙여 한 번만 교정 재시도한다.
SQL Query AI와 Dashboard Assistant의 retrieval compatibility는 source를 만들거나 검색하지 않는다. Resolver는 빈 `sources`와 `mode/status=disabled`, `provenance=rag_removed`를 반환하고 `usedEvidenceIds`는 빈 배열만 허용한다. Provider가 임의 ID를 반환하면 해당 citation을 제거하고 경고를 추가한다. 이 정규화는 SQL read-only/scope 또는 widget action의 dataset, column, type, config 검증을 완화하지 않는다.
Private AI Gateway 설정이 없거나 provider 호출이 실패하면 명시적인 unavailable/error 응답과 빈 action을 반환한다.
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
  semanticModelId?: string | null;
  currentDatasetId?: string | null;
  surface?: "dashboard" | "catalog" | "semantic";
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
  requestId?: string | null;
  actions: Array<
    | {
        type: "create_widget";
        widget: {
          title: string;
          type: DashboardRuntimeWidgetType;
          datasetId: string;
          config: DashboardRuntimeWidgetConfig;
        };
        usedEvidenceIds: string[];
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
        usedEvidenceIds: string[];
      }
    | {
        type: "report";
        markdown: string;
        usedEvidenceIds: string[];
      }
  >;
  warnings: string[];
  model?: string | null;
  provider?: string | null;
  sources: Array<Record<string, unknown>>;
  retrieval?: Record<string, unknown> | null;
  usedEvidenceIds: string[];
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
`visualization_request` 모드는 `actions`의 `create_widget` 또는 `update_widget`을 적용한다.
프론트는 현재 선택한 Dataset을 `currentDatasetId`로 고정하고, 명시적인 시각화 생성/수정 의도만 mutation으로 분류한다. 검증된 action도 기존 draft widget create/update API가 실제 성공한 경우에만 적용 성공으로 표시한다. 저장 callback이 실패하거나 `false`를 반환하면 현재 draft와 편집 입력을 유지하고 오류를 표시한다.
현재 시각화 요청 위젯은 기존 구현과의 호환을 위해 `configPatch` 또는 `widgetPatch.config`가 내려오면 현재 위젯 config에 병합한다.
`VITE_DASHBOARD_ASSISTANT_API_PATH`가 없거나 Docker build arg가 빈 문자열이면 기본 경로 `/api/dashboards/assistant`를 사용한다. 절대 URL override에도 세션 credential을 포함하며 서버 CORS 정책을 통과해야 한다.
`widgets`는 구버전/테스트 호환 fallback payload로 유지하지만, `dashboardId`가 있으면 서버 DB runtime 컨텍스트가 우선이다.
`selectedWidgetId` 또는 `widgetId`가 있으면 서버는 해당 위젯만 `update_widget` 대상에 포함한다.
서버 guard는 Assistant가 없는 컬럼이나 문자열 값축을 반환하면 catalog schema/sample rows 기준으로 보정한다. 차원-only 요청은 `count` 집계 차트로 보정하고, `revenue`/`total_amount` 같은 금액 alias는 실제 dataset 컬럼에 맞춰 정규화한다. 적용 가능한 action, provider/model provenance 또는 검증된 실제 사용 evidence가 없으면 성공 action을 합성하지 않고 unavailable/error와 빈 action을 반환한다.

### Review Analysis Gateway/Run 계약

`POST /api/review-analysis/schema-suggestion`은 최대 40개 source column과 최대 3개 sample row를 private Gateway의 `review_schema` mode로 전달한다. `POST /api/review-analysis/preview`는 최대 10개 실제 row와 최대 64개 요청 output column을 `review_row` mode로 분석하고 요청한 `targetName`만 문자열 row로 반환한다. `one_of_values` 결과가 `allowedValues` 밖이면 `502`로 실패하며 provider/model provenance가 없는 응답도 성공으로 취급하지 않는다.

`POST /api/review-analysis/runs` request:

```ts
type ReviewAnalysisRunRequest = {
  limit?: number; // default 25; interactive Gateway 상한 이내
  schemaColumns?: Array<Record<string, unknown>>;
  full?: false;
  runtime?: "gateway";
  source?: { bucket: string; key: string };
  trainModels?: boolean;
};
```

성공 시 `202 Accepted`와 `{ runId, status: "queued", source, result, error, createdAt, startedAt, finishedAt }`를 반환한다. `GET /api/review-analysis/runs/latest`는 현재 actor의 최신 run을, `GET /api/review-analysis/runs/{runId}`는 해당 actor 또는 admin이 볼 수 있는 지정 run을 반환한다. Run은 `review_analysis_runs`에 `queued -> running -> success|failed`로 저장되고 Background Task와 `REVIEW_ANALYSIS_WORKER_INTERVAL_SECONDS` 주기의 recovery tick이 같은 atomic claim을 사용해 allow-list Node bridge로 실제 object-storage JSONL을 처리한다. 일반 actor가 `source`를 생략하면 설정된 review source를 사용하며, 그와 다른 bucket/key 지정은 Catalog resource 권한 계약이 추가되기 전까지 `403`이다. Admin만 운영 목적으로 명시 source를 지정할 수 있다. `full=true`, `limit=0`, 또는 `ASKLAKE_REVIEW_AI_MAX_ROWS`를 넘는 interactive 요청은 `422`이며 bounded batch로 나눠야 한다.

`trainModels=true`이면 AI Gateway가 라벨링한 분류형 output을 학습 후보로 사용한다. 최소 8개 학습 row, class별 최소 row, holdout accuracy/macro-F1, 모든 allowed class validation coverage를 모두 통과한 artifact만 SHA-256 digest와 label provider/model/source provenance를 포함한 manifest로 원자 게시한다. `GET /api/catalog/models`는 이 published manifest와 digest를 다시 검증한 artifact만 반환한다. 기존 `/api/review-analysis/cellphones`와 `/api/review-analysis/cellphones/run`은 deprecated compatibility alias이며, 기존 POST alias는 `200 OK` 응답 계약을 유지한다. 새 frontend client는 canonical `/runs`, `/runs/latest`, `/runs/{runId}`, `/preview`만 호출한다.

## 8.1) ETL Review Snapshot

`POST /api/etl/review`는 생성 직전 Review 화면에서 사용할 단일 snapshot을 반환합니다.

- 요청은 `POST /api/etl/jobs`와 같은 pipeline draft 계약에 `sourceConnectionStatus`를 추가합니다.
- live mode에서는 source status가 `success`일 때 backend가 source connector를 다시 확인하고, 실패하면 Review의 소스 연결 상태를 `확인 필요`로 반환합니다. 내부 `Data Lake`는 파일 경로를 재검사하지 않고 `Source Dataset ID`의 Catalog 존재, `available` 상태, 현재 actor의 조회 권한, 사용 가능한 Iceberg table mapping을 검증합니다.
- 응답은 `basicInformation`, `schema`, `destination`, `permission`, `validation`, `canCreate`를 포함합니다.
- `basicInformation`은 생성 전 사용자가 확인할 값만 표시합니다. 내부 `id`와 자동 생성용 `jobName`은 노출하지 않고, 실행 방식은 `배치 처리` 또는 `실시간 스트리밍`, 저장 대상은 `출력 데이터셋 이름`으로 표시합니다.
- `permission`은 담당자의 자동 전체 권한, 로그인한 모든 사용자의 조회 허용 여부, 그룹·사용자·역할별 저장 예정 action을 반환합니다. `public:view`는 별도 대상 행으로 중복하지 않고 `로그인한 모든 사용자=조회 가능`으로 요약합니다. draft grant의 optional `principalName`은 Review 표시용 이름이며 권한 판정은 `principalType + principalId`를 사용합니다.
- `validation`은 실제 생성 차단 조건인 소스 데이터, 선택형 레코드 구조화, 출력 스키마, 처리 규칙, 접근 권한, 저장 위치를 반환합니다. 스케줄과 실패 재시도는 생성 차단 조건이 아니므로 포함하지 않습니다.
- frontend는 이 응답만 화면에 표시하며, 생성 버튼은 `canCreate`가 `true`일 때만 활성화합니다.
- 격리 단위 테스트 fixture는 같은 응답 shape를 검증하지만 사용자 실행 경로에는 연결되지 않습니다.

## 9) 변경 규칙

### Pipeline·Snapshot·SQL·Catalog 내부 경계 호환

PR 07의 application 경계 분리는 공개 endpoint와 payload를 변경하지 않는다. `POST /api/etl/jobs`, `PATCH /api/etl/jobs/{jobId}`, `POST /api/etl/jobs/{jobId}/commands`, SQL Query Run, derived Dataset, Catalog 조회 endpoint는 기존 request/response/status code를 유지한다. 내부적으로 Snapshot command는 Continuous command와 별도 planner를 사용하고, SQL/ETL Catalog writer는 같은 payload port 및 materialization identity를 사용한다. 상세 검증은 [Pipeline·Snapshot·SQL·Catalog Application 경계](refactor-2026/contracts/pipeline-snapshot-sql-catalog-boundaries.md)를 따른다.

- Endpoint, request, response, status code, error code가 바뀌면 이 문서와 `docs/api-contract.md`를 함께 업데이트한다.

### Refactor 하위 호환 게이트

`npm run verify:backward-compatibility`는 refactor baseline의 95개 operation과 component schema를 현재 FastAPI OpenAPI와 비교한다. local `$ref`는 실제 component schema로 안전하게 resolve한 뒤 inline schema와 의미 기준으로 비교한다. 기존 operation·response·property·enum 제거, primitive type 변경, request required 강화와 resolve할 수 없는 reference는 허용하지 않으며 enum 값 추가는 additive로 기록한다. 현재 추가된 `KafkaContinuousRuntime.desiredState`, `observedState`와 `ContinuousRuntimeErrorDetail`은 기존 `status`, `lastError`를 유지하는 응답 전용 additive 계약이다. 이 검증은 endpoint를 추가하는 작업을 막지 않지만 additive 항목을 출력해 리뷰 근거로 남긴다.

## 10) ETL Permission 옵션 및 grant 저장

`GET /api/etl/permission-options`는 ETL 생성 화면에서 선택할 수 있는 조직 그룹과 사용자를 반환한다. `jobId` query가 없으면 새 작업 생성에 필요한 경량 디렉터리 조회이므로 인증된 사용자가 호출할 수 있다. `jobId`가 있으면 기존 Job의 권한 편집으로 간주하며 admin, 해당 Job의 생성자, 담당자(owner), 또는 `manage` grant를 가진 actor만 호출할 수 있다. 그 외 actor는 `403 FORBIDDEN`, 존재하지 않는 Job은 `404 NOT_FOUND`를 반환한다. 응답은 권한 요약이나 전체 resource 목록을 계산하지 않는다.

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

`POST /api/etl/jobs`와 `PATCH /api/etl/jobs/{jobId}`는 `permissionGrants?: PermissionGrant[]` 계약을 실제 저장 경로로 사용한다. 전달된 grant는 해당 Job의 `permission_ui` source 행으로 저장되며, 수정 시 기존 `permission_ui` 행만 교체한다. 관리 콘솔에서 생성한 `admin` source grant는 유지한다. `query`, `run`, `manage`, `delete`, `share` action은 기본 조회가 가능하도록 `view`와 함께 정규화한다. `모든 사용자에게 조회 허용`은 `principalType=public`, `principalId=public`, `actions=[view]`로 저장된다. 담당자(owner)의 전체 권한은 별도 grant 없이 backend fallback으로 계산한다. 생성·수정 응답의 `permissionGrants`와 actor별 `permissions`에는 저장 결과가 즉시 반영되고, Review 응답의 `permission`에는 담당자 자동 권한과 실제 저장 예정 grant를 나열한다. `principalName`은 Review 표시를 돕는 optional metadata이며 저장 identity와 권한 판정에는 사용하지 않는다.

ETL Job에 직접 대응하는 action은 아래와 같다.

| Action | ETL 화면 표시 | 적용 API 예시 |
| --- | --- | --- |
| `view` | 조회 | Job 목록·상세 조회 |
| `run` | 실행 | 실행, 재실행, 연속 수집 시작·재개 |
| `manage` | 운영/수정 | Job 수정, 일시정지, 취소, 중지, 스케줄 재개 |
| `delete` | 삭제 | Job 삭제 |

공통 계약의 `query`, `share`도 validation 가능한 action이다. frontend는 프리셋으로 선택 대상 전체에 같은 action 집합을 적용하거나, 직접 설정에서 대상별 action을 편집한다.

현재 응답의 사용자 후보는 `auth_users` table을 우선하고, 비어 있으면 demo user를 사용한다. 그룹 후보는 아직 `DEMO_GROUPS` 고정 정의이며 조직 디렉터리 연동 결과가 아니다. 따라서 `groups[].actions`는 현재 backend가 제공하는 기본 action bundle이고, 프론트는 이를 실제 조직 역할 체계로 과장해 표시하지 않는다.

`principalType="public"`, `principalId="public"`, `actions=["view"]`는 인증 경계 안의 모든 actor에게 Job 조회를 허용한다. Permission 화면의 `모든 사용자에게 조회 허용`이 이 grant를 만든다. 이는 익명 공개 링크나 별도 share token을 생성하지 않는다.

`owner`, `permissionSummary`, `permissionRoles`는 표시·호환 metadata다. 실제 권한은 저장된 `permissionGrants`로 판정하며 owner는 별도 grant 없이 전체 권한 fallback으로 계산한다.

`GET /api/etl/permission-options`는 권한 디렉터리 조회만 수행한다. 민감 데이터 감지나 공개 범위 안전 판정을 반환하지 않는다.
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
## EKS MVP runtime contract

EKS standard/web-only 프로필의 FastAPI는 아래 환경 계약을 사용한다.

| Variable | EKS MVP value | Meaning |
| --- | --- | --- |
| `ASKLAKE_CONTINUOUS_CONTROL_PLANE` | `external_ec2` | Kafka Continuous 제어권과 상태는 EC2에 남기고 EKS 접근을 차단한다. |
| `ASKLAKE_SPARK_EXECUTION_LEASE_SECONDS` | `60` | 같은 `runId` 외부 실행의 RDS lease TTL이다. Spark run timeout과 독립적이다. |
| `ASKLAKE_SPARK_RESOURCE_PLANNER_MODE` | `off` | `off`, `shadow`, `enforce`. 최초 적용은 계산만 기록하는 `shadow`다. |
| `ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES` | `134217728` | 예상 Spark read partition 크기다. |
| `ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR` | `384` | 이력이 없을 때 `history-sla-cost-v1` 크기 seed에서 executor 하나가 담당하도록 계획하는 partition 수다. |
| `ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS` | `1` | Resource Plan 최소 executor 수다. |
| `ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS` | `4` | V1 후보 `1`, `2`, `4` 중 최대 executor 수다. |
| `ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES` | dev 활성값 `10737418240`, rollback `0` | exact source byte가 양수 한도 이하일 때만 direct `MEMORY_AND_DISK` cache를 선택한다. 10GiB 외 임의 운영값은 runtime ConfigMap schema가 거부한다. |
| `ASKLAKE_SPARK_KUBERNETES_MAX_ATTEMPTS` | `2` | terminal-failed SparkApplication 뒤 같은 logical Run에서 허용하는 attempt generation 상한이다. `1..3`으로 제한한다. |
| `ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS` | `7200` | SparkApplication polling의 최대 실행시간이다. heartbeat가 이 제한을 연장하지 않는다. |
| `ASKLAKE_SPARK_RUNNER` | `kubernetes` | in-cluster API로 `SparkApplication`을 제출·복구·조회하고 driver 결과를 수집한다. |

현재 Realtime V1-only 프로필은 승인된 owner transfer generation과 이전 owner fence를 함께 요구하고 `ASKLAKE_CONTINUOUS_CONTROL_PLANE=local`로 전환한다. 이때 EKS 전용 `asklake-realtime-v1-worker` 하나가 `CONTINUOUS_WORKER_SCOPE=all`을 소유하며 ClickHouse V2/Kafka Connect는 렌더하지 않는다. EC2 worker는 동시에 활성 owner가 될 수 없다.

`external_ec2`에서 `GET /api/etl/jobs`는 Continuous Job을 반환하지 않는다. Continuous Job의 상세·수정·삭제, 생성, command, 전용 runtime/log/maintenance API와 Continuous dataset의 freshness/dashboard widget data 조회는 아래 `409` envelope를 반환한다. Batch/SQL dataset 조회는 이 경계의 영향을 받지 않는다.

```json
{
  "error": {
    "code": "CONTINUOUS_CONTROL_OWNED_BY_EC2",
    "message": "Kafka Continuous control remains owned by the EC2 environment for the EKS MVP.",
    "details": {
      "controlPlane": "external_ec2"
    }
  }
}
```

`ASKLAKE_SPARK_RUNNER=kubernetes`에서 같은 `runId`와 같은 attempt generation은 같은 Kubernetes object name을 사용한다. 최초 create 응답을 잃거나 이미 object가 있으면 provider는 기존 `SparkApplication`의 run/job/image/attempt identity를 검증한 뒤 이어서 polling한다. identity가 다르면 기존 object를 재사용하지 않고 실행을 실패시킨다. create/recover 직후 terminal 전에도 `etl_runs.task_states.sparkExecution.kubernetesExecution`에 namespace, application name/UID, attempt generation, run/job/image identity, 관찰 state와 recovery 여부를 저장한다. driver가 생기면 Pod name을 연결하고 terminal에는 Pod phase, termination reason/exit code, result marker 존재 여부를 합친다. terminal manifest와 이미 저장한 RDS identity의 namespace/name/UID/image/attempt/driver Pod가 다르거나 `success`에 유효한 `ASKLAKE_SPARK_JOB_RESULT` marker가 없으면 `409 SPARK_EXECUTION_IDENTITY_MISMATCH`로 성공 처리를 차단한다. timeout은 해당 application 삭제 후 실패 처리한다.

Resource Planner가 활성화되면 최초 제출 전에
`taskStates.sparkExecution.resourcePlan`을 저장한다. 같은 Run과 새 attempt
generation의 retry는 이 값을 재계산하지 않으며 SparkApplication annotation과
Kubernetes execution의 `resourcePlanHash`가 다르면 identity mismatch로 차단한다.
policy V3 `history-sla-cost-v1`은 cores `2`, CPU request/limit `2/3`,
heap/overhead `4g/1g`인 `standard-v1` profile에서 executor 수만 `1`, `2`, `4` 중
선택한다. 같은 Job의 성공 이력으로 후보별 `spark_duration_ms`와
`executor_seconds`를 계산해 30분을 만족하는 최소 비용 후보를 고르고, 비교 가능한
이력이 없으면 기존 partition budget을 size seed로 사용한다. `shadow`의
`appliedExecutors`는 기존 고정 executor 수와 같다. 입력 크기를 알 수 없거나 실제
profile이 다르면 `enforce`에서도 기존 executor 수를 유지한다. policy V1/V2 Plan은
retry/recovery 호환을 위해 계속 읽되 새 Run에는 소급 적용하지 않는다.

terminal failure 뒤 internal execute 경계를 같은 `runId`로 다시 호출하면 기본 최대 2회 안에서 다음 deterministic application name과 새 UID를 만든다. 이전 terminal identity는 `sparkExecution.kubernetesAttempts`에 남고 현재 attempt와 분리된다. non-terminal application에는 새 UID를 만들 수 없으며, 상한을 넘으면 `409 SPARK_TERMINAL_RETRY_EXHAUSTED`다.

`POST /api/internal/airflow/spark-runs/{runId}/fault-attempts/msk-authorization`는 Day 18 deny-only 증거를 기존 EKS fixture Run에 연결하는 bearer-protected adapter다. body는 `jobId`, `category: "AUTHORIZATION"`, `attemptedRecords: 1`, `acknowledgedRecords: 0`, 64자리 소문자 `evidenceSha256`만 허용한다. 다른 category/count, 일반 Job, terminal result 이후 입력, 같은 Run의 다른 evidence는 `409`로 거부한다. 동일 evidence 재전송은 새 generation을 만들지 않고 저장된 attempt를 반환한다.

`kubernetesExecution`의 비밀값 없는 추적 필드는 다음과 같다. `driverPodName`과 terminal Pod 필드는 해당 단계가 관찰된 뒤 추가된다.

```json
{
  "runId": "<AskLake runId>",
  "jobId": "<AskLake jobId>",
  "namespace": "asklake-dev",
  "applicationName": "asklake-run-...",
  "applicationUid": "<Kubernetes UID>",
  "attemptGeneration": 1,
  "imageDigest": "<repository>@sha256:<digest>",
  "state": "COMPLETED",
  "recovered": false,
  "replacement": false,
  "driverPodName": "asklake-run-...-driver",
  "driverPodPhase": "Succeeded",
  "driverTerminationReason": "Completed",
  "driverExitCode": 0,
  "resultMarkerFound": true
}
```
## 공통 correlation·오류·health 계약 (2026-07-16)

- 모든 API는 유효한 request `X-Correlation-ID`를 보존하거나 새 ID를 생성해 같은 response header로 반환한다.
- 공통 `error`는 기존 `code`, `message`, `details`를 유지하고 `stage`, `retryable`, `operatorMessage`, `userMessage`, `diagnosticId`를 additive field로 제공한다.
- `details`는 secret key를 재귀적으로 redaction하며 validation input 원문과 unhandled stack을 반환하지 않는다.
- `GET /api/health/live`는 process liveness, `GET /api/health/ready`는 DB readiness, 기존 `GET /api/health`는 호환 readiness다.
- `GET /api/health/metrics`는 현재 backend process의 진단 counter snapshot을 반환한다.
- `GET /api/health/ai`는 `gateway` runtime에서 Gateway `/health`를 확인한다. 정상은 HTTP 200과 `status=ready`, 설정 누락·provider/MCP 장애는 HTTP 503과 `unconfigured` 또는 `unavailable`이다. 응답의 `gateway`에는 service/provider/model/MCP/check/capability 진단만 포함하고 token·provider key는 반환하지 않는다. `direct` rollback runtime에서는 `status=disabled`다.

## EKS Realtime V1-only API 계약

- `GET /api/realtime/config`는 Spark realtime capability만 반환한다.
- Kafka `executionMode=continuous` Job 생성 시 server가
  `continuousConfig.runtimeEngine=spark_structured_streaming`을 저장한다.
- start, pause, resume, stop은 desired state와 state revision만 변경하며 실제
  SparkApplication side effect는 exact-one realtime worker가 수행한다.
- session/batch API는 checkpoint, source offset, Iceberg snapshot, Catalog publication을
  연결한 durable 상태를 반환한다.
