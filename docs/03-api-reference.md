# 03. API Reference

이 문서는 AskLake API/interface 계약의 상위 진입점이다.
상세 request/response shape는 기존 문서인 `docs/api-contract.md`를 기준으로 한다.
백엔드 연결 순서와 mock 제거 계획은 `docs/backend-integration-readiness.md`를 기준으로 한다.

## 1) 현재 상태

- 현재 앱은 frontend-only baseline이다.
- `frontend/src/services/mockApi.ts`가 mock/live 전환 지점이다.
- `frontend/src/services/apiClient.ts`가 live API 호출 wrapper다.
- `VITE_USE_MOCK_API=false`일 때 P0 API는 실제 backend로 호출된다.

## 2) 환경 변수

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=false
```

## 3) 공통 규칙

- Base Path: `/api`
- Body format: JSON
- Response format: JSON
- ID type: opaque string
- Time format: ISO 8601 string
- Status values: API, mock fixture, and frontend internal state use English canonical values. UI labels are translated in the frontend.
- Error envelope: `docs/api-contract.md`의 Error Envelope를 따른다.
- Authentication: 현재 demo frontend에는 토큰 저장이 없다. backend 도입 시 임시 actor 또는 bearer token 전략을 명시해야 한다.

Canonical status values:

| Resource | Field | Values |
| --- | --- | --- |
| Job | `status` | `scheduled`, `running`, `failed`, `paused`, `canceled` |
| Run | `status` | `queued`, `running`, `success`, `failed`, `canceled` |
| Dataset | `status` | `available`, `approval_required` |
| Dataset | `freshness` | `latest`, `stale`, `approval` |
| Dashboard | `status` | `draft`, `published` |

## 4) P0 API

| Method | Endpoint | Auth | 설명 | 상세 문서 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/etl/jobs` | TBD | 새 수집/처리 job 생성 | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs/{jobId}/commands` | TBD | 실행, 재실행, 일시정지, 취소 | `docs/api-contract.md` |
| `POST` | `/api/query/runs` | TBD | read-only SQL 실행 | `docs/api-contract.md` |

## 5) P1 API

| Method | Endpoint | Auth | 설명 | 상세 문서 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/etl/jobs` | TBD | job 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/etl/jobs/{jobId}` | TBD | job 상세 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets` | TBD | dataset 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}` | TBD | dataset 상세 hydrate | `docs/backend-integration-readiness.md` |

## 6) P2 / 확장 API

| Method | Endpoint | 설명 |
| --- | --- | --- |
| `GET` | `/api/dashboards` | dashboard 첫 목록 조회, 기본 10개 반환 |
| `POST` | `/api/dashboards/query` | dashboard 검색/필터/정렬/pagination JSON 요청, 서버 SQL로 처리 |
| `POST` | `/api/dashboards` | dashboard draft 생성 |
| `PATCH` | `/api/dashboards/{dashboardId}` | dashboard 저장 |
| `GET` | `/api/dashboards/{dashboardId}/published` | published revision 기반 dashboard runtime 조회 |
| `POST` | `/api/dashboards/{dashboardId}/draft/ensure` | draft revision 조회 또는 생성 |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages` | draft revision에 page 추가 |
| `DELETE` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page와 하위 widgets 삭제 |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets` | draft page에 widget 추가 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/layouts` | draft widget layout batch 저장 |
| `POST` | `/api/dashboards/{dashboardId}/publish` | dashboard 게시 |
| `POST` | `/api/audit-logs` | audit log 서버 저장 |

## 7) 화면별 데이터 계약

