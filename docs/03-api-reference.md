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
- ETL/Catalog 초기 hydrate 결과가 비어 있으면 UI도 빈 목록으로 시작한다.

## 2) 환경 변수

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=true
```

- `VITE_USE_MOCK_API=false`: live backend mode. Source connector, create/run/query API를 실제 backend로 보낸다.
- 미설정 또는 `true`: frontend demo/mock mode. Source connector도 mock sample을 반환한다.

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
| `POST` | `/api/catalog/derived-datasets` | TBD | SQL 결과 기반 Lake Dataset 생성 | `docs/api-contract.md` |

## 5) P1 API

| Method | Endpoint | Auth | 설명 | 상세 문서 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/etl/jobs` | TBD | job 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/etl/jobs/{jobId}` | TBD | job 상세 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets` | TBD | dataset 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}` | TBD | dataset 상세 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}/lineage` | TBD | column-level lineage graph hydrate | `docs/api-contract.md` |

## 6) P2 / 확장 API

| Method | Endpoint | 설명 |
| --- | --- | --- |
| `POST` | `/api/dashboards` | dashboard draft 생성 |
| `PATCH` | `/api/dashboards/{dashboardId}` | dashboard 저장 |
| `POST` | `/api/dashboards/{dashboardId}/publish` | dashboard 게시 |
| `POST` | `/api/audit-logs` | audit log 서버 저장 |

## 7) 화면별 데이터 계약

| 화면 | 현재 데이터 | Future API |
| --- | --- | --- |
| 수집/처리 목록 | live backend hydrate | `GET /api/etl/jobs` |
| 수집/처리 상세 | selected job state | `GET /api/etl/jobs/{jobId}` |
| 생성 flow | `DraftPipeline` state | `POST /api/etl/jobs` |
| Source/Schema 연결 | `testSourceConnector` mock/live adapter | `POST /api/etl/sources/test` |
| 카탈로그 | live backend hydrate | `GET /api/catalog/datasets` |
| 카탈로그 상세 | selected dataset state | `GET /api/catalog/datasets/{datasetId}` |
| Lineage | `LineageGraph` mock/fallback | `GET /api/catalog/datasets/{datasetId}/lineage` |
| SQL 분석 | `executeQueryPreview` mock/live, `executeQueryDraft` 호환 wrapper | `POST /api/query/runs` preview mode |
| SQL 결과 Dataset 생성 | `createDerivedDatasetFromSql` mock/live | `POST /api/catalog/derived-datasets` |
| 대시보드 | local builder state | dashboard APIs |
| 감사 로그 | local/localStorage state | `POST /api/audit-logs` |

## 8) Pair Handoff Contracts

Pair 간 전달 객체는 API field name을 사용한다.
ID field는 camelCase로 고정하고, 화면 표시용 한국어 상태값을 전달 객체에 넣지 않는다.

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

Mock mode에서는 Pair A pipeline 생성 dataset과 SQL derived dataset을 모두 `window.localStorage["asklake.catalogDatasets"]`에 저장하고 앱 로드시 mock catalog dataset 앞에 병합한다. 기존 `asklake.derivedDatasets` 값은 읽기 호환만 유지한다. Live API mode에서는 localStorage fallback을 사용하지 않고 backend catalog persistence와 `GET /api/catalog/datasets` 응답을 source of truth로 둔다.

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

## 9) 변경 규칙

- Endpoint, request, response, status code, error code가 바뀌면 이 문서와 `docs/api-contract.md`를 함께 업데이트한다.
- Mock/live 전환 순서가 바뀌면 `docs/backend-integration-readiness.md`를 업데이트한다.
- Frontend 타입이 바뀌면 관련 `frontend/src/types/`와 문서를 함께 업데이트한다.
