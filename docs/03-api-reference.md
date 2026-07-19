# 03. API Reference

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
REALTIME_EVENTS_ENABLED=true
CONTINUOUS_SQL_JOIN_ENABLED=true
CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=false
CLICKHOUSE_REALTIME_V2_ENABLED=true
KAFKA_CONNECT_SINK_ENABLED=true
CLICKHOUSE_REALTIME_CONSUMER_OWNER=kafka_connect_v2
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

- `VITE_API_BASE_URL`을 생략하거나 빈 문자열로 두면 개발·production build 모두 같은 출처의 `/api`를 호출한다. Realtime event URL도 같은 규칙을 사용한다. Vite는 이를 `VITE_DEV_PROXY_TARGET` 또는 기본 `http://127.0.0.1:8080`으로 전달하고, frontend container의 Nginx는 Compose `backend:8080`으로 전달하되 `/api/realtime/events`는 SSE buffering을 끈다.
- SQL Query AI, Dashboard Assistant, ETL transform, 리뷰 분석 frontend client는 세션을 포함한 live API만 호출한다. 개발 전용 `VITE_USE_MOCK_API` 호환 모드는 이 AI client들에 적용되지 않으며, production에서는 계속 비활성화된다.
- Legacy demo 계정은 production에서 기본 생성·복구되지 않는다. 재배포는 기존 `auth_users.status`와 session을 보존한다. 공개 demo 배포는 `AUTH_LEGACY_DEMO_USERS_ENABLED=true`와 `VITE_AUTH_LEGACY_DEMO_USERS_ENABLED=true`를 함께 명시할 때만 누락 계정을 만들거나 disabled 계정을 복구하고 로그인 안내를 활성화한다. preflight는 두 플래그의 lowercase boolean 및 일치를 강제하며, 일반 운영 로그인은 bootstrap admin 또는 승인된 IdP/session 경로를 사용한다.
- `AUTH_SESSION_COOKIE_SECURE`는 운영 세션 쿠키의 `Secure` 속성을 제어하며 기본값은 운영에서 `true`다. HTTPS가 없는 제한된 dev HTTP ALB에서만 `false`를 명시하고, HTTPS 전환 즉시 `true`로 복구한다. 이 설정은 header-auth fallback이나 public signup을 활성화하지 않는다.
- `VITE_DASHBOARD_ASSISTANT_API_PATH`: 미설정 시 `/api/dashboards/assistant`를 사용한다. 다른 Assistant API origin 또는 경로가 필요할 때만 지정한다.
- `DASHBOARD_SYNC_MODE`: `polling`, `hybrid`, `sse` 중 하나다. invalid 값 또는 event backbone 비활성 조합은 effective `polling`으로 fail closed한다.
- `REALTIME_EVENTS_ENABLED`: durable event/SSE 경로의 총괄 kill switch다. Production Compose 기본값은 `true`다.
- `CONTINUOUS_SQL_JOIN_ENABLED`: Continuous SQL create/start 경로의 kill switch다. Production Compose 기본값은 `true`이며 기존 Kafka Continuous ingestion과 정적 SQL에는 영향을 주지 않는다.
- `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED`: Kafka Engine V1 worker의 kill switch다. Production Compose는 V2의 단일 consumer ownership을 위해 기본값을 `false`로 둔다.
- `CLICKHOUSE_REALTIME_V2_ENABLED`, `KAFKA_CONNECT_SINK_ENABLED`: Production Compose에서 V2 application과 Kafka Connect sink를 함께 활성화한다.
- `CLICKHOUSE_REALTIME_CONSUMER_OWNER`: production 기본값은 `kafka_connect_v2`다. 같은 Job generation에서 `kafka_engine_v1`과 동시에 사용할 수 없다.
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
- Query AI 요청은 선택된 dataset ID만 전달한다. Backend가 actor의 `query` 권한과 governance를 확인하고 짧은 수명의 단일 사용 signed context를 발급하며, Gateway는 내부 MCP로 bounded/redacted Catalog context를 읽는다. Backend는 read-only·Dataset scope뿐 아니라 prompt의 명시적 집계/그룹화 의도도 검증하고, 위반 시 한 번만 교정 재요청한다. Frontend는 선택 Dataset·query·dialog context가 달라진 요청을 취소하고 stale 응답을 적용하지 않는다. Provider/RAG 실패 시 frontend가 로컬 SQL이나 근거를 대신 만들지 않는다.
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
- `POST /api/etl/jobs/{jobId}/commands`의 Continuous start/pause/resume/stop은 production에서 durable intent를 먼저 기록한다. `processingResult.controlPlaneOnly=true`이면 별도 control-plane worker가 Spark side effect를 수행한다. 이 응답은 worker 시작 완료를 뜻하지 않는다.
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
  "realtimeEventsEnabled": false,
  "continuousSqlJoinEnabled": false,
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

`clickhouseRealtimeConsumerOwner`는 `disabled | kafka_engine_v1 | kafka_connect_v2`다. V2와 sink field는 설정 검증 결과를 보여줄 뿐 connector가 등록되거나 ready라는 뜻이 아니다. `fallbackReason`은 `invalid_dashboard_sync_mode` 또는 `realtime_events_disabled`일 수 있다. 이 endpoint는 Connect URL, connector name, secret이나 raw env 값을 반환하지 않는다.

### Realtime Dashboard stream

`GET /api/realtime/events?dashboardId=<id>&datasetIds=<id,id>&cursor=<eventCursor>`는 인증된 `text/event-stream` endpoint다. `asklake_session` cookie를 사용하고 Dashboard `view`와 모든 Dataset `query` 권한을 검사한다. reconnect에서는 `Last-Event-ID`와 query cursor 중 큰 값을 사용한다.

Domain event는 `id`, `event`, JSON `data`를 가지며 `dataset.revision.committed`와 `dashboard.published`를 지원한다. `stream.ready`, `system.heartbeat`, `system.resync_required`, `system.authorization_changed`는 client control event다. response는 `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`이며 cursor retention gap 또는 bounded queue overflow에서는 resync를 지시하고 연결을 닫는다.

`GET /api/realtime/status`는 인증된 운영 진단용 JSON으로 effective mode, readiness, cursor bounds와 process metric/capacity snapshot을 반환한다. `GET /api/health/realtime`는 load balancer용 realtime readiness를 일반 `/api/health`와 분리하고 PR02부터 아래 `v2` object를 additive하게 포함한다.

```json
{
  "v2": {
    "enabled": false,
    "ready": false,
    "status": "disabled",
    "consumerOwner": "disabled",
    "connector": {
      "enabled": false,
      "configured": false
    }
  }
}
```

