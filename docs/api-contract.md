# AskLake Backend API Contract

이 문서는 AskLake 프론트엔드와 실제 백엔드 API를 연결하기 위한 구현 명세입니다.
프론트 연결 지점은 `frontend/src/services/apiClient.ts`, `frontend/src/services/pipelineApi.ts`, `frontend/src/services/sourceConnectorService.ts`입니다.

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

현재 Pair A Source/Schema/Create/Run/Catalog/SQL preview 흐름은 live backend API를 호출합니다.
Dashboard API 계약은 Pair3 FastAPI 전환 대상이며, 그 전까지 프론트는 local/mock fallback 또는 Node demo API reference를 사용합니다.

## 2. 프론트 연결 위치

- 공통 fetch client: `frontend/src/services/apiClient.ts`
- Pipeline create/run/query client: `frontend/src/services/pipelineApi.ts`
- Source connector client: `frontend/src/services/sourceConnectorService.ts`
- 프론트 데이터 상태: `frontend/src/hooks/useAskLakeData.ts`
- 감사 로그/토스트 상태: `frontend/src/hooks/useAuditLogs.ts`

타입 위치:

- ETL job/draft: `frontend/src/types/etl.ts`
- catalog dataset: `frontend/src/types/catalog.ts`
- SQL result: `frontend/src/types/sql.ts`
- dashboard view: `frontend/src/types/dashboard.ts`
- audit/error: `frontend/src/types/audit.ts`

## 3. 환경변수

`frontend/.env`

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=true
```

- `VITE_API_BASE_URL`: 백엔드 base URL입니다.
- `VITE_USE_MOCK_API`: `false`일 때 live backend를 호출합니다. 미설정 또는 `true`이면 frontend mock mode입니다.
- mock mode에서는 Source/Schema 연결 테스트도 `sourceConnectorService.ts`의 mock `SourceConnectorAnalysis`를 사용합니다.
- live mode에서는 Source/Schema/Create/Run 흐름이 실제 백엔드를 호출합니다.

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
  "catalogTarget": {}
}
```

FastAPI 구현에서도 모든 성공 응답을 `{ ok, data }` 같은 단일 envelope로 강제하지 않습니다.
각 endpoint는 이 문서에 적힌 response shape를 우선하고, 목록 API처럼 pagination 정보가 필요한 경우에만 resource 배열과 page metadata를 함께 반환합니다.

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

page 번호 기반 목록 API는 아래 필드명을 사용합니다.

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 10
}
```

FastAPI 공통 schema에서는 `PageRequest`, `PageMeta`, `PageResponse`, `CursorPageMeta`를 재사용할 수 있습니다.
단, 실제 resource key가 `items`가 아니라 `datasets`, `dashboards`처럼 정해진 endpoint는 해당 상세 계약을 우선합니다.

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
FastAPI 구현은 `backend/app/schemas/common.py`의 `ErrorResponse`와 `ErrorDetail`을 기준으로 이 envelope를 생성합니다.

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
API와 frontend internal state의 상태값은 영어 canonical value를 사용합니다.
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
  lineageGraph?: LineageGraph;
};
```

### LineageGraph

```ts
type LineageGraph = {
  datasetId: string;
  datasets: Array<{
    id: string;
    name: string;
    layer: "SOURCE" | "RAW" | "BRONZE" | "SILVER" | "GOLD" | "CONSUMER";
    engine: string;
    columns: Array<{
      id: string;
      name: string;
      type: string;
    }>;
  }>;
  edges: Array<{
    fromDatasetId: string;
    fromColumnId: string;
    toDatasetId: string;
    toColumnId: string;
  }>;
};
```

`LineageGraph`는 화면 좌표나 렌더링 스타일을 포함하지 않습니다.
백엔드는 dataset/column/edge 관계만 반환하고, 프론트는 이를 React Flow node/edge와 column row handle로 변환합니다.
`CatalogDataset.upstream`과 `CatalogDataset.downstream`은 요약/fallback context로 유지할 수 있습니다.

### SqlResultDraft

