# AskLake Backend Integration Readiness

이 문서는 AskLake 프론트엔드와 백엔드 연결 상태, 남은 API 범위, 검증 기준을 정리한다. Pair A Source/Schema/Create/Run 흐름은 mock mode에서는 frontend fallback으로, live API mode에서는 backend를 기준으로 검증한다.
FastAPI 전환의 공통 구조와 의사결정은 `docs/backend-fastapi-transition-plan.md`를 기준으로 한다.

상세 request/response shape는 `docs/api-contract.md`를 기준으로 한다.

## 1. 현재 연결 상태

| 영역 | 현재 상태 | 남은 범위 |
| --- | --- | --- |
| 수집/처리 목록 | `GET /api/etl/jobs` hydrate. 서버 상태가 비어 있으면 빈 목록으로 시작 | 삭제, 수정 저장 persistence |
| 새 수집/처리 생성 | Source -> Schema -> Rule -> Schedule -> Permission -> Target -> Review -> Create가 `POST /api/etl/jobs`로 연결 | 중간 단계별 서버 저장 API는 후속 범위 |
| Source/Schema | mock mode에서는 `SourceConnectorAnalysis` fallback으로 schema/sampleRows 반영, live mode에서는 `POST /api/etl/sources/test`로 실제 connector 확인 | Kafka message payload sampling, Parquet physical schema inference |
| Rule | 현재 schema/sampleRows 기반 preview, create payload에 transform/quality detail 포함 | 별도 backend rule preview API |
| Job command | `POST /api/etl/jobs/{jobId}/commands`로 Spark run 실행 | pause/cancel의 실제 Spark job interrupt |
| Run/DAG | Spark 결과로 runHistory, dagSteps, catalog dataset 갱신 | 장기 persistence와 run detail 조회 API |
| Catalog | `GET /api/catalog/datasets` hydrate, `GET /api/catalog/datasets/{datasetId}/lineage`, create/run 결과 반영 | search persistence |
| SQL 분석 | `POST /api/query/runs`, `POST /api/catalog/derived-datasets` 호출 지점 유지 | read-only SQL engine 고도화 |
| Dashboard | FastAPI dashboard card/list와 draft/published runtime API 연결. 프론트는 404 local fallback 유지 | 권한/공유 API, export API, cross-pair E2E QA |
| Audit | local 기록 중심 | `POST /api/audit-logs` 서버 저장 |

FastAPI 1차 scaffold의 범위는 서버 실행, CORS, PostgreSQL 연결, 공통 error envelope, `/api/health` 확인이었다.
현재 브랜치는 ETL/Catalog/SQL live endpoint와 Dashboard card/runtime FastAPI endpoint를 함께 포함한다.
FastAPI 공통 schema 기준은 `backend/app/schemas/common.py`에 두며, 각 Pair는 도메인별 schema 파일에서 `CamelModel`, `ErrorResponse`, pagination 관련 schema를 재사용한다.
Demo hydrate endpoint는 live ETL/Catalog API를 가리지 않도록 `/api/demo/etl/jobs`, `/api/demo/catalog/datasets`에 둔다.

## 2. Pair A Live Contract

Pair A 생성 요청은 nested `draftPipeline`을 submit 직전에 flat `CreatePipelineRequest`로 변환한다.

Frontend demo baseline에서는 `VITE_USE_MOCK_API`가 미설정이면 mock mode로 동작한다. 이때 `frontend/src/services/sourceConnectorService.ts`는 backend 호출 없이 source type별 mock `SourceConnectorAnalysis`를 반환해야 한다. `VITE_USE_MOCK_API=false`일 때만 live backend connector를 호출한다.

필수 create payload:

- Source: `sourceType`, `sourceLabel`, `sourceConfig`
- Schema: `schemaColumns`, `schemaSampleRows`, `schemaSummary`, `schemaFingerprint`
- Transform: `transformSteps`, `transformOutputColumns`
- Quality: `qualityRules`, `qualityScore`, `qualityStatus`, `qualityInvalidRows`
- Schedule/Permission/Target: `scheduleLabel`, `retryPolicy`, `owner`, `targetDataset`, `targetLayer`, `targetFormat`

