# 02 Day별 마일스톤

## DAY1-A-ETL-CREATE. 새 Job/Dataset 생성 연결

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 사용자 관점 결과물 | Review에서 `파이프라인 생성`을 누르면 ETL 목록에 새 Job이 보이고 Catalog에 새 Dataset이 보인다. |
| 구현해야 하는 코드 결과물 | `createPipelineDraft` adapter 정리, `jobs/datasets` prepend, `selectedJob/selectedDataset` 갱신, 중복 클릭 방지, 실패 Toast와 rollback |
| 연결 API / Mock | `POST /api/etl/jobs` 또는 `createPipelineDraft(draftPipeline, jobCount)` |
| 성공 기준 | 생성 후 앱이 멈추지 않고 새 Job/Dataset이 보인다. 실패 시 입력값이 유지된다. |
| Fallback | API가 준비되지 않으면 mock 생성 응답을 사용한다. |

## DAY1-B-CATALOG-LINEAGE-BASIC. Catalog 상세와 기본 Lineage 표시

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair B - Catalog, Lineage & SQL Analysis |
| 사용자 관점 결과물 | Catalog에서 Dataset을 클릭하면 상세 화면에 schema와 upstream -> current -> downstream lineage가 보인다. |
| 구현해야 하는 코드 결과물 | Catalog detail mapper, schema table, lineage node/edge mapper, empty/error/fallback 상태 |
| 연결 API / Mock | `GET /api/catalog/datasets`, `GET /api/catalog/datasets/{datasetId}` 또는 mock Dataset의 `upstream/downstream` |
| 성공 기준 | Lineage 중심 노드가 선택 Dataset이고, Dataset을 바꾸면 lineage도 바뀐다. |
| Fallback | Lineage API가 없으면 mock Dataset의 `upstream/downstream` 배열로 단계형 lineage를 표시한다. |

## DAY1-C-DASHBOARD-ENTRY. Dashboard 목록과 Builder 진입 안정화

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair C - Dashboard Builder & Publish |
| 사용자 관점 결과물 | Dashboard 메뉴를 열면 목록 또는 empty state가 보이고, Builder 진입 화면이 깨지지 않는다. |
| 구현해야 하는 코드 결과물 | Dashboard list state, empty state, Builder shell, local draft 초기값 |
| 연결 API / Mock | local Dashboard state, optional `GET/POST /api/dashboards` mock |
| 성공 기준 | SQL Result가 없어도 Dashboard 화면이 안전하게 열린다. |
| Fallback | Dashboard API가 없으면 local state로 목록과 draft를 유지한다. |

### Day 1 종료 데모 상태

- Review 생성 후 ETL 목록 최상단에 새 Job이 보인다.
- Catalog 최상단에 새 Dataset이 보인다.
- Dataset 상세에 schema와 기본 lineage가 보인다.
- Dashboard 목록/Builder 진입 화면이 깨지지 않는다.

## DAY2-A-ETL-RUN-DAG. Job 실행 상태를 이력/DAG까지 연결

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 사용자 관점 결과물 | ETL 목록에서 `즉시 실행`을 누르면 목록/상세/실행 이력/DAG에 같은 Run 상태가 보인다. |
| 구현해야 하는 코드 결과물 | `runsByJobId`, `selectedRun`, `dagByRunId`, command response mapper, 실행 실패 rollback |
| 연결 API / Mock | `POST /api/etl/jobs/{jobId}/commands`, optional runs/DAG API, `runJobCommand(job, command)` |
| 성공 기준 | `실행 중`, 현재 단계, `Run ID`가 같은 Job 기준으로 보인다. |
| Fallback | runs/DAG API가 없으면 command 응답 fixture로 local Run/DAG를 만든다. |

## DAY2-B-CATALOG-SQL-CONTEXT. Catalog Dataset을 SQL context로 연결

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair B - Catalog, Lineage & SQL Analysis |
| 사용자 관점 결과물 | Catalog에서 Dataset을 열고 `쿼리 편집기에서 열기`를 누르면 SQL 화면에 Dataset 이름, schema, 기본 SELECT query가 채워진다. |
| 구현해야 하는 코드 결과물 | `selectedDataset` 전달, SQL default query 재계산, Dataset 변경 시 이전 SQL result reset, Lineage 선택 상태 유지 |
| 연결 API / Mock | `Dataset -> selectedDataset -> SQL context`, mock Dataset |
| 성공 기준 | SQL의 `FROM`이 선택 Dataset 이름과 일치하고, 이전 Dataset 결과가 남지 않는다. |
| Fallback | Catalog API 실패 시 기존 mock Dataset과 mock lineage를 유지한다. |

## DAY2-C-SQL-DASH-TABLE. SQL Result를 Dashboard Table Widget으로 연결

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair C - Dashboard Builder & Publish |
| 사용자 관점 결과물 | SQL 실행 후 `대시보드 만들기`를 누르면 Dashboard Builder에 `SQL 결과 테이블` Widget 1개가 생긴다. |
| 구현해야 하는 코드 결과물 | `SqlResult -> DashboardRecord` mapper, Table Widget 생성, Builder pending/error state |
| 연결 API / Mock | `SqlResult`, optional `POST /api/dashboards`, local Dashboard draft |
| 성공 기준 | Dashboard에 `Run ID`, Dataset 이름, SQL 결과 columns/rows가 보인다. |
| Fallback | Dashboard API가 없으면 local draft state로 Table Widget을 유지한다. |

### Day 2 종료 데모 상태

- Job을 실행하면 같은 Run ID가 목록/상세/이력/DAG에 보인다.
- Catalog에서 선택한 Dataset이 SQL 화면에 그대로 이어진다.
- SQL 결과가 Dashboard Table Widget으로 넘어간다.