```ts
type SqlResultDraft = {
  runId: string;
  baseDatasetId?: string;
  datasetId: string;
  datasetName: string;
  query: string;
  referenceDatasetIds?: string[];
  columns: string[];
  rows: string[][];
  rowCount: number;
  executedAt: string;
  mode?: "preview" | "run";
  previewLimit?: number;
  validationKey?: string;
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
  transformSteps: Array<{
    enabled: boolean;
    id: string;
    input: string;
    kind: "rename" | "cast" | "trim" | "jsonPath" | "mask" | "derive";
    label: string;
    onError: string;
    operation: string;
    output: string;
    params: string;
  }>;
  transformOutputColumns: Array<[string, string]>;
  qualityRules: Array<{
    enabled: boolean;
    failureAction: "Warn" | "Quarantine" | "Fail Run" | "Drop Row" | "Set Null";
    id: string;
    kind: "notNull" | "range" | "acceptedValues" | "regex" | "unique";
    severity: "Warning" | "Error";
    targetColumn: string;
    validationType: "Not Null" | "Range Check" | "Regex Match" | "Accepted Values";
  }>;
  qualityInvalidRows: string[][];
  qualityScore?: number;
  qualityStatus: "idle" | "pass" | "warn" | "fail";
  scheduleLabel: string;
  scheduleSummary: string;
  startDate: string;
  endDate?: string;
  timezone: string;
  permissionSummary: string;
  storageType: "S3" | "Local" | "HDFS";
  partition: string;
  compression: "Snappy" | "Gzip" | "None";
  storagePath: string;
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
  "scheduleSummary": "매일 09:00 · 시작 2026.07.02 · 종료일 없음 · (GMT+09:00) Seoul, Tokyo",
  "startDate": "2026-07-02",
  "timezone": "(GMT+09:00) Seoul, Tokyo",
  "permissionSummary": "Data Engineer Group / 조직 내부",
  "storageType": "S3",
  "partition": "year/month/region",
  "compression": "Snappy",
  "storagePath": "s3a://asklake-output/customer_review_silver/silver/",
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
  catalogTarget: {
    id: string;
    name: string;
    layer: string;
    status: "pending_run";
  };
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
  "catalogTarget": {
    "id": "ds_customer_review_silver",
    "name": "customer_review_silver",
    "layer": "SILVER",
    "status": "pending_run"
  }
}
```

프론트 기대 동작:

- `job`을 수집/처리 목록 최상단에 추가합니다.
- `catalogTarget`은 실행 전 대상 표시용으로만 사용합니다.
- `selectedJob`을 응답값으로 변경합니다.
- Catalog Dataset은 Spark run 성공 후 command 응답의 `dataset`으로 추가합니다.
- 생성 성공 감사 로그를 남깁니다.
- mock mode에서는 생성된 pipeline dataset을 `window.localStorage["asklake.catalogDatasets"]`에 저장하고 앱 로드시 mock catalog dataset 앞에 병합합니다.
- 응답 dataset에 `lineageGraph`가 있으면 Catalog lineage modal은 이를 우선 사용합니다. 없으면 `upstream` 기반 fallback graph를 사용합니다.

Validation:

- `jobName`, `sourceType`, `sourceLabel`, `targetDataset`, `targetLayer`, `owner`는 필수입니다.
- `targetLayer`는 `RAW`, `BRONZE`, `SILVER`, `GOLD` 중 하나여야 합니다.
- `storageType`, `partition`, `compression`, `storagePath`는 Target 화면의 draft 값이며, 없으면 frontend는 기존 기본값을 채웁니다.
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

프론트 상태 반영 계약:

```ts
type RunsByJobId = Record<string, JobRunSummary[]>;
type SelectedRunIdByJobId = Record<string, string>;
type DagStepsByRunId = Record<string, JobDagStep[]>;
```

- `job.id`는 `runsByJobId`의 key입니다.
- `run.runId`는 `selectedRunIdByJobId[job.id]`의 value이자 `dagStepsByRunId`의 key입니다.
- `run`이 있으면 `runsByJobId[job.id]`에 최신순으로 upsert합니다.
- 같은 `run.runId`가 이미 있으면 기존 Run을 교체하고 중복 row를 만들지 않습니다.
- 새 `run`이 있으면 `selectedRunIdByJobId[job.id]`는 해당 `run.runId`로 갱신합니다.
- `dagSteps`는 같은 응답의 `run.runId`에 묶어 `dagStepsByRunId[run.runId]`에 저장합니다.
- `dagSteps`에 별도 `runId` 필드를 요구하지 않습니다.
- History row 선택은 `selectRunForJob(jobId, runId)` action으로 `selectedRunIdByJobId[job.id]`만 갱신합니다.
- 초기 `/api/etl/jobs` hydrate에서는 `job.runHistory`를 `runsByJobId[job.id]`로 옮기고, `job.dagSteps`를 최신 Run의 `runId`에 연결합니다.
- PR1 optimistic 실행 상태는 API request에 `clientRunId`를 추가하지 않습니다. 프론트가 `client:<jobId>:<timestamp>` 형식의 temp run id를 만들고, 서버 응답의 `run.runId`가 오면 temp run을 실제 Run으로 교체합니다.
- `jobExecutionEvidence`는 기존 화면 호환 adapter이며 정식 source of truth가 아닙니다.

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