V2 flag가 켜지면 `v2.status="configuration_validated"`가 되지만 PR02에서는 live probe가 없으므로 `v2.ready`는 계속 `false`다. 이 경우 endpoint도 HTTP `503`으로 fail closed하며 event backbone이 꺼져 있으면 top-level `status="not_ready"`, 켜져 있으면 `status="unavailable"`이다. `connector.configured`는 sink flag, URL과 name이 설정됐다는 configuration marker이지 Connect REST/plugin/task 또는 ClickHouse write health가 아니다. V2가 꺼지면 기존 realtime health 동작을 유지한다.

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

validate/create request는 `query`, distinct `relationDatasetIds`, `staticBindingPolicy`, `triggerIntervalSeconds`를 사용한다. `triggerIntervalSeconds`는 1~3,600초이고 새 Continuous SQL request의 기본값은 5초다. 명시한 기존 request와 저장된 Job 값은 바꾸지 않는다. create는 `name`, `clientRequestId`와 아래 두 output mode 중 하나를 추가한다.

- 기본 `servingMode=iceberg`: 기존처럼 `storagePath`, append `icebergTarget`, optional `checkpointPath`를 사용한다.
- opt-in `servingMode=clickhouse`: `clickhouseTarget: { engine: "clickhouse", database, table }`만 사용한다. `storagePath`, `icebergTarget`, `checkpointPath`를 함께 보내면 `422`다. 정적 S3/Iceberg relation은 Job 시작 때 참조 열만 Trino page로 읽어 snapshot-scoped ClickHouse local table에 고정하고, 같은 snapshot은 resume에서 재사용한다. Kafka Engine은 메시지를 `RawBLOB`으로 받고 Dataset의 `recordParsing/schemaColumns`에 따라 typed raw table로 변환한 뒤 JOIN output table에 연속 반영한다. 이 mode는 `PINNED_AT_START`만 지원한다.

Job 응답은 `servingMode`와 mode별 `outputTarget`을 반환한다. ClickHouse 결과 Dataset은 Catalog에 `storageFormat=clickhouse`와 `clickhouseTable`을 기록하며 Dataset row와 Dashboard widget API는 output table을 `FINAL`로 읽는다. 일반 Trino SQL mapping은 만들지 않는다. plan relation의 `cacheHint`는 서버가 Catalog 통계와 안전 한도로 계산한 실행 hint이며 client가 임의로 지정하는 입력이 아니다. active Run 응답은 generation과 `fencingTokenHash`만 포함하며 fencing token 원문은 반환하지 않는다.

지원 SQL, Catalog relation metadata, lifecycle, error stage와 publication 계약은 `docs/realtime-2026/contracts/continuous-sql-v1.md`를 따른다. 기능 비활성은 `409 CONTINUOUS_SQL_DISABLED`, SQL/metadata validation은 안정적인 `CONTINUOUS_SQL_*` code와 `422`, 잘못된 transition/idempotency 충돌은 `409`다.

SQL 분석 frontend는 선택 관계가 Kafka streaming 1개와 static 1개 이상일 때 `실시간 JOIN 만들기` action을 표시한다. action은 `GET /api/realtime/config`의 `continuousSqlJoinEnabled`와 `clickhouseContinuousJoinEnabled`가 모두 true인지 확인하고, 현재 editor SQL과 선택 Dataset ID 전체로 validate를 먼저 호출한다. static key 증적만 없으면 위 exact verification API를 자동 호출하고 validate를 재시도한다. 성공하면 `servingMode=clickhouse`, `layer=GOLD`, `staticBindingPolicy=PINNED_AT_START`로 Job을 생성하고 별도 `start` command를 전송한다. UI 기본 trigger는 빠른 시작을 위해 1초를 명시하지만 backend request 기본값 5초와 기존 Job 값은 변경하지 않는다. Job `running`과 첫 실제 offset이 게시되어 Catalog row가 조회되는 시점을 구분하므로 첫 publication 전에는 완료로 표시하지 않는다.

Canonical status values:

| Resource | Field | Values |
| --- | --- | --- |
| Job | `status` | persisted legacy 값은 `scheduled`, `running`, `failed`, `paused`, `canceled`, `stopped`; 목록 UI는 `scheduled`, `running`, `stopped` 중심으로 표시하고 실패·취소는 최신 Run 결과로 표시 |
| Run | `status` | `queued`, `running`, `success`, `failed`, `canceled` |
| Dataset | `status` | `available`, `approval_required` |
| Dataset | `freshness` | `latest`, `stale`, `approval` |
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
| `POST` | `/api/etl/sql-jobs` | source Query Run submitter/admin | 성공한 Trino Query Run에서 반복 full-refresh SQL Job 생성 | `docs/trino-query-run-contract.md` |
| `PATCH` | `/api/etl/jobs/{jobId}` | `manage` | 생성된 Job의 허용 설정 업데이트. source identity는 요청에 포함할 수 없음 | `docs/etl-job-edit-contract.md` |
| `POST` | `/api/etl/jobs/{jobId}/commands` | TBD | 실행, 재실행, 일시정지, 현재 Run 취소, 스케줄 중지 | `docs/api-contract.md` |
| `GET` | `/api/etl/kafka/replay-producer` | `manage` | 배포 환경 Kafka replay producer 상태/최근 로그 조회 | `docs/api-contract.md` |
| `POST` | `/api/etl/kafka/replay-producer` | `manage` | JSON envelope 또는 원문 줄 단위 Kafka replay producer 시작 | `docs/api-contract.md` |
| `DELETE` | `/api/etl/kafka/replay-producer` | `manage` | 실행 중인 Kafka replay producer에 graceful stop 요청 | `docs/api-contract.md` |
| `POST` | `/api/internal/airflow/spark-runs/{runId}/execute` | Airflow service bearer token | 저장된 일반 배치 Job/Run을 재검증하고 PySpark 실행. 브라우저 호출 금지 | `docs/api-contract.md` |
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
| `POST` | `/api/query/ai-suggestions` | 모든 선택 Dataset의 `query` | signed MCP context, Semantic RAG, Catalog cost metadata 기반 SQL 초안 생성. intent/cost 공용 최대 1회 교정 횟수와 generator/prompt version 반환 | `docs/api-contract.md` |
| `POST` | `/api/ai/generate-sql` | authenticated actor | ETL field/SQL transform용 Gateway SQL 생성 후 relation·column·read-only 검증 | 이 문서 |
| `GET` | `/api/catalog/datasets/{datasetId}/rows` | `view` + `query` | 최신 성공 materialization의 실제 row를 최대 500행 page로 조회 | `docs/api-contract.md` |
| `POST` | `/api/catalog/derived-datasets` | TBD | SQL 결과 기반 Lake Dataset 생성 | `docs/api-contract.md` |
| `POST` | `/api/catalog/trino-runs/{runId}/materializations` | source run submitter/admin | 완료된 Trino run의 1회성 Iceberg CTAS 등록 시작. SQL 결과 toolbar에는 노출하지 않음 | `docs/trino-query-run-contract.md` |
| `GET` | `/api/catalog/trino-materializations/{materializationId}` | submitter/admin + current `query` access | persisted CTAS/등록 상태 조회 | `docs/trino-query-run-contract.md` |