Backend create response:

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

Backend command response:

```ts
type JobCommandResponse = {
  action: string;
  apiPath: string;
  job: JobRowData;
  run: JobRunSummary;
  dagSteps: JobDagStep[];
};
```

## 3. Source Credential Handling

Backend connector 응답은 secret field를 redacted value로 내려준다. 프론트는 응답 metadata, schema, sampleRows는 반영하되 브라우저 세션에 사용자가 입력한 credential 값은 다음 connector 호출을 위해 유지해야 한다.

적용 기준:

- 첫 연결 테스트 성공 후 Schema 단계의 다시 확인이 credential 없이 실패하면 안 된다.
- 샘플 범위 변경 재호출도 같은 credential을 유지해야 한다.
- PR 본문, 로그, 문서에는 실제 credential 값을 쓰지 않는다.

## 4. Spark Run Path

`POST /api/etl/jobs/{jobId}/commands`는 Spark runner를 호출한다.

Spark runner 입력:

- File / S3, Data Lake: object path를 Spark source로 직접 사용
- REST/PostgreSQL/MongoDB 등 connector source: bounded schema sample rows를 JSONL로 기록한 뒤 Spark source로 사용
- connector sample JSONL은 `ASKLAKE_SPARK_REPORT_DIR`에 쓰고 Spark submit/master/worker 모두 `ASKLAKE_SPARK_REPORT_CONTAINER_DIR` 기본값 `/work/reports`로 같은 host directory를 mount해야 한다. worktree가 바뀌면 Spark container는 mount source가 달라지므로 자동 재생성되어야 한다.
- `ASKLAKE_SPARK_TRANSFORM_STEPS`: create payload의 transform steps
- `ASKLAKE_SPARK_QUALITY_RULES`: create payload의 quality rules

Spark runner 결과:

- transformed Parquet output
- output schema
- input/output row count
- quality summary
- run status
- DAG step status

## 5. 검증 명령

Backend:

```powershell
cd backend
npm run verify
npm run verify:fastapi-pair2
npm run verify:sources
npm run verify:spark-run
```

FastAPI Pair2 smoke:

- `npm run verify:fastapi-pair2`는 `orders_clean` demo dataset을 seed한 뒤 별도 포트에서 FastAPI를 띄운다.
- Catalog 목록/상세/lineage, SQL preview, SQL read-only guard, derived dataset 생성, 생성 dataset 재조회, derived lineage를 한 번에 확인한다.
- 기본 포트는 `18084`이며 `ASKLAKE_FASTAPI_SMOKE_PORT`로 바꿀 수 있다.
- 이미 실행 중인 FastAPI를 대상으로 볼 때는 `ASKLAKE_FASTAPI_SMOKE_START_SERVER=false`와 `ASKLAKE_FASTAPI_SMOKE_BASE_URL`을 지정한다.

Frontend:

```powershell
cd frontend
npm run build
```

Browser smoke:

- backend server를 켠다.
- frontend dev server를 켠다.
- 수집/처리 목록이 처음에는 비어 있는지 확인한다.
- 새 수집/처리 생성에서 Source 연결, Schema 확인, Rule 적용, Review, Create를 진행한다.
- 생성된 Job을 실행하고 Run history와 DAG가 Spark 결과를 반영하는지 확인한다.

## 6. 완료 기준

- ETL/Catalog 초기 목록은 서버가 비어 있으면 빈 상태로 표시된다.
- Source/Schema/Create/Run 흐름에서 seed나 fixture job을 사용자 화면에 표시하지 않는다.
- Source credential은 connector 응답의 redacted config로 덮어쓰이지 않는다.
- Transform/Quality는 summary 문자열만이 아니라 실행 가능한 payload로 create request에 들어간다.
- Spark run 후 DAG는 Source, Schema, Spark Source read, Transform, Quality, Parquet write, Catalog update 단계를 표시한다.
- 실패 상태는 실제 실패 단계와 원인을 표시하고, 고정된 fake failed DAG를 보여주지 않는다.

