# AskLake Backend API Contract

이 문서는 AskLake 프론트엔드 mock 흐름을 실제 백엔드 API로 교체하기 위한 구현 명세입니다.
프론트 연결 지점은 `frontend/src/services/mockApi.ts`와 `frontend/src/services/apiClient.ts`입니다.

## 1. 구현 우선순위

| 단계 | 우선순위 | API | 목적 |
| --- | --- | --- | --- |
| 1 | P0 | `POST /api/etl/jobs` | 새 수집/처리 생성 완료 |
| 2 | P0 | `POST /api/etl/jobs/{jobId}/commands` | 즉시 실행, 재실행, 일시정지, 취소 |
| 3 | P0 | `POST /api/query/runs` | 읽기 전용 SQL 실행 |
| 4 | P1 | `GET /api/catalog/datasets` | 카탈로그 목록 hydrate |
| 5 | P1 | `GET /api/catalog/datasets/{datasetId}` | 데이터셋 상세 hydrate |
| 6 | P1 | `POST /api/dashboards` | 대시보드 초안 생성 |
| 7 | P2 | `POST /api/audit-logs` | 감사 로그 서버 저장 |

현재 프론트에서 `VITE_USE_MOCK_API=false`로 바꾸면 P0 API 3개를 실제 백엔드로 호출합니다.
P1/P2 API는 다음 연결 단계에서 프론트 hydrate와 저장 흐름을 분리할 때 붙이면 됩니다.

## 2. 프론트 연결 위치

- API 전환: `frontend/src/services/mockApi.ts`
- 공통 fetch client: `frontend/src/services/apiClient.ts`
- 프론트 데이터 상태: `frontend/src/hooks/useAskLakeData.ts`
- 감사 로그/토스트 상태: `frontend/src/hooks/useAuditLogs.ts`

타입 위치:

- ETL job/draft: `frontend/src/types/etl.ts`
- catalog dataset: `frontend/src/types/catalog.ts`
- SQL result: `frontend/src/types/sql.ts`
- dashboard view: `frontend/src/types/dashboard.ts`
- audit/error: `frontend/src/types/audit.ts`

## 2.1. Pair A A0 Draft Contract

Pair A는 frontend/backend로 나누지 않고 기능 slice별로 end-to-end 책임을 나눈다. 따라서 ETL 생성 wizard의 공통 상태는 먼저 A0 계약으로 고정한다.

Frontend 내부 draft는 step별 소유권이 보이도록 nested shape를 쓴다.

```ts
type DraftPipeline = {
  id: string;
  source: SourceDraft;
  schema: SchemaDraft;
  transform: TransformDraft;
  quality: QualityDraft;
  schedule: ScheduleDraft;
  permission: PermissionDraft;
  target: TargetDraft;
};
```

Slice 소유권:

| Slice | 주 소유자 | 포함 값 |
| --- | --- | --- |
| `source` | Pair A 1번 | source type, source label, source config, connection status |
| `schema` | Pair A 1번 | columns, sample rows, schema summary, schema fingerprint |
| `transform` | Pair A 2번 | transform steps, output columns, transform summary |
| `quality` | Pair A 2번 | quality rules, score/status, invalid row preview, quality summary |
| `schedule` | Pair A 2번 | manual/once/repeat mode, schedule label, next run |
| `permission` | Pair A 2번 | owner, permission summary |
| `target` | Pair A 2번 | target dataset, layer, format, RAG flag |

Create submit 직전에는 `frontend/src/services/draftPipelineContract.ts`의 mapper가 nested draft를 flat `CreatePipelineRequest`로 변환한다.

```ts
type CreatePipelineRequest = {
  id: string;
  jobName: string;
  sourceConfig: Array<[string, string]>;
  sourceType: string;
  sourceLabel: string;
  schemaSummary: string;
  ruleSummary: string;
  scheduleLabel: string;
  permissionSummary: string;
  targetDataset: string;
  targetLayer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  targetFormat: string;
  owner: string;
  rag: boolean;
};
```

규칙:

- Review Summary는 `DraftPipeline`에서 파생한 `CreatePipelineRequest` 값을 표시한다.
- `POST /api/etl/jobs`는 flat `CreatePipelineRequest`를 받는다.
- `ruleSummary`는 `transform.summary`와 `quality.summary`를 합친 값이며, 둘 중 하나가 다른 하나를 덮어쓰면 안 된다.
- 성공 응답은 `{ job, dataset }` shape를 유지한다.
- 생성 성공 시 Pair A 1번이 `jobs`, `datasets`, `selectedJob`, `selectedDataset` 반영을 책임진다.
- 개별 step은 자기 slice만 바꾼다. root draft 구조는 A0 계약 변경 없이는 바꾸지 않는다.

## 3. 환경변수

`frontend/.env`

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=false
```

- `VITE_API_BASE_URL`: 백엔드 base URL입니다.
- `VITE_USE_MOCK_API=true`: 프론트 mock 응답을 사용합니다.
- `VITE_USE_MOCK_API=false`: 실제 백엔드를 호출합니다.

## 4. 공통 HTTP 규칙

### Request

- 모든 request body는 JSON입니다.
- 모든 response body는 JSON입니다.
- 날짜/시간은 ISO 8601 문자열을 사용합니다.
- ID는 문자열입니다.
- 프론트는 현재 `credentials`를 포함하지 않고 `fetch`를 호출합니다.

권장 header:

```http
Content-Type: application/json
Accept: application/json
Authorization: Bearer {accessToken}
X-Request-Id: req_20260703_000001
```

현재 데모 프론트에는 로그인/토큰 저장이 아직 없으므로, 인증이 붙기 전까지는 백엔드에서 임시 actor를 `demo-user`로 처리해도 됩니다.
인증을 붙일 때는 `frontend/src/services/apiClient.ts`에서 `Authorization` 헤더 주입 지점을 추가하면 됩니다.

### Success Envelope

P0 API는 프론트 타입과 바로 맞추기 위해 envelope 없이 아래 response shape 그대로 반환합니다.

예:

```json
{
  "job": {},
  "dataset": {}
}
```

목록 API처럼 확장 필드가 필요한 경우에는 아래처럼 리소스 배열을 감싸서 반환합니다.

```json
{
  "datasets": [],
  "page": {
    "cursor": null,
    "hasNext": false
  }
}
```

### Error Envelope

실패 응답은 모든 API에서 동일한 형식을 사용합니다.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "targetDataset is required",
    "details": {
      "field": "targetDataset"
    }
  }
}
```

프론트의 현재 필수 필드는 `code`, `message`입니다.
`details`는 선택입니다.

### 상태 코드

| Status | 의미 | 사용 예 |
| --- | --- | --- |
| `200` | 조회/명령 성공 | 작업 명령, SQL 실행 성공 |
| `201` | 생성 성공 | ETL job 생성, 대시보드 초안 생성 |
| `202` | 비동기 작업 접수 | ETL run queue 등록 |
| `400` | validation 실패 | 필수 필드 누락, 잘못된 enum |
| `401` | 인증 없음 | access token 없음 |
| `403` | 권한 없음 | 데이터셋/작업 접근 불가 |
| `404` | 리소스 없음 | jobId, datasetId 없음 |
| `409` | 충돌 | 이미 실행 중인 job을 다시 실행 |
| `422` | 실행 불가 상태 | SQL 문법 오류, schema mismatch |
| `500` | 서버 오류 | 알 수 없는 내부 오류 |

권장 에러 코드:

```text
VALIDATION_ERROR
UNAUTHORIZED
FORBIDDEN
NOT_FOUND
CONFLICT
INVALID_JOB_STATE
SQL_SYNTAX_ERROR
BACKEND_TIMEOUT
INTERNAL_ERROR
```

## 5. 리소스 ID 규칙

권장 prefix:

| 리소스 | 예시 |
| --- | --- |
| ETL job | `JOB-001` 또는 `job_01HZ...` |
| ETL run | `run_01HZ...` |
| Dataset | `ds_orders_clean` |
| SQL run | `sql_01HZ...` |
| Dashboard | `dash_01HZ...` |
| Audit log | `audit_01HZ...` |
| Request | `req_01HZ...` |