### AI SQL transform 생성

`POST /api/ai/generate-sql`은 `{ question, promptType, metadata, context?, engine }`을 받고 `{ sql, schemaContext, model, provider }`를 반환한다. `promptType`은 `query_page`, `field_transform`, `sql_transform`, `partition`, `general` 중 하나다. `field_transform`은 scalar expression만, `sql_transform` 또는 SELECT 응답은 단일 read-only query만 허용한다. Backend는 Gateway 출력에서 supplied metadata 밖의 column/relation, wildcard field transform, Spark script transform과 `reflect`/`java_method` 계열 위험 함수를 거부한다. Gateway 미설정·timeout·invalid provenance·invalid SQL은 성공 초안으로 대체하지 않고 공통 error envelope로 반환한다.

`GET /api/etl/sources/defaults`는 `{ "kafkaBroker": "...", "kafkaTopic": "...", "s3Bucket": "...", "s3Prefix": "..." }`를 반환한다. 새 빈 Kafka/S3 Source draft만 build-time 상수 대신 이 값을 한 번 채우며 저장된 설정과 사용자가 편집한 값은 보존한다. 응답에는 access key, secret, token 같은 인증 정보를 포함하지 않는다.

Kafka `POST /api/etl/sources/test`와 Snapshot ingest consumer는 uncompressed 및 Snappy-compressed record batch를 지원한다. Source test는 consumer 오류를 빈 metadata preview로 바꾸지 않는다. 첫 메시지 이후 최소 샘플 수에 도달하면 idle window로 종료하고, 도달하지 못해도 bounded settle window 뒤 현재 샘플을 반환한다. 응답의 `rawPreviewLines`는 broker에서 읽은 Kafka `value` 문자열을 순서대로 보존하며 JSON envelope의 nested field를 공백 로그로 재구성하지 않는다. JSON/JSONL이면 `requiresRecordParsing=false`로 Schema 단계로 이동하고, 실제 raw text value일 때만 `detectedFormat=TXT`, `requiresRecordParsing=true`로 레코드 구조화 단계를 연다.

`POST /api/etl/jobs/{jobId}/commands`의 일반 배치 `run`/`retry`는 Airflow 접수 직후 `queued` 또는 `running` 상태를 응답한다. Airflow의 `spark_process_write` task가 bearer token으로 FastAPI internal execution API를 호출해 실제 PySpark 처리를 수행한다. Backend는 `AIRFLOW_RUN_SYNC_INTERVAL_SECONDS`(기본 5초)마다 active Snapshot Run을 Airflow와 동기화해 DB에 저장하고, Jobs 화면은 `GET /api/etl/jobs/statuses` 한 요청으로 여러 Job의 최종 Run/DAG/Spark 상태를 읽는다.

`jobKind=trino_sql_materialization` Job의 `run`/`retry`/`cancelRun`은 Airflow/Spark가 아니라 Trino materializer와 durable collector를 사용한다. 매 Run은 고유 Iceberg table에 full-refresh CTAS하고 `DESCRIBE` 성공 후 안정적인 Catalog Dataset mapping을 교체한다. 실패·취소는 이전 정상 mapping을 변경하지 않는다.

PostgreSQL Snapshot Job의 `run`/`retry`는 생성 시 저장된 `schemaSampleRows`, `__Schema Sample Scope`, `__Sample Row Limit`을 실행 행 제한으로 사용하지 않는다. 내부 실행 API는 선택한 `DATASET OR TABLE SELECTOR` 기본 테이블을 repeatable-read cursor로 끝까지 export하고 Spark manifest의 `inputRows`/`outputRows`에 실제 전체 행 수를 기록한다. 연결 실패, 테이블 부재, 빈 테이블, export 실패는 Spark/Catalog 성공으로 처리하지 않는다.

File / S3 Prefix Job의 `run`/`retry`는 저장된 `Path / Prefix` 아래에서 Preview와 같은 형식·비데이터 제외 규칙을 다시 적용한다. `_SUCCESS`, `manifest.json`, 숨김 객체와 다른 형식 객체는 Spark 입력이 아니며, 실제 처리 근거는 Spark manifest의 `inputFileCount`, `inputBytes`, `inputRows`, `outputFileCount`, `outputRows`로 반환한다.

내부 실행 API는 `AIRFLOW_EXECUTION_API_TOKEN`이 없으면 `503 AIRFLOW_EXECUTION_NOT_CONFIGURED`, token이 다르면 `401 AIRFLOW_EXECUTION_UNAUTHORIZED`, 저장된 Job/Run/Airflow DAG Run identity가 일치하지 않으면 `409 AIRFLOW_RUN_MISMATCH`를 반환한다. 성공/실패 Spark manifest는 `JobRunSummary.taskStates.sparkResult`에 보존된다. 일반 non-Kafka batch 성공 manifest의 `outputPath`는 `iceberg://...`이고 `icebergCommit`에 snapshot ID, warehouse location, target, schema/rule fingerprint, source boundary가 포함된다.

`publish_run_result` task는 `POST /api/internal/airflow/spark-runs/{runId}/catalog`에 `{ "jobId": "..." }`를 보낸다. 일반 batch에서는 backend가 저장된 `sparkResult.status=success`, persisted `icebergTarget`, snapshot/fingerprint identity, Trino `DESCRIBE`/`$snapshots`/`$files`, Job의 `datasetId`를 검증한 뒤 같은 Run의 materialization과 lineage를 `catalog_datasets.payload`에 저장한다. 성공 response는 `status`, `runId`, `reconciledAt`, `dataset`을 반환하고 `JobRunSummary.taskStates.catalogResult`에도 snapshot ID, data-file count, storage location을 보존한다.

Catalog endpoint는 `runId` 기준으로 멱등하다. `publish_run_result`는 30초 간격으로 최대 2회 재시도하므로 최초 시도를 포함해 최대 3회 같은 `runId`의 Catalog reconciliation을 호출한다. 이 task retry는 upstream의 성공 Spark XCom과 저장된 `sparkResult`를 재사용해 Spark를 다시 실행하지 않으며, `materializationRuns`에는 같은 `runId`가 하나만 남아야 한다. 저장된 Spark 성공 결과가 없으면 `409 SPARK_RESULT_NOT_READY`, identity가 다르면 `409 AIRFLOW_RUN_MISMATCH`, 실제 output 확인 또는 Catalog transaction이 실패하면 `500 CATALOG_RECONCILIATION_FAILED`를 반환한다. 실패 응답은 재시도 소진 후 `publish_run_result` task와 DAG Run을 실패시키고, AskLake Run의 실패 단계는 `Catalog reconciliation`로 표시한다.

