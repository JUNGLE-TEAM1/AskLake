# 03. API Reference

??문서??AskLake API/interface 계약???�위 진입?�이??
?�세 request/response shape??기존 문서??`docs/api-contract.md`�?기�??�로 ?�다.
백엔???�결 ?�서?� mock ?�거 계획?� `docs/backend-integration-readiness.md`�?기�??�로 ?�다.

## 1) ?�재 ?�태

- ?�재 ?��? frontend-only baseline?�다.
- `frontend/src/services/mockApi.ts`가 mock/live ?�환 지?�이??
- `frontend/src/services/apiClient.ts`가 live API ?�출 wrapper??
- `VITE_USE_MOCK_API=false`????P0 API???�제 backend�??�출?�다.

## 2) ?�경 변??

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
- Error envelope: `docs/api-contract.md`??Error Envelope�??�른??
- Authentication: ?�재 demo frontend?�는 ?�큰 ?�?�이 ?�다. backend ?�입 ???�시 actor ?�는 bearer token ?�략??명시?�야 ?�다.

Canonical status values:

| Resource | Field | Values |
| --- | --- | --- |
| Job | `status` | `scheduled`, `running`, `failed`, `paused`, `canceled` |
| Run | `status` | `queued`, `running`, `success`, `failed`, `canceled` |
| Dataset | `status` | `available`, `approval_required` |
| Dataset | `freshness` | `latest`, `stale`, `approval` |
| Dashboard | `status` | `draft`, `published` |

## 4) P0 API

| Method | Endpoint | Auth | ?�명 | ?�세 문서 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/etl/jobs` | TBD | ???�집/처리 job ?�성 | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs/{jobId}/commands` | TBD | ?�행, ?�실?? ?�시?��?, 취소 | `docs/api-contract.md` |
| `POST` | `/api/query/runs` | TBD | read-only SQL ?�행 | `docs/api-contract.md` |

## 5) P1 API

| Method | Endpoint | Auth | ?�명 | ?�세 문서 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/etl/jobs` | TBD | job 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/etl/jobs/{jobId}` | TBD | job ?�세 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets` | TBD | dataset 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}` | TBD | dataset ?�세 hydrate | `docs/backend-integration-readiness.md` |

## 6) P2 / ?�장 API

| Method | Endpoint | ?�명 |
| --- | --- | --- |
| `GET` | `/api/dashboards` | dashboard �?목록 조회, 기본 10�?반환 |
| `POST` | `/api/dashboards/query` | dashboard 검???�터/?�렬/pagination JSON ?�청, ?�버 SQL�?처리 |
| `POST` | `/api/dashboards` | dashboard draft ?�성 |
| `PATCH` | `/api/dashboards/{dashboardId}` | dashboard ?�??|
| `GET` | `/api/dashboards/{dashboardId}/published` | published revision 기반 dashboard runtime 조회 |
| `POST` | `/api/dashboards/{dashboardId}/draft/ensure` | draft revision 조회 ?�는 ?�성 |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages` | draft revision??page 추�? |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page 이름 수정 |
| `DELETE` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page?� ?�위 widgets ??�� |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets` | draft page??widget 추�? |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/widgets/{widgetId}` | draft widget 수정 |
| `DELETE` | `/api/dashboards/{dashboardId}/draft/widgets/{widgetId}` | draft widget 삭제 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/layouts` | draft widget layout batch ?�??|
| `POST` | `/api/dashboards/{dashboardId}/publish` | dashboard 게시 |
| `DELETE` | `/api/dashboards/{dashboardId}` | dashboard ??��. ?�유???�는 관리자�??�용 |
| `POST` | `/api/audit-logs` | audit log ?�버 ?�??|

Dataset-based widget creation sends top-level `datasetId` plus `type` and a type-specific `config`. The supported runtime widget types are fixed to `metric`, `table`, `bar_chart`, `line_chart`, and `donut_chart`; each widget config must follow the contract in the Dashboard Runtime Contract section. The draft runtime response must preserve `queryId`, `datasetId`, `type`, and `config` on each widget.

## 7) ?�면�??�이??계약

| ?�면 | ?�재 ?�이??| Future API |
| --- | --- | --- |
| ?�집/처리 목록 | `etlJobs` mock | `GET /api/etl/jobs` |
| ?�집/처리 ?�세 | selected job state | `GET /api/etl/jobs/{jobId}` |
| ?�성 flow | `DraftPipeline` state | `POST /api/etl/jobs` |
| 카탈로그 | `catalogDatasets` mock | `GET /api/catalog/datasets` |
| 카탈로그 ?�세 | selected dataset state | `GET /api/catalog/datasets/{datasetId}` |
| Lineage | `upstream`/`downstream` arrays | dataset detail ?�는 lineage API |
| SQL 분석 | `executeQueryDraft` mock/live | `POST /api/query/runs` |
| ��ú��� | Postgres/API adapter state | `GET /api/dashboards`, `POST /api/dashboards`, `POST /api/dashboards/query`, `DELETE /api/dashboards/{dashboardId}`, draft/published revision runtime APIs |
| 감사 로그 | local/localStorage state | `POST /api/audit-logs` |