## 7. Catalog/SQL 연결 범위

### Catalog

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| 목록 | live mode에서는 `GET /api/catalog/datasets`, mock mode에서는 fixture 표시 | `GET /api/catalog/datasets` |
| 검색/태그/필터 | 프론트 이벤트 로그 중심 | `GET /api/catalog/datasets?q=&tag=&layer=` |
| 상세 | selectedDataset 표시 | `GET /api/catalog/datasets/{datasetId}` |
| 스키마 | dataset.schema 표시 | 상세 포함 또는 `/schema` |
| 샘플 row | dataset.sampleRows 표시 | 상세 포함 또는 `/sample-rows` |
| 리니지 | `LineageGraph` contract를 React Flow로 렌더링, 없으면 upstream fallback | `GET /api/catalog/datasets/{datasetId}/lineage` |
| SQL로 열기 | SQL 화면 이동 | 없음, datasetId 유지 |

### SQL 분석

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| SQL 점검 | SQL/context 변경 시 frontend가 PostgreSQL parser 기반으로 read-only/select-only, 문법 오류, unknown table을 자동 검사하고 footer compact indicator로 표시. CTE와 comma-separated table도 context 검증 대상에 포함. 테이블 alias는 문법상 허용하되 LIMIT 오타 가능성을 compact warning으로 표시 | backend SQL guard와 query validation response |
| Preview 실행 | 자동 SQL 점검 통과 후 `POST /api/query/runs` 호출. mock mode에서는 fixture result 생성 | `POST /api/query/runs` preview mode |
| Base Dataset 변경 | SQL 화면 내부 base dataset 상태를 바꾸고 query/result를 해당 dataset 기준으로 reset | 없음, `datasetId` 유지 또는 SQL context API |
| 참조 테이블 | SQL 화면 내부에서 여러 참조 dataset id를 선택하고 editor context에 표시 | `POST /api/query/runs` payload에 `baseDatasetId`, `referenceDatasetIds`, `query` 포함 |
| 테이블 검색/자동완성 | 검색 사이드바는 접근 가능한 mock dataset을 보여주고, editor autocomplete는 base/reference context의 table/column과 SQL keyword만 후보로 표시 | `GET /api/catalog/datasets?q=` 또는 권한 필터링된 SQL context API |
| SQL 저장 | 현재 SQL 화면에서는 제외 | `POST /api/query/saved` |
| 결과 Lake 저장 | Preview 성공 후 생성 대상 이름/설명/태그/레이어/RAG 여부를 받아 Catalog Dataset 생성. mock mode에서는 localStorage fallback 유지 | `POST /api/catalog/derived-datasets` |
| CSV 다운로드 | 현재 브라우저에서 실행 결과 CSV를 생성해 다운로드 | `GET /api/query/runs/{runId}/download` |
| 대시보드 생성 | 후속 Pair C handoff에서 재연결 | `POST /api/dashboards` |
| 새 Lake Dataset 저장 | Preview runId/source dataset/query와 dataset metadata를 기반으로 datasets state에 prepend하고 mock mode에서는 `asklake.catalogDatasets`에서 재hydrate하며 SQL 화면 context는 유지 | `POST /api/catalog/derived-datasets` 또는 `POST /api/etl/jobs` |

Mock mode에서는 수집/처리 pipeline 생성 dataset과 SQL derived dataset이 같은 stored catalog dataset fallback(`asklake.catalogDatasets`)을 사용합니다. 기존 `asklake.derivedDatasets`는 읽기 호환만 유지합니다. Live API mode에서는 localStorage fallback을 쓰지 않고 backend catalog persistence와 `GET /api/catalog/datasets` hydrate를 source of truth로 둡니다.