검증된 Spark Catalog publication은 `sourceManifest`를 함께 저장한다. Iceberg Dataset의 manifest는 `manifestVersion`, `datasetId`, `sparkPath`, `format=iceberg`, `fingerprint`, `expiresAt`, `runId`, `icebergSnapshotId`를 포함하며, RAG parent staging은 table 최신 상태가 아니라 이 검증된 snapshot ID를 읽는다. snapshot 증적이 없는 Iceberg 결과에는 RAG용 manifest를 발급하지 않는다.

Airflow DAG Run은 Catalog endpoint가 성공한 뒤에만 `success`가 된다. Jobs 화면의 상태 조회는 Job 상태만 갱신하며 Catalog 목록을 함께 요청하지 않는다. Catalog·SQL·AI 화면에 들어갈 때 해당 화면의 loader가 최신 Catalog 목록을 읽는다.

`stopSchedule`/`resumeSchedule`은 배치에서는 자동 실행 중지/재개, 실시간에서는 수집 중지/재개로 해석한다. 실행 중인 실시간 Job을 중지하면 현재 Run도 `canceled`로 종료하고 중지 시각을 기록한다.

ETL 성공 dataset의 `lineageGraph`는 transform-aware column lineage를 사용한다. source node는 실제 transform input만 포함하고, 하나의 source `text`에서 여러 분류 컬럼을 파생하면 `text -> 각 output` edge를 각각 반환한다. Spark가 생성한 `_asklake_*` 컬럼은 job node에서 시작한다.

Issue #500은 같은 command endpoint에 `startContinuous`, `pauseContinuous`, `resumeContinuous`, `stopContinuous`를 추가한다. 이 명령은 `executionMode: "continuous"` Kafka Job에만 적용하며, Docker가 시작한 long-running Spark Structured Streaming worker를 제어한다. 사용자 화면은 checkpoint를 보존하는 `중지`와 `스트림 시작`만 제공한다. Continuous 생성은 일반 cron 스케줄 단계를 건너뛰며 request에는 `scheduleLabel: "스케줄링 건너뛰기"`와 스트림 lifecycle 설명을 저장한다. `pauseContinuous`/`resumeContinuous`는 기존 API 호환을 위해 유지하지만 별도 UI 흐름으로 노출하지 않는다. 응답의 `processingResult.controlPlaneOnly`는 `false`, `worker`는 `spark_structured_streaming`이다. Backend Continuous runtime sync loop가 worker container liveness와 heartbeat를 검사해 runtime을 저장하며, 요청 없이 종료되거나 heartbeat가 만료된 active worker는 `failed`로 반영한다. `GET /api/etl/jobs/{jobId}`는 저장된 `continuousRuntime`을 read-only로 반환한다. `pausing`/`stopping`에서의 의도된 worker 종료는 각각 `paused`/`stopped`로 완료한다. `continuousRuntime`은 기존 `status`/`lastError`와 함께 additive `desiredState`, `observedState`, `stateRevision`, `fencingToken`, `errorDetail`을 반환한다. command revision과 active worker attempt fencing으로 늦은 polling/report가 최신 상태를 덮지 못하게 하며 legacy row는 migration 없이 hydrate한다. Continuous Job은 장기 실행 Spark query와 checkpoint로 상태를 복원하므로 `run`/`retry` Snapshot command와 섞어 사용할 수 없다. 상세 request/response와 충돌 정책은 [Kafka Continuous Ingestion Contract](kafka-continuous-ingestion-contract.md), 상태 소유권은 [Continuous runtime 상태·오류 소유권](refactor-2026/contracts/runtime-state-ownership.md)을 따른다.

Issue #567 Phase 5부터 Continuous create/review/preview는 Snapshot conformance를 통과한 stateless canonical Rule을 허용한다. `GET /api/etl/jobs/{jobId}`의 `continuousRuntime`은 `ruleContractVersion`, `ruleFingerprint`, `runtimeFingerprint`, `ruleMetrics`, `lastRuleResult`를 추가로 반환한다. Worker report, batch manifest와 Catalog `materializationRuns`도 schema/rule/runtime fingerprint와 Transform/Quality 결과를 보존한다. 실행 중 processing contract 변경은 `409 CONTINUOUS_IMMUTABLE_CONFIG_ACTIVE`, checkpoint가 초기화된 뒤의 schema/Rule/physical target 변경은 `409 CONTINUOUS_CHECKPOINT_CONTRACT_IMMUTABLE`이며 Job copy와 새 checkpoint가 필요하다.

Continuous 운영 API는 `GET /api/etl/jobs/{jobId}/continuous/logs`, `GET /api/etl/jobs/{jobId}/continuous/sessions`, `GET /api/etl/jobs/{jobId}/continuous/sessions/{sessionId}`, `GET /api/etl/jobs/{jobId}/continuous/sessions/{sessionId}/batches?limit=100`, `GET /api/etl/jobs/{jobId}/continuous/quarantine`, `GET /api/etl/jobs/{jobId}/continuous/maintenance-runs`, `POST /api/etl/jobs/{jobId}/continuous/quarantine/replays`, `POST /api/etl/jobs/{jobId}/continuous/compactions`, `POST /api/etl/jobs/{jobId}/continuous/iceberg-maintenance`를 제공한다. session은 한 번의 stream start부터 terminal 전환까지를 나타내고 batch endpoint는 그 session에 속한 최근 micro-batch를 최신순으로 반환한다. batch는 `sourceBoundary`, `icebergSnapshotId`, `icebergTableUri`를 추가로 반환한다. session과 batch의 `dagSteps`는 Source, Schema, Transform, Quality, Target, Manifest/Checkpoint, Catalog 7단계 근거를 제공하며 Catalog cursor 확인 전 publication은 마지막 단계가 `pending`이다. manifest 전에 Rule이 실패한 batch도 `failed` 이력과 오류를 반환하고, 규칙이 없는 Transform/Quality 단계는 `pass-through`다. 조회 API는 worker report와 liveness를 먼저 동기화하므로 별도 새로고침 명령 없이 최신 durable 상태를 읽는다. Replay body는 `offsets?: string[]`와 `approveUnknownFields?: boolean`을 받고 현재 policy/Rule을 적용한 성공 행을 같은 Iceberg table에 append한 뒤 Trino 검증 성공 시 `catalogApplied=true`를 남긴다. `approveUnknownFields: true`는 unknown field만 고정 projection으로 승인하는 `manage` 권한 작업이다. `compactions`는 `targetFileSizeMb`(128~512)를 받아 Iceberg `rewrite_data_files`를 실행한다. `iceberg-maintenance`는 rewrite와 선택적 snapshot expiration/orphan cleanup을 조합하며 삭제성 작업은 `manage` 권한이 필요하다. 모든 maintenance는 worker가 paused/stopped일 때 Job/runtime row lock 순서로 worker start/resume과 상호 배제되고, 완료 snapshot과 파일 지표를 Trino로 검증한다. Maintenance run은 기본 900초 lease를 가지며 durable REST runner heartbeat가 fresh이면 lease를 갱신하고 stale/absent runner만 정리한다.

