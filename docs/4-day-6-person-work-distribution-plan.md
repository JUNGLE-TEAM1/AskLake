# AskLake/XFLOW 4일 6인 E2E 작업 분배안

> 기준: 기능 명세서 묶음과 현재 프론트엔드 구현 상태를 바탕으로, 6명이 2명씩 3개 Pair로 나뉘어 4일 동안 구현할 수 있는 현실적인 작업 분배안을 정리한다.
>
> 이번 계획의 최우선 목표는 데이터 크기 검증이 아니라, 작은 샘플 데이터라도 `Source -> ETL -> Catalog -> SQL -> Dashboard` 흐름이 브라우저에서 끝까지 끊기지 않는 것이다.

## 8-1. 전체 분업 원칙

### 왜 3개 덩어리로 나누는가

4일 MVP에서 가장 위험한 지점은 화면 자체가 아니라 화면 사이의 handoff다. 그래서 Pair를 기능명 기준이 아니라 데이터가 다음 화면으로 넘어가는 경계 기준으로 나눈다.

| 덩어리 | 책임지는 흐름 | 나누는 이유 |
| --- | --- | --- |
| Pair A - ETL Creation & Job Operations | `DraftPipeline -> Job -> Run -> Dataset` | Source부터 Review까지 입력한 설정이 실제 Job, 실행 상태, 생성 Dataset으로 이어지는 첫 관문이다. |
| Pair B - Catalog & SQL Analysis | `Dataset -> SQL Context -> SQL Result` | Pair A가 만든 Dataset을 사용자가 찾고, 선택하고, 읽기 전용 SQL 결과로 바꾸는 중간 관문이다. |
| Pair C - Dashboard & Integration | `SQL Result -> Dashboard -> Widget -> Published View` | SQL 결과가 최종 사용자 가치인 대시보드 위젯과 게시 화면으로 끝까지 보이는 마지막 관문이다. |

### 화면 / 데이터 흐름 / API 기준 균형

| 기준 | 판단 |
| --- | --- |
| 화면 기준 | Pair A는 ETL 생성 wizard와 Job 목록/상세/이력/DAG, Pair B는 Catalog/SQL, Pair C는 Dashboard 목록/Builder/Published를 맡아 화면 소유가 겹치지 않는다. |
| 데이터 흐름 기준 | `jobId`, `runId`, `datasetId`, `sqlResult.runId`, `dashboardId`, `widget.sourceRunId`가 앞 화면에서 뒤 화면으로 이어진다. |
| API 기준 | P0 API는 Pair A/B가 만들고 소비하며, Pair C는 Dashboard API와 mock/live fallback, 최종 통합 QA를 함께 책임진다. |

### 4일 안에 반드시 살릴 메인 데모 플로우

```text
Source / Schema / Rule / Schedule / Permission / Target / Review 설정
-> ETL Job 생성
-> ETL 목록에 생성된 Job 표시
-> Job 즉시 실행 또는 재실행
-> 실행 상태가 목록 / 상세 / 실행 이력 / DAG에 반영
-> 생성된 Dataset이 Catalog에 표시
-> Catalog에서 Dataset 선택
-> SQL 화면에서 Dataset 기반 read-only SQL 실행
-> SQL 결과를 Dashboard Builder로 전달
-> Dashboard에 최소 1개 Table Widget 표시
-> Dashboard 저장 / Publish
```

### 현재 프론트엔드 구현 활용 방식

현재 프론트엔드는 URL router 중심이 아니라 [App.tsx](/Users/sisu/Documents/AskLake/frontend/src/App.tsx:1)의 `activeFlow`로 화면을 전환한다. 따라서 명세상 Route와 현재 FlowId를 함께 보고 작업한다.

| 현재 구현 | 이번 계획의 활용 방식 |
| --- | --- |
| `useAskLakeData`가 `jobs`, `datasets`, `draftPipeline`, `selectedJob`, `selectedDataset`, `sqlResultDraft`를 들고 있다. | 새 전역 상태를 크게 만들지 말고 기존 state handoff를 안정화한다. |
| `createPipelineDraft`가 mock/live 전환 형태로 `POST /api/etl/jobs`를 호출할 수 있다. | 응답 shape를 `{ job, dataset }`으로 고정하고 생성 결과를 ETL 목록과 Catalog에 동시에 반영한다. |
| `runJobCommand`가 Job 상태를 `실행 중`, `일시정지`, `취소됨`으로 바꾼다. | 여기에 최소 `Run`/`runId`/단계 정보를 붙여 목록, 상세, 이력, DAG가 같은 실행을 보게 한다. |
| Catalog에서 `쿼리 편집기에서 열기`를 누르면 `selectedDataset`으로 SQL 화면에 간다. | SQL default query, schema chip, result reset을 Dataset 기준으로 안정화한다. |
| SQL에서 `executeQueryDraft`로 `SqlResultDraft`를 만들 수 있다. | read-only guard와 Dashboard handoff의 공식 계약으로 쓴다. |
| Dashboard는 SQL Result 기반 Builder 진입과 localStorage 저장 흐름이 있다. | Dashboard API가 늦어도 localStorage snapshot으로 저장/Publish 데모를 끊기지 않게 한다. |

### 데이터 크기보다 E2E flow를 우선하는 이유

이번 4일은 플랫폼의 “큰 데이터 처리 능력”을 증명하는 시간이 아니라 “데이터 플랫폼처럼 보이는 핵심 제품 흐름”을 증명하는 시간이다. 10MB, 50MB, 100MB 샘플이어도 같은 `jobId`, `runId`, `datasetId`, `sqlResult.runId`, `dashboardId`가 화면 사이에서 이어지면 발표 가치가 생긴다. 처리량 검증은 Nice to have로 내리고, 먼저 클릭 가능한 단일 데모 경로를 매일 merge 후 살린다.

## 8-2. 3개 페어 분업안

| Pair | 담당 영역 | 담당 명세서 | 최종 책임 결과물 | 다른 Pair와의 연결점 | 기술 검증 책임 | 위험도 |
| --- | --- | --- | --- | --- | --- | --- |
| Pair A - ETL Creation & Job Operations | Source / Schema / Rule / Schedule / Permission / Target / Review, Job 생성, Job 목록, 즉시 실행/재실행/일시정지/취소, 상세/실행 이력/DAG | Source Connection, page-01~05 Schema/Rule/Quality, ETL 스케줄링 3종, ETL 권한설정, ETL 타겟설정, ETL 검토및생성, ETL 목록/상세/이력/DAG | Review에서 생성 버튼을 누르면 ETL 목록에 새 Job이 생기고, 실행 버튼을 누르면 목록/상세/이력/DAG에서 같은 Run ID와 단계 상태가 보인다. | Pair B에 `Dataset`과 `datasetId`를 넘긴다. Pair C에는 `runId`와 실행 요약을 넘긴다. | `POST /api/etl/jobs`, `POST /api/etl/jobs/{jobId}/commands`, `Job`, `Run`, `RunResultSummary`, fallback mock 동작 여부 | 높음 |
| Pair B - Catalog & SQL Analysis | Dataset 목록/상세/Schema/Lineage, Catalog에서 SQL로 열기, Dataset-scoped SQL, read-only guard, SQL Result 생성, Dashboard handoff 직전 상태 | Data Catalog/Lineage, Dataset-Scoped SQL 실행 | Catalog에서 선택한 Dataset이 SQL context가 되고, SQL 실행 후 `SqlResult`가 생성되어 Dashboard 버튼으로 넘겨진다. | Pair A의 `Dataset`을 소비한다. Pair C에 `SqlResult`를 넘긴다. | `GET /api/catalog/datasets`, `GET /api/catalog/datasets/{datasetId}`, `POST /api/query/runs`, read-only 차단 로그, selectedDataset consistency | 중 |
| Pair C - Dashboard & Integration | Dashboard 목록/Builder, SQL 결과 기반 Widget, Widget 설정/삭제, 저장/Publish, Share/Permission 최소 mock, 전체 데모 QA | Dashboard Core, Widget/Data, Published/Permission | SQL Result로 Dashboard Builder에 Table Widget이 생성되고, 저장/Publish 후 Published 화면에서 같은 위젯이 보인다. 최종 runbook으로 전체 flow를 5분 안에 재현한다. | Pair B의 `SqlResult`를 소비한다. Pair A/B와 공통 타입, fixture, fallback switch를 매일 맞춘다. | `POST /api/dashboards`, `PATCH /api/dashboards/{dashboardId}`, `POST /api/dashboards/{dashboardId}/publish`, localStorage fallback, console error 없음 | 중상 |

