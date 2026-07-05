# 03. API Reference

## Current Pair A API Boundary (2026-07-06)

- `POST /api/etl/sources/test`, `POST /api/etl/jobs`, `GET /api/etl/jobs`, `POST /api/etl/jobs/{jobId}/commands`, `GET /api/catalog/datasets`, and `POST /api/query/runs` are implemented live paths for Pair A validation.
- `/api/etl/schema-inference` is not a separate authoritative endpoint in this branch. Schema re-check uses the source connector test path and the returned `draftPatch.schema`.
- `CreateJobResponse` returns `{ job, catalogTarget }`; a Catalog Dataset is not created at pipeline-create time.
- `JobCommandResponse` returns `{ job, run, dagSteps, dataset }`. `run.runId` is the key used by History and DAG.
- Create request includes `permissionRoles`, `storageType`, `partition`, `compression`, and `storagePath` when the UI has those values.


??臾몄꽌??AskLake API/interface 怨꾩빟???곸쐞 吏꾩엯?먯씠??
?곸꽭 request/response shape??湲곗〈 臾몄꽌??`docs/api-contract.md`瑜?湲곗??쇰줈 ?쒕떎.
諛깆뿏???곌껐 踰붿쐞? ?⑥? ?묒뾽? `docs/backend-integration-readiness.md`瑜?湲곗??쇰줈 ?쒕떎.

## 1) ?꾩옱 ?곹깭

- ?꾩옱 Pair A Source/Schema/Create/Run ?먮쫫? live backend API瑜??몄텧?쒕떎.
- `frontend/src/services/apiClient.ts`媛 API ?몄텧 wrapper??
- `frontend/src/services/pipelineApi.ts`媛 create/run/query ?몄텧 吏꾩엯?먯씠??
- ETL/Catalog 珥덇린 hydrate 寃곌낵媛 鍮꾩뼱 ?덉쑝硫?UI??鍮?紐⑸줉?쇰줈 ?쒖옉?쒕떎.

## 2) ?섍꼍 蹂??

```bash
VITE_API_BASE_URL=http://localhost:8080
```

## 3) 怨듯넻 洹쒖튃

- Base Path: `/api`
- Body format: JSON
- Response format: JSON
- ID type: opaque string
- Time format: ISO 8601 string
- Status values: API and frontend internal state use English canonical values. UI labels are translated in the frontend.
- Error envelope: `docs/api-contract.md`??Error Envelope瑜??곕Ⅸ??
- Authentication: ?꾩옱 demo frontend?먮뒗 ?좏겙 ??μ씠 ?녿떎. backend ?꾩엯 ???꾩떆 actor ?먮뒗 bearer token ?꾨왂??紐낆떆?댁빞 ?쒕떎.

Canonical status values:

| Resource | Field | Values |
| --- | --- | --- |
| Job | `status` | `scheduled`, `running`, `failed`, `paused`, `canceled` |
| Run | `status` | `queued`, `running`, `success`, `failed`, `canceled` |
| Dataset | `status` | `available`, `approval_required` |
| Dataset | `freshness` | `latest`, `stale`, `approval` |
| Dashboard | `status` | `draft`, `published` |

## 4) P0 API

