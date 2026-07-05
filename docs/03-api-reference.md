# 03. API Reference

??ë¬¸ì„œ??AskLake API/interface ê³„ì•½???ìœ„ ì§„ì…?ì´??
?ì„¸ request/response shape??ê¸°ì¡´ ë¬¸ì„œ??`docs/api-contract.md`ë¥?ê¸°ì??¼ë¡œ ?œë‹¤.
ë°±ì—”???°ê²° ?œì„œ?€ mock ?œê±° ê³„íš?€ `docs/backend-integration-readiness.md`ë¥?ê¸°ì??¼ë¡œ ?œë‹¤.

## 1) ?„ì¬ ?íƒœ

- ?„ì¬ ?±ì? frontend-only baseline?´ë‹¤.
- `frontend/src/services/mockApi.ts`ê°€ mock/live ?„í™˜ ì§€?ì´??
- `frontend/src/services/apiClient.ts`ê°€ live API ?¸ì¶œ wrapper??
- `VITE_USE_MOCK_API=false`????P0 API???¤ì œ backendë¡??¸ì¶œ?œë‹¤.

## 2) ?˜ê²½ ë³€??

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=false
```

## 3) ê³µí†µ ê·œì¹™

- Base Path: `/api`
- Body format: JSON
- Response format: JSON
- ID type: opaque string
- Time format: ISO 8601 string
- Status values: API, mock fixture, and frontend internal state use English canonical values. UI labels are translated in the frontend.
- Error envelope: `docs/api-contract.md`??Error Envelopeë¥??°ë¥¸??
- Authentication: ?„ì¬ demo frontend?ëŠ” ? í° ?€?¥ì´ ?†ë‹¤. backend ?„ì… ???„ì‹œ actor ?ëŠ” bearer token ?„ëµ??ëª…ì‹œ?´ì•¼ ?œë‹¤.

Canonical status values:

| Resource | Field | Values |
| --- | --- | --- |
| Job | `status` | `scheduled`, `running`, `failed`, `paused`, `canceled` |
| Run | `status` | `queued`, `running`, `success`, `failed`, `canceled` |
| Dataset | `status` | `available`, `approval_required` |
| Dataset | `freshness` | `latest`, `stale`, `approval` |
| Dashboard | `status` | `draft`, `published` |

## 4) P0 API

| Method | Endpoint | Auth | ?¤ëª… | ?ì„¸ ë¬¸ì„œ |
| --- | --- | --- | --- | --- |
| `POST` | `/api/etl/jobs` | TBD | ???˜ì§‘/ì²˜ë¦¬ job ?ì„± | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs/{jobId}/commands` | TBD | ?¤í–‰, ?¬ì‹¤?? ?¼ì‹œ?•ì?, ì·¨ì†Œ | `docs/api-contract.md` |
| `POST` | `/api/query/runs` | TBD | read-only SQL ?¤í–‰ | `docs/api-contract.md` |

## 5) P1 API

| Method | Endpoint | Auth | ?¤ëª… | ?ì„¸ ë¬¸ì„œ |
| --- | --- | --- | --- | --- |
| `GET` | `/api/etl/jobs` | TBD | job ëª©ë¡ hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/etl/jobs/{jobId}` | TBD | job ?ì„¸ hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets` | TBD | dataset ëª©ë¡ hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}` | TBD | dataset ?ì„¸ hydrate | `docs/backend-integration-readiness.md` |

## 6) P2 / ?•ì¥ API

| Method | Endpoint | ?¤ëª… |
| --- | --- | --- |
| `GET` | `/api/dashboards` | dashboard ì²?ëª©ë¡ ì¡°íšŒ, ê¸°ë³¸ 10ê°?ë°˜í™˜ |
| `POST` | `/api/dashboards/query` | dashboard ê²€???„í„°/?•ë ¬/pagination JSON ?”ì²­, ?œë²„ SQLë¡?ì²˜ë¦¬ |
| `POST` | `/api/dashboards` | dashboard draft ?ì„± |
| `PATCH` | `/api/dashboards/{dashboardId}` | dashboard ?€??|
| `GET` | `/api/dashboards/{dashboardId}/published` | published revision ê¸°ë°˜ dashboard runtime ì¡°íšŒ |
| `POST` | `/api/dashboards/{dashboardId}/draft/ensure` | draft revision ì¡°íšŒ ?ëŠ” ?ì„± |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages` | draft revision??page ì¶”ê? |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page ì´ë¦„ ìˆ˜ì • |
| `DELETE` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page?€ ?˜ìœ„ widgets ?? œ |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets` | draft page??widget ì¶”ê? |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/layouts` | draft widget layout batch ?€??|
| `POST` | `/api/dashboards/{dashboardId}/publish` | dashboard ê²Œì‹œ |
| `DELETE` | `/api/dashboards/{dashboardId}` | dashboard ?? œ. ?Œìœ ???ëŠ” ê´€ë¦¬ìë§??ˆìš© |
| `POST` | `/api/audit-logs` | audit log ?œë²„ ?€??|