## 8-3. 4일 마일스톤 계획

| Day | Milestone ID | Pair | 사용자 관점 결과물 | 기술 검증 결과물 | 대상 화면/Route | 클릭 시나리오 | 코드 산출물 | API/State 연결 | 샘플 데이터 | 완료 판정 기준 | Fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Day 1 | DAY1-A-REVIEW-CREATE | Pair A | 사용자가 Review 화면에서 `파이프라인 생성`을 수행하면, Job/Dataset 생성 state 변경이 일어나고, ETL 목록과 Catalog에서 새 항목을 확인할 수 있다. | create request/response, `jobId`, `datasetId`, `selectedJob`, `selectedDataset`, fallback 사용 여부, console error 없음 | `/etl/review`, `/etl/jobs`, `/catalog`; FlowId `review`, `jobs`, `catalog` | Source -> Schema -> Rule -> Schedule -> Permission -> Target -> Review -> 생성 -> ETL 목록 -> Catalog | `createPipelineDraft` response mapper, 중복 클릭 방지, Job/Dataset prepend, Toast/error state | `POST /api/etl/jobs`, `DraftPipeline -> { job, dataset }` | 10MB CSV fixture 또는 mock sampleRows | 생성 직후 Job 이름과 Dataset 이름이 화면에 보이고 앱이 죽지 않는다. | API 미준비 시 `mockApi.createPipelineDraft` 사용 |
| Day 1 | DAY1-B-CATALOG-SQL-CONTEXT | Pair B | 사용자가 Catalog에서 Dataset을 선택하고 `쿼리 편집기에서 열기`를 수행하면, `selectedDataset`이 바뀌고 SQL 화면에서 Dataset 이름, schema, 기본 query를 확인할 수 있다. | `selectedDataset.id`, SQL default query, schema chip, Catalog fallback log, console error 없음 | `/catalog`, `/catalog?dataset_id=...`, `/analyze/sql`; FlowId `catalog`, `catalogDetail`, `sql` | Catalog -> Dataset 카드 선택 -> 쿼리 편집기에서 열기 -> SQL context 확인 | Catalog response mapper, loading/error/fallback 상태, SQL query reset | `GET /api/catalog/datasets`, `GET /api/catalog/datasets/{datasetId}`, `selectedDataset` | 10MB sampleRows | SQL `FROM`이 선택 Dataset 이름과 일치한다. | Catalog API 실패 시 기존 `catalogDatasets` 사용 |
| Day 1 | DAY1-C-DASHBOARD-SEED | Pair C | 사용자가 Dashboard 메뉴 또는 SQL fixture에서 Builder를 열면, Dashboard draft state가 생성되고, Builder에서 Table Widget 1개를 확인할 수 있다. | `dashboardId`, widget count, `sourceRunId` fixture, localStorage key, console error 없음 | `/dashboards`, `/dashboards/{dashboardId}`; FlowId `dashboard` | Dashboard -> 대시보드 만들기 -> SQL 결과 fixture 선택 -> Table Widget 확인 | Dashboard fixture, Widget source mapping, localStorage fallback 기준 | `SqlResult fixture -> Dashboard -> Widget` | 10MB SQL result fixture | Builder에 `SQL 결과 테이블` 위젯이 보인다. | Pair B SQL handoff가 늦으면 fixture로 Builder 먼저 완성 |
| Day 2 | DAY2-A-RUN-STATUS-DAG | Pair A | 사용자가 ETL 목록에서 `즉시 실행`을 수행하면, Run state 변경이 일어나고, 목록/상세/실행 이력/DAG에서 같은 Run ID와 현재 단계를 확인할 수 있다. | command response, `runId`, `jobId`, 단계명, `RunResultSummary`, audit log, console error 없음 | `/etl/jobs`, `/etl/jobs/{jobId}`, `/etl/jobs/{jobId}/runs`, `/etl/jobs/{jobId}/dag`; FlowId `jobs`, `jobDetail`, `jobRuns`, `jobDag` | ETL 목록 -> 즉시 실행 -> 상세 -> 실행 이력 -> DAG | `runsByJobId`, `selectedRun`, DAG step state, command rollback | `POST /api/etl/jobs/{jobId}/commands`, `Run`, `DagStep` | 50MB CSV fixture | 같은 Run ID가 Job 카드, 실행 이력, DAG에 보인다. | command API 없으면 command 응답 fixture로 local Run 생성 |
| Day 2 | DAY2-B-SQL-READONLY-RUN | Pair B | 사용자가 SQL 화면에서 `실행`을 수행하면, query run state 변경이 일어나고, Result Preview에서 rows/columns와 Run ID를 확인할 수 있다. | `SqlResult.runId`, `datasetId`, columns/rows, read-only guard 차단 로그, console error 없음 | `/analyze/sql`; FlowId `sql` | SELECT 실행 -> Result Preview 확인 -> UPDATE 입력 -> 실행 차단 확인 | read-only guard, query pending/error/success state, result reset | `POST /api/query/runs`, `Dataset -> SqlResult` | 50MB sampleRows 또는 fixture result | SELECT/WITH는 실행되고 INSERT/UPDATE/DELETE/DROP/ALTER/CREATE는 차단된다. | SQL API 실패 시 Dataset `sampleRows`로 Result 생성 |
| Day 2 | DAY2-C-SQL-TO-DASHBOARD | Pair C | 사용자가 SQL 결과 화면에서 `대시보드 만들기`를 수행하면, Dashboard handoff state가 생기고, Builder에서 SQL 결과 기반 Table Widget을 확인할 수 있다. | `SqlResult.runId`, `Dashboard.id`, `Widget.id`, `sourceRunId`, widget count, console error 없음 | `/analyze/sql`, `/dashboards/{dashboardId}`; FlowId `sql`, `dashboard` | SQL 실행 -> 대시보드 만들기 -> Builder -> Table Widget 확인 | `SqlResult -> DashboardRecord` mapper, Widget 생성, pending/error state | `SqlResult`, optional `POST /api/dashboards` | 50MB SQL result fixture | Widget의 행/컬럼이 SQL Result와 일치한다. | Dashboard API 없으면 local state/localStorage 저장 |
| Day 3 | DAY3-A-RUN-COMPLETE-CATALOG | Pair A | 사용자가 실행 중 Job을 완료 상태로 확인하면, Run 완료 state와 Dataset 갱신이 일어나고, Catalog에서 같은 Dataset의 row/size/freshness가 바뀐 것을 확인할 수 있다. | `runId`, `datasetId`, `status: success`, `inputRows`, `outputRows`, `outputSizeLabel`, dataset patch log | `/etl/jobs/{jobId}/runs`, `/catalog`; FlowId `jobRuns`, `catalog` | 실행 이력 -> 완료 Run 확인 -> Catalog 이동 -> Dataset 지표 확인 | Run complete mapper, Dataset patch, success/failed state | `RunResultSummary -> Dataset` | 100MB CSV fixture 또는 작은 JSONL fixture | Run 완료 후 Catalog의 Dataset `lastUpdated`, `rows`, `size`가 갱신된다. | 실제 완료 API 없으면 success fixture로 Dataset patch |
| Day 3 | DAY3-B-CATALOG-SQL-STABILITY | Pair B | 사용자가 Catalog에서 Dataset A/B를 번갈아 SQL로 열면, Dataset state reset이 일어나고, SQL 화면에서 이전 Dataset query/result가 남지 않는 것을 확인할 수 있다. | `selectedDataset.id`, `SqlResult.datasetId`, result reset log, read-only guard, console error 없음 | `/catalog`, `/analyze/sql`; FlowId `catalog`, `catalogDetail`, `sql` | Dataset A SQL -> Dataset B SQL -> SELECT 실행 -> 결과 비교 | selectedDataset reset, SqlResult reset, empty/loading/error polish | `Dataset -> SQL Context -> SqlResult` | 100MB fixture + 10MB fixture | 화면의 Dataset 이름, schema, query, result가 항상 같은 Dataset 기준이다. | 문제가 생기는 Dataset은 demo fixture Dataset으로 고정 |
| Day 3 | DAY3-C-DASHBOARD-SAVE-PUBLISH | Pair C | 사용자가 Dashboard Builder에서 `저장`과 `Publish`를 수행하면, Dashboard state 저장이 일어나고, 목록과 Published 화면에서 같은 위젯을 확인할 수 있다. | `dashboardId`, `status: Draft/Published`, widget count, localStorage/API response, publish audit log | `/dashboards`, `/dashboards/{dashboardId}`, `/dashboards/{dashboardId}/published`; FlowId `dashboard` | Builder -> 저장 -> 목록 -> 다시 열기 -> Publish -> Published 확인 | save/publish adapter, localStorage snapshot, published view state | `POST /api/dashboards`, `PATCH /api/dashboards/{dashboardId}`, `POST /api/dashboards/{dashboardId}/publish` | 100MB SQL result fixture | 저장 후 목록에 남고, Publish 후 Published view에서 같은 Widget이 보인다. | API 실패 시 localStorage snapshot 사용 |
| Day 4 | DAY4-A-ETL-HARDENING | Pair A | 사용자가 생성/실행 중 실패 응답이나 중복 클릭을 만나면, Error state와 rollback이 일어나고, 입력값과 이전 Job 상태가 유지되는 것을 확인할 수 있다. | 422/500/timeout fixture, duplicate guard, rollback state, fallback 여부, console error 없음 | ETL 전체; FlowId `source`~`review`, `jobs`, `jobDetail`, `jobRuns`, `jobDag` | 생성 중복 클릭 -> 실패 Toast -> 재시도 -> 실행 실패 -> 이전 상태 확인 | error envelope mapper, duplicate submit guard, rollback, final ETL smoke | P0 ETL API, `ErrorResponse` | 10MB/50MB fixture | 실패 후 앱이 죽지 않고 다시 정상 flow를 실행할 수 있다. | 발표 전 live 불안정 시 mock mode 고정 |
| Day 4 | DAY4-B-CATALOG-SQL-QA | Pair B | 사용자가 Catalog -> SQL -> Dashboard handoff를 반복하면, Dataset/SqlResult state 검증이 일어나고, 같은 Dataset 기반 결과가 유지되는 것을 확인할 수 있다. | consistency checklist, `SqlResult.runId`, read-only guard evidence, fallback 사용 여부, console error 없음 | `/catalog`, `/analyze/sql`, `/dashboards`; FlowId `catalog`, `sql`, `dashboard` | Dataset 선택 -> SQL 실행 -> Dashboard 만들기 -> 다른 Dataset으로 반복 | Catalog/SQL mapper final fix, query/result reset, empty/error state | `Dataset`, `SqlResult`, `ErrorResponse` | 100MB fixture | 3회 반복해도 Dataset 이름/schema/query/result가 꼬이지 않는다. | 안정 Dataset 1개를 demo route로 고정 |
| Day 4 | DAY4-C-FINAL-RUNBOOK | Pair C | 발표자가 runbook대로 Source -> ETL -> Catalog -> SQL -> Dashboard -> Publish를 수행하면, 전체 state/API/mock fallback이 이어지고, 5분 안에 Published Dashboard를 확인할 수 있다. | final smoke result, fixture checksum, `jobId/runId/datasetId/sqlRunId/dashboardId`, known issues, fallback switch guide | 전체 FlowId | runbook 1회 정상 리허설 -> 실패 fixture 1회 -> mock fallback 1회 | final runbook, smoke checklist, fixture index, known issues | mock/live toggle, P0/P1 fixture, Dashboard snapshot | 10MB/50MB/100MB 중 안정 샘플 | 전체 flow가 한 번 이상 끊기지 않고 통과한다. | live 실패 시 mock snapshot으로 발표 |

