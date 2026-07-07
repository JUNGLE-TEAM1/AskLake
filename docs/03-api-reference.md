# 03. API Reference

이 문서는 AskLake API/interface 계약의 상위 진입점이다.
상세 request/response shape는 기존 문서인 `docs/api-contract.md`를 기준으로 한다.
백엔드 연결 범위와 남은 작업은 `docs/backend-integration-readiness.md`를 기준으로 한다.

## 1) 현재 상태

- 현재 Pair A Source/Schema/Create/Run 흐름은 mock/live adapter를 통해 동작한다.
- mock mode(`VITE_USE_MOCK_API` 미설정 또는 `true`)에서는 Source/Schema 연결 테스트도 backend 없이 mock `SourceConnectorAnalysis`를 반환한다.
- live API mode(`VITE_USE_MOCK_API=false`)에서만 Source/Schema/Create/Run이 live backend API를 호출한다.
- `frontend/src/services/apiClient.ts`가 API 호출 wrapper다.
- `frontend/src/services/pipelineApi.ts`가 create/run/query 호출 진입점이다.
- live backend mode에서 ETL job, catalog dataset, SQL run snapshot은 Postgres JSONB metadata tables에 저장된다.
- ETL/Catalog 초기 hydrate 결과가 Postgres에 비어 있으면 UI도 빈 목록으로 시작한다.

## 2) 환경 변수

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=true
DATABASE_URL=postgres://asklake:asklake_dev@127.0.0.1:54328/asklake
```

- 개발 서버에서 `VITE_API_BASE_URL`을 생략하면 프론트는 같은 출처의 `/api`를 호출하고, Vite proxy가 FastAPI `http://127.0.0.1:8080`으로 전달한다.
- `VITE_USE_MOCK_API=false`: live backend mode. Source connector, create/run/query/catalog/dashboard API를 실제 backend로 보낸다.
- 미설정 또는 `true`: frontend demo/mock mode. Source connector도 mock sample을 반환한다.
- `DATABASE_URL`: backend metadata DB. 미설정 시 `docker-compose.yml`의 local Postgres 기본값을 사용한다.
- Dashboard adapter는 FastAPI 응답을 우선하고, 이전 backend 호환을 위해 404 local/mock fallback을 유지한다.
- Query AI live mode는 backend env의 `OPENAI_API_KEY`와 `OPENAI_QUERY_AI_MODEL`을 사용한다. 브라우저 env에는 OpenAI 키를 두지 않는다.

## 3) 공통 규칙

- Base Path: `/api`
- Body format: JSON
- Response format: JSON
- ID type: opaque string
- Time format: ISO 8601 string
- Status values: API and frontend internal state use English canonical values. UI labels are translated in the frontend.
- Error envelope: `docs/api-contract.md`의 Error Envelope를 따른다.
- Authentication: 현재 demo frontend에는 토큰 저장이 없다. backend 도입 시 임시 actor 또는 bearer token 전략을 명시해야 한다.

FastAPI schema 구현 기준:

- 공통 Pydantic schema는 `backend/app/schemas/common.py`에 둔다.
- 각 도메인 schema는 `CamelModel`을 상속해 Python 내부에서는 `snake_case`, API request/response에서는 `camelCase`를 사용한다.
- 실패 응답은 `ErrorResponse` / `ErrorDetail`을 사용하고, code 값은 `docs/api-contract.md`의 권장 에러 코드를 우선한다.
- 목록형 API는 필요에 따라 `PageRequest`, `PageMeta`, `PageResponse`, `CursorPageMeta`, `SortDirection`을 재사용한다.
- 모든 성공 응답을 하나의 envelope로 강제하지 않는다. 각 endpoint의 성공 response shape는 `docs/api-contract.md`의 상세 계약을 따른다.

Canonical status values:

| Resource | Field | Values |
| --- | --- | --- |
| Job | `status` | `scheduled`, `running`, `failed`, `paused`, `canceled`, `stopped` |
| Run | `status` | `queued`, `running`, `success`, `failed`, `canceled` |
| Dataset | `status` | `available`, `approval_required` |
| Dataset | `freshness` | `latest`, `stale`, `approval` |
| Dashboard | `status` | `draft`, `published` |

## 4) P0 API