## 8) Pair Handoff Contracts

### Dashboard Runtime Contract

Dashboard ?�세/?�집 runtime?� dashboard meta?� revision snapshot??분리?�다.

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
    layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number };
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

Dashboard widget 생성 API는 `datasetId`가 있고 명시적 `data`가 없을 때 catalog dataset의 rows 또는 sample rows를 column name 기반 object row로 변환해 widget `data` snapshot에 저장한다. Draft runtime 조회 응답은 이 `widget.data`를 그대로 내려준다. 현재 demo backend는 `sampleRows`와 `schema`를 사용하며, dataset을 찾지 못하거나 rows/sample rows가 없으면 `data: []` fallback을 유지한다.

`POST /api/dashboards`는 랜딩 페이지의 새 대시보드 생성 버튼에서 사용한다. 생성 즉시 `status: "draft"` dashboard card를 DB에 저장하고, 프론트는 응답받은 `dashboard.id`로 `/dashboards/{dashboardId}` 조회 화면에 진입한다. 편집용 draft revision/page/widget은 `위젯 편집` 이후 `POST /api/dashboards/{dashboardId}/draft/ensure`에서 준비한다.
`PATCH /api/dashboards/{dashboardId}`는 dashboard card의 표시 제목을 수정한다.
`PATCH /api/dashboards/{dashboardId}/draft/pages/{pageId}`는 현재 draft revision에 속한 page 제목만 수정한다.

`GET /api/dashboards/{dashboardId}/published`??published revision???�으�?`revision: null`, `pages: []`, `widgetsByPageId: {}`�??�답?�다.
`POST /api/dashboards/{dashboardId}/draft/ensure`??idempotent?�며 draft가 ?�으�?published snapshot ?�는 �?revision�?기본 page�?만든??
`DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`??page?� ?�당 page??widgets�??�께 ??��?�다.
`PATCH /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`는 현재 draft revision에 속한 widget의 type, title, datasetId, config를 수정한다.
`DELETE /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`는 현재 draft revision에 속한 widget만 삭제한다.
`POST /api/dashboards/{dashboardId}/publish`???�재 draft revision????published revision?�로 복사?��?�? draft editor?�서 추�?/??��??pages??publish ??published viewer?�서 보인??

Pair �??�달 객체??API/mock fixture?� 같�? field name???�용?�다.
ID field??camelCase�?고정?�고, ?�면 ?�시???�국???�태값을 ?�달 객체???��? ?�는??

### Dashboard runtime UX note

Phase 06 frontend behavior uses the existing runtime endpoints without adding a share API. Draft publish calls `POST /api/dashboards/{dashboardId}/publish`, refresh refetches the active draft or published runtime payload, and share copies `/dashboards/{dashboardId}` when a published revision exists or `/dashboards/{dashboardId}/edit` when only draft is available.

### Pair A -> Pair B

```ts
type CreateJobResponse = {
  job: JobRowData;
  dataset: CatalogDataset;
};
```

?�수 ?�인:

- `dataset.id`, `dataset.name`, `dataset.schema`, `dataset.sampleRows`, `dataset.rows`, `dataset.size`가 ?�어??SQL context�?만들 ???�다.
- `dataset.upstream`�?`dataset.downstream`???�으�?Lineage fallback??만들 ???�다.
- ?�성 ??ETL 목록�?Catalog 목록??같�? `job.id`?� `dataset.id` 기�? 결과가 보여???�다.

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

?�수 ?�인:

- `job`???�으�??�론?�는 ?�당 ?�답??기�??�로 Job ?�태�?갱신?�다.
- `run.runId`가 ?�으�?Dashboard??`sourceRunId`까�? ?�어진다.
- `processingResult.runId`?� `processingResult.datasetId`??Run, Catalog, SQL, Dashboard?�서 같아???�다.

### Pair B -> Pair C

```ts
type QueryRunResponse = SqlResultDraft;
```

?�수 ?�인:

- `columns`?� `rows`가 Table Widget???�이?��? ?�다.
- `runId`??Dashboard `sourceRunId`가 ?�다.
- `datasetId`??Dashboard `datasetId`?� 같아???�다.

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

Lineage API가 ?�으�?`CatalogDataset.upstream`�?`CatalogDataset.downstream`?�로 fallback context�?만든??

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

`DataProcessingResult`???�?�량 처리 증거가 ?�요???�만 ?�는 optional demo evidence ?�장 객체??
?�식 persistence API가 ?�기�??�에??`JobCommandResponse.processingResult` ?�는 fixture�??�달?�다.

## 9) 변�?규칙

- Endpoint, request, response, status code, error code가 바뀌면 ??문서?� `docs/api-contract.md`�??�께 ?�데?�트?�다.
- Mock/live ?�환 ?�서가 바뀌면 `docs/backend-integration-readiness.md`�??�데?�트?�다.
- Frontend ?�?�이 바뀌면 관??`frontend/src/types/`?� 문서�??�께 ?�데?�트?�다.