### 8-3B. 결과물 카드

#### DAY1-A-REVIEW-CREATE

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY1-A-REVIEW-CREATE |
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 마일스톤 이름 | Review 생성 결과가 ETL 목록과 Catalog에 동시에 반영된다 |
| 사용자가 보는 최종 결과 | Review에서 `파이프라인 생성`을 누르면 새 Job이 ETL 목록 최상단에 추가되고, 새 Dataset이 Catalog 목록 최상단에 추가된다. |
| 기술적으로 남는 검증 결과 | `POST /api/etl/jobs` request/response, `jobId`, `datasetId`, `selectedJob`, `selectedDataset`, audit log, fallback 사용 여부, console error 없음 |
| 대상 화면 / Route | 명세상 `/etl/review`, `/etl/jobs`, `/catalog`; 현재 FlowId `review`, `jobs`, `catalog` |
| 현재 UI 동작 | `ReviewPage`와 생성 버튼이 있고, `useAskLakeData.createPipeline`이 `createPipelineDraft`로 Job/Dataset을 mock 생성한다. |
| 목표 UI 동작 | 생성 응답 shape를 고정하고 성공 시 Job/Dataset을 prepend한다. 실패 시 입력값을 유지하고 Toast를 보여준다. |
| 사용자 액션 | Source부터 Target까지 확인하고 Review에서 `파이프라인 생성`을 누른 뒤 ETL 목록과 Catalog를 연다. |
| 구현해야 하는 코드 결과물 | 생성 adapter mapper, 중복 클릭 방지, success/error Toast, Job/Dataset prepend, selected state 갱신 |
| 연결해야 하는 API 또는 mock 함수 | `POST /api/etl/jobs`, fallback `createPipelineDraft(draftPipeline, jobCount)` |
| 필요한 request/response shape | Request: `DraftPipeline`. Response: `{ job: Job, dataset: Dataset }` |
| 화면에서 반드시 보여야 하는 텍스트 | `파이프라인 생성 요청이 접수되었습니다.`, Job 이름, `스케줄됨`, Dataset 이름, `사용 가능` |
| 성공 기준 | 생성 후 ETL 목록과 Catalog에서 같은 target Dataset 이름을 확인할 수 있다. |
| 검증 방법 | 브라우저 클릭, Network 탭 또는 audit log 확인, console error 확인, mock/live mode 각각 확인 |
| 이 마일스톤에서 하지 않는 것 | 실제 Source 연결, 실제 저장소 적재, 모든 wizard 중간 API 연결 |
| Fallback | API가 없으면 `mockApi.ts` 응답을 공식 fixture로 사용한다. |