## DAY3-A-ETL-HARDENING. ETL 실패/반복 상황 정리

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 사용자 관점 결과물 | 생성/실행 중 중복 클릭, 500/422/timeout을 만나도 입력값과 이전 Job 상태가 유지되고 Toast가 보인다. |
| 구현해야 하는 코드 결과물 | duplicate submit guard, rollback state, error envelope mapper, timeout/500/422 fixture |
| 연결 API / Mock | Job API, `ErrorResponse`, `createPipelineDraft`, `runJobCommand` |
| 성공 기준 | 실패 케이스 후에도 다시 정상 생성/실행 데모를 할 수 있다. |
| Fallback | live 응답이 불안정하면 mock 응답으로 같은 화면 흐름을 유지한다. |

## DAY3-B-SQL-LINEAGE-INTERACTION. SQL 실행과 Lineage 상호작용 보강

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair B - Catalog, Lineage & SQL Analysis |
| 사용자 관점 결과물 | SQL 화면에서 SELECT를 실행하면 Result Preview가 바뀌고, Catalog Lineage 노드를 선택하면 해당 Dataset 기준 상세가 갱신된다. |
| 구현해야 하는 코드 결과물 | `SqlResult` 우선 렌더링, read-only guard, SQL 실패 Toast, Lineage node selected state, node click handler |
| 연결 API / Mock | `POST /api/query/runs`, `executeQueryDraft(dataset, query)`, Lineage fixture |
| 성공 기준 | `SELECT`/`WITH`만 통과하고 변경성 SQL은 차단된다. Lineage 노드 선택 시 현재 Dataset 표시가 바뀐다. |
| Fallback | SQL API 실패 시 Dataset `sampleRows`를 결과로 표시한다. |

## DAY3-C-DASHBOARD-WIDGET-EDIT. Widget 제목 수정/삭제/추가

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair C - Dashboard Builder & Publish |
| 사용자 관점 결과물 | Dashboard Builder에서 Widget 제목을 수정하고, Widget을 삭제하고, KPI 또는 Chart Widget을 1개 추가할 수 있다. |
| 구현해야 하는 코드 결과물 | Widget edit state, delete action, add widget action, local draft reducer, dirty/saved 표시 |
| 연결 API / Mock | local Dashboard draft, optional `PATCH /api/dashboards/{dashboardId}` |
| 성공 기준 | 제목 수정/삭제/추가가 화면에 즉시 반영되고 새로고침 전까지 유지된다. |
| Fallback | Chart가 늦으면 KPI Widget 1개와 Table Widget 편집만 완성한다. |

### Day 3 종료 데모 상태

- 실패 상황 후 ETL 흐름이 복구된다.
- SQL Result가 응답 데이터 기준으로 표시된다.
- Lineage 노드 선택이 Dataset 상세와 연결된다.
- Dashboard Builder에서 Widget 편집이 된다.

## DAY4-A-ETL-FINAL-QA. ETL 최종 흐름 QA

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 사용자 관점 결과물 | Source -> Review -> 생성 -> 목록 -> 실행 -> 이력/DAG 흐름을 반복해도 상태가 꼬이지 않는다. |
| 구현해야 하는 코드 결과물 | final ETL QA checklist, selectedJob 보정, Run 상태 reset, 실패 fixture 확인 |
| 연결 API / Mock | Job 생성/실행 API 또는 mock adapter |
| 성공 기준 | 같은 흐름을 2회 반복해도 Job/Run 상태가 올바르다. |
| Fallback | 문제가 있는 Job은 demo fixture Job으로 고정한다. |

## DAY4-B-CATALOG-LINEAGE-SQL-QA. Catalog/Lineage/SQL 반복 이동 QA

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair B - Catalog, Lineage & SQL Analysis |
| 사용자 관점 결과물 | Dataset A/B를 번갈아 열어도 schema, lineage, SQL query, SQL result가 현재 Dataset 기준으로 맞게 바뀐다. |
| 구현해야 하는 코드 결과물 | selectedDataset reset rule, SQL result reset, Lineage selected node reset, empty/error state polish |
| 연결 API / Mock | `Dataset -> Lineage -> SqlResult`, `ErrorResponse`, fallback Dataset fixture |
| 성공 기준 | 이전 Dataset의 schema/lineage/result가 남지 않는다. |
| Fallback | 문제가 있는 Dataset은 demo fixture Dataset으로 고정하고 known issues에 남긴다. |

## DAY4-C-DASHBOARD-SAVE-PUBLISH. Dashboard 저장/Publish 완성

| 항목 | 내용 |
|---|---|
| 담당 Pair | Pair C - Dashboard Builder & Publish |
| 사용자 관점 결과물 | Dashboard를 저장하면 목록에 카드가 생기고, Publish를 누르면 Published 화면에서 같은 Widget 구성을 확인할 수 있다. |
| 구현해야 하는 코드 결과물 | save adapter, localStorage fallback, publish action, published snapshot, saved/published 상태 배지 |
| 연결 API / Mock | `POST /api/dashboards`, `PATCH /api/dashboards/{dashboardId}`, `POST /api/dashboards/{dashboardId}/publish`, localStorage |
| 성공 기준 | 저장 후 목록에 남고, Publish 후 Published 화면에 같은 Widget이 보인다. |
| Fallback | API가 없으면 localStorage snapshot으로 목록/게시 상태를 유지한다. |

### Day 4 종료 데모 상태

- Source -> ETL -> Catalog -> Lineage -> SQL -> Dashboard -> Publish 흐름이 통과한다.
- 실패 fixture 후 정상 흐름으로 복구된다.
- Dashboard 저장/목록/Published 화면이 같은 데이터와 Widget 구성을 보여준다.