- `executeQueryPreview(dataset, query, { limit, validationKey })`
- `executeQueryDraft(dataset, query)`는 기존 화면 연결을 위한 호환 wrapper로 유지

Request:

```ts
type ExecuteQueryRequest = {
  baseDatasetId?: string;
  datasetId: string;
  mode?: "preview" | "run";
  limit?: number;
  query: string;
  referenceDatasetIds?: string[];
  validationKey?: string;
};
```

Request 예시:

```json
{
  "baseDatasetId": "ds_customer_review_silver",
  "datasetId": "ds_customer_review_silver",
  "mode": "preview",
  "limit": 100,
  "query": "SELECT review_id, rating, sentiment FROM customer_review_silver",
  "referenceDatasetIds": ["ds_product_master"],
  "validationKey": "frontend-generated-context-key"
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
  "baseDatasetId": "ds_customer_review_silver",
  "datasetId": "ds_customer_review_silver",
  "datasetName": "customer_review_silver",
  "query": "SELECT review_id, rating, sentiment FROM customer_review_silver",
  "referenceDatasetIds": ["ds_product_master"],
  "mode": "preview",
  "previewLimit": 100,
  "columns": ["review_id", "rating", "sentiment"],
  "rows": [
    ["10001", "5", "positive"],
    ["10002", "3", "neutral"],
    ["10003", "1", "negative"]
  ],
  "rowCount": 3,
  "executedAt": "2026-07-03T11:35:00.000Z",
  "validationKey": "frontend-generated-context-key"
}
```

Validation:

- `datasetId`, `query`는 필수입니다.
- `mode: "preview"`일 때 백엔드는 원본 SQL을 저장/변경하지 않고 서버 쪽에서 preview row limit을 적용해야 합니다.
- `baseDatasetId`와 `referenceDatasetIds`는 접근 권한 검증과 SQL table context 검증에 사용합니다.
- frontend preflight는 PostgreSQL parser로 `SELECT` 단일 문장, CTE, `FROM`/`JOIN` table context를 검사합니다. backend는 같은 기준을 서버에서 다시 검증해야 합니다.
- 읽기 전용 SQL만 허용합니다.
- `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `MERGE` 등 변경 쿼리는 `403 FORBIDDEN` 또는 `422 VALIDATION_ERROR`를 권장합니다.
- SQL 문법 오류는 `422 SQL_SYNTAX_ERROR`.
- 결과 row는 데모 단계에서 최대 500행 이하를 권장합니다.

프론트 기대 동작:

- `columns`, `rows`를 SQL 결과 테이블에 표시합니다.
- 대시보드 생성 시 같은 `SqlResultDraft`를 전달합니다.
- 실패 시 `analysis.query.preview_failed` 감사 로그를 남깁니다.

### 7.4 SQL 결과 기반 Lake Dataset 생성

`POST /api/catalog/derived-datasets`

프론트 함수:

- `createDerivedDatasetFromSql({ request, sourceDataset, sqlResult })`

Request:

```ts
type CreateDerivedDatasetRequest = {
  dataset: {
    description: string;
    layer: "SILVER" | "GOLD";
    name: string;
    rag: boolean;
    refreshPolicy: "manual";
    tags: string[];
  };
  previewLimit?: number;
  query: string;
  referenceDatasetIds?: string[];
  sourceDatasetId: string;
  sourceRunId: string;
  validationKey?: string;
};
```

Request 예시:

```json
{
  "dataset": {
    "description": "일별 매출 SQL Preview 결과로 생성한 분석 데이터셋",
    "layer": "GOLD",
    "name": "sales_daily_summary_analysis",
    "rag": true,
    "refreshPolicy": "manual",
    "tags": ["#sql-derived", "#sales", "#dw"]
  },
  "previewLimit": 100,
  "query": "SELECT ...",
  "referenceDatasetIds": ["ds_product_master"],
  "sourceDatasetId": "ds_sales_daily_summary",
  "sourceRunId": "sql_preview_01J1Z8W2V7KX",
  "validationKey": "frontend-generated-context-key"
}
```

Response `201 Created`:

```ts
type CreateDerivedDatasetResponse = CatalogDataset;
```

프론트 기대 동작:

- 생성된 dataset을 Catalog 목록 맨 앞에 추가합니다. SQL 작성 화면이 리셋되지 않도록 현재 선택 dataset은 유지할 수 있습니다.
- 저장 화면에서 입력한 `name`, `description`, `tags`, `layer`, `rag` 값을 생성된 `CatalogDataset` metadata에 반영합니다.
- mock mode에서는 생성된 derived dataset을 pipeline 생성 dataset과 같은 `window.localStorage["asklake.catalogDatasets"]`에 저장하고, 앱 로드시 mock catalog dataset 앞에 병합합니다. 기존 `asklake.derivedDatasets`는 읽기 호환만 유지합니다.
- live API mode에서는 localStorage fallback을 사용하지 않고 `POST /api/catalog/derived-datasets` 응답과 이후 `GET /api/catalog/datasets` hydrate를 신뢰합니다.
- `sampleRows`, `schema`, `upstream`에는 SQL Preview 결과와 `sourceRunId` 연결 정보가 포함되어야 합니다.
- `lineageGraph`가 있으면 카탈로그의 데이터 흐름도 확인에서 원본 dataset -> SQL derived dataset 관계를 표시합니다.
- 응답 dataset에 `lineageGraph`가 있으면 Catalog lineage modal은 이를 우선 사용합니다.
- `lineageGraph`에는 source dataset의 기존 upstream graph와 새 derived dataset node, source column -> derived column edge가 포함되어야 합니다.
- 실패 시 `analysis.derived_dataset.create_failed` 감사 로그와 Toast를 남깁니다.

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

- 앱 초기 로딩 때 `GET /api/catalog/datasets`로 hydrate합니다.
- 생성 직후에는 Catalog에 추가하지 않습니다.
- Spark run 성공 후 `POST /api/etl/jobs/{jobId}/commands` 응답의 `dataset`을 반영하고, 목록 재조회로 동기화하면 됩니다.
- mock mode에서는 pipeline 생성 dataset과 SQL derived dataset이 같은 stored catalog dataset fallback(`asklake.catalogDatasets`)을 사용합니다.

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

`GET /api/catalog/datasets/{datasetId}/lineage` Response `200 OK`:

```ts
type DatasetLineageResponse = LineageGraph;
```

Response 예시:

```json
{
  "datasetId": "ds_customer_orders_gold",
  "datasets": [
    {
      "id": "source-commerce-orders",
      "name": "commerce.orders",
      "layer": "SOURCE",
      "engine": "POSTGRESQL",
      "columns": [
        { "id": "order_id", "name": "order_id", "type": "string" }
      ]
    },
    {
      "id": "ds_customer_orders_gold",
      "name": "orders_clean",
      "layer": "GOLD",
      "engine": "ICEBERG",
      "columns": [
        { "id": "order_id", "name": "order_id", "type": "string" }
      ]
    }
  ],
  "edges": [
    {
      "fromDatasetId": "source-commerce-orders",
      "fromColumnId": "order_id",
      "toDatasetId": "ds_customer_orders_gold",
      "toColumnId": "order_id"
    }
  ]
}
```

현재 프론트는 `CatalogDataset` 하나에 schema, sampleRows, upstream, downstream을 포함해서 표시하고, lineage modal은 `LineageGraph`를 우선 사용합니다.
Lineage API나 `lineageGraph` fixture가 없으면 mock adapter가 `CatalogDataset.upstream`으로 fallback graph를 생성합니다.

### 8.3 대시보드 목록 조회

`POST /api/dashboards/query`

첫 진입은 `GET /api/dashboards`가 기본 정렬 기준으로 10개만 반환합니다.
검색, 필터, 정렬, 다음 page 요청은 프론트가 JSON body를 보내고 서버가 SQL 조건을 구성해 조회합니다.

Request body:

| 이름 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `search` | string | no | dashboard 이름, 소유자, 태그 검색어 |
| `searchQuery` | string | no | local API 호환 검색어. `search`와 같은 의미 |
| `owner` | string | no | 특정 소유자 필터 |
| `tags` | string[] | no | 선택된 태그 목록. 예: `["Marketing", "ROI"]` |
| `sort` | string | yes | `name-asc`, `name-desc`, `updated-asc`, `updated-desc`, `created-asc`, `created-desc` |
| `page` | number | yes | 1부터 시작하는 page 번호 |
| `pageSize` | number | yes | 한 page에 표시할 dashboard 개수 |

Request 예시:

```json
{
  "searchQuery": "roi",
  "owner": "Jane Doe",
  "tags": ["Marketing", "ROI"],
  "sort": "updated-desc",
  "page": 1,
  "pageSize": 10
}
```

Response `200 OK`:

```ts
type DashboardListResponse = {
  items: SavedDashboardCard[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: {
    owners: string[];
    tags: string[];
  };
};
```

`items`는 이미 서버에서 검색, 필터, 정렬, pagination이 적용된 현재 page 목록입니다.
프론트는 `items`를 그대로 표시하고, `total`, `page`, `pageSize`로 pagination UI를 계산합니다.
`filterOptions`는 현재 page에 보이는 값이 아니라 전체 dashboard 목록 기준으로 선택 가능한 소유자와 태그를 내려줍니다.

### 8.4 대시보드 삭제

`DELETE /api/dashboards/{dashboardId}`

대시보드 목록에서 삭제 버튼을 누르면 프론트가 먼저 사용자 확인 모달을 띄우고, 확인 후 이 API를 호출합니다.
서버는 삭제 전에 해당 dashboard가 존재하는지 확인하고, 소유자 또는 관리자 권한인지 검사합니다.

Request body는 없습니다.

로컬 API 서버의 임시 권한 입력:

| Header | 기본값 | 설명 |
| --- | --- | --- |
| `X-AskLake-User` | `Admin User` | 요청 사용자 이름 |
| `X-AskLake-Role` | `admin` | `admin`이면 모든 dashboard 삭제 가능. 그 외에는 dashboard `owner`와 같아야 삭제 가능 |

Response `200 OK`:

```json
{
  "deletedDashboardId": "dash_sales_analytics_demo"
}
```

Error:

| Status | Code | 상황 |
| --- | --- | --- |
| `403` | `FORBIDDEN` | 삭제 권한이 없는 사용자 |
| `404` | `NOT_FOUND` | 존재하지 않는 dashboard |

삭제 성공 후 프론트는 dashboard 목록을 다시 조회합니다.

### 8.5 대시보드 초안 생성

`POST /api/dashboards`

대시보드 랜딩 페이지의 `새 대시보드 생성` 버튼에서 호출한다.
생성 즉시 `dashboards` 테이블에 `status: "draft"` 카드 정보를 저장하고, 프론트는 응답받은 `dashboard.id`로 `/dashboards/{dashboardId}` 조회 화면에 진입한다.
실제 편집용 draft revision/page/widget은 사용자가 내부 화면에서 `위젯 편집`을 눌렀을 때 `POST /api/dashboards/{dashboardId}/draft/ensure`로 준비한다.
`게시` 동작은 `POST /api/dashboards/{dashboardId}/publish`를 호출하며, 이때 목록 status가 `published`로 바뀐다.

Request:

```ts
type CreateDashboardDraftRequest = {
  title?: string;
  source?: "manual" | "sql" | "catalog";
  datasetId?: string;
  sqlRunId?: string;
};
```

Request 예시:

```json
{
  "title": "새 대시보드 2026-07-05 16:42",
  "source": "manual"
}
```

Response `201 Created`:

```json
{
  "dashboard": {
    "id": "dash_1751710920000_ab12cd34",
    "name": "새 대시보드 2026-07-05 16:42",
    "owner": "Admin User",
    "meta": "0개 위젯 · 수동 생성",
    "status": "draft",
    "tags": "초안 · Dashboard",
    "createdAt": "2026-07-05 16:42",
    "createdAtValue": "2026-07-05T07:42:00.000Z",
    "updated": "방금 전",
    "updatedAtValue": "2026-07-05T07:42:00.000Z",
    "hasPublishedRevision": false,
    "widgets": []
  }
}
```

현재 프론트 동작:

- 랜딩 페이지에서 새 대시보드 생성 시 빈 dashboard card를 `draft`로 생성합니다.
- 생성 응답의 `dashboard.id`를 사용해 `/dashboards/{dashboardId}` 조회 화면으로 이동합니다.
- 위젯 추가와 draft revision 생성은 내부 화면의 `위젯 편집` 이후 별도 runtime API에서 처리합니다.

### 8.5.0 대시보드 제목 수정

`PATCH /api/dashboards/{dashboardId}`

대시보드 내부 draft 편집 화면에서 상단 제목을 수정할 때 사용합니다.
서버는 기존 dashboard card payload를 유지하고 `name`, `title`, `updated`, `updatedAtValue`만 갱신합니다.

Request:

```json
{
  "title": "월별 물류비 대시보드"
}
```

Response `200 OK`:

```json
{
  "dashboard": {
    "id": "dash_...",
    "name": "월별 물류비 대시보드",
    "updated": "방금 전",
    "updatedAtValue": "2026-07-05T07:42:00.000Z"
  }
}
```

실패:

- dashboard가 없으면 `404 NOT_FOUND`.
- 빈 제목이면 `400 VALIDATION_ERROR`.

### 8.5 대시보드 revision runtime

Phase 02 dashboard runtime은 기존 dashboard card 저장과 별도로 draft/published revision snapshot을 저장합니다.
현재 demo API는 PostgreSQL JSONB 기반 서버 스타일에 맞춰 `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets`, `dashboard_tags` 테이블을 idempotent하게 생성합니다.

공통 response:

```ts
type DashboardRuntimeWidgetType = "metric" | "bar_chart" | "line_chart" | "donut_chart" | "table";
type DashboardWidgetAggregation = "sum" | "avg" | "count" | "min" | "max";
type DashboardWidgetDateUnit = "day" | "month" | "year";
type DashboardWidgetFormat = "number" | "currency" | "percent";
type DashboardWidgetSortDirection = "asc" | "desc";

type DashboardWidgetConfigBase = {
  color?: string;
  description?: string;
  error?: string;
  errorMessage?: string;
};

type MetricWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: string;
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
  color: string;
  groupKey?: string;
  xKey: string;
  yKey: string;
};

type LineChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: string;
  dateUnit?: DashboardWidgetDateUnit;
  seriesKey?: string;
  xKey: string;
  yKey: string;
};

type DonutChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: string;
  labelKey: string;
  valueKey: string;
};

type DashboardRuntimeWidgetConfigByType = {
  metric: MetricWidgetConfig;
  table: TableWidgetConfig;
  bar_chart: BarChartWidgetConfig;
  line_chart: LineChartWidgetConfig;
  donut_chart: DonutChartWidgetConfig;
};

type DashboardRuntimeWidget = {
  [Type in DashboardRuntimeWidgetType]: {
    id: string;
    pageId: string;
    type: Type;
    title: string | null;
    layout: {
      x: number;
      y: number;
      w: number;
      h: number;
      minW?: number;
      minH?: number;
    };
    config: DashboardRuntimeWidgetConfigByType[Type];
    data: Array<Record<string, unknown>>;
    queryId?: string | null;
    datasetId?: string | null;
  };
}[DashboardRuntimeWidgetType];

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

#### 8.5.1 Published 조회

`GET /api/dashboards/{dashboardId}/published`

Response `200 OK`:

- published revision이 있으면 해당 revision의 pages/widgets를 반환합니다.
- published revision이 없으면 `revision: null`, `pages: []`, `widgetsByPageId: {}`로 정상 응답합니다.