#### DAY1-B-CATALOG-SQL-CONTEXT

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY1-B-CATALOG-SQL-CONTEXT |
| 담당 Pair | Pair B - Catalog & SQL Analysis |
| 마일스톤 이름 | Catalog 선택 Dataset이 SQL context가 된다 |
| 사용자가 보는 최종 결과 | Catalog에서 Dataset을 선택하고 `쿼리 편집기에서 열기`를 누르면 SQL 화면에 Dataset 이름, schema, 기본 query가 채워진다. |
| 기술적으로 남는 검증 결과 | `selectedDataset.id`, SQL default query, schema chip, Catalog fallback log, console error 없음 |
| 대상 화면 / Route | 명세상 `/catalog`, `/catalog?dataset_id={datasetId}`, `/analyze/sql`; 현재 FlowId `catalog`, `catalogDetail`, `sql` |
| 현재 UI 동작 | Catalog 목록/상세는 mock 데이터로 동작하고 `openDatasetInSql` 흐름이 있다. |
| 목표 UI 동작 | API/mock 어느 쪽이든 Dataset shape를 통일하고 SQL 진입 시 이전 query/result를 reset한다. |
| 사용자 액션 | Catalog에서 Dataset 카드 선택, `쿼리 편집기에서 열기`, SQL 화면의 Dataset 이름과 `FROM` 확인 |
| 구현해야 하는 코드 결과물 | Catalog response mapper, loading/error/fallback state, SQL default query reset |
| 연결해야 하는 API 또는 mock 함수 | `GET /api/catalog/datasets`, `GET /api/catalog/datasets/{datasetId}`, fallback `catalogDatasets` |
| 필요한 request/response shape | 목록 Response: `{ items: Dataset[], page?: number, total?: number }`. 상세 Response: `Dataset` |
| 화면에서 반드시 보여야 하는 텍스트 | `SQL CONTEXT`, `선택 데이터셋`, Dataset 이름, `읽기 전용 SQL 실행` |
| 성공 기준 | SQL editor의 `FROM`이 방금 선택한 Dataset 이름과 일치한다. |
| 검증 방법 | Dataset A/B 이동, query 문자열 확인, schema chip 확인, console error 확인 |
| 이 마일스톤에서 하지 않는 것 | 서버 검색/필터/정렬 완성, bookmark 저장, lineage 신규 고도화 |
| Fallback | API 실패 시 기존 mock Dataset 목록을 유지하고 audit log에 fallback을 남긴다. |

#### DAY1-C-DASHBOARD-SEED

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY1-C-DASHBOARD-SEED |
| 담당 Pair | Pair C - Dashboard & Integration |
| 마일스톤 이름 | Dashboard Builder가 SQL 결과 fixture로 Table Widget을 보여준다 |
| 사용자가 보는 최종 결과 | Dashboard Builder를 열면 SQL 결과 기반 `SQL 결과 테이블` 위젯이 최소 1개 보인다. |
| 기술적으로 남는 검증 결과 | `dashboardId`, `widgetId`, `sourceRunId`, localStorage key, console error 없음 |
| 대상 화면 / Route | 명세상 `/dashboards`, `/dashboards/{dashboardId}`; 현재 FlowId `dashboard` |
| 현재 UI 동작 | Dashboard 목록/Builder가 있고 SQL Result에서 Builder로 진입할 수 있다. 저장은 localStorage 중심이다. |
| 목표 UI 동작 | SQL handoff가 없어도 fixture로 Builder를 열 수 있고, 위젯 source가 `SqlResult.runId`와 연결된다. |
| 사용자 액션 | Dashboard 메뉴 진입, 대시보드 만들기, Table Widget 확인 |
| 구현해야 하는 코드 결과물 | SQL result fixture, Dashboard draft fixture, Widget source mapping, localStorage fallback 기준 |
| 연결해야 하는 API 또는 mock 함수 | Day 1은 local fixture, Day 2부터 `POST /api/dashboards` 후보 |
| 필요한 request/response shape | `SqlResult -> Dashboard`, `Dashboard.widgets[] -> Widget` |
| 화면에서 반드시 보여야 하는 텍스트 | `Dashboard`, `SQL Result Dashboard`, `SQL 결과 테이블`, `Draft` |
| 성공 기준 | Builder에서 Table Widget과 Draft 상태가 보이고 console error가 없다. |
| 검증 방법 | Dashboard 진입, Builder 열기, localStorage 확인, console error 확인 |
| 이 마일스톤에서 하지 않는 것 | 저장 API 완성, 공유 권한 실제 저장, drag/resize persistence |
| Fallback | Pair B SQL이 늦으면 fixture `SqlResult`로 Builder를 먼저 완성한다. |

#### DAY2-A-RUN-STATUS-DAG

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY2-A-RUN-STATUS-DAG |
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 마일스톤 이름 | 즉시 실행 상태가 목록, 상세, 실행 이력, DAG에 같은 Run으로 보인다 |
| 사용자가 보는 최종 결과 | ETL 목록에서 `즉시 실행`을 누르면 Job 카드가 `실행 중`으로 바뀌고, 실행 이력과 DAG에 같은 Run ID가 표시된다. |
| 기술적으로 남는 검증 결과 | command response, `jobId`, `runId`, DAG step state, `RunResultSummary`, audit log, console error 없음 |
| 대상 화면 / Route | `/etl/jobs`, `/etl/jobs/{jobId}`, `/etl/jobs/{jobId}/runs`, `/etl/jobs/{jobId}/dag`; FlowId `jobs`, `jobDetail`, `jobRuns`, `jobDag` |
| 현재 UI 동작 | `runJobCommand`가 Job의 `status`, `lastState`, `progress`를 바꾼다. Run 목록/DAG는 Job 상태 중심이다. |
| 목표 UI 동작 | command 응답 또는 fixture에서 `runId`를 만들고 목록/상세/이력/DAG가 같은 실행을 표시한다. |
| 사용자 액션 | ETL 목록에서 `즉시 실행`, `상세`, `실행 이력`, `DAG` 순서로 클릭한다. |
| 구현해야 하는 코드 결과물 | `Run` state, `selectedRun`, DAG step mapper, command 실패 rollback |
| 연결해야 하는 API 또는 mock 함수 | `POST /api/etl/jobs/{jobId}/commands`, fallback `runJobCommand(job, command)` |
| 필요한 request/response shape | Request: `{ command: "run" | "retry" | "pause" | "cancel" }`. Response: `{ job, run, dagSteps?, resultSummary? }` |
| 화면에서 반드시 보여야 하는 텍스트 | `실행 중`, `1/8 단계 · Source 연결`, `Run ID`, `DAG` |
| 성공 기준 | 같은 Run ID가 실행 이력과 DAG에 보인다. |
| 검증 방법 | 브라우저 클릭, command response 확인, 실행 이력/DAG의 Run ID 비교 |
| 이 마일스톤에서 하지 않는 것 | 실제 Airflow DAG 생성, 모든 단계 실시간 streaming |
| Fallback | API가 없으면 command fixture로 local Run과 DAG step을 만든다. |

#### DAY2-B-SQL-READONLY-RUN

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY2-B-SQL-READONLY-RUN |
| 담당 Pair | Pair B - Catalog & SQL Analysis |
| 마일스톤 이름 | Dataset-scoped read-only SQL 결과가 Result Preview에 보인다 |
| 사용자가 보는 최종 결과 | SQL 화면에서 `실행`을 누르면 Result Preview에 columns/rows와 Run ID가 보이고, 변경성 SQL은 실행 전에 차단된다. |
| 기술적으로 남는 검증 결과 | `SqlResult.runId`, `datasetId`, columns/rows, read-only guard 차단 로그, console error 없음 |
| 대상 화면 / Route | `/analyze/sql`; FlowId `sql` |
| 현재 UI 동작 | `executeQueryDraft`가 Dataset `sampleRows` 기반으로 `SqlResultDraft`를 만든다. |
| 목표 UI 동작 | SELECT/WITH만 통과시키고, 성공/실패/실행 중 상태를 화면에 명확히 표시한다. |
| 사용자 액션 | SELECT 실행, 결과 확인, UPDATE/DELETE/DROP 입력 후 차단 확인 |
| 구현해야 하는 코드 결과물 | read-only guard, query pending/error/success state, `SqlResult` reset |
| 연결해야 하는 API 또는 mock 함수 | `POST /api/query/runs`, fallback `executeQueryDraft(dataset, query)` |
| 필요한 request/response shape | Request: `{ datasetId, query, mode: "read_only" }`. Response: `SqlResult` |
| 화면에서 반드시 보여야 하는 텍스트 | `RESULT PREVIEW`, `Run ID`, `읽기 전용`, `차단됨` |
| 성공 기준 | SELECT/WITH는 결과가 보이고 INSERT/UPDATE/DELETE/DROP/ALTER/CREATE는 실행되지 않는다. |
| 검증 방법 | 정상 SQL과 차단 SQL을 각각 실행, audit log와 console 확인 |
| 이 마일스톤에서 하지 않는 것 | SQL formatter 서버 완성, CSV download, Lake 저장 |
| Fallback | API 실패 시 Dataset `sampleRows`를 `SqlResult`로 변환한다. |