FastAPI Catalog persistence는 `catalog_datasets.payload`를 canonical dataset 계약으로 사용합니다. Spark run 성공으로 생성된 ETL dataset과 SQL derived dataset은 같은 payload shape로 저장하며, payload가 없는 기존 컬럼 기반 row는 목록/상세 조회에서 payload shape로 변환해 읽기 호환만 유지합니다. 두 생성 경로 모두 `size`는 표시용 저장 크기 문자열로 사용하고, 물리 저장 정보는 `storageLocation`, `storageFormat`, `storageSizeBytes`에 둡니다. ETL dataset은 source -> Spark job -> target 기본 `lineageGraph`를 저장하고, SQL derived dataset은 source dataset lineage를 이어받아 source -> derived column edge를 저장합니다.

SQL 실행 백엔드는 반드시 read-only guard를 둬야 합니다. 현재 frontend preflight는 데모 안전장치이며, backend 전환 시 같은 기준을 서버 validation과 query runtime에서 재검증해야 합니다. Preview 실행은 원본 SQL을 바꾸지 않고 서버 쪽에서 row limit을 적용하는 흐름으로 분리해야 합니다. SQL 결과로 만든 derived dataset은 `lineageGraph`에 source dataset lineage와 derived node/column edge를 포함해야 합니다. payload lineage가 없는 기존 row만 `upstream` fallback을 사용합니다. Join builder와 join key recommendation은 이번 범위에서 제외합니다.

Pair2 FastAPI 5단계 완료 기준:

- `npm run verify:fastapi-pair2`가 통과한다.
- live mode frontend는 `VITE_USE_MOCK_API=false`에서 Catalog 목록을 hydrate한다.
- Catalog 상세에서 lineage modal이 `GET /api/catalog/datasets/{datasetId}/lineage` 결과로 열린다.
- SQL Preview 실행은 `POST /api/query/runs`를 호출하고 read-only guard 실패를 toast/audit failure로 처리한다.
- Lake Dataset 생성은 `POST /api/catalog/derived-datasets` 응답 dataset을 Catalog에 반영하고, 재조회 후에도 유지된다.
- 생성 dataset의 `lineageGraph`는 원본 dataset -> derived dataset 관계를 표시한다.

## 8. 대시보드

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| 목록 조회 | DB-backed dashboard card 목록 조회, 검색/소유자/태그/정렬/pagination 서버 처리 | `GET /api/dashboards`, `POST /api/dashboards/query` |
| 새 대시보드 생성 | `draft` 상태 dashboard card를 DB에 먼저 저장하고 조회 화면으로 이동 | `POST /api/dashboards` |
| 목록 삭제 | 확인 후 dashboard와 runtime snapshot 삭제 API 호출 | `DELETE /api/dashboards/{id}` |
| Dashboard title 수정 | dashboard card title 수정 | `PATCH /api/dashboards/{id}` |
| Published 조회 | published revision snapshot을 조회. 없으면 빈 runtime 응답 표시 | `GET /api/dashboards/{id}/published` |
| Draft 조회/생성 | 편집 진입 시 draft revision/page 준비 | `POST /api/dashboards/{id}/draft/ensure` |
| Page 추가 | DB-backed draft page 추가 | `POST /api/dashboards/{id}/draft/pages` |
| Page 이름 수정 | DB-backed draft page title 수정 | `PATCH /api/dashboards/{id}/draft/pages/{pageId}` |
| Page 삭제 | DB-backed draft page와 하위 widgets 삭제 | `DELETE /api/dashboards/{id}/draft/pages/{pageId}` |
| 위젯 추가 | selected dataset과 type별 config로 draft widget 생성 | `POST /api/dashboards/{id}/draft/pages/{pageId}/widgets` |
| 위젯 수정 | draft widget title/type/datasetId/config 수정 | `PATCH /api/dashboards/{id}/draft/widgets/{widgetId}` |
| 위젯 삭제 | draft widget 삭제 | `DELETE /api/dashboards/{id}/draft/widgets/{widgetId}` |
| Layout 저장 | drag/resize 종료 시 layout batch 저장 | `PATCH /api/dashboards/{id}/draft/layouts` |
| Publish | 현재 draft revision을 published revision으로 복사 | `POST /api/dashboards/{id}/publish` |
| Share | 프론트에서 runtime 링크 복사 feedback 표시 | 별도 share API는 현재 없음 |
| 내보내기 | local snapshot JSON 다운로드와 감사 로그 기록 | `GET /api/dashboards/{id}/export` |
| 전체화면/차트 확대 | 프론트 모달 표시 | 백엔드 불필요 |