| 화면 | 현재 데이터 | Future API |
| --- | --- | --- |
| 수집/처리 목록 | `etlJobs` mock | `GET /api/etl/jobs` |
| 수집/처리 상세 | selected job state | `GET /api/etl/jobs/{jobId}` |
| 생성 flow | `DraftPipeline` state | `POST /api/etl/jobs` |
| 카탈로그 | `catalogDatasets` mock | `GET /api/catalog/datasets` |
| 카탈로그 상세 | selected dataset state | `GET /api/catalog/datasets/{datasetId}` |
| Lineage | `upstream`/`downstream` arrays | dataset detail 또는 lineage API |
| SQL 분석 | `executeQueryDraft` mock/live | `POST /api/query/runs` |
| 대시보드 | Postgres/API adapter state | `GET /api/dashboards`, `POST /api/dashboards/query`, draft/published revision runtime APIs |
| 감사 로그 | local/localStorage state | `POST /api/audit-logs` |

## 8) Pair Handoff Contracts

### Dashboard Runtime Contract

Dashboard 상세/편집 runtime은 dashboard meta와 revision snapshot을 분리한다.

```ts
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
  widgetsByPageId: Record<string, Array<{
    id: string;
    pageId: string;
    type: "metric" | "bar_chart" | "line_chart" | "donut_chart" | "table";
    title: string | null;
    layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number };
    config: Record<string, unknown>;
    data: Array<Record<string, unknown>>;
  }>>;
  filters: Array<{ id: string; label: string; value: unknown }>;
};
```

`GET /api/dashboards/{dashboardId}/published`는 published revision이 없으면 `revision: null`, `pages: []`, `widgetsByPageId: {}`로 응답한다.
`POST /api/dashboards/{dashboardId}/draft/ensure`는 idempotent하며 draft가 없으면 published snapshot 또는 빈 revision과 기본 page를 만든다.
`DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`는 page와 해당 page의 widgets를 함께 삭제한다.
`POST /api/dashboards/{dashboardId}/publish`는 현재 draft revision을 새 published revision으로 복사하므로, draft editor에서 추가/삭제한 pages는 publish 후 published viewer에서 보인다.

Pair 간 전달 객체는 API/mock fixture와 같은 field name을 사용한다.
ID field는 camelCase로 고정하고, 화면 표시용 한국어 상태값을 전달 객체에 넣지 않는다.

### Pair A -> Pair B

```ts
type CreateJobResponse = {
  job: JobRowData;
  dataset: CatalogDataset;
};
```

필수 확인:

- `dataset.id`, `dataset.name`, `dataset.schema`, `dataset.sampleRows`, `dataset.rows`, `dataset.size`가 있어야 SQL context를 만들 수 있다.
- `dataset.upstream`과 `dataset.downstream`이 있으면 Lineage fallback을 만들 수 있다.
- 생성 후 ETL 목록과 Catalog 목록에 같은 `job.id`와 `dataset.id` 기준 결과가 보여야 한다.

### Pair A -> Pair C

```ts
type JobCommandResponse = {
  action: "etl.run.requested" | "etl.run.retry_requested" | "etl.job.pause_requested" | "etl.run.cancel_requested";
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

### Pair B -> Pair C

```ts
type QueryRunResponse = SqlResultDraft;
```

필수 확인:

- `columns`와 `rows`가 Table Widget의 데이터가 된다.
- `runId`는 Dashboard `sourceRunId`가 된다.
- `datasetId`는 Dashboard `datasetId`와 같아야 한다.

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

Lineage API가 없으면 `CatalogDataset.upstream`과 `CatalogDataset.downstream`으로 fallback context를 만든다.

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
  scaleLabel: "500MB" | "1GB" | "10GB";
  caveat?: string;
};
```

`DataProcessingResult`는 대용량 처리 증거가 필요할 때만 쓰는 optional demo evidence 확장 객체다.
정식 persistence API가 생기기 전에는 `JobCommandResponse.processingResult` 또는 fixture로 전달한다.

## 9) 변경 규칙

- Endpoint, request, response, status code, error code가 바뀌면 이 문서와 `docs/api-contract.md`를 함께 업데이트한다.
- Mock/live 전환 순서가 바뀌면 `docs/backend-integration-readiness.md`를 업데이트한다.
- Frontend 타입이 바뀌면 관련 `frontend/src/types/`와 문서를 함께 업데이트한다.