| Method | Endpoint | Auth | 설명 | 상세 문서 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/etl/sources/test` | TBD | Source 연결 테스트와 schema draft patch 반환 | `docs/api-contract.md` |
| `POST` | `/api/etl/schema-inference` | TBD | Source 테스트 결과 기반 schema 반환 | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs` | TBD | 새 수집/처리 job 생성 | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs/{jobId}/commands` | TBD | 실행, 재실행, 일시정지, 현재 Run 취소, 스케줄 중지 | `docs/api-contract.md` |
| `POST` | `/api/query/runs` | TBD | read-only SQL 실행 | `docs/api-contract.md` |
| `POST` | `/api/query/ai-suggestions` | TBD | 선택 테이블 context 기반 Query AI SQL 초안 생성 | `docs/api-contract.md` |
| `POST` | `/api/catalog/derived-datasets` | TBD | SQL 결과 기반 Lake Dataset 생성 | `docs/api-contract.md` |

`POST /api/etl/jobs/{jobId}/commands`의 `run`/`retry`는 실행 접수 직후 `running` 상태를 응답하고, Spark 완료 후 최종 상태는 `GET /api/etl/jobs/{jobId}` polling으로 반영한다.

## 5) P1 API

| Method | Endpoint | Auth | 설명 | 상세 문서 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/etl/jobs` | TBD | job 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/etl/jobs/{jobId}` | TBD | job 상세 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets` | TBD | dataset 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}` | TBD | dataset 상세 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}/lineage` | TBD | column-level lineage graph hydrate 또는 fallback | `docs/api-contract.md` |
| `POST` | `/api/catalog/derived-datasets` | TBD | SQL preview 결과 기반 dataset 생성 | `docs/api-contract.md` |

## 6) P2 / 확장 API

| Method | Endpoint | 설명 |
| --- | --- | --- |
| `GET` | `/api/dashboards` | dashboard 목록 조회 |
| `POST` | `/api/dashboards/query` | dashboard 검색, 소유자/태그 필터, 정렬, pagination 조회 |
| `POST` | `/api/dashboards` | dashboard card를 `draft` 상태로 생성 |
| `PATCH` | `/api/dashboards/{dashboardId}` | dashboard title 등 card metadata 수정 |
| `DELETE` | `/api/dashboards/{dashboardId}` | dashboard 삭제. 소유자 또는 관리자 권한 필요 |
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
| `POST` | `/api/audit-logs` | audit log 서버 저장 |

Dataset 기반 widget 생성은 top-level `datasetId`, `type`, type별 `config`를 함께 전송한다. 지원 runtime widget type은 `metric`, `table`, ApexCharts 차트 8종(`bar_chart`, `line_chart`, `area_chart`, `donut_chart`, `pie_chart`, `radial_bar_chart`, `heatmap_chart`, `treemap_chart`)으로 둔다. Draft runtime 응답은 각 widget의 `queryId`, `datasetId`, `type`, `config`, `data` snapshot을 유지해야 한다.

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
| Source/Schema 연결 | `testSourceConnector` mock/live adapter | `POST /api/etl/sources/test` |
| 카탈로그 | Postgres JSONB-backed live backend hydrate | `GET /api/catalog/datasets` |
| 카탈로그 상세 | selected dataset state | `GET /api/catalog/datasets/{datasetId}` |
| Lineage | `LineageGraph` mock/fallback | `GET /api/catalog/datasets/{datasetId}/lineage` |
| SQL 분석 | `executeQueryPreview` mock/live, `executeQueryDraft` 호환 wrapper | `POST /api/query/runs` preview mode |
| Query AI 보조 | mock mode는 로컬 초안 fallback, live mode는 FastAPI/OpenAI 호출 | `POST /api/query/ai-suggestions` |
| SQL 결과 Dataset 생성 | UI는 `prepareSqlDatasetJobDraft`로 Review에 넘긴 뒤 `POST /api/etl/jobs`; backend direct materialize API는 `createDerivedDatasetFromSql` 호환 유지 | `POST /api/etl/jobs`, `POST /api/catalog/derived-datasets` |
| 대시보드 | FastAPI dashboard adapter, 404 local/mock fallback | `GET /api/dashboards`, `POST /api/dashboards/query`, draft/published runtime APIs |
| 감사 로그 | local/localStorage state | `POST /api/audit-logs` |