프론트 dashboard adapter는 FastAPI가 404를 반환하는 이전 backend에서도 화면을 깨지 않도록 local/mock fallback을 유지한다. 현재 병합 기준에서는 FastAPI dashboard endpoint가 우선 source of truth다.

Dataset 기반 widget 생성 API는 `metric`, `table`, `bar_chart`, `line_chart`, `donut_chart` runtime type만 받는다. Backend save/read response는 `frontend/src/types/dashboard.ts`의 type별 config 계약을 보존해야 한다. `datasetId`가 있고 명시적 `data`가 없으면 catalog dataset의 rows 또는 sample rows를 column name 기반 object row로 변환해 widget `data` snapshot에 저장한다.

현재 FastAPI live smoke에서는 실제 Catalog persistence가 아직 완성되지 않았기 때문에 `backend/app/services/demo_catalog.py`가 임시 dataset 공급처 역할을 한다. Dashboard runtime service는 `datasetId -> widget.data snapshot` 흐름만 소유하고, demo catalog의 구체 데이터 구조는 해당 파일 안에 가둔다. 이후 실제 Catalog/SQL Result API가 준비되면 `get_demo_dataset()` 호출부를 실제 dataset/query result service 호출로 교체하고, `dataset_rows_to_widget_data()`와 같은 row snapshot 변환 경계는 유지한다.

Runtime table 보강 코드는 Alembic migration 도입 전까지 로컬 PostgreSQL smoke를 막지 않기 위한 임시 안전장치다. `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets`에 `created_at`, `updated_at`, JSON snapshot 컬럼이 빠져 있으면 repository에서 `ADD COLUMN IF NOT EXISTS`로 보강하지만, 장기 운영 기준의 source of truth는 후속 Alembic migration으로 옮겨야 한다.

Dashboard FastAPI 구현은 아래 순서와 파일 경계로 유지한다.

1. Dashboard 계약/schema skeleton 정리: `backend/app/schemas/dashboard.py`
2. Card/List API: 목록, 검색/필터/정렬, 생성, 제목 수정, 삭제
3. Runtime 조회 API: published 조회, draft ensure
4. Draft page API: page 추가/이름 수정/삭제
5. Draft widget/layout/publish API: widget 생성/수정/삭제, layout 저장, publish
6. Frontend adapter E2E: `frontend/src/services/dashboardApi.ts`, `frontend/src/services/dashboardRuntimeApi.ts`

Card/List API는 `dashboards`, `dashboard_tags`를 우선 소유한다.
Runtime API는 `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets`를 우선 소유한다.
두 흐름은 `dashboardId`와 `publishedRevisionId`만 공유하고, published 화면은 draft revision을 직접 읽지 않는다.
Dashboard 삭제 API는 card/list row 삭제와 함께 runtime revision/page/widget snapshot도 삭제한다.
구현 기록과 Card/List merge 시 확인할 접점은 `docs/dashboard-runtime-api-implementation.md`를 따른다.

## 9. 아직 실제 저장되지 않는 기능

아래 기능은 현재 UI 반응과 감사 로그만 있고, 서버 저장은 없습니다.