Dataset-based widget creation sends top-level `datasetId` plus `config.xKey`, `config.yKey`, `config.color`, and `config.description`; the draft runtime response must preserve `queryId`, `datasetId`, and `config` on each widget.

## 7) ?”ë©´ë³??°ì´??ê³„ì•½

| ?”ë©´ | ?„ì¬ ?°ì´??| Future API |
| --- | --- | --- |
| ?˜ì§‘/ì²˜ë¦¬ ëª©ë¡ | `etlJobs` mock | `GET /api/etl/jobs` |
| ?˜ì§‘/ì²˜ë¦¬ ?ì„¸ | selected job state | `GET /api/etl/jobs/{jobId}` |
| ?ì„± flow | `DraftPipeline` state | `POST /api/etl/jobs` |
| ì¹´íƒˆë¡œê·¸ | `catalogDatasets` mock | `GET /api/catalog/datasets` |
| ì¹´íƒˆë¡œê·¸ ?ì„¸ | selected dataset state | `GET /api/catalog/datasets/{datasetId}` |
| Lineage | `upstream`/`downstream` arrays | dataset detail ?ëŠ” lineage API |
| SQL ë¶„ì„ | `executeQueryDraft` mock/live | `POST /api/query/runs` |
| ´ë½Ãº¸µå | Postgres/API adapter state | `GET /api/dashboards`, `POST /api/dashboards`, `POST /api/dashboards/query`, `DELETE /api/dashboards/{dashboardId}`, draft/published revision runtime APIs |
| ê°ì‚¬ ë¡œê·¸ | local/localStorage state | `POST /api/audit-logs` |

## 8) Pair Handoff Contracts

### Dashboard Runtime Contract