프론트는 ID를 opaque string으로 취급합니다.
표시용 이름은 `name`, `jobName`, `targetDataset`을 사용합니다.
API, mock fixture, frontend internal state의 상태값은 영어 canonical value를 사용합니다.
한국어 배지/버튼 문구는 프론트 UI mapper에서 변환합니다.

## 6. 데이터 모델 요약

### JobRowData

```ts
type JobStatus = "scheduled" | "failed" | "running" | "paused" | "canceled";

type JobRowData = {
  id: string;
  name: string;
  owner: string;
  status: JobStatus;
  tag: string;
  source: string;
  target: string;
  schedule: string;
  lastRun: string;
  lastState: string;
  nextRun: string;
  progress?: {
    label: string;
    value: number;
  };
};
```

### JobRunSummary and JobDagStep

```ts
type JobRunStatus = "queued" | "running" | "success" | "failed" | "canceled";
type JobDagStepStatus = "pending" | "running" | "success" | "failed" | "blocked";

type JobRunSummary = {
  runId: string;
  status: JobRunStatus;
  startedAt: string;
  endedAt: string;
  duration: string;
  inputRows: string;
  outputRows: string;
  failedStage: string;
  errorSummary: string;
};

type JobDagStep = {
  id: string;
  title: string;
  meta: string;
  status: JobDagStepStatus;
  note?: string;
};
```

### CatalogDataset

```ts
type CatalogDataset = {
  id: string;
  name: string;
  description: string;
  owner: string;
  layer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  status: "available" | "approval_required";
  freshness: "latest" | "stale" | "approval";
  source: string;
  rows: string;
  size: string;
  quality: string;
  lastUpdated: string;
  nextRefresh: string;
  rag: boolean;
  tags: string[];
  schema: Array<[string, string]>;
  sampleRows: string[][];
  upstream: string[];
  downstream: string[];
};
```

### SqlResultDraft

```ts
type SqlResultDraft = {
  runId: string;
  datasetId: string;
  datasetName: string;
  query: string;
  columns: string[];
  rows: string[][];
  rowCount: number;
  executedAt: string;
};
```

## 7. P0 API

### 7.1 파이프라인 생성

`POST /api/etl/jobs`

프론트 함수:

- `createPipelineDraft(draftPipeline, jobCount)`

Request:

```ts
type CreatePipelineRequest = {
  id: string;
  jobName: string;
  sourceConfig: Array<[string, string]>;
  sourceType: string;
  sourceLabel: string;
  schemaSummary: string;
  ruleSummary: string;
  scheduleLabel: string;
  permissionSummary: string;
  targetDataset: string;
  targetLayer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  targetFormat: string;
  owner: string;
  rag: boolean;
};
```

Request 예시:

```json
{
  "id": "draft_customer_review",
  "jobName": "customer_review_daily_ingest",
  "sourceType": "Object Storage",
  "sourceLabel": "Amazon S3",
  "sourceConfig": [
    ["Storage Provider", "Amazon S3"],
    ["Bucket / Stage Name", "asklake-raw-ingest-us-east"],
    ["Path / Prefix", "data/inventory/daily/"]
  ],
  "schemaSummary": "5 columns inferred, review_id bigint primary key candidate",
  "ruleSummary": "3 quality rules enabled",
  "scheduleLabel": "매일 09:00",
  "permissionSummary": "Data Engineer Group / 조직 내부",
  "targetDataset": "customer_review_silver",
  "targetLayer": "SILVER",
  "targetFormat": "Delta",
  "owner": "Data Engineer Group",
  "rag": true
}
```

Response `201 Created`:

```ts
type CreatePipelineResponse = {
  job: JobRowData;
  dataset: CatalogDataset;
};
```

Response 예시:

```json
{
  "job": {
    "id": "JOB-001",
    "name": "customer_review_daily_ingest",
    "owner": "Data Engineer Group",
    "status": "scheduled",
    "tag": "[리뷰]",
    "source": "Object Storage / Amazon S3",
    "target": "customer_review_silver",
    "schedule": "매일 09:00",
    "lastRun": "생성됨",
    "lastState": "대기 중",
    "nextRun": "다음 예약 대기"
  },
  "dataset": {
    "id": "ds_customer_review_silver",
    "name": "customer_review_silver",
    "description": "생성 플로우에서 만든 고객 리뷰 분석용 데이터셋",
    "owner": "Data Engineer Group",
    "layer": "SILVER",
    "status": "available",
    "freshness": "latest",
    "source": "customer_review_daily_ingest",
    "rows": "0 rows",
    "size": "Pending",
    "quality": "95% (Draft verified)",
    "lastUpdated": "2026-07-03T11:30:00.000Z",
    "nextRefresh": "매일 09:00",
    "rag": true,
    "tags": ["#customer", "#RAG", "#리뷰"],
    "schema": [
      ["review_id", "bigint"],
      ["product_id", "string"],
      ["rating", "int"],
      ["review_text", "string"],
      ["sentiment", "string"]
    ],
    "sampleRows": [["-", "-", "-", "-", "Pipeline queued"]],
    "upstream": ["Amazon S3", "customer_review_daily_ingest"],
    "downstream": ["SQL 분석", "대시보드", "AI 활용"]
  }
}
```

프론트 기대 동작:

- `job`을 수집/처리 목록 최상단에 추가합니다.
- `dataset`을 카탈로그 목록 최상단에 추가합니다.
- `selectedJob`, `selectedDataset`을 응답값으로 변경합니다.
- 생성 성공 감사 로그를 남깁니다.

Validation:

- `jobName`, `sourceType`, `sourceLabel`, `targetDataset`, `targetLayer`, `owner`는 필수입니다.
- `targetLayer`는 `RAW`, `BRONZE`, `SILVER`, `GOLD` 중 하나여야 합니다.
- 같은 `targetDataset`이 이미 존재하면 `409 CONFLICT`를 권장합니다.

### 7.2 작업 명령

`POST /api/etl/jobs/{jobId}/commands`

프론트 함수:

- `runJobCommand(job, command)`

Request:

```ts
type JobCommandRequest = {
  command: "run" | "retry" | "pause" | "cancel";
};
```

Request 예시:

```json
{
  "command": "run"
}
```

Response `200 OK`:

```ts
type JobCommandResponse = {
  action: string;
  apiPath: string;
  job?: JobRowData;
  run?: JobRunSummary;
  dagSteps?: JobDagStep[];
};
```

Response 예시:

```json
{
  "action": "etl.run.requested",
  "apiPath": "/api/etl/jobs/JOB-001/runs",
  "job": {
    "id": "JOB-001",
    "name": "customer_review_daily_ingest",
    "owner": "Data Engineer Group",
    "status": "running",
    "tag": "[리뷰]",
    "source": "Object Storage / Amazon S3",
    "target": "customer_review_silver",
    "schedule": "매일 09:00",
    "lastRun": "현재 실행 중",
    "lastState": "1/8 단계 · Source 연결",
    "nextRun": "-",
    "progress": {
      "label": "1/8 단계 · Source 연결",
      "value": 12
    }
  }
}
```

명령별 권장 동작:

| command | action | 상태 변경 |
| --- | --- | --- |
| `run` | `etl.run.requested` | `running` |
| `retry` | `etl.run.retry_requested` | `running` |
| `pause` | `etl.job.pause_requested` | `paused` |
| `cancel` | `etl.run.cancel_requested` | `scheduled`, `canceled`, 또는 이전 안정 상태 |

Validation:

- 존재하지 않는 job은 `404 NOT_FOUND`.
- 이미 실행 중인데 다시 `run`하면 `409 CONFLICT`.
- 완료/취소 불가 상태에서 `cancel`하면 `422 INVALID_JOB_STATE`.

### 7.3 읽기 전용 SQL 실행

`POST /api/query/runs`

프론트 함수:

- `executeQueryDraft(dataset, query)`

Request:

```ts
type ExecuteQueryRequest = {
  datasetId: string;
  query: string;
};
```

Request 예시:

```json
{
  "datasetId": "ds_customer_review_silver",
  "query": "SELECT review_id, rating, sentiment FROM customer_review_silver LIMIT 100"
}
```