#### DAY2-C-SQL-TO-DASHBOARD

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY2-C-SQL-TO-DASHBOARD |
| 담당 Pair | Pair C - Dashboard & Integration |
| 마일스톤 이름 | SQL Result가 Dashboard Builder의 Table Widget으로 이어진다 |
| 사용자가 보는 최종 결과 | SQL 결과 화면에서 `대시보드 만들기`를 누르면 Dashboard Builder가 열리고 SQL 결과 기반 Table Widget이 생성된다. |
| 기술적으로 남는 검증 결과 | `SqlResult.runId`, `dashboardId`, `widgetId`, `sourceRunId`, widget count, console error 없음 |
| 대상 화면 / Route | `/analyze/sql`, `/dashboards/{dashboardId}`; FlowId `sql`, `dashboard` |
| 현재 UI 동작 | `openDashboardFromSql`이 `sqlResultDraft`를 저장하고 Dashboard Builder로 이동한다. |
| 목표 UI 동작 | Dashboard Widget이 SQL Result rows/columns를 직접 사용하고 source Run ID를 보존한다. |
| 사용자 액션 | SQL 실행, `대시보드 만들기`, Builder에서 Table Widget 확인 |
| 구현해야 하는 코드 결과물 | `SqlResult -> DashboardRecord` mapper, Table Widget 생성, handoff error state |
| 연결해야 하는 API 또는 mock 함수 | optional `POST /api/dashboards`, local Dashboard state |
| 필요한 request/response shape | Request: `{ sourceSqlRunId, datasetId, name }`. Response: `Dashboard` |
| 화면에서 반드시 보여야 하는 텍스트 | `SQL Result Dashboard`, `SQL 결과 테이블`, `Run ID` |
| 성공 기준 | Widget의 columns/rows가 SQL Result와 일치한다. |
| 검증 방법 | SQL Result와 Dashboard Widget row/column 비교, console error 확인 |
| 이 마일스톤에서 하지 않는 것 | 복잡한 차트 설정, 권한 공유 실제 저장 |
| Fallback | Dashboard API가 없으면 local state와 localStorage를 사용한다. |

#### DAY3-A-RUN-COMPLETE-CATALOG

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY3-A-RUN-COMPLETE-CATALOG |
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 마일스톤 이름 | Run 완료 결과가 Catalog Dataset 지표에 반영된다 |
| 사용자가 보는 최종 결과 | 실행 이력에서 성공 Run을 확인한 뒤 Catalog로 이동하면 같은 Dataset의 행 수, 크기, 갱신 시각이 바뀌어 있다. |
| 기술적으로 남는 검증 결과 | `runId`, `datasetId`, `status: success`, `inputRows`, `outputRows`, `outputSizeLabel`, dataset patch log |
| 대상 화면 / Route | `/etl/jobs/{jobId}/runs`, `/catalog`; FlowId `jobRuns`, `catalog` |
| 현재 UI 동작 | 생성 직후 Dataset은 `0 rows`/`Pending` 중심이며 Run 완료와 Catalog 지표 연결은 약하다. |
| 목표 UI 동작 | Run 완료 응답 또는 fixture로 Dataset 지표를 patch한다. |
| 사용자 액션 | 실행 이력에서 완료 Run 확인, Catalog 이동, 같은 Dataset 선택 |
| 구현해야 하는 코드 결과물 | Run complete mapper, Dataset patch reducer, success/failed state |
| 연결해야 하는 API 또는 mock 함수 | command result 또는 `GET /api/etl/jobs/{jobId}` fixture, Catalog dataset patch |
| 필요한 request/response shape | `RunResultSummary`가 `runId`, `datasetId`, `outputRows`, `outputSizeLabel`을 포함 |
| 화면에서 반드시 보여야 하는 텍스트 | `성공`, `방금 갱신됨`, rows, size label, Dataset 이름 |
| 성공 기준 | Run의 `datasetId`와 Catalog Dataset `id`가 일치하고 지표가 갱신된다. |
| 검증 방법 | 실행 이력의 Dataset ID와 Catalog 항목 비교, console error 확인 |
| 이 마일스톤에서 하지 않는 것 | 운영급 처리 성능 보고서, 모든 Source Type 처리 |
| Fallback | 실제 완료 API가 없으면 success fixture로 Dataset patch를 수행한다. |

#### DAY3-B-CATALOG-SQL-STABILITY

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY3-B-CATALOG-SQL-STABILITY |
| 담당 Pair | Pair B - Catalog & SQL Analysis |
| 마일스톤 이름 | Dataset을 바꿔도 SQL context와 Result가 꼬이지 않는다 |
| 사용자가 보는 최종 결과 | Catalog에서 Dataset A/B를 번갈아 SQL로 열어도 SQL 화면의 Dataset 이름, schema, query, result가 현재 Dataset 기준으로 바뀐다. |
| 기술적으로 남는 검증 결과 | `selectedDataset.id`, `SqlResult.datasetId`, result reset log, console error 없음 |
| 대상 화면 / Route | `/catalog`, `/analyze/sql`; FlowId `catalog`, `catalogDetail`, `sql` |
| 현재 UI 동작 | Dataset 변경 시 query는 reset되지만 실행 결과 표시/상태 reset은 더 명확해야 한다. |
| 목표 UI 동작 | Dataset 변경마다 query/result/loading/error state가 현재 Dataset 기준으로 초기화된다. |
| 사용자 액션 | Dataset A SQL 열기, 실행, Dataset B SQL 열기, 실행 결과 비교 |
| 구현해야 하는 코드 결과물 | selectedDataset reset, SqlResult reset, empty/error/loading polish |
| 연결해야 하는 API 또는 mock 함수 | `Dataset -> SQL Context -> SqlResult` |
| 필요한 request/response shape | `SqlResult.datasetId`가 현재 `selectedDataset.id`와 일치 |
| 화면에서 반드시 보여야 하는 텍스트 | Dataset A/B 이름, `RESULT PREVIEW`, `SQL CONTEXT` |
| 성공 기준 | 이전 Dataset의 rows/columns가 새 Dataset 화면에 남지 않는다. |
| 검증 방법 | Dataset 2개 이상 반복 이동, result datasetId 비교, console error 확인 |
| 이 마일스톤에서 하지 않는 것 | 고급 join builder, SQL 저장/내보내기 완성 |
| Fallback | 데모 Dataset을 하나로 고정하되, state reset 이슈는 known issue로 기록한다. |

#### DAY3-C-DASHBOARD-SAVE-PUBLISH

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY3-C-DASHBOARD-SAVE-PUBLISH |
| 담당 Pair | Pair C - Dashboard & Integration |
| 마일스톤 이름 | Dashboard 저장/Publish 후 같은 Widget이 유지된다 |
| 사용자가 보는 최종 결과 | Builder에서 `저장`과 `Publish`를 누르면 Dashboard 목록과 Published 화면에서 같은 Table Widget을 다시 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | `dashboardId`, `status`, widget count, localStorage/API response, publish audit log |
| 대상 화면 / Route | `/dashboards`, `/dashboards/{dashboardId}`, `/dashboards/{dashboardId}/published`; FlowId `dashboard` |
| 현재 UI 동작 | Dashboard 카드가 localStorage에 저장되고 Publish 상태가 local state로 표시된다. |
| 목표 UI 동작 | API가 있으면 API를 쓰고, 없으면 localStorage snapshot으로 Draft/Published 상태를 유지한다. |
| 사용자 액션 | Builder에서 Widget 확인, 저장, 목록 이동, 다시 열기, Publish, Published view 확인 |
| 구현해야 하는 코드 결과물 | save/publish adapter, localStorage snapshot schema, published view state |
| 연결해야 하는 API 또는 mock 함수 | `POST /api/dashboards`, `PATCH /api/dashboards/{dashboardId}`, `POST /api/dashboards/{dashboardId}/publish` |
| 필요한 request/response shape | `Dashboard` with `widgets[]` and `status: "draft" | "published"` |
| 화면에서 반드시 보여야 하는 텍스트 | `Draft`, `Published`, `SQL 결과 테이블`, Dashboard 이름 |
| 성공 기준 | 저장 후 목록에 남고 Publish 후 Published 화면에 같은 Widget이 보인다. |
| 검증 방법 | 저장/게시 클릭, 새로고침 또는 화면 재진입, localStorage/API response 확인 |
| 이 마일스톤에서 하지 않는 것 | 권한 공유 실제 저장, 복잡한 레이아웃 편집 persistence |
| Fallback | API 실패 시 localStorage snapshot을 authoritative source로 사용한다. |