Dashboard ?ì„¸/?¸ì§‘ runtime?€ dashboard meta?€ revision snapshot??ë¶„ë¦¬?œë‹¤.

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
    queryId?: string | null;
    datasetId?: string | null;
  }>>;
  filters: Array<{ id: string; label: string; value: unknown }>;
};
```

`POST /api/dashboards`ëŠ” ëœë”© í˜ì´ì§€ì˜ ìƒˆ ëŒ€ì‹œë³´ë“œ ìƒì„± ë²„íŠ¼ì—ì„œ ì‚¬ìš©í•œë‹¤. ìƒì„± ì¦‰ì‹œ `status: "draft"` dashboard cardë¥¼ DBì— ì €ì¥í•˜ê³ , í”„ë¡ íŠ¸ëŠ” ì‘ë‹µë°›ì€ `dashboard.id`ë¡œ `/dashboards/{dashboardId}` ì¡°íšŒ í™”ë©´ì— ì§„ì…í•œë‹¤. í¸ì§‘ìš© draft revision/page/widgetì€ `ìœ„ì ¯ í¸ì§‘` ì´í›„ `POST /api/dashboards/{dashboardId}/draft/ensure`ì—ì„œ ì¤€ë¹„í•œë‹¤.
`PATCH /api/dashboards/{dashboardId}`ëŠ” dashboard cardì˜ í‘œì‹œ ì œëª©ì„ ìˆ˜ì •í•œë‹¤.
`PATCH /api/dashboards/{dashboardId}/draft/pages/{pageId}`ëŠ” í˜„ì¬ draft revisionì— ì†í•œ page ì œëª©ë§Œ ìˆ˜ì •í•œë‹¤.

`GET /api/dashboards/{dashboardId}/published`??published revision???†ìœ¼ë©?`revision: null`, `pages: []`, `widgetsByPageId: {}`ë¡??‘ë‹µ?œë‹¤.
`POST /api/dashboards/{dashboardId}/draft/ensure`??idempotent?˜ë©° draftê°€ ?†ìœ¼ë©?published snapshot ?ëŠ” ë¹?revisionê³?ê¸°ë³¸ pageë¥?ë§Œë“ ??
`DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`??page?€ ?´ë‹¹ page??widgetsë¥??¨ê»˜ ?? œ?œë‹¤.
`POST /api/dashboards/{dashboardId}/publish`???„ì¬ draft revision????published revision?¼ë¡œ ë³µì‚¬?˜ë?ë¡? draft editor?ì„œ ì¶”ê?/?? œ??pages??publish ??published viewer?ì„œ ë³´ì¸??

Pair ê°??„ë‹¬ ê°ì²´??API/mock fixture?€ ê°™ì? field name???¬ìš©?œë‹¤.
ID field??camelCaseë¡?ê³ ì •?˜ê³ , ?”ë©´ ?œì‹œ???œêµ­???íƒœê°’ì„ ?„ë‹¬ ê°ì²´???£ì? ?ŠëŠ”??

### Dashboard runtime UX note

Phase 06 frontend behavior uses the existing runtime endpoints without adding a share API. Draft publish calls `POST /api/dashboards/{dashboardId}/publish`, refresh refetches the active draft or published runtime payload, and share copies `/dashboards/{dashboardId}` when a published revision exists or `/dashboards/{dashboardId}/edit` when only draft is available.

### Pair A -> Pair B

```ts
type CreateJobResponse = {
  job: JobRowData;
  dataset: CatalogDataset;
};
```

?„ìˆ˜ ?•ì¸:

- `dataset.id`, `dataset.name`, `dataset.schema`, `dataset.sampleRows`, `dataset.rows`, `dataset.size`ê°€ ?ˆì–´??SQL contextë¥?ë§Œë“¤ ???ˆë‹¤.
- `dataset.upstream`ê³?`dataset.downstream`???ˆìœ¼ë©?Lineage fallback??ë§Œë“¤ ???ˆë‹¤.
- ?ì„± ??ETL ëª©ë¡ê³?Catalog ëª©ë¡??ê°™ì? `job.id`?€ `dataset.id` ê¸°ì? ê²°ê³¼ê°€ ë³´ì—¬???œë‹¤.

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

?„ìˆ˜ ?•ì¸:

- `job`???ˆìœ¼ë©??„ë¡ ?¸ëŠ” ?´ë‹¹ ?‘ë‹µ??ê¸°ì??¼ë¡œ Job ?íƒœë¥?ê°±ì‹ ?œë‹¤.
- `run.runId`ê°€ ?ˆìœ¼ë©?Dashboard??`sourceRunId`ê¹Œì? ?´ì–´ì§„ë‹¤.
- `processingResult.runId`?€ `processingResult.datasetId`??Run, Catalog, SQL, Dashboard?ì„œ ê°™ì•„???œë‹¤.

### Pair B -> Pair C

```ts
type QueryRunResponse = SqlResultDraft;
```

?„ìˆ˜ ?•ì¸:

- `columns`?€ `rows`ê°€ Table Widget???°ì´?°ê? ?œë‹¤.
- `runId`??Dashboard `sourceRunId`ê°€ ?œë‹¤.
- `datasetId`??Dashboard `datasetId`?€ ê°™ì•„???œë‹¤.

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

Lineage APIê°€ ?†ìœ¼ë©?`CatalogDataset.upstream`ê³?`CatalogDataset.downstream`?¼ë¡œ fallback contextë¥?ë§Œë“ ??

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

`DataProcessingResult`???€?©ëŸ‰ ì²˜ë¦¬ ì¦ê±°ê°€ ?„ìš”???Œë§Œ ?°ëŠ” optional demo evidence ?•ì¥ ê°ì²´??
?•ì‹ persistence APIê°€ ?ê¸°ê¸??„ì—??`JobCommandResponse.processingResult` ?ëŠ” fixtureë¡??„ë‹¬?œë‹¤.

## 9) ë³€ê²?ê·œì¹™

- Endpoint, request, response, status code, error codeê°€ ë°”ë€Œë©´ ??ë¬¸ì„œ?€ `docs/api-contract.md`ë¥??¨ê»˜ ?…ë°?´íŠ¸?œë‹¤.
- Mock/live ?„í™˜ ?œì„œê°€ ë°”ë€Œë©´ `docs/backend-integration-readiness.md`ë¥??…ë°?´íŠ¸?œë‹¤.
- Frontend ?€?…ì´ ë°”ë€Œë©´ ê´€??`frontend/src/types/`?€ ë¬¸ì„œë¥??¨ê»˜ ?…ë°?´íŠ¸?œë‹¤.