Kafka replay producer API는 Continuous worker와 분리된 테스트 입력 도구다. `POST /api/etl/kafka/replay-producer`는 `topic`, `rate`, `batchSize`, `loop`, `maxCycles?`, `maxMessages?`, `cycleDelayMs?`, `burstMinMessages?`, `burstMaxMessages?`, `burstIntervalSeconds?`, `inputPath?`, `payloadMode?`를 받으며 한 번에 하나만 실행한다. `payloadMode` 기본값은 `json_envelope`이고 기존 fixture를 유지한다. `raw_text`이면 `inputPath`가 필수이며 `.txt`, `.log`, `.jsonl` 파일의 비어 있지 않은 각 줄을 JSON 변환 없이 Kafka value로 보낸다. burst 세 값은 함께 쓰며 loop mode에서 매 interval마다 min~max의 랜덤 건수를 rate 제한 없이 전송한다. JSON envelope loop 모드는 cycle별 고유 `event_id`와 증가하는 논리 `offset`을 만들고, 기존 topic을 삭제하지 않는다. `inputPath`는 배포 설정의 `ASKLAKE_REPLAY_INPUT_DIR` 아래 상대 경로만 허용한다.

`GET /api/etl/jobs/{jobId}`는 Job 상세·전체 실행 이력·수정 화면 hydrate의 read-only source of truth다. 주기적인 실행 상태 갱신은 `GET /api/etl/jobs/statuses`가 담당한다. 상세 응답은 source config, schema columns/fingerprint/sample/summary, transform/quality, schedule/retry/watermark, permission summary/roles, target database/metadata를 함께 유지한다.

`PATCH /api/etl/jobs/{jobId}`는 `manage` 권한이 필요하다. request는 source field를 허용하지 않으며, 실행 중인 Job은 `409`, 성공 Run이 있는 Snapshot Job의 target dataset/database/layer/format/storage identity 변경은 `422`로 차단한다. Continuous는 checkpoint contract 초기화 전까지만 schema/Rule/physical target을 수정할 수 있고, 초기화 후에는 위 전용 `409` 오류로 Job copy를 요구한다. update는 Kafka consumer group offset, Snapshot 경계 또는 Continuous checkpoint를 변경하지 않는다.

Kafka Source Snapshot Job의 `run`/`retry`는 Airflow 대신 backend Kafka ingest bridge와 Spark Iceberg writer를 실행한다. Job 시작 시 partition별 end offset snapshot을 고정하고 해당 range만 consume한 뒤 `topic -> transform/quality -> Iceberg append -> Trino physical verification -> Catalog materialization -> consumer offset commit` 순서로 처리한다. 같은 consumer group을 쓰면 마지막 성공 snapshot의 end offset 이후만 target에 저장된다. lag가 없으면 새 Iceberg data file이나 materialization 없이 0건 Run으로 성공한다. 같은 durable snapshot 재시도는 Iceberg source marker와 Catalog snapshot identity를 재사용해 중복 append하지 않는다.

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
| Lineage | `LineageGraph` mock/fallback | `GET /api/catalog/datasets/{datasetId}/lineage` |
| SQL 분석 | 최대 100행 Trino preview Query Run 제출, 상태 polling, on-demand 전체 결과 run, signed-cursor page와 server CSV. 사용자별 실행 이력 조회·재열기 endpoint는 backend 계약으로 유지하며 이번 화면에는 별도 이력 선택 목록을 노출하지 않음 | Query lifecycle endpoints |
| Query AI 생성 | 선택 Dataset ID와 prompt를 FastAPI에 보내고 private Gateway + 단일 사용 MCP context + Semantic RAG + Catalog cost metadata로 초안을 생성한다. 실제 사용 근거만 표시하고 backend cost guard와 intent guard가 공통 최대 1회 교정하며 로컬 SQL fallback은 없다. | `POST /api/query/ai-suggestions` |
| SQL 결과 Dataset 생성 | UI는 SQL 내부 다단계 모달에서 스케줄·거버넌스·저장 설정을 완료하고 `createSqlDatasetJob`으로 명시적 draft를 제출; backend direct materialize API는 `createDerivedDatasetFromSql` 호환 유지 | `POST /api/etl/jobs`, `POST /api/catalog/derived-datasets` |
| 대시보드 | FastAPI dashboard adapter와 draft/published runtime. Assistant 시각화는 검증된 widget action만 적용하며 local/mock chart fallback 없음 | `GET /api/dashboards`, `POST /api/dashboards/query`, draft/published runtime APIs |
| 감사 로그 | 서버 `audit_events` 조회 + local/localStorage 최근 호출 | `GET /api/admin/audit-logs` |

SQL 화면은 한국어/공백 dataset·column 표시명을 금지하지 않는다. 자동완성, 기본 쿼리, 컬럼 삽입, JOIN 초안 생성은 SQL 실행명으로 `"월별 매출 데이터"`처럼 double-quoted identifier를 사용한다. 사용자가 따옴표 없이 한글/공백 table reference를 직접 입력하면 frontend preflight가 실행 전에 감지하고 quoted identifier 자동 보정을 제안한다. backend table context 검증은 표시명 문자열만 믿지 않고 `baseDatasetId`와 `referenceDatasetIds`로 선택된 dataset 범위를 계속 source of truth로 사용한다.

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

`POST /api/dashboards`는 랜딩 페이지의 새 대시보드 생성 버튼에서 사용한다. 생성 즉시 `status: "draft"` dashboard card를 DB에 저장하고, 프론트는 응답받은 `dashboard.id`로 `/dashboards/{dashboardId}` 조회 화면에 진입한다. 편집용 draft revision/page/widget은 `위젯 편집` 이후 `POST /api/dashboards/{dashboardId}/draft/ensure`에서 준비한다.

`GET /api/dashboards/{dashboardId}/published`는 published revision이 없으면 `revision: null`, `pages: []`, `widgetsByPageId: {}`를 반환한다. `POST /api/dashboards/{dashboardId}/draft/ensure`는 idempotent이며 draft가 없으면 published snapshot 또는 새 revision과 기본 page를 만든다.