Response `200 OK`:

```ts
type ExecuteQueryResponse = SqlResultDraft;
```

Response 예시:

```json
{
  "runId": "sql_01J1Z8W2V7KX",
  "datasetId": "ds_customer_review_silver",
  "datasetName": "customer_review_silver",
  "query": "SELECT review_id, rating, sentiment FROM customer_review_silver LIMIT 100",
  "columns": ["review_id", "rating", "sentiment"],
  "rows": [
    ["10001", "5", "positive"],
    ["10002", "3", "neutral"],
    ["10003", "1", "negative"]
  ],
  "rowCount": 3,
  "executedAt": "2026-07-03T11:35:00.000Z"
}
```

Validation:

- `datasetId`, `query`는 필수입니다.
- 읽기 전용 SQL만 허용합니다.
- `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `MERGE` 등 변경 쿼리는 `403 FORBIDDEN` 또는 `422 VALIDATION_ERROR`를 권장합니다.
- SQL 문법 오류는 `422 SQL_SYNTAX_ERROR`.
- 결과 row는 데모 단계에서 최대 500행 이하를 권장합니다.

프론트 기대 동작:

- `columns`, `rows`를 SQL 결과 테이블에 표시합니다.
- 대시보드 생성 시 같은 `SqlResultDraft`를 전달합니다.
- 실패 시 `analysis.query.failed` 감사 로그를 남깁니다.

## 8. P1 API

### 8.1 데이터셋 목록

`GET /api/catalog/datasets`

Query parameter 권장:

| 이름 | 타입 | 설명 |
| --- | --- | --- |
| `q` | string | 검색어 |
| `tag` | string | 태그 필터 |
| `layer` | string | `RAW`, `BRONZE`, `SILVER`, `GOLD` |
| `owner` | string | 소유자 |
| `cursor` | string | 다음 페이지 cursor |
| `limit` | number | 기본 20 |

Response `200 OK`:

```json
{
  "datasets": [
    {
      "id": "ds_customer_review_silver",
      "name": "customer_review_silver",
      "description": "고객 리뷰 정제 데이터셋",
      "owner": "Data Engineer Group",
      "layer": "SILVER",
      "status": "available",
      "freshness": "latest",
      "source": "customer_review_daily_ingest",
      "rows": "128,420 rows",
      "size": "2.1 GB",
      "quality": "98%",
      "lastUpdated": "2026-07-03T11:30:00.000Z",
      "nextRefresh": "매일 09:00",
      "rag": true,
      "tags": ["#customer", "#review", "#silver"],
      "schema": [["review_id", "bigint"], ["rating", "int"]],
      "sampleRows": [["10001", "5"], ["10002", "3"]],
      "upstream": ["Amazon S3"],
      "downstream": ["SQL 분석", "대시보드"]
    }
  ],
  "page": {
    "cursor": null,
    "hasNext": false
  }
}
```

프론트 연결 시점:

- 앱 초기 로딩 때 mock `catalogDatasets` 대신 hydrate합니다.
- 생성 직후에는 `POST /api/etl/jobs` 응답 dataset을 우선 반영한 뒤, 목록 재조회로 동기화하면 됩니다.

### 8.2 데이터셋 상세

`GET /api/catalog/datasets/{datasetId}`

Response `200 OK`:

```ts
type DatasetDetailResponse = CatalogDataset;
```

추가 상세 API를 분리할 경우 권장 endpoint:

```text
GET /api/catalog/datasets/{datasetId}/schema
GET /api/catalog/datasets/{datasetId}/sample-rows
GET /api/catalog/datasets/{datasetId}/lineage
```

현재 프론트는 `CatalogDataset` 하나에 schema, sampleRows, upstream, downstream을 모두 포함해서 표시합니다.

### 8.3 대시보드 초안 생성

`POST /api/dashboards`

Request:

```ts
type CreateDashboardDraftRequest = {
  datasetId: string;
  source: "sql" | "catalog";
  sqlRunId?: string;
};
```

Request 예시:

```json
{
  "datasetId": "ds_customer_review_silver",
  "source": "sql",
  "sqlRunId": "sql_01J1Z8W2V7KX"
}
```

Response `201 Created`:

```json
{
  "dashboardId": "dash_01J1Z8W5ABCD",
  "view": "builder",
  "widgets": [
    {
      "type": "table",
      "title": "SQL 결과 테이블",
      "fields": {
        "columns": "review_id, rating, sentiment",
        "sort": "review_id ASC"
      }
    },
    {
      "type": "bar",
      "title": "sentiment별 rating",
      "fields": {
        "x": "sentiment",
        "y": "rating",
        "aggregation": "AVG"
      }
    }
  ]
}
```

현재 프론트 동작:

- SQL에서 넘어온 경우 `SqlResultDraft` 기준으로 `table`, `bar` 위젯을 기본 배치합니다.
- 백엔드 연결 시 위젯 추천 결과를 이 응답으로 대체하면 됩니다.

## 9. P2 API

### 9.1 감사 로그 저장

`POST /api/audit-logs`

현재 프론트 내부 저장 위치:

- `window.__asklakeAuditLogs`
- `window.localStorage["asklake.auditLogs"]`
- Topbar 최근 API 호출 패널

Request:

```ts
type AuditEntry = {
  action: string;
  actor_id: string;
  api_path: string;
  created_at: string;
  request_id: string;
  result: "success" | "failed";
  target_id: string;
  target_type: "etl_job" | "dataset" | "dashboard" | "ai_module" | "admin_module" | "ui";
};
```

Request 예시:

```json
{
  "action": "etl.pipeline.created",
  "actor_id": "demo-user",
  "api_path": "/api/etl/jobs",
  "created_at": "2026-07-03T11:40:00.000Z",
  "request_id": "req_01J1Z8W8EFGH",
  "result": "success",
  "target_id": "JOB-001",
  "target_type": "etl_job"
}
```

Response `201 Created`:

```json
{
  "id": "audit_01J1Z8W8IJKL",
  "stored": true
}
```

감사 로그 API는 실패해도 주요 사용자 액션을 막지 않는 것을 권장합니다.

## 10. 백엔드 구현 체크리스트

- P0 API 3개를 먼저 구현합니다.
- CORS에서 `http://localhost:5173`을 허용합니다.
- 모든 response에 `Content-Type: application/json`을 설정합니다.
- 실패 응답은 `error.code`, `error.message`를 반드시 포함합니다.
- SQL 실행은 read-only guard를 반드시 둡니다.
- ETL job command는 상태 전이를 서버에서 검증합니다.
- `request_id`를 서버 로그에 남깁니다.
- 날짜는 ISO 8601 UTC 문자열로 내려줍니다.
- ID는 프론트에서 그대로 저장/표시할 수 있는 문자열로 내려줍니다.