| 영역 | 기능 |
| --- | --- |
| 수집/처리 | 삭제, 상세 수정 저장, 필터 조건 저장 |
| 생성 플로우 | Source 중간 테스트 결과, Schema 승인, Rule 추가/검증 |
| 카탈로그 | 저장소 보관, 태그/필터 서버 검색 |
| SQL | 쿼리 저장, CSV 다운로드 |
| 대시보드 | 권한 기반 공유, 내보내기 API, 장기 운영용 권한/감사 로그 |
| 공통 | 감사 로그 서버 저장, 사용자 인증/권한 |

## 10. 백엔드 팀에 넘길 최소 구현 범위

최소 데모 연동만 목표라면 아래 5개면 충분합니다.

1. `POST /api/etl/jobs`
2. `POST /api/etl/jobs/{jobId}/commands`
3. `GET /api/etl/jobs`
4. `GET /api/catalog/datasets`
5. `POST /api/query/runs`

대시보드 실제 저장 API는 현재 병합 기준에서 추가되어 있으며 아래 endpoint를 유지합니다.

1. `GET /api/dashboards`
2. `POST /api/dashboards/query`
3. `POST /api/dashboards`
4. `PATCH /api/dashboards/{dashboardId}`
5. `DELETE /api/dashboards/{dashboardId}`
6. `GET /api/dashboards/{dashboardId}/published`
7. `POST /api/dashboards/{dashboardId}/draft/ensure`
8. `POST /api/dashboards/{dashboardId}/draft/pages`
9. `PATCH /api/dashboards/{dashboardId}/draft/pages/{pageId}`
10. `DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`
11. `POST /api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets`
12. `PATCH /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`
13. `DELETE /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`
14. `PATCH /api/dashboards/{dashboardId}/draft/layouts`
15. `POST /api/dashboards/{dashboardId}/publish`

## 11. 프론트에서 다음에 할 작업

백엔드 API가 준비되기 전 프론트에서 미리 할 수 있는 작업입니다.

| 순서 | 작업 | 파일 |
| --- | --- | --- |
| 1 | `getJobs`, `getDatasets`, `getDatasetLineageGraph` API adapter 추가 | `frontend/src/services/mockApi.ts` |
| 2 | 초기 hydrate loading/error 상태 추가 | `frontend/src/hooks/useAskLakeData.ts` |
| 3 | dashboard list/runtime adapter와 FastAPI fallback 경로 확인 | `frontend/src/services/mockApi.ts`, `frontend/src/services/dashboardApi.ts`, `frontend/src/services/dashboardRuntimeApi.ts` |
| 4 | audit log 서버 저장 옵션 추가 | `frontend/src/hooks/useAuditLogs.ts` |
| 5 | 삭제/저장/게시 실패 시 rollback 처리 | `frontend/src/hooks/useAskLakeData.ts`, dashboard page |

## 12. 인수 기준

백엔드 연결이 끝났다고 판단하려면 아래를 통과해야 합니다.

- `.env`에서 `VITE_USE_MOCK_API=false`로 실행해도 앱이 정상 로딩됩니다.
- 새 수집/처리 생성 후 목록과 카탈로그에 서버 응답 데이터가 표시됩니다.
- 즉시 실행/재실행/일시정지/취소 버튼이 서버 상태 전이를 반영합니다.
- SQL 실행 결과가 서버 응답 columns/rows 그대로 표시됩니다.
- SQL 결과에서 대시보드 생성 시 같은 `runId`가 dashboard request에 포함됩니다.
- 새로고침 후에도 저장된 대시보드/작업/데이터셋이 유지됩니다.
- 실패 응답은 토스트와 감사 로그에 남습니다.
- 콘솔에 React key/layout 관련 error가 없어야 합니다.

## 13. 남은 작업

- Kafka message payload schema sampling
- Parquet physical schema inference endpoint
- ETL job/dataset/run persistence
- 삭제/수정 API persistence
- SQL engine read-only guard 고도화
- Dashboard 권한/공유/export API
- Audit log server persistence