Catalog `datasetId`를 연결한 Widget은 browser가 보낸 `data`와 Catalog `sampleRows`를 저장 데이터로 사용하지 않는다. Runtime 조회 시 backend는 actor의 dataset `query` permission과 governance를 storage 접근 전에 검사한다. Iceberg Dataset은 Catalog의 `icebergSnapshotId`에 `FOR VERSION AS OF`를 적용한 Trino query로 읽고, 전환 전 CSV/JSON/JSONL/Parquet segment만 DuckDB에 등록한다. `materializationMode`가 명시되면 그 값을 우선하고, 미지정 Kafka run은 `delta`, 그 외 run은 `snapshot`으로 판정한다. 원격 file segment는 allowlist와 누적 byte/object 예산을 통과해야 하고 모든 query는 resource/timeout 경계 안에서 실행한다. chart/metric은 최대 500개 그룹으로 집계하며 table은 최대 500행 preview만 반환한다. 응답 `config.sourceConfig`는 편집 원본을, `dataMode`는 `server_aggregated` 또는 `server_preview`를 나타낸다. 권한이 없으면 `DASHBOARD_DATA_FORBIDDEN`, 삭제된 Catalog dataset 또는 물리 데이터를 읽을 수 없으면 `DASHBOARD_DATA_UNAVAILABLE` error config와 빈 data를 해당 widget에 반환한다. `queryId`가 있는 bounded SQL snapshot은 Catalog payload가 없어도 최대 500행을 유지한다.

`DELETE /api/dashboards/{dashboardId}`는 dashboard card/list row와 runtime revision/page/widget snapshot을 함께 삭제한다.

### Kafka Continuous Dashboard Refresh Contract

이 계약은 새 UI나 새 Kafka Consumer를 만들지 않는다. Worker 시작/재개 시 PostgreSQL `dataset_kafka_partition_cursors`를 전달하고 Spark는 저장 전에 `offset < nextOffset` 행을 제거한다. 전부 중복이면 게시하지 않고, 일부 중복이면 새 suffix만 처리한다. 기존 Spark Structured Streaming이 필터된 micro-batch를 backend-owned Iceberg table에 append하고 immutable manifest를 완료한 뒤, backend가 manifest `_SUCCESS`, exact Iceberg snapshot/table과 `sourceBoundary`, Kafka topic/partition/[startOffset, endOffset) `sourceRanges`, batch identity와 해당 snapshot의 Run 행 수=`storedCount`를 확인하고 Trino 검증까지 끝낸다. 그 다음 Catalog와 같은 PostgreSQL transaction으로 `dataset_revision_commits`와 `dataset_freshness`를 갱신한다. commit은 종류, offset fingerprint, Iceberg table·manifest 위치를 보존한다. watermark로 같은 stream offset은 한 번만 반영하고 과거·겹침 범위를 거절한다. 0행 batch도 committed manifest를 확인한 뒤 offset watermark만 전진시킨다. 종료 worker report가 비었거나 이미 ack한 window만 남았으면 S3에서 ack 이후 완료 manifest를 나열해 이어서 복구하고, 마지막 batch `_SUCCESS`가 없으면 ack를 전진시키지 않는다. quarantine replay는 한 번에 최대 1,000행을 처리해 자체 완료 manifest를 만들고 별도 commit 종류로 관리한다. 새 replay snapshot 뒤 manifest 게시가 실패하면 새 commit만 rollback한다. 남은 행은 다음 replay에서 이어서 처리한다.

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

`widgetIds`는 1~100개다. Dashboard `view`와 각 Dataset `query` 권한을 재검사하고, 현재 published revision에 없는 widget ID가 포함되면 `404`를 반환한다. 응답은 `widgets: DashboardRuntimeWidget[]`이며 Continuous widget은 `liveRefresh=true`, `appliedRevision`, `calculationVersion`, `calculatedAt`을 포함한다.

`calculationVersion`은 `contractVersion + datasetId + widgetType + sourceConfig + schemaIdentity`를 canonical JSON으로 만든 SHA-256이다. `schemaIdentity`는 Catalog `schemaFingerprint`를 우선하고 없으면 schema 전체를 사용한다.

전체 누적 기준 `count`/`sum`/`avg`는 새 widget에서 Catalog `icebergSnapshotId`에 고정한 전체 데이터로 기준값을 한 번 만든다. 이후 revision은 한 개씩 `_asklake_run_id = commit.run_id`인 행만 Trino 집계해 기존 계산 상태에 병합하고 성공한 revision까지만 저장한다. row가 존재하는 commit의 delta 집계가 비어 있으면 revision만 전진시키지 않고 같은 Catalog snapshot 전체 재계산으로 fallback한다. backfill/legacy/non-delta revision, `min`/`max`, table, revision gap, 내부 run ID가 없는 과거 table, 고카디널리티는 같은 Catalog snapshot 전체 재계산으로 fallback한다. Iceberg full scan은 query timeout 경계를 적용하므로 매우 큰 최초 baseline은 별도 aggregate snapshot/bootstrap이 필요하다. 전환 전 file-backed full scan에는 기본 256 objects, 512 MiB, 15초 한계가 있다. 최근 N분·슬라이딩 시간창은 지원하지 않는다. 결과는 집계 최대 500 group이다. table의 backend 상한은 500행이며 현재 UI 설정은 기본 10행, 최대 100행이다.

Frontend는 published `/dashboards/{dashboardId}`에서만 polling한다. partial 응답이 이전 `appliedRevision`보다 전진했지만 아직 최신보다 뒤면 250ms 뒤 다음 revision을 이어서 요청한다. 응답 revision이 그대로면 빠른 catch-up을 중지한다. hidden tab에서는 polling을 중지하고 요청을 취소하며, route unmount 시 timer를 정리한다. 갱신 실패는 이전 widget result를 유지하고 화면을 loading 상태로 바꾸지 않는다. 계산 버전 변경 직후 새 계산이 실패해도 같은 widget·같은 dataset의 직전 성공 result만 반환한다. Continuous published 위젯은 `실시간 · R{appliedRevision}` 배지와 revision 변경 pulse를 표시하며, bar chart는 숫자 data label과 dynamic animation으로 갱신을 시각화한다. 이 배지는 SSE/WebSocket 연결 상태가 아니라 마지막으로 성공 적용된 PostgreSQL dataset revision을 나타낸다.

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