## 11. 프론트 전환 순서

1. 백엔드 서버를 실행합니다.
2. `frontend/.env`에 `VITE_API_BASE_URL`을 설정합니다.
3. `frontend/.env`에서 `VITE_USE_MOCK_API=false`로 바꿉니다.
4. 프론트 dev 서버를 재시작합니다.
5. `POST /api/etl/jobs` 생성 플로우를 확인합니다.
6. `POST /api/etl/jobs/{jobId}/commands` 버튼 흐름을 확인합니다.
7. `POST /api/query/runs` SQL 실행 흐름을 확인합니다.
8. P1 API를 붙인 뒤 mock 초기 데이터를 hydrate로 교체합니다.

## 12. 열린 결정 사항

백엔드 구현 전에 팀에서 결정하면 좋은 항목입니다.

- 인증 방식: JWT, 세션, 또는 임시 demo actor.
- 실제 ETL 실행 엔진: Airflow, Dagster, 자체 worker, Spark job 중 선택.
- SQL 실행 엔진: Trino, Spark SQL, DuckDB, warehouse API 중 선택.
- dataset row count/size 표기: 문자열로 내려줄지 숫자와 단위를 분리할지.
- audit log 저장 실패 시 사용자에게 노출할지 여부.
- dashboard widget 저장 모델을 `dashboards`, `dashboard_widgets`로 분리할지 여부.