실패:

- dashboard가 없으면 `404 NOT_FOUND`.

#### 8.5.2 Draft 조회/생성

`POST /api/dashboards/{dashboardId}/draft/ensure`

동작:

1. draft revision이 있으면 그대로 반환합니다.
2. draft가 없고 published revision이 있으면 published revision을 복사해 draft를 만듭니다.
3. 둘 다 없으면 빈 draft revision과 기본 page 1개를 만듭니다.

실패:

- dashboard가 없으면 `404 NOT_FOUND`.

#### 8.5.3 Draft page 추가

`POST /api/dashboards/{dashboardId}/draft/pages`

Request:

```json
{
  "title": "제목 없는 페이지"
}
```

Response `201 Created`:

```json
{
  "id": "dashpage_...",
  "title": "제목 없는 페이지",
  "orderIndex": 1
}
```

#### 8.5.4 Draft page 이름 수정

`PATCH /api/dashboards/{dashboardId}/draft/pages/{pageId}`

현재 draft revision에 속한 page의 표시 이름을 수정합니다.
Published revision의 page 이름은 이 API로 직접 수정하지 않고, 이후 `POST /api/dashboards/{dashboardId}/publish` 시점에 draft snapshot이 published로 복사됩니다.

Request:

```json
{
  "title": "월별 비용"
}
```