- `dataset.id`, `dataset.name`, `dataset.schema`, `dataset.sampleRows`, `dataset.rows`, `dataset.size`가 있어야 SQL context를 만들 수 있다.
- `dataset.lineageGraph`가 있으면 Catalog lineage modal은 생성 직후 이 그래프를 우선 사용한다.
- `dataset.upstream`이 있으면 Catalog lineage modal의 source/upstream -> current fallback을 만들 수 있다.
- `dataset.downstream`은 SQL, dashboard, mart 같은 영향도/소비처 context에 사용할 수 있다.
- 생성 후 ETL 목록과 Catalog 목록에 같은 `job.id`와 `dataset.id` 기준 결과가 보여야 한다.
- 같은 Job 또는 표시명이 정확히 같은 `targetDataset`으로 생성/실행한 결과는 새 Catalog row를 늘리지 않고 기존 dataset의 `materializationRuns` history에 추가한다. 일반 ETL/SQL full refresh는 `materializationMode: "snapshot"`, Kafka 추가분은 `materializationMode: "delta"`다. 현재 Dataset은 최신 성공 snapshot과 그보다 최신인 성공 delta만 사용한다. 대상 판정은 손실 가능한 slug가 아니라 저장된 `targetDataset` 표시명으로 수행한다. 새 dataset의 내부 `datasetId`는 안전한 소문자 ASCII 이름이면 `ds_<name>`, 그 외에는 `ds_<slug>_<stable-hash>` 형식이므로 서로 다른 한글·공백·특수문자 이름이 같은 ID로 합쳐지지 않는다. Catalog 목록 row는 하나만 보이고, row 펼침에서 version history를 최대 5개씩 pagination으로 표시한다.
- Target draft의 `storageType`, `partition`, `partitionColumns`, `indexColumns`, `compression`, `storagePath`, `targetDatabase`, `targetDescription`, `targetTags`는 `targetDataset`, `targetLayer`, `targetFormat`과 함께 create request에 전달된다. 다중 파티션 컬럼은 선택 순서를 유지한 `partitionColumns` 배열과 `/`로 연결한 하위 호환용 `partition` 문자열로 함께 전송한다. SQL 결과 처리 Job wizard도 같은 target metadata를 구성한 뒤 기존 create request로 변환한다.
- SQL 결과 처리 Job wizard의 owner는 현재 session actor를 사용한다. `private`은 owner fallback, `organization`은 `authenticated-users` public principal, `project`는 현재 actor가 속한 실제 group ID를 `principalId`로 전송한다. Backend는 이 값으로 권한 역할과 요약을 canonical하게 만들며 고정 demo 그룹명은 사용하지 않는다.
- `POST /api/etl/jobs`의 `job.icebergTarget`은 frontend 입력이 아니라 backend가 `targetDataset`과 Dataset ID로 만든 optional writer 계약이다. 새 ETL Job은 `catalog`, `namespace`, `table`, `tableUri`, `writeMode`, `partitionColumns`를 저장하며 기존 Job은 첫 일반 batch 실행 전에 같은 규칙으로 backfill된다. 일반 full batch는 `replace`, 증분 S3/Data Lake folder는 `append`, Kafka는 `append`다. 이 선언만으로 Catalog `queryEngineTable`이나 SQL 권한을 만들지 않으며 실제 commit과 Trino 검증이 필요하다.
- Target 화면은 `targetLayer`를 노출하지 않는다. 기존 create/update 계약 호환을 위해 frontend가 source/execution별 내부 기본값을 전송하고 backend는 기존 조합 검증을 유지한다. Kafka Snapshot은 JSONL, Kafka Continuous는 Parquet 포맷만 사용자에게 노출하며 두 실행의 최종 target은 backend-owned Iceberg table이다.
- `rag` 필드는 호환을 위해 create request에 남아 있지만, 현재 Target 화면에서는 노출하지 않고 frontend 기본값은 `false`다.
- Target 화면은 기본정보, 태그, 파티션 단위로 구성되며 태그/파티션 섹션은 접고 펼칠 수 있다.
- Source/schema sample이 `data` JSON 단일 컬럼으로 들어오면 frontend가 JSON을 dot-path 컬럼으로 펼쳐 `schemaRules`와 preview를 만든다. 원본 JSON 보존용 `raw_data` 컬럼은 기본 미사용 optional 컬럼으로 제공한다.
- Target 화면 저장은 backend API가 없는 현 범위에서 `window.localStorage["asklake.targetConfigDraft"]`에 `{ metadata, tags, partitionColumns, indexColumns, schemaRules, previewRows, lineage, lastTestRun }` 형태로 저장한다. Review 생성 요청과 Spark run 성공 후 Catalog dataset metadata는 같은 Target draft 값을 사용해야 한다.

Mock mode에서는 Pair A pipeline 생성 dataset과 backend direct SQL derived dataset을 모두 `window.localStorage["asklake.catalogDatasets"]`에 저장하고 앱 로드시 mock catalog dataset 앞에 병합한다. 현재 SQL 화면의 `처리 Job 생성` UI는 직접 localStorage에 dataset을 쓰지 않고, 모달에서 만든 설정을 SQL Result 기반 `DraftPipeline`으로 변환해 기존 Job 생성 경로를 사용한다. 이때 접근 범위는 권한 요약과 역할 metadata에 동기화하고, 스케줄·DB·파일 포맷·압축·다중 파티션·태그·저장 경로·설명은 mock Job과 dataset에도 보존한다. 기존 `asklake.derivedDatasets` 값은 읽기 호환만 유지한다. Live API mode에서는 localStorage fallback을 사용하지 않고 backend catalog persistence와 `GET /api/catalog/datasets` 응답을 source of truth로 둔다.

Catalog dataset의 `materializationRuns` 항목은 `runId`, `jobId`, `status`, `createdAt`, `materializationMode`, `rowCount`, `storageSizeBytes`, `storageLocation`, `sourceKind`, `sourceLabel`을 포함한다. Kafka Continuous materialization은 추가로 `sourceBoundary`, `sourceRanges`, `icebergCommittedAt`, `icebergSnapshotId`, `queryEngineTable`, `publicationManifest`, schema/rule/runtime fingerprint, `transform`, `quality` 실행 결과를 반환하며 replay에도 같은 Rule 실행 정체성을 유지한다. history는 `icebergCommittedAt`, fallback `createdAt` 기준 newest-first로 정렬한다. 늦게 복구된 과거 snapshot은 history/합계만 보강하고 현재 schema/sample/quality/physical mapping을 되돌리지 않는다. 부모 dataset의 `rows`, `size`, `storageSizeBytes`, `lastUpdated`, `sourceRunId`는 newest-first 성공 history에서 첫 `snapshot`까지의 active segment 기준으로 계산한다. mode가 없는 legacy Kafka Run은 `delta`, 그 외 Run은 `snapshot`으로 해석한다.

- Catalog row page와 Dashboard physical widget은 검증된 Iceberg Dataset을 `queryEngineTable`의 Trino table로 읽는다. Iceberg warehouse data file 직접 scan은 금지하며 legacy file-backed Dataset만 DuckDB compatibility path를 사용한다.
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
SQL Query AI와 Dashboard Assistant는 요청별 RAG source `documentId` allowlist를 provider schema에 적용한다. Source가 없으면 `usedEvidenceIds`는 빈 배열만 허용하며, provider가 범위 밖 ID를 반환하면 해당 citation만 제거하고 경고를 추가한다. Dashboard 최상위 목록은 검증된 action별 evidence의 합집합으로 다시 계산한다. 이 정규화는 SQL read-only/scope 또는 widget action의 dataset, column, type, config 검증을 완화하지 않는다.
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
# 공통 correlation·오류·health 계약 (2026-07-16)