#### DAY4-A-ETL-HARDENING

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY4-A-ETL-HARDENING |
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 마일스톤 이름 | ETL 생성/실행 실패에도 화면 상태가 복구된다 |
| 사용자가 보는 최종 결과 | 생성 중복 클릭, 422/500/timeout을 만나도 입력값과 이전 Job 상태가 유지되고 Toast가 보인다. |
| 기술적으로 남는 검증 결과 | error fixture, duplicate guard, rollback state, fallback 여부, console error 없음 |
| 대상 화면 / Route | ETL 전체; FlowId `source`~`review`, `jobs`, `jobDetail`, `jobRuns`, `jobDag` |
| 현재 UI 동작 | catch에서 Toast를 보여주지만 에러 shape와 rollback 기준이 더 명확해야 한다. |
| 목표 UI 동작 | API 실패 시 이전 state를 유지하고 사용자가 같은 버튼을 다시 눌러 정상 flow를 재개할 수 있다. |
| 사용자 액션 | 생성 중복 클릭, 실패 fixture 실행, 재시도, Job 실행 실패, 이전 상태 확인 |
| 구현해야 하는 코드 결과물 | `ErrorResponse` mapper, duplicate submit guard, rollback checklist |
| 연결해야 하는 API 또는 mock 함수 | P0 ETL API, error fixture |
| 필요한 request/response shape | `ErrorResponse` |
| 화면에서 반드시 보여야 하는 텍스트 | `요청에 실패했습니다.`, `다시 시도`, 기존 Job 이름 |
| 성공 기준 | 실패 후 앱이 죽지 않고 다시 정상 생성/실행을 할 수 있다. |
| 검증 방법 | 실패 fixture, Network error, console error, state 유지 확인 |
| 이 마일스톤에서 하지 않는 것 | 복잡한 retry policy, 운영급 alerting |
| Fallback | 발표 전 live API가 불안정하면 mock mode로 고정한다. |

#### DAY4-B-CATALOG-SQL-QA

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY4-B-CATALOG-SQL-QA |
| 담당 Pair | Pair B - Catalog & SQL Analysis |
| 마일스톤 이름 | Catalog -> SQL -> Dashboard handoff를 반복해도 state가 일관된다 |
| 사용자가 보는 최종 결과 | Catalog에서 Dataset을 선택하고 SQL 실행 후 Dashboard 만들기를 여러 번 반복해도 결과가 현재 Dataset 기준으로 유지된다. |
| 기술적으로 남는 검증 결과 | consistency checklist, `SqlResult.runId`, `datasetId`, read-only guard evidence, fallback 사용 여부 |
| 대상 화면 / Route | `/catalog`, `/analyze/sql`, `/dashboards`; FlowId `catalog`, `sql`, `dashboard` |
| 현재 UI 동작 | 주요 handoff는 존재하지만 반복 QA 기준과 실패 fallback 문서화가 부족하다. |
| 목표 UI 동작 | 3회 반복 클릭해도 Dataset/query/result/dashboard source가 꼬이지 않는다. |
| 사용자 액션 | Dataset 선택, SQL 실행, Dashboard 만들기, 다른 Dataset으로 반복 |
| 구현해야 하는 코드 결과물 | final mapper fixes, reset checklist, empty/error/loading state |
| 연결해야 하는 API 또는 mock 함수 | Catalog API, Query API, Dashboard handoff state |
| 필요한 request/response shape | `Dataset`, `SqlResult`, `ErrorResponse` |
| 화면에서 반드시 보여야 하는 텍스트 | Dataset 이름, `RESULT PREVIEW`, `SQL 결과 테이블` |
| 성공 기준 | Dataset 이름/schema/query/result/dashboard source가 한 Dataset 기준으로 일치한다. |
| 검증 방법 | 반복 클릭 QA, console error 확인, fixture/live mode 각각 확인 |
| 이 마일스톤에서 하지 않는 것 | 서버 pagination 완성, export/download |
| Fallback | 안정적인 demo Dataset 1개를 고정하고 다른 Dataset 문제는 known issue로 남긴다. |

#### DAY4-C-FINAL-RUNBOOK

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY4-C-FINAL-RUNBOOK |
| 담당 Pair | Pair C - Dashboard & Integration |
| 마일스톤 이름 | 최종 발표자가 5분 안에 전체 flow를 재현한다 |
| 사용자가 보는 최종 결과 | runbook 순서대로 Source -> ETL -> Catalog -> SQL -> Dashboard -> Publish를 클릭하면 Published Dashboard까지 끊기지 않는다. |
| 기술적으로 남는 검증 결과 | final smoke result, fixture checksum, `jobId/runId/datasetId/sqlRunId/dashboardId`, known issues, fallback switch guide |
| 대상 화면 / Route | 전체 FlowId |
| 현재 UI 동작 | 개별 화면은 있으나 최종 발표 순서와 fallback switch 기준이 한 문서로 고정되어 있지 않다. |
| 목표 UI 동작 | 정상 flow, 실패 fixture flow, mock fallback flow를 발표자가 순서대로 재현한다. |
| 사용자 액션 | runbook 1회 정상 리허설, 실패 fixture 1회, mock fallback 1회 |
| 구현해야 하는 코드 결과물 | final runbook, smoke checklist, fixture index, known issues |
| 연결해야 하는 API 또는 mock 함수 | mock/live toggle, P0/P1 fixtures, Dashboard snapshot |
| 필요한 request/response shape | 이 문서의 `Job`, `Run`, `Dataset`, `SqlResult`, `Dashboard`, `Widget`, `ErrorResponse` |
| 화면에서 반드시 보여야 하는 텍스트 | `Published`, `SQL 결과 테이블`, `Run ID`, Dataset 이름 |
| 성공 기준 | 전체 flow가 1회 이상 끊기지 않고 통과한다. |
| 검증 방법 | 발표자 리허설, console error 확인, fixture checksum 확인 |
| 이 마일스톤에서 하지 않는 것 | 성능 벤치마크, 모든 nice-to-have 처리 |
| Fallback | live API 실패 시 mock snapshot으로 발표한다. |

### 매일 통합 지점

| Day | 통합 지점 | Pair A가 넘기는 것 | Pair B가 넘기는 것 | Pair C가 고정하는 것 | merge 후 화면 확인 |
| --- | --- | --- | --- | --- | --- |
| Day 1 | 생성 결과가 Catalog/SQL/Dashboard seed까지 이어지는지 확인 | `{ job, dataset }`, `selectedJob`, `selectedDataset` | Catalog 선택 Dataset과 SQL default query | SQL fixture 기반 Dashboard draft | ETL 새 Job, Catalog 새 Dataset, SQL context, Dashboard Table Widget |
| Day 2 | Run 상태와 SQL Result가 Dashboard Widget까지 이어지는지 확인 | `Run`, `runId`, DAG 단계 | `SqlResult`, read-only guard 결과 | `sourceRunId` 기반 Widget | Job 실행 중, 실행 이력/DAG, Result Preview, Dashboard Widget |
| Day 3 | Run 완료 결과가 Dataset/SQL/Dashboard 저장까지 이어지는지 확인 | `RunResultSummary`, Dataset patch | Dataset switching consistency | Draft/Published snapshot | Catalog 지표 갱신, SQL reset, Published Dashboard |
| Day 4 | 발표 runbook과 fallback이 재현되는지 확인 | ETL error/rollback smoke | Catalog/SQL 반복 QA 결과 | final runbook, fixture index, known issues | 전체 5분 데모, 실패 fixture, mock fallback |