Response `200 OK`:

```json
{
  "id": "dashpage_...",
  "title": "월별 비용",
  "orderIndex": 0
}
```

실패:

- dashboard, draft revision, page가 없으면 `404 NOT_FOUND`.
- 빈 제목이면 `400 VALIDATION_ERROR`.

#### 8.5.5 Draft page 삭제

`DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`

동작:

1. 현재 draft revision에 속한 page만 삭제합니다.
2. 해당 page의 widgets는 cascade로 함께 삭제합니다.
3. 남은 page의 `orderIndex`를 다시 정렬합니다.

Response `200 OK`:

```json
{ "ok": true }
```

실패:

- dashboard, draft revision, page가 없으면 `404 NOT_FOUND`.

#### 8.5.6 Draft widget 추가

`POST /api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets`

Request:

```json
{
  "datasetId": "gold_logistics_cost_overview",
  "type": "bar_chart",
  "title": "월별 물류비",
  "layout": { "x": 0, "y": 0, "w": 6, "h": 5, "minW": 3, "minH": 3 },
  "config": {
    "xKey": "month",
    "yKey": "total_cost",
    "aggregation": "sum",
    "color": "blue",
    "description": "월 기준 총 물류비 추이"
  }
}
```

`data`는 optional입니다. 호출자가 `data`를 명시하지 않고 `datasetId`를 보내면 서버는 catalog dataset의 rows 또는 sample rows를 찾아 `Array<Record<string, unknown>>` 형태로 변환한 뒤 widget `data` snapshot으로 저장합니다.
현재 demo backend는 실제 rows API가 없으므로 `catalog_datasets.payload.sampleRows`와 `schema`를 사용해 column name 기반 object row를 만듭니다.
예를 들어 `sampleRows: [["2026-01", "KR", "FastShip", "4200000"]]`, `schema: [["month", "date"], ["region", "string"], ["carrier", "string"], ["transport_cost", "decimal"]]`는 `[{ "month": "2026-01", "region": "KR", "carrier": "FastShip", "transport_cost": 4200000 }]`로 저장됩니다.

Response `201 Created`:

```json
{ "id": "dashwidget_..." }
```

서버는 `type`을 runtime widget enum으로 정규화하고, layout이 없으면 widget type별 기본 layout을 적용합니다.
기존 기본 위젯 추가 흐름을 위해 `datasetId`와 `config`는 optional이지만, 데이터셋 기반 위젯 생성 UI와 API는 `type`별 config 계약을 사용합니다. `metric`은 `valueKey`, `aggregation`, `color`, optional `format`; `table`은 `columns`, optional `limit`, optional `sortKey`, optional `sortDirection`, common `color`; `bar_chart`는 `xKey`, `yKey`, `aggregation`, `color`, optional `groupKey`; `line_chart`는 `xKey`, `yKey`, `aggregation`, `color`, optional `dateUnit`, optional `seriesKey`; `donut_chart`는 `labelKey`, `valueKey`, `aggregation`, `color`를 보냅니다.
생성 후 draft runtime 조회 응답의 widget에는 `datasetId`, `config`, `data`가 유지되어야 합니다.
dataset을 찾지 못하거나 rows/sample rows가 없으면 서버는 기존 생성 흐름을 깨지 않고 `data: []` fallback을 저장합니다.

#### 8.5.7 Draft widget 수정

`PATCH /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`

Request:

```json
{
  "datasetId": "gold_logistics_cost_overview",
  "type": "line_chart",
  "title": "월별 물류비 추이",
  "config": {
    "xKey": "month",
    "yKey": "total_cost",
    "aggregation": "sum",
    "dateUnit": "month",
    "color": "blue",
    "description": "월 기준 총 물류비 추이"
  }
}
```

동작:

1. 현재 draft revision에 속한 widget만 수정합니다.
2. `type`, `title`, `datasetId`, `config`를 갱신합니다.
3. published revision의 widget은 직접 수정하지 않습니다.
4. 이후 `POST /api/dashboards/{dashboardId}/publish` 시점에 수정된 draft snapshot이 published로 복사됩니다.

Response `200 OK`:

```json
{ "id": "dashwidget_..." }
```

실패:

- dashboard, draft revision, widget이 없거나 현재 draft revision에 속하지 않으면 `404 NOT_FOUND`.

#### 8.5.8 Draft widget 삭제

`DELETE /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`

동작:

1. 현재 draft revision에 속한 widget만 삭제합니다.
2. published revision의 widget은 직접 삭제하지 않습니다.
3. 이후 `POST /api/dashboards/{dashboardId}/publish` 시점에 삭제된 draft snapshot이 published로 복사됩니다.

Response `200 OK`:

```json
{ "ok": true, "deletedWidgetId": "dashwidget_..." }
```

실패:

- dashboard, draft revision, widget이 없거나 현재 draft revision에 속하지 않으면 `404 NOT_FOUND`.

#### 8.5.9 Draft layout batch 저장

`PATCH /api/dashboards/{dashboardId}/draft/layouts`

Request:

```json
{
  "pageId": "dashpage_...",
  "layouts": [
    { "widgetId": "dashwidget_...", "x": 0, "y": 0, "w": 6, "h": 4, "minW": 2, "minH": 2 }
  ]
}
```

Response `200 OK`:

```json
{ "ok": true }
```

서버는 `x`, `y`, `w`, `h`, `minW`, `minH`를 유한 숫자로 정규화하고, 음수 좌표나 1보다 작은 크기를 보정합니다.

#### 8.5.10 Publish

`POST /api/dashboards/{dashboardId}/publish`

동작:

1. 현재 draft revision을 깊은 복사합니다.
2. 새 revision을 `kind = "published"`로 저장합니다.
3. dashboard card payload의 `publishedRevisionId`, `hasPublishedRevision`, `status`, `updatedAtValue`를 갱신합니다.

Draft editor에서 page를 추가/삭제하거나 widget layout을 바꾼 뒤 이 endpoint를 호출하면, 그 시점의 draft pages/widgets가 published viewer의 `GET /api/dashboards/{dashboardId}/published` 응답에 반영됩니다.

Response `200 OK`:

```json
{
  "dashboardId": "dash_...",
  "publishedRevisionId": "dashrev_published_...",
  "publishedAt": "2026-07-04T12:00:00.000Z"
}
```

실패:

- dashboard가 없으면 `404 NOT_FOUND`.
- draft revision이 없으면 `422 NO_DRAFT_REVISION`.

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

1. mock mode에서 backend 없이 Source/Schema 연결 테스트, 생성 플로우, Catalog/SQL 화면이 깨지지 않는지 확인합니다.
2. 백엔드 서버를 실행합니다.
3. `frontend/.env`에 `VITE_API_BASE_URL`과 `VITE_USE_MOCK_API=false`를 설정합니다.
4. 프론트 dev 서버를 재시작합니다.
5. `POST /api/etl/sources/test` Source/Schema live 연결 흐름을 확인합니다.
6. `POST /api/etl/jobs` 생성 플로우를 확인합니다.
7. `POST /api/etl/jobs/{jobId}/commands` 버튼 흐름과 Spark DAG 갱신을 확인합니다.
8. `POST /api/query/runs` SQL 실행 흐름을 확인합니다.
9. P1 API를 붙인 뒤 남은 정적 초기 데이터를 서버 hydrate로 교체합니다.

## 12. 열린 결정 사항

백엔드 구현 전에 팀에서 결정하면 좋은 항목입니다.

- 인증 방식: JWT, 세션, 또는 임시 demo actor.
- 실제 ETL 실행 엔진: Airflow, Dagster, 자체 worker, Spark job 중 선택.
- SQL 실행 엔진: Trino, Spark SQL, DuckDB, warehouse API 중 선택.
- dataset row count/size 표기: 문자열로 내려줄지 숫자와 단위를 분리할지.
- audit log 저장 실패 시 사용자에게 노출할지 여부.
- dashboard widget 저장 모델을 `dashboards`, `dashboard_widgets`로 분리할지 여부.