Schedule UI는 `수동/자동/1회 실행` 대신 `스케줄링 건너뛰기`와 `반복 실행` 두 선택지만 사용한다. 스케줄링을 건너뛰면 사용자가 `POST /api/etl/jobs/{jobId}/commands`의 `run` command action으로 필요할 때 1회 Run을 만든다. 반복 실행 화면은 데모 흐름을 위해 반복 주기, 실행 시각, IANA `timezone`, 실패 재시도만 노출한다. `startDate`, `endDate`, `nextRunUtc`, `overlapPolicy`, `watermarkPolicy`는 create request에 보존하되 UI에서는 기본값을 사용한다. 기본 `overlapPolicy`는 `skip_if_running`이며, 재시도는 다음 예약 시각 계산을 밀지 않고 현재 Run 안에서 2배 지수 백오프 정책으로 처리한다.

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

Day1 Pair A create request는 Review Summary용 `ruleSummary`만 보내지 않는다. `transformSteps`, `transformOutputColumns`, `qualityRules`, `qualityScore`, `qualityStatus`, `qualityInvalidRows`를 함께 보내고, backend는 이 payload를 job에 저장한 뒤 run command에서 Spark transform/quality 실행에 사용한다.

필수 확인:

- `dataset.id`, `dataset.name`, `dataset.schema`, `dataset.sampleRows`, `dataset.rows`, `dataset.size`가 있어야 SQL context를 만들 수 있다.
- `dataset.lineageGraph`가 있으면 Catalog lineage modal은 생성 직후 이 그래프를 우선 사용한다.
- `dataset.upstream`이 있으면 Catalog lineage modal의 source/upstream -> current fallback을 만들 수 있다.
- `dataset.downstream`은 SQL, dashboard, mart 같은 영향도/소비처 context에 사용할 수 있다.
- 생성 후 ETL 목록과 Catalog 목록에 같은 `job.id`와 `dataset.id` 기준 결과가 보여야 한다.
- Target draft의 `storageType`, `partition`, `compression`, `storagePath`는 `targetDataset`, `targetLayer`, `targetFormat`과 함께 create request에 전달된다.

Mock mode에서는 Pair A pipeline 생성 dataset과 backend direct SQL derived dataset을 모두 `window.localStorage["asklake.catalogDatasets"]`에 저장하고 앱 로드시 mock catalog dataset 앞에 병합한다. 현재 SQL 화면의 `처리 Job 생성` UI는 직접 localStorage에 dataset을 쓰지 않고 SQL Result를 ETL Review draft로 변환한 뒤 기존 Job 생성 경로를 사용한다. 기존 `asklake.derivedDatasets` 값은 읽기 호환만 유지한다. Live API mode에서는 localStorage fallback을 사용하지 않고 backend catalog persistence와 `GET /api/catalog/datasets` 응답을 source of truth로 둔다.

### Pair A -> Pair C

```ts
type JobCommandResponse = {
  action: "etl.run.requested" | "etl.run.retry_requested" | "etl.job.pause_requested" | "etl.run.cancel_requested" | "etl.schedule.stop_requested";
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
프론트는 `VITE_DASHBOARD_ASSISTANT_API_PATH`가 설정된 경우에만 해당 경로로 `POST` 요청을 보낸다.

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
`VITE_DASHBOARD_ASSISTANT_API_PATH`가 없으면 UI는 미설정 안내만 표시하고 요청을 보내지 않는다.
`widgets`는 구버전/테스트 호환 fallback payload로 유지하지만, `dashboardId`가 있으면 서버 DB runtime 컨텍스트가 우선이다.
`selectedWidgetId` 또는 `widgetId`가 있으면 서버는 해당 위젯만 `update_widget` 대상에 포함한다.

## 9) 변경 규칙

- Endpoint, request, response, status code, error code가 바뀌면 이 문서와 `docs/api-contract.md`를 함께 업데이트한다.
- Mock/live 전환 순서가 바뀌면 `docs/backend-integration-readiness.md`를 업데이트한다.
- Frontend 타입이 바뀌면 관련 `frontend/src/types/`와 문서를 함께 업데이트한다.