- 모든 API는 유효한 request `X-Correlation-ID`를 보존하거나 새 ID를 생성해 같은 response header로 반환한다.
- 공통 `error`는 기존 `code`, `message`, `details`를 유지하고 `stage`, `retryable`, `operatorMessage`, `userMessage`, `diagnosticId`를 additive field로 제공한다.
- `details`는 secret key를 재귀적으로 redaction하며 validation input 원문과 unhandled stack을 반환하지 않는다.
- `GET /api/health/live`는 process liveness, `GET /api/health/ready`는 DB readiness, 기존 `GET /api/health`는 호환 readiness다.
- `GET /api/health/metrics`는 현재 backend process의 진단 counter snapshot을 반환한다.

## 11) ClickHouse Realtime Serving V2 additive API

이 절은 `docs/codex-clickhouse-realtime-pr-pack/STACKED_PR_PLAN.md` 순서로 도입한다. 누적 PR01~09 branch에는 아래 Catalog/freshness/event 계약이 구현돼 있지만, 각 PR이 `dev`에 순서대로 merge되기 전에는 production request/response에 존재한다고 가정하지 않는다.

### 기존 Continuous SQL API 확장

- 별도 `/api/realtime/pipelines` 계층을 만들지 않고 기존 `/api/query/continuous-jobs/validate`, `/api/query/continuous-jobs`, `/api/query/continuous-jobs/{jobId}`, command API를 확장한다.
- validate/create의 optional `runtimeVersion=2`는 V2 flag가 켜진 경우에만 허용한다. 미지정 기존 request는 현재 V1 의미를 유지한다.
- V2 validate 응답은 `executionMode`, `dimensionSemantics`, JOIN별 `missingPolicy`, `correctionPolicy`, normalized SQL fingerprint와 source boundary estimate를 additive field로 제공한다.
- V2 Job/Run은 immutable plan/pipeline version, materialization ID, connector identity, consumer owner와 binding epoch를 보존한다.
- repair/reconcile endpoint는 구현 PR에서 OpenAPI와 `docs/api-contract.md`를 함께 확정하기 전까지 외부 호출 경로로 열지 않는다.

### Catalog additive binding

기존 `queryEngineTable`과 `clickhouseTable`은 migration window 동안 유지한다. V2 Dataset은 다음 optional field를 추가한다.

```json
{
  "physicalBindings": [
    {
      "role": "serving",
      "engine": "clickhouse",
      "status": "active",
      "database": "asklake_serving",
      "table": "joined_click_events_v2_current",
      "pipelineVersionId": "rtpv_1",
      "bindingEpoch": 4,
      "latestRevision": 1532,
      "sourceBoundary": {}
    },
    {
      "role": "archive",
      "engine": "trino",
      "status": "active",
      "catalog": "iceberg",
      "schema": "gold",
      "table": "joined_click_events",
      "pipelineVersionId": "rtpv_1",
      "dimensionVersionIds": {},
      "sourceBoundary": {}
    }
  ]
}
```

ClickHouse identifier를 `queryEngineTable`에 저장하지 않는다. archive binding이 같은 pipeline/dimension version의 Gold projection을 가리킬 때만 Trino fallback으로 사용할 수 있다. ClickHouse-only V1 또는 아직 Gold projection을 검증하지 않은 Dataset은 archive binding이 없거나 `status="pending"`일 수 있으며, 이 상태를 검증된 Trino fallback으로 표시하지 않는다. 현재 status enum은 `pending|active|stale|failed`, engine enum은 `clickhouse|trino`다.

### Dashboard cursor와 mutation

아래 optional Dataset cursor map은 목표 request extension이며 현재 누적 branch의 public request schema에는 아직 노출하지 않는다.

```json
{
  "clientKnownRevisions": {
    "ds_joined": {"bindingEpoch": 4, "revision": 1532}
  }
}
```

현재 public widget 응답은 기존 `appliedRevision`, `calculatedAt`, `dataStatus`, `dataError`를 유지한다. engine/binding/boundary/mutation evidence는 `POST /api/datasets/freshness/query`, Catalog `physicalBindings`와 SSE schema v2에서 읽는다. `mutationType=append`만 targeted delta 후보이며 `upsert|replace|retract`, binding/pipeline 변경과 revision gap은 frontend가 published runtime snapshot을 다시 조회한다.

기존 `GET /api/realtime/events`와 `realtime_event_log`를 재사용한다. 기존 event 이름 `dataset.revision.committed`, `dashboard.published`와 `system.*` control event를 rename하지 않는다. V2는 schema version 2 allowlist payload에 `bindingEpoch`, revision, `pipelineVersionId`, `materializationId`와 mutation type을 추가하되 event 본문에 row/widget 결과를 넣지 않는다. Browser는 `(bindingEpoch, revision)`을 비교하고 epoch가 증가한 cutover/rollback 결과를 수용한다.

V2 설정 이름은 `CLICKHOUSE_REALTIME_V2_ENABLED`, `KAFKA_CONNECT_SINK_ENABLED`, `CLICKHOUSE_REALTIME_CONSUMER_OWNER`, `KAFKA_CONNECT_URL`, `KAFKA_CONNECT_CONNECTOR_NAME`이다. Production Compose는 V2/sink를 활성화하고 owner를 `kafka_connect_v2`로 설정한다. 모순된 V1/V2 owner 조합은 startup에서 실패하며 secret·TLS·immutable image 또는 live connector readiness가 없으면 preflight/health가 fail closed한다. 상세 경계는 [V2 기반시설 운영 계약](clickhouse-realtime-v2-foundation.md)을 따른다.

### 내부 archive/recovery 계약

외부 `/api/realtime/pipelines` 또는 cutover HTTP API는 추가하지 않았다. Backend-owned worker/운영 command가 `ArchiveRecoveryService`를 호출하고 caller가 transaction commit/rollback을 소유한다.

- parity: 같은 boundary/version의 hot/archive evidence를 `realtime_parity_checks`에 immutable하게 기록한다.
- rebuild: matched parity만 `planned → running → ready`로 이동하며 gap/overlap이 하나라도 있으면 ready가 될 수 없다.
- cutover/rollback: production cutover는 10만 건, 72시간, P95, chaos, security, rollback drill, dashboard/runbook evidence를 모두 요구한다. rollback은 matched parity와 expected pointer를 요구하지만 장애 복구를 72시간 기다리게 하지는 않는다.
- 성공 event는 기존 `dataset.revision.committed` schema v2이며 `mutationType="replace"`, 새 `bindingEpoch`, 새 global revision과 target version을 담는다.
- 같은 idempotency key retry는 기존 operation/revision/event cursor를 반환한다. 다른 evidence로 key를 재사용하면 `ValueError`로 fail closed한다.

외부 operator route가 별도 승인으로 추가되기 전까지 raw DB update로 이 내부 경계를 우회하지 않는다.