### Dependency와 fallback

| Dependency | 선행 조건 | mock 대체 전략 | 막혔을 때 fallback |
| --- | --- | --- | --- |
| Pair B가 Pair A의 Dataset을 사용 | create response에 `dataset.id`, `dataset.name`, `schema`, `sampleRows`가 있어야 한다. | `createPipelineDraft`가 만든 Dataset을 Catalog 최상단에 prepend한다. | 기존 mock Dataset 중 하나를 demo Dataset으로 고정한다. |
| Pair A의 Run을 Pair C가 source로 표시 | command response 또는 fixture에 `runId`, `jobId`, `datasetId`가 있어야 한다. | `runJobCommand` local fixture가 `Run`을 만든다. | Dashboard에는 `sourceRunId: "fixture_run"`을 표시한다. |
| Pair C가 Pair B의 SQL Result를 받음 | `SqlResult`에 `runId`, `datasetId`, `columns`, `rows`, `rowCount`가 있어야 한다. | `executeQueryDraft` 응답을 그대로 Dashboard handoff에 사용한다. | SQL API 실패 시 Dataset `sampleRows`로 Table Widget을 만든다. |
| Dashboard 저장 API가 늦음 | `Dashboard`와 `Widget` 최소 필드가 고정되어야 한다. | localStorage snapshot을 저장소로 사용한다. | Published 화면은 local snapshot으로 발표한다. |

## 8-4. 매일 통합 데모 시나리오

### Day 1 종료 데모

1. 브라우저에서 `+ 새 수집/처리 생성`을 누르고 Source부터 Review까지 이동한다.
2. Review에서 `파이프라인 생성`을 누른다.
3. ETL 목록 최상단에 새 Job이 보이고, Catalog 최상단에 새 Dataset이 보인다.
4. Catalog에서 `쿼리 편집기에서 열기`를 누르면 SQL 화면에 같은 Dataset 이름과 기본 query가 보인다.
5. Dashboard Builder에서 SQL fixture 기반 `SQL 결과 테이블` 위젯을 확인한다.
6. 기술 증거: create response, `jobId`, `datasetId`, SQL default query, Dashboard fixture `sourceRunId`, console error 없음.

### Day 2 종료 데모

1. ETL 목록에서 Day 1에 만든 Job의 `즉시 실행`을 누른다.
2. Job 카드가 `실행 중`으로 바뀌고 상세/실행 이력/DAG에서 같은 Run ID를 확인한다.
3. Catalog에서 같은 Dataset을 SQL로 열고 SELECT를 실행한다.
4. UPDATE/DELETE 같은 변경성 query가 차단되는지 확인한다.
5. `대시보드 만들기`를 눌러 Dashboard Builder에 Table Widget이 생기는지 확인한다.
6. 기술 증거: command response, `runId`, `SqlResult.runId`, read-only 차단 로그, Widget `sourceRunId`, console error 없음.

### Day 3 종료 데모

1. 실행 이력에서 성공 Run을 확인하고 Catalog로 이동한다.
2. Catalog에서 같은 Dataset의 rows/size/freshness가 갱신되었는지 확인한다.
3. Dataset A/B를 번갈아 SQL로 열어 query/result가 reset되는지 확인한다.
4. SQL 결과로 Dashboard Builder를 열고 `저장`, `Publish`를 누른다.
5. Dashboard 목록과 Published 화면에서 같은 Widget이 유지되는지 확인한다.
6. 기술 증거: `RunResultSummary`, Dataset patch log, `SqlResult.datasetId`, localStorage/API publish response, console error 없음.

### Day 4 종료 데모

1. 발표자가 runbook대로 Source -> ETL 생성 -> 실행 -> Catalog -> SQL -> Dashboard -> Publish를 5분 안에 클릭한다.
2. 실패 fixture를 한 번 켜서 Toast, rollback, fallback이 작동하는지 확인한다.
3. mock/live 전환 절차를 확인하고, live가 불안정할 때 mock snapshot으로 같은 발표가 가능한지 확인한다.
4. 화면마다 같은 `jobId`, `runId`, `datasetId`, `sqlRunId`, `dashboardId`가 이어지는지 확인한다.
5. 기술 증거: final smoke result, fixture checksum, known issues, fallback switch guide, console error 없음.

## 8-5. Pair 간 API / 타입 계약

```ts
type JobStatus = "scheduled" | "running" | "paused" | "success" | "failed" | "canceled";
type Layer = "RAW" | "BRONZE" | "SILVER" | "GOLD";

interface Job {
  id: string;
  name: string;
  owner: string;
  status: JobStatus;
  sourceLabel: string;
  targetDatasetId: string;
  targetDatasetName: string;
  scheduleLabel: string;
  lastRunId?: string;
  lastStateLabel: string;
  progress?: { label: string; value: number };
}

interface Run {
  id: string;
  jobId: string;
  datasetId: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
  currentStep: string;
  startedAt: string;
  finishedAt?: string;
  resultSummary?: RunResultSummary;
}

interface RunResultSummary {
  runId: string;
  datasetId: string;
  inputRows: number;
  outputRows: number;
  outputSizeLabel: "fixture" | "10MB" | "50MB" | "100MB";
  outputPath?: string;
  usedFallback: boolean;
}

interface Dataset {
  id: string;
  name: string;
  layer: Layer;
  owner: string;
  status: "available" | "approval_required";
  rowsLabel: string;
  sizeLabel: "Pending" | "fixture" | "10MB" | "50MB" | "100MB";
  qualityLabel: string;
  lastUpdatedLabel: string;
  schema: Array<{ name: string; type: string; nullable?: boolean }>;
  sampleRows: string[][];
  sourceJobId?: string;
  latestRunId?: string;
}

interface SqlResult {
  runId: string;
  datasetId: string;
  datasetName: string;
  query: string;
  columns: string[];
  rows: string[][];
  rowCount: number;
  executedAt: string;
  usedFallback: boolean;
}

interface Dashboard {
  id: string;
  name: string;
  datasetId: string;
  sourceSqlRunId?: string;
  status: "draft" | "published";
  widgets: Widget[];
  updatedAt: string;
}

interface Widget {
  id: string;
  dashboardId: string;
  type: "kpi" | "bar" | "line" | "donut" | "table";
  title: string;
  datasetId: string;
  sourceSqlRunId?: string;
  columns: string[];
  rows?: string[][];
}

interface ErrorResponse {
  error: {
    code:
      | "VALIDATION_ERROR"
      | "NOT_FOUND"
      | "CONFLICT"
      | "INVALID_JOB_STATE"
      | "SQL_NOT_READ_ONLY"
      | "SQL_SYNTAX_ERROR"
      | "BACKEND_TIMEOUT"
      | "INTERNAL_ERROR";
    message: string;
    details?: unknown;
    fallbackAvailable?: boolean;
  };
}
```

### 최소 API shape

```ts
type CreateJobRequest = {
  jobName: string;
  sourceType: string;
  sourceLabel: string;
  schemaSummary: string;
  ruleSummary: string;
  scheduleLabel: string;
  permissionSummary: string;
  targetDataset: string;
  targetLayer: Layer;
  owner: string;
};

type CreateJobResponse = {
  job: Job;
  dataset: Dataset;
};

type JobCommandResponse = {
  job: Job;
  run: Run;
  dagSteps?: Array<{ id: string; label: string; status: "pending" | "running" | "success" | "failed" }>;
};

type QueryRunRequest = {
  datasetId: string;
  query: string;
  mode: "read_only";
};

type QueryRunResponse = SqlResult;

type DashboardSaveResponse = Dashboard;
```

## 8-6. End-to-End 샘플 데이터 검증 계획