| Method | Endpoint | Auth | ?ㅻ챸 | ?곸꽭 臾몄꽌 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/etl/sources/test` | TBD | Source ?곌껐 ?뚯뒪?몄? schema draft patch 諛섑솚 | `docs/api-contract.md` |
| `POST` | `/api/etl/schema-inference` | TBD | Source ?뚯뒪??寃곌낵 湲곕컲 schema 諛섑솚 | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs` | TBD | ???섏쭛/泥섎━ job ?앹꽦 | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs/{jobId}/commands` | TBD | ?ㅽ뻾, ?ъ떎?? ?쇱떆?뺤?, 痍⑥냼 | `docs/api-contract.md` |
| `POST` | `/api/query/runs` | TBD | read-only SQL ?ㅽ뻾 | `docs/api-contract.md` |

## 5) P1 API

| Method | Endpoint | Auth | ?ㅻ챸 | ?곸꽭 臾몄꽌 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/etl/jobs` | TBD | job 紐⑸줉 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/etl/jobs/{jobId}` | TBD | job ?곸꽭 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets` | TBD | dataset 紐⑸줉 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}` | TBD | dataset ?곸꽭 hydrate | `docs/backend-integration-readiness.md` |

## 6) P2 / ?뺤옣 API

| Method | Endpoint | ?ㅻ챸 |
| --- | --- | --- |
| `POST` | `/api/dashboards` | dashboard draft ?앹꽦 |
| `PATCH` | `/api/dashboards/{dashboardId}` | dashboard ???|
| `POST` | `/api/dashboards/{dashboardId}/publish` | dashboard 寃뚯떆 |
| `POST` | `/api/audit-logs` | audit log ?쒕쾭 ???|

## 7) ?붾㈃蹂??곗씠??怨꾩빟

| ?붾㈃ | ?꾩옱 ?곗씠??| Future API |
| --- | --- | --- |
| ?섏쭛/泥섎━ 紐⑸줉 | live backend hydrate | `GET /api/etl/jobs` |
| ?섏쭛/泥섎━ ?곸꽭 | selected job state | `GET /api/etl/jobs/{jobId}` |
| ?앹꽦 flow | `DraftPipeline` state | `POST /api/etl/jobs` |
| 移댄깉濡쒓렇 | live backend hydrate | `GET /api/catalog/datasets` |
| 移댄깉濡쒓렇 ?곸꽭 | selected dataset state | `GET /api/catalog/datasets/{datasetId}` |
| Lineage | `upstream`/`downstream` arrays | dataset detail ?먮뒗 lineage API |
| SQL 遺꾩꽍 | `executeQueryDraft` live API ?몄텧 | `POST /api/query/runs` |
| ??쒕낫??| local builder state | dashboard APIs |
| 媛먯궗 濡쒓렇 | local/localStorage state | `POST /api/audit-logs` |

諛섎났 ?ㅽ뻾 schedule? `scheduleLabel`???뷀빐 `scheduleSummary`, `startDate`, `endDate`, `timezone`??create request???ы븿??Review? ?앹꽦 payload媛 媛숈? 媛믪쓣 蹂닿쾶 ?쒕떎.

## 8) Pair Handoff Contracts

Pair 媛??꾨떖 媛앹껜??API field name???ъ슜?쒕떎.
ID field??camelCase濡?怨좎젙?섍퀬, ?붾㈃ ?쒖떆???쒓뎅???곹깭媛믪쓣 ?꾨떖 媛앹껜???ｌ? ?딅뒗??

### Pair A -> Pair B

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

Day1 Pair A create request??Review Summary??`ruleSummary`留?蹂대궡吏 ?딅뒗?? `transformSteps`, `transformOutputColumns`, `qualityRules`, `qualityScore`, `qualityStatus`, `qualityInvalidRows`瑜??④퍡 蹂대궡怨? backend????payload瑜?job????ν븳 ??run command?먯꽌 Spark transform/quality ?ㅽ뻾???ъ슜?쒕떎. Catalog Dataset? create ?쒖젏??留뚮뱾吏 ?딄퀬 Spark run ?깃났 ??`JobCommandResponse.dataset`?쇰줈 ?앹꽦/媛깆떊?쒕떎.

?꾩닔 ?뺤씤:

- `catalogTarget.id`, `catalogTarget.name`, `catalogTarget.layer`, `catalogTarget.status`媛 ?덉뼱???ㅽ뻾 ??????뺣낫瑜?蹂댁뿬以????덈떎.
- Spark run ?깃났 ??command ?묐떟??`dataset.id`, `dataset.name`, `dataset.schema`, `dataset.sampleRows`, `dataset.rows`, `dataset.size`媛 SQL context瑜?留뚮뱾 ???덉뼱???쒕떎.
- ?앹꽦 ??ETL 紐⑸줉?먮뒗 Job??蹂댁씠怨? Catalog 紐⑸줉? Spark run ?깃났 ?꾧퉴吏 鍮꾩뼱 ?덉뼱???쒕떎.
- Target draft??`storageType`, `partition`, `compression`, `storagePath`??`targetDataset`, `targetLayer`, `targetFormat`怨??④퍡 create request???꾨떖?쒕떎.

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
  dataset?: CatalogDataset;
  processingResult?: DataProcessingResult;
};
```