| 항목 | 계획 |
| --- | --- |
| 어떤 샘플 Dataset을 사용할 것인가? | `customer_review_sample`, `commerce_orders_sample`, `behavior_events_sample` 중 하나를 메인 데모 Dataset으로 고정한다. |
| 샘플 크기는 어느 정도인가? | Day 1은 10MB 또는 `sampleRows`, Day 2는 50MB fixture, Day 3~4는 100MB fixture까지 사용한다. 크기보다 ID 연결을 우선한다. |
| mock sampleRows와 실제 샘플 파일을 어떻게 구분할 것인가? | `RunResultSummary.usedFallback`과 `Dataset.sizeLabel`에 `fixture`, `10MB`, `50MB`, `100MB`를 표시한다. |
| Job 실행 결과로 어떤 최소 증거를 남길 것인가? | `jobId`, `runId`, `datasetId`, `status`, `inputRows`, `outputRows`, `outputSizeLabel`, `usedFallback`을 남긴다. |
| Catalog에서 무엇이 보여야 하는가? | Dataset 이름, layer, owner, rows, size, lastUpdated, schema preview, `SQL 분석에서 열기` 버튼이 보여야 한다. |
| SQL에서 어떤 query가 실행되어야 하는가? | 기본 query는 `SELECT <schema columns> FROM <dataset.name> LIMIT 100;`이며, 데모 query는 read-only SELECT/WITH만 허용한다. |
| Dashboard에서 어떤 Widget이 보여야 하는가? | SQL Result 기반 `SQL 결과 테이블` Widget 1개가 필수다. 추가 KPI/bar widget은 있으면 좋지만 필수는 아니다. |
| API가 없을 때 어떤 fixture로 대체할 것인가? | `createPipelineDraft`, `runJobCommand`, `executeQueryDraft`, Dashboard localStorage snapshot을 authoritative fallback으로 쓴다. |

샘플 검증의 목적은 처리량이 아니라 연결성이다. 검증 순서는 `Job 생성 -> Dataset 생성 -> Run 상태 변경 -> Catalog 선택 -> SQL 실행 -> Dashboard Widget 생성 -> Publish`다.

## 8-7. Nice to have

| 제외 기능 | 제외 이유 | 나중에 붙일 위치 |
| --- | --- | --- |
| 10GB 데이터 처리 검증 | 4일 MVP의 핵심은 E2E flow 연결이며, 대용량 검증은 실패 시 전체 데모를 흔든다. | 성능 검증 스프린트, Run artifact/report |
| TB급 처리 검증 | 인프라, 데이터 준비, 재현성 확보가 별도 과제다. | 장기 성능 로드맵 |
| Spark/Trino/Kafka/Airflow 전체 완전 운영 | 화면 handoff보다 훨씬 큰 운영 범위다. | 플랫폼 운영 단계 |
| Kafka 실시간 스트리밍 완성 | MVP 데모는 batch-like 샘플 흐름만으로 충분하다. | streaming ingest module |
| 모든 Source Type 실제 연결 | Database/File/S3 중심 mock flow를 먼저 살린다. | Connector 확장 단계 |
| 인증/인가 완성 | 버튼 비활성화와 permission mock까지만 한다. | Admin/Auth 스프린트 |
| Dashboard 권한 공유 실제 저장 | Share/Permission은 mock modal 또는 copy link로 충분하다. | Dashboard collaboration |
| 완전한 Airflow DAG 생성기 | DAG 화면은 run step state 표시까지만 한다. | Workflow orchestration |
| 운영급 모니터링/로깅 체계 | 발표 증거는 audit log, console error 없음, smoke checklist로 충분하다. | Observability |
| 배포 자동화 | 4일 계획의 핵심은 로컬/공유 환경에서 클릭 가능한 flow다. | CI/CD |
| 클라우드 인프라 구성 | 인프라 구성은 제품 흐름보다 시간이 많이 든다. | Deployment 스프린트 |
| 고급 Dashboard chart builder | 필수 위젯은 Table 1개다. | Dashboard 고도화 |
| SQL export / Lake 저장 | SQL 결과가 Dashboard로 넘어가는 것이 우선이다. | SQL P1 기능 |

## 8-8. 리스크와 대응

| 리스크 | 예방책 | Fallback |
| --- | --- | --- |
| 페어 간 인터페이스 불일치 | Day 1 오전에 `Job`, `Run`, `Dataset`, `SqlResult`, `Dashboard`, `Widget`, `ErrorResponse` 최소 필드를 고정한다. | Pair C가 fixture를 authoritative sample로 두고 각 Pair는 mapper만 맞춘다. |
| mock 데이터와 실제 API response 불일치 | mock/live adapter가 같은 return type을 내도록 response mapper를 둔다. | live 응답을 mock shape로 normalize하고 안 되는 필드는 fallback label로 표시한다. |
| ETL 생성 플로우가 너무 커지는 문제 | Source~Target 중간 단계는 기존 UI를 유지하고 Review 생성 결과에 집중한다. | Source/Schema/Rule 상세 API는 제외하고 draft state만 사용한다. |
| SQL 실행과 Dashboard 연결이 늦어지는 문제 | Day 1부터 SQL Result fixture로 Dashboard Builder를 먼저 만든다. | SQL API가 늦으면 `sampleRows` 기반 `SqlResult`로 handoff한다. |
| Lineage / DAG 시각화가 과해지는 문제 | DAG/Lineage는 읽기 전용 상태 표시와 최소 step/card만 한다. | 복잡한 연결선은 숨기고 단계 list로 대체한다. |
| Dataset 선택 상태가 SQL/Dashboard까지 이어지지 않는 문제 | `selectedDataset.id`, `SqlResult.datasetId`, `Dashboard.datasetId`를 매일 smoke에서 비교한다. | 안정 Dataset 하나를 demo Dataset으로 고정한다. |
| Dashboard 저장/Publish가 늦어지는 문제 | API와 localStorage fallback을 같은 `Dashboard` shape로 맞춘다. | Published 화면은 localStorage snapshot으로 발표한다. |
| merge conflict | Pair별 화면 소유를 분리하고 공통 타입 변경은 하루 1회 짧은 sync 후 반영한다. | 공통 타입 변경은 Pair C가 작은 PR/commit으로 먼저 넣는다. |
| 4일차에 통합 실패하는 문제 | Day 1부터 매일 전체 flow를 짧게라도 클릭한다. | Day 4에는 기능 추가를 멈추고 known issue와 mock fallback으로 발표 경로를 고정한다. |
| 작은 샘플 데이터로도 전체 flow가 끊기는 문제 | 10MB `sampleRows` fixture를 항상 유지하고, 50MB/100MB는 보강 샘플로 둔다. | 실제 파일 처리 실패 시 fixture result로 Job/SQL/Dashboard flow를 유지한다. |
| read-only SQL guard가 너무 느슨한 문제 | 금지 키워드와 허용 시작 키워드를 Day 2에 먼저 고정한다. | SQL 실행 버튼을 Dataset default SELECT만 실행하도록 잠근다. |
| 발표자가 어디를 클릭해야 할지 헷갈리는 문제 | Day 4-C에서 5분 runbook과 fallback switch guide를 만든다. | 발표자는 stable demo route만 사용한다. |

## 8-9. 최종 추천안

4일 동안 반드시 완성해야 하는 것은 `Review 생성 -> ETL 목록/실행/이력/DAG -> Catalog -> SQL -> Dashboard Publish`로 이어지는 하나의 끊기지 않는 데모 경로다. Pair A는 Job 생성과 Run 상태를 같은 ID로 남기는 데 집중하고, Pair B는 Dataset 선택이 SQL Result까지 흔들리지 않게 만드는 데 집중하고, Pair C는 SQL Result가 Table Widget과 Published Dashboard로 끝까지 보이게 하면서 매일 통합 QA를 책임진다. 매일 merge 후에는 화면 클릭 결과와 `jobId/runId/datasetId/sqlRunId/dashboardId`가 이어지는지 확인해야 한다. 데이터 규모보다 우선할 것은 화면 간 상태 전달과 fallback이 있는 end-to-end flow다. 가장 먼저 집중해야 할 것은 공통 타입과 P0 response shape 고정이고, 가장 먼저 버려야 할 욕심은 대용량 검증, 모든 Source Type 실제 연결, Spark/Trino/Kafka/Airflow 완전 운영을 동시에 끝내려는 것이다.