?꾩닔 ?뺤씤:

- `job`???덉쑝硫??꾨줎?몃뒗 ?대떦 ?묐떟??湲곗??쇰줈 Job ?곹깭瑜?媛깆떊?쒕떎.
- `run.runId`媛 ?덉쑝硫?Dashboard??`sourceRunId`源뚯? ?댁뼱吏꾨떎.
- `processingResult.runId`? `processingResult.datasetId`??Run, Catalog, SQL, Dashboard?먯꽌 媛숈븘???쒕떎.

?꾨줎??Run ?곹깭 怨꾩빟:

```ts
type RunsByJobId = Record<string, JobRunSummary[]>;
type SelectedRunIdByJobId = Record<string, string>;
type DagStepsByRunId = Record<string, JobDagStep[]>;
```

?꾩닔 洹쒖튃:

- `runsByJobId[job.id]`??理쒖떊 Run???욎뿉 ?붾떎.
- 媛숈? `run.runId`媛 ?ㅼ떆 ?ㅼ뼱?ㅻ㈃ 湲곗〈 Run??援먯껜?쒕떎.
- ??Run???ㅼ뼱?ㅻ㈃ `selectedRunIdByJobId[job.id]`瑜?洹?`run.runId`濡?媛깆떊?쒕떎.
- `dagSteps`??蹂꾨룄 `runId` ?꾨뱶瑜??붽뎄?섏? ?딄퀬, 媛숈? ?묐떟??`run.runId` 湲곗??쇰줈 `dagStepsByRunId`????ν븳??
- DAG ?붾㈃? `runs[0]`???꾨땲??`selectedRunIdByJobId[job.id]` 湲곗??쇰줈 ?④퀎瑜?李얜뒗??
- History??`selectRunForJob(jobId, runId)` action?쇰줈留??좏깮 Run??諛붽씔??
- 珥덇린 hydrate ??`job.runHistory`??`runsByJobId[job.id]`濡???린怨? `job.dagSteps`??理쒖떊 Run??`runId`??臾띕뒗??
- PR1 optimistic ?ㅽ뻾 ?곹깭??API request??`clientRunId`瑜?異붽??섏? ?딄퀬 frontend temp id `client:<jobId>:<timestamp>`瑜?留뚮뱺 ?? ?쒕쾭 ?묐떟??`run.runId`濡?援먯껜?쒕떎.

### Pair B -> Pair C

```ts
type QueryRunResponse = SqlResultDraft;
```

?꾩닔 ?뺤씤:

- `columns`? `rows`媛 Table Widget???곗씠?곌? ?쒕떎.
- `runId`??Dashboard `sourceRunId`媛 ?쒕떎.
- `datasetId`??Dashboard `datasetId`? 媛숈븘???쒕떎.

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

Lineage API媛 ?놁쑝硫?`CatalogDataset.upstream`怨?`CatalogDataset.downstream`?쇰줈 fallback context瑜?留뚮뱺??

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

`DataProcessingResult`????⑸웾 泥섎━ 利앷굅媛 ?꾩슂???뚮쭔 ?곕뒗 optional demo evidence ?뺤옣 媛앹껜??
?뺤떇 persistence API媛 ?앷린湲??꾩뿉??`JobCommandResponse.processingResult` ?먮뒗 fixture濡??꾨떖?쒕떎.

## 9) 蹂寃?洹쒖튃

- Endpoint, request, response, status code, error code媛 諛붾뚮㈃ ??臾몄꽌? `docs/api-contract.md`瑜??④퍡 ?낅뜲?댄듃?쒕떎.
- Mock/live ?꾪솚 ?쒖꽌媛 諛붾뚮㈃ `docs/backend-integration-readiness.md`瑜??낅뜲?댄듃?쒕떎.
- Frontend ??낆씠 諛붾뚮㈃ 愿??`frontend/src/types/`? 臾몄꽌瑜??④퍡 ?낅뜲?댄듃?쒕떎.
