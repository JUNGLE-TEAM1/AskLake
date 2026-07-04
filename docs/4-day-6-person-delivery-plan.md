# AskLake/XFLOW 4일 / 6인 작업 분배 계획

이 문서는 기능 명세서 묶음과 현재 프론트엔드 구현 상태를 기준으로, 6명이 2명씩 3개 Pair로 나뉘어 4일 동안 구현할 수 있는 현실적인 분업안을 정의한다.

중요 전제:

- 기능 개발 문서가 아니라 작업 분배 계획 문서다.
- 기존 UI를 갈아엎지 않는다.
- 새 화면을 처음부터 만들지 않는다.
- 이미 구현된 화면을 실제 제품 흐름처럼 연결하는 데 집중한다.
- 매일 merge 후 브라우저에서 클릭 가능한 화면 결과물, 기술 검증 결과물, 배포 검증 결과물을 모두 남긴다.
- 현재 프론트엔드는 URL router가 아니라 `App.tsx`의 `activeFlow`로 화면을 전환한다. 따라서 이 문서의 Route는 명세상 URL과 현재 FlowId를 함께 쓴다.

## 10-1. 전체 분업 원칙

### 왜 3개 덩어리로 나누는가

3개 Pair는 사용자 흐름의 끊김 지점을 기준으로 나눈다.

| 덩어리 | 끊김 지점 | 책임 |
| --- | --- | --- |
| Pair A - ETL Creation & Job Operations | Source/Schema/Rule/Schedule 설정이 실제 Job/Run 상태로 이어지는 지점 | Job 생성, 실행, 상세, 실행 이력, DAG, 10GB batch 실행 증거 |
| Pair B - Catalog & SQL Analysis | 생성/처리된 Dataset이 분석 가능한 Dataset context로 이어지는 지점 | Catalog 표시, Dataset 선택, SQL context, read-only query, 10GB 결과 조회 |
| Pair C - Dashboard & Integration | SQL 결과가 최종 사용자 가치인 Dashboard/Published view로 이어지는 지점 | SQL 결과 기반 Widget, Dashboard 저장/게시, 최종 통합 smoke, frontend 배포 검증 |

이 분할은 화면 기준으로도, 데이터 흐름 기준으로도, API 기준으로도 균형이 맞다. Pair A가 upstream 생산자인 Job/Run을 책임지고, Pair B가 Dataset/SQL 중간 산출물을 책임지고, Pair C가 Dashboard/Published 최종 산출물을 책임진다. API 계약 검토, 타입 정의, QA, 배포 검증은 특정 Pair 하나에 몰지 않고 각 Pair의 화면 책임 안에 포함한다.

### 화면 기준 균형

- Pair A는 ETL 생성 wizard, Job 목록, Job 상세, 실행 이력, DAG까지 여러 화면을 책임진다.
- Pair B는 Catalog 목록/상세, SQL 편집기, SQL 결과 화면을 책임진다.
- Pair C는 Dashboard 목록, Builder, Widget, Published view, 최종 runbook을 책임진다.

Pair C를 API/QA 보조 Pair로 두지 않는다. Pair C는 매일 Dashboard 화면에서 확인 가능한 결과물을 내고, 통합 QA와 runbook은 Dashboard 책임의 일부로만 수행한다.

### 데이터 흐름 기준 균형

최종 데모 데이터는 아래 순서로 움직인다.

```text
DraftPipeline
-> Job
-> Run
-> DataProcessingResult
-> Dataset
-> SQL Result
-> Dashboard
-> Widget
-> Published Dashboard
```

Pair A는 `DraftPipeline -> Job -> Run -> DataProcessingResult`, Pair B는 `DataProcessingResult -> Dataset -> SQL Result`, Pair C는 `SQL Result -> Dashboard -> Widget -> Published Dashboard`를 맡는다.

### API 기준 균형

| Pair | P0/P1 API 책임 |
| --- | --- |
| Pair A | `POST /api/etl/jobs`, `POST /api/etl/jobs/{jobId}/commands`, `GET /health`, run/evidence mapper |
| Pair B | `GET /api/catalog/datasets`, `GET /api/catalog/datasets/{datasetId}`, `POST /api/query/runs` |
| Pair C | `POST /api/dashboards`, `PATCH /api/dashboards/{dashboardId}`, `POST /api/dashboards/{dashboardId}/publish`, frontend build smoke |

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
-> Dashboard에 SQL 결과 기반 Table 위젯 1개 표시
-> Dashboard 저장 / Publish
-> 10GB 처리 증거를 실행 이력 / Catalog / SQL / Dashboard에서 확인
-> 최소 배포 환경에서 frontend, backend `/health`, P0 API smoke 확인
```

### 이미 구현된 UI 활용 방식

현재 프론트엔드는 `frontend/src/App.tsx`의 `activeFlow`로 `jobs`, `source`, `schema`, `rules`, `repeat`, `manual`, `once`, `permission`, `target`, `review`, `catalog`, `catalogDetail`, `sql`, `dashboard`를 전환한다. `useAskLakeData.ts`는 이미 `jobs`, `datasets`, `selectedJob`, `selectedDataset`, `sqlResultDraft`, `draftPipeline` 상태를 들고 있고, `mockApi.ts`는 `VITE_USE_MOCK_API=false`일 때 P0 API 3개를 live backend로 호출할 수 있다.

따라서 4일 작업은 화면 재작성보다 다음 연결에 집중한다.

- mock/live adapter response shape 고정
- `selectedJob`, `selectedRun`, `selectedDataset`, `SqlResultDraft`, `DashboardRecord` 전달 안정화
- Loading / Empty / Error / Success / Running 상태 보강
- API 실패 시 mock fallback 유지
- 실행 이력, Catalog, SQL, Dashboard에 같은 `runId`, `datasetId`, `sourceRunId`를 표시

### 10GB 데이터 처리 목표 반영

10GB 처리는 별도 기술 과제로 고립하지 않는다. Day 1은 100MB~500MB fixture로 전체 UI/API 흐름을 검증하고, Day 2는 1GB 처리 증거를 Run/Catalog에 반영하며, Day 3은 10GB 실제 batch run 또는 1GB 실제 + synthetic 10GB scale report를 실행 이력/Catalog/SQL에 연결하고, Day 4는 10GB 처리 결과를 Dashboard Published view까지 연결한다.

10GB 검증의 주 실행 책임은 Pair A가 갖지만, Pair B와 Pair C도 각자의 화면에서 10GB 증거를 확인해야 한다.

### Pair 간 의존도를 낮추는 방식

- 모든 Pair는 Day 1에 공통 fixture를 먼저 고정한다.
- Pair A의 Dataset 생성이 늦어도 Pair B는 `catalogDatasets[0]` 또는 `customer_review_10gb_silver` fixture로 시작한다.
- Pair B의 SQL API가 늦어도 Pair C는 `SqlResultDraft` fixture로 Dashboard Builder를 진행한다.
- live backend가 늦어도 `VITE_USE_MOCK_API=true`와 local stub으로 같은 클릭 순서를 유지한다.
- 매일 종료 시 `Job`, `Run`, `Dataset`, `SQL Result`, `Dashboard`, `Widget`, `DataProcessingResult`, `DeploymentCheckResult` 타입을 함께 점검한다.

### 작업 볼륨 균형 근거

Pair A는 ETL 화면 수가 많고 10GB 실행 주 책임이 있어 가장 위험하지만, 새로운 화면 제작 대신 상태/API 연결과 증거 표시로 범위를 제한한다. Pair B는 Catalog/SQL 연결과 read-only guard, 10GB 결과 조회를 맡아 중간 데이터 계약의 핵심을 담당한다. Pair C는 Dashboard/Published 화면 구현 책임과 frontend 배포 smoke, 최종 runbook을 함께 맡기 때문에 QA 보조만 하는 가벼운 Pair가 아니다.

### 최소 배포 PoC 범위

배포는 4일 안에 가능한 최소 검증으로 제한한다.

| 범위 | 이번 4일에 한다 | Nice to have로 내린다 |
| --- | --- | --- |
| 실행 환경 | AWS EC2 1대 또는 팀 공유 VM + Docker Compose 수준 | EKS, ALB, TLS, 도메인, 오토스케일링 |
| Frontend | `npm run build`, 정적 파일 서빙 또는 Vite preview, 배포 URL 접속 smoke | 완전한 CI/CD, CDN 최적화 |
| Backend | `/health`, P0 API 3개, Catalog/SQL/Dashboard smoke용 최소 endpoint 또는 stub | Spark/Trino/Airflow/Kafka 운영급 구성 |
| 데이터 처리 | 10GB batch 1회 성공 또는 caveat 있는 scale report | streaming과 batch를 동시에 완성 |
| 증거 | curl 결과, build log, screenshot, runbook, artifact index | 운영급 모니터링/알림/로그 수집 |

## 10-2. 3개 페어 분업안

| Pair | 담당 영역 | 담당 명세서 | 최종 책임 결과물 | 다른 Pair와의 연결점 | 기술 검증 책임 | 배포 검증 책임 | 작업 볼륨 균형 근거 | 위험도 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pair A - ETL Creation & Job Operations | Source/Schema/Rule/Schedule/Permission/Target/Review, Job 목록/상세/실행 이력/DAG, 10GB batch 실행 | Source Connection, PostgreSQL 메타데이터, CSV Schema, MongoDB/JSON Schema, Rule/Transformation, Quality/Validation, Schedule 수동/1회/반복, 권한, Target, Review, ETL 목록/상세/이력/DAG, 공통 확인 모달 | Review 생성 후 ETL 목록에 Job 표시, Catalog에 Dataset 반영, 즉시 실행/재실행/취소 상태가 목록/상세/이력/DAG에 같은 Run으로 보임, 10GB 실행 증거 생성 | Pair B에 `Dataset`과 `DataProcessingResult` 전달, Pair C에 `Run`/`sourceRunId` 전달 | `POST /api/etl/jobs`, `POST /api/etl/jobs/{jobId}/commands`, `Run`, `DAG step`, 1GB/10GB processing artifact, error envelope | backend `/health`, Job create/command API smoke, run result artifact 경로 확인 | 화면 수와 대용량 처리 책임이 크지만 중간 Source/Schema 세부 API는 fallback으로 제한해 범위를 맞춘다 | 높음 |
| Pair B - Catalog & SQL Analysis | Catalog 목록/상세/Schema/Lineage, Dataset 선택, Dataset-scoped SQL, read-only guard, SQL Result | Data Catalog/Lineage, Dataset-Scoped SQL, Backend API Contract 중 Catalog/Query, Backend Integration Readiness 중 hydrate/query | Catalog에서 Dataset을 SQL로 열면 SQL context와 기본 query가 채워지고, read-only SQL 실행 결과가 Result table과 `SqlResultDraft`로 남음, 10GB Dataset의 count/group query 결과 표시 | Pair A의 `Dataset`/`DataProcessingResult`를 받아 Catalog 지표로 표시, Pair C에 `SqlResultDraft` 전달 | Catalog hydrate, selectedDataset consistency, `POST /api/query/runs`, read-only SQL guard, `SELECT COUNT(*)`, `GROUP BY` query evidence | 배포 환경에서 Catalog 목록/상세 조회, SQL read-only query smoke, 원격 API response 확인 | Catalog와 SQL은 화면 수는 적지만 데이터 계약과 query guard가 핵심이라 Pair A/C와 비슷한 난이도다 | 중상 |
| Pair C - Dashboard & Integration | Dashboard 목록/Builder/Widget, SQL 결과 기반 Widget, 저장/Publish, Published view, 전체 데모 runbook | Dashboard Core, Widget/Data, Published/Permission, Backend API Contract 중 Dashboard, Backend Integration Readiness 중 dashboard persistence | SQL 결과 기반 Table 위젯이 Dashboard Builder에 생기고 저장/게시 후 목록과 Published view에 유지됨, 최종 runbook으로 전체 흐름 재현 | Pair B의 `SqlResultDraft`를 받아 `Dashboard`/`Widget` 생성, Pair A/B의 smoke 결과를 최종 runbook에 포함 | Dashboard save/publish adapter, localStorage fallback, `sourceRunId` consistency, frontend build, console error 없음, full flow smoke | frontend build/preview 접속, Dashboard smoke, 배포 URL smoke, 발표용 runbook과 screenshot/curl 증거 정리 | API/QA만 맡지 않고 Dashboard 최종 사용자 화면을 책임지므로 볼륨이 균형 잡힌다 | 중상 |

## 10-3. 4일 마일스톤 계획

| Day | Milestone ID | Pair | 사용자 관점 결과물 | 기술 검증 결과물 | 배포 검증 결과물 | 대상 화면/Route | 클릭 시나리오 | 코드 산출물 | API/State 연결 | 데이터 규모 | 실행/배포 환경 | 완료 판정 기준 | Fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Day 1 오전 | DAY1-A-ETL-CREATE | Pair A | 사용자가 Review 화면에서 생성 버튼을 수행하면, `POST /api/etl/jobs` 또는 mock state 변경이 일어나고, ETL 목록과 Catalog에서 새 Job/Dataset을 확인할 수 있다. | create request/response, Job ID, Dataset ID, audit log, console error 없음 | local backend `/health` 또는 stub `/health` 200, create API smoke 기록 | `/etl/create/review`, `/etl/jobs`, `/catalog`; FlowId `review`, `jobs`, `catalog` | Source->Schema->Rule->Schedule->Permission->Target->Review->생성->목록->Catalog | `createPipelineDraft` adapter shape, `jobs/datasets` prepend, selected state 갱신, Toast/error 유지 | `DraftPipeline -> { job, dataset }`, `selectedJob`, `selectedDataset` | 100MB~500MB sample fixture | local mock, local live stub | 생성 후 Job `스케줄됨`, Dataset `사용 가능`, Toast 표시, mock/live mode 동일 클릭 | API 미준비 시 `mockApi.ts` 생성 응답 유지 |
| Day 1 오후 | DAY1-B-CATALOG-SQL-CONTEXT | Pair B | 사용자가 Catalog에서 Dataset을 선택하고 SQL로 열기를 수행하면, `selectedDataset` 변경이 일어나고, SQL 화면에서 Dataset 이름/schema/default query를 확인할 수 있다. | Catalog response mapper, selectedDataset log, SQL default query, console error 없음 | local Catalog 목록 조회 또는 mock fallback smoke 기록 | `/catalog`, `/catalog/{datasetId}`, `/analyze/sql`; FlowId `catalog`, `catalogDetail`, `sql` | Catalog->Dataset 선택->쿼리 편집기에서 열기->SQL context 확인 | Catalog hydrate 계획, loading/error/fallback, SQL default query 재계산, Dataset mapper | `GET /api/catalog/datasets`, `selectedDataset -> SqlAnalysisPage` | 100MB~500MB sample Dataset | local mock, local live stub | SQL `FROM`이 선택 Dataset과 일치하고 schema chip이 보임 | Catalog API 실패 시 mock dataset 목록 사용 |
| Day 1 오후 | DAY1-C-DASHBOARD-SEED-WIDGET | Pair C | 사용자가 Dashboard에서 SQL result fixture로 대시보드 만들기를 수행하면, `DashboardRecord` draft가 생성되고, Builder에서 Table 위젯을 확인할 수 있다. | `DashboardRecord`/`Widget` fixture, localStorage key, `sourceRunId` sample, console error 없음 | `npm run build` 계획과 env checklist, local frontend 접속 smoke 기록 | `/dashboards`, `/dashboards/{dashboardId}`; FlowId `dashboard` | Dashboard->대시보드 만들기 또는 SQL fixture 진입->Table 위젯 추가->Draft 확인 | Dashboard fixture, widget source mapping, localStorage fallback 기준, build checklist | `SqlResultDraft fixture -> DashboardRecord -> Widget` | 100MB~500MB sample result | local mock | Builder에 `SQL 결과 테이블` 위젯과 Draft 상태가 보임 | SQL handoff 미준비 시 fixture result로 시작 |
| Day 2 오전 | DAY2-A-RUN-HISTORY-DAG-1GB | Pair A | 사용자가 ETL 목록에서 즉시 실행을 수행하면, command 응답과 Run state 변경이 일어나고, 목록/상세/실행 이력/DAG에서 같은 Run ID와 1GB 처리 증거를 확인할 수 있다. | command response, `Run`, DAG step, 1GB input bytes/rows/duration/output path artifact | Job command API smoke, backend `/health`, local compose 또는 stub 실행 로그 | `/etl/jobs`, `/etl/jobs/{jobId}`, `/runs`, `/dag`; FlowId `jobs`, `jobDetail`, `jobRuns`, `jobDag` | Job 즉시 실행->상세->실행 이력->DAG | `runsByJobId`, `selectedRun`, DAG mapper, `DataProcessingResult` mapper | `POST /api/etl/jobs/{jobId}/commands`, `Run`, `dagSteps`, `datasetPatch` | 1GB sample | local live stub 또는 local processing script | `실행 중`, `Run ID`, `1.0GB`, `output path`가 같은 Run으로 보임 | 1GB 늦으면 500MB 이상 실제 처리 + caveat |
| Day 2 오후 | DAY2-B-SQL-READONLY-RESULT-1GB | Pair B | 사용자가 1GB Dataset을 SQL 화면에서 SELECT 실행하면, query run 응답이 일어나고, Result preview에서 row count와 결과 테이블을 확인할 수 있다. | `POST /api/query/runs`, `SqlResultDraft`, read-only guard 차단 로그, `SELECT COUNT(*)` 결과 | SQL API smoke curl, remote-ready env 값 기록 | `/catalog`, `/analyze/sql`; FlowId `catalog`, `sql` | 1GB Dataset 선택->SQL 열기->SELECT COUNT 실행->변경 SQL 차단 확인 | `SqlResultDraft` 우선 렌더링, read-only guard, query error state | `Dataset -> { datasetId, query } -> SqlResultDraft` | 1GB sample result | local mock/live stub | SELECT/WITH만 실행되고 INSERT/UPDATE/DELETE/DROP은 차단됨 | SQL API 실패 시 sampleRows 기반 result 생성 |
| Day 2 오후 | DAY2-C-DASHBOARD-SAVE-PUBLISH | Pair C | 사용자가 SQL 결과에서 Dashboard 생성 후 저장/Publish를 수행하면, dashboard 저장 상태 변경이 일어나고, 목록과 Published view에서 같은 위젯을 확인할 수 있다. | dashboard id, widget count, localStorage/API response, publish audit log | frontend build, preview 접속, Dashboard smoke 기록 | `/dashboards`, `/dashboards/{dashboardId}`; FlowId `dashboard` | SQL 결과->대시보드 생성->저장->Publish->목록->게시된 대시보드 보기 | save/publish adapter 계획, `DashboardRecord`, pending/error/fallback state | `POST /api/dashboards`, `PATCH`, `POST /publish`, localStorage fallback | 1GB SQL result | local mock/live stub | 새로고침 후에도 localStorage fallback 목록에 Draft/Published가 남음 | Dashboard API 실패 시 localStorage snapshot 사용 |
| Day 3 오전 | DAY3-A-10GB-BATCH-RUN-EVIDENCE | Pair A | 사용자가 10GB Job을 실행하면, batch run evidence가 생성되고, 실행 이력 화면에서 input size, rows, duration, output path, 성공 Run ID를 확인할 수 있다. | 10GB processing artifact 또는 caveat 있는 scale report, retry/error log, checksum | AWS EC2 또는 팀 VM backend `/health`, Job command smoke | `/etl/jobs/{jobId}/runs`, `/etl/jobs/{jobId}/dag`; FlowId `jobRuns`, `jobDag` | 10GB Job 선택->즉시 실행->실행 이력->DAG 상태 확인 | processing artifact index, `DataProcessingResult` mapper, retry/error log link | `Run -> DataProcessingResult`, `datasetPatch`, DAG final state | 10GB 실제 batch 또는 1GB 실제 + synthetic 10GB | EC2/VM + Docker Compose 또는 local fallback | `10GB`, row count, duration, output path, Run ID가 화면과 artifact에 남음 | 10GB 실패 시 1GB 실제 + synthetic scale report를 문서/화면에 명시 |
| Day 3 오후 | DAY3-B-10GB-CATALOG-SQL | Pair B | 사용자가 Catalog에서 10GB Dataset을 선택하고 SQL로 열어 COUNT query를 실행하면, Dataset 지표와 SQL 결과에서 10GB 처리 결과를 확인할 수 있다. | Catalog dataset patch, `SELECT COUNT(*)`, `GROUP BY` result, query runId, schema/freshness evidence | 배포 환경 Catalog 목록/상세 API smoke, SQL query smoke | `/catalog`, `/catalog/{datasetId}`, `/analyze/sql`; FlowId `catalog`, `catalogDetail`, `sql` | Catalog에서 10GB Dataset 선택->SQL 열기->COUNT/GROUP BY 실행 | 10GB dataset mapper, SQL result fixture/adapter, empty/error/fallback state | `DataProcessingResult -> Dataset`, `POST /api/query/runs` | 10GB processed Dataset | EC2/VM live API 또는 mock fallback | Catalog에 `10.0GB+`, rows, lastUpdated가 보이고 SQL count가 성공 | SQL backend 미준비 시 count fixture와 caveat 표시 |
| Day 3 오후 | DAY3-C-10GB-DASHBOARD-PUBLISHED | Pair C | 사용자가 10GB SQL 결과로 Dashboard 만들기와 Publish를 수행하면, Dashboard state가 저장되고, Published view에서 10GB Dataset 기반 Table/KPI 위젯을 확인할 수 있다. | `sourceRunId`, dashboard snapshot, widget data source, published status, screenshot | 배포 URL에서 frontend/Dashboard smoke, build artifact 기록 | `/dashboards`, `/dashboards/{dashboardId}/published`; FlowId `dashboard` | SQL result->대시보드 생성->Table/KPI 위젯 확인->저장->Publish->Published view | published snapshot, 10GB badge/source 표시, widget source consistency check | `SqlResultDraft -> DashboardRecord -> Widget -> PublishedSnapshot` | 10GB SQL result | EC2/VM frontend + mock/live API | Published 화면에 10GB Dataset 이름, `Run ID`, 최소 1개 위젯 표시 | Dashboard API 미준비 시 localStorage published snapshot 사용 |
| Day 4 오전 | DAY4-A-ETL-HARDENING-RELEASE | Pair A | 사용자가 ETL 생성/실행 중 중복 클릭이나 API 실패를 만나면, error envelope 처리와 rollback이 일어나고, ETL 화면에서 입력값과 이전 Job 상태 유지 및 Toast를 확인할 수 있다. | 500/422/timeout fixture, rollback evidence, duplicate guard, console error 없음 | 배포 환경 backend `/health`, create/command smoke 최종 기록 | ETL 전체; FlowId `source`~`review`, `jobs`, `jobDetail`, `jobRuns`, `jobDag` | 생성->중복 클릭->실패 fixture->재시도->실행->취소 | error mapper, rollback checklist, selectedJob consistency, ETL smoke checklist | P0 ETL API, ErrorResponse, previous state snapshot | 10GB evidence fixture 연결 | release candidate env + mock fallback | 실패 후 앱이 죽지 않고 입력값/이전 Job이 유지됨 | live API 불안정 시 mock mode로 같은 클릭 순서 유지 |
| Day 4 오후 | DAY4-B-CATALOG-SQL-HARDENING-RELEASE | Pair B | 사용자가 Catalog->SQL 전체 경로를 반복하면, Dataset/SQL state consistency 검증이 일어나고, 같은 Dataset 기반 결과를 안정적으로 확인할 수 있다. | Catalog/SQL consistency log, read-only guard final, SQL snapshot, console error 없음 | 배포 환경 Catalog/SQL P0/P1 smoke 최종 기록 | `/catalog`, `/catalog/{datasetId}`, `/analyze/sql`; FlowId `catalog`, `catalogDetail`, `sql` | Catalog->Dataset 선택->SQL 열기->SELECT 실행->Dashboard handoff 확인 | final mapper fixes checklist, error/empty/loading checklist, SQL smoke checklist | `selectedDataset.id`, `SqlResultDraft.datasetId/runId` 일치 | 10GB Dataset + fallback sample | release candidate env + mock fallback | Dataset 이름/schema/row count가 화면마다 일치 | Catalog/SQL API 실패 시 stable snapshot fixture |
| Day 4 오후 | DAY4-C-FINAL-DEMO-RUNBOOK | Pair C | 발표자가 runbook대로 Dashboard Publish까지 수행하면, final fixture와 배포 smoke가 사용되고, 전체 흐름과 10GB 증거를 5분 안에 확인할 수 있다. | final runbook, frontend build result, P0/P1 smoke result, 10GB artifact index, known issues | 배포 URL 접속, frontend smoke, Dashboard smoke, curl 결과, screenshot | 전체 FlowId, `/health`, P0/P1 API | runbook 열기->Source/Review 생성->실행->Catalog->SQL->Dashboard->Publish->10GB 증거 확인 | runbook, artifact index, fixture index, release checklist, known issues | mock/live toggle, DeploymentCheckResult, Dashboard final snapshot | 10GB result | release candidate env + local fallback | 발표자가 runbook만 보고 전체 경로를 재현함 | 배포 실패 시 local preview + mock mode runbook |

### 10-3B. 결과물 카드

#### DAY1-A-ETL-CREATE

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY1-A-ETL-CREATE |
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 마일스톤 이름 | 새 수집/처리 생성 결과가 ETL 목록과 Catalog에 동시에 반영된다 |
| 사용자가 보는 최종 결과 | 사용자가 Review 화면에서 `생성` 버튼을 수행하면, `POST /api/etl/jobs` 또는 `createPipelineDraft` 호출이 일어나고, ETL 목록에서 새 Job 카드와 Catalog에서 새 Dataset 카드를 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | create request/response JSON, Job ID, Dataset ID, audit log, 성공/실패 Toast, console error 없음 |
| 배포 검증 결과 | local stub 또는 backend `/health` 200, create API smoke 결과, mock/live env 값 기록 |
| 대상 화면 / Route | 명세상 `/etl/create/review`, `/etl/jobs`, `/catalog`; 현재 FlowId `review`, `jobs`, `catalog` |
| 현재 UI 동작 | `ReviewPage`와 생성 버튼은 존재한다. `useAskLakeData.createPipeline`이 `createPipelineDraft`를 호출하고 `jobs`, `datasets`, `selectedJob`, `selectedDataset`을 갱신한다. 목록과 Catalog는 mock 데이터 중심이다. |
| 목표 UI 동작 | 생성 버튼 클릭 시 API 또는 mock adapter를 호출한다. 성공 응답의 `job`은 ETL 목록 최상단에 추가되고 `dataset`은 Catalog 목록 최상단에 추가된다. 실패 시 Error Toast가 뜨고 입력값은 유지된다. |
| 사용자 액션 | 1. Source, Schema, Rule, Schedule, Permission, Target 값을 입력한다. 2. Review에서 `생성`을 클릭한다. 3. 성공 Toast를 확인한다. 4. ETL 목록으로 이동한다. 5. 방금 만든 Job을 확인한다. 6. Catalog로 이동한다. 7. 방금 만든 Dataset을 확인한다. |
| 구현해야 하는 코드 결과물 | `createPipelineDraft` adapter shape 정리, 생성 응답 `jobs` prepend, 생성 응답 `datasets` prepend, `selectedJob/selectedDataset` 갱신, 중복 클릭 방지, 실패 Toast와 rollback |
| 연결해야 하는 API 또는 mock 함수 | `POST /api/etl/jobs`, fallback `createPipelineDraft(draftPipeline, jobCount)` |
| 필요한 request/response shape | Request: `jobName`, `sourceType`, `sourceLabel`, `schemaSummary`, `ruleSummary`, `scheduleLabel`, `permissionSummary`, `targetDataset`, `targetLayer`, `owner`. Response: `{ job: Job, dataset: Dataset }` |
| 화면에서 반드시 보여야 하는 텍스트 | `customer_review_daily_ingest`, `스케줄됨`, `customer_review_silver`, `파이프라인 생성 요청이 접수되었습니다.` |
| 성공 기준 | 생성 버튼 클릭 후 앱이 죽지 않는다. ETL 목록에 새 Job이 보인다. Catalog 목록에 새 Dataset이 보인다. 새 Job 상태가 `스케줄됨`으로 보인다. 실패 응답이면 Toast가 뜨고 입력값이 사라지지 않는다. |
| 검증 방법 | 브라우저 실제 클릭, Network 탭 요청 확인, mock mode/live mode 각각 확인, console error 확인 |
| 이 마일스톤에서 하지 않는 것 | 실제 Airflow DAG 생성, 실제 S3/Delta 적재, Source/Schema/Rule 중간 API 전체 연결 |
| Fallback | 백엔드 API가 준비되지 않으면 `mockApi.ts`의 `createPipelineDraft` 응답으로 동일 화면 흐름을 유지한다. |

#### DAY1-B-CATALOG-SQL-CONTEXT

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY1-B-CATALOG-SQL-CONTEXT |
| 담당 Pair | Pair B - Catalog & SQL Analysis |
| 마일스톤 이름 | Catalog에서 선택한 Dataset이 SQL 화면의 실행 context가 된다 |
| 사용자가 보는 최종 결과 | 사용자가 Catalog 화면에서 Dataset을 선택하고 `쿼리 편집기에서 열기`를 수행하면, `selectedDataset` 상태 변경이 일어나고, SQL 화면에서 Dataset 이름, schema chip, 기본 SELECT query를 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | `selectedDataset` state, SQL default query, Catalog hydrate 또는 fallback log, console error 없음 |
| 배포 검증 결과 | local Catalog 목록 API 또는 mock fallback smoke 결과, `VITE_USE_MOCK_API` 값 기록 |
| 대상 화면 / Route | 명세상 `/catalog`, `/catalog/{datasetId}`, `/analyze/sql`; 현재 FlowId `catalog`, `catalogDetail`, `sql` |
| 현재 UI 동작 | Catalog 목록/상세/리니지 화면은 mock 데이터로 표시된다. `openDatasetInSql` 흐름은 존재한다. hydrate loading/error 상태와 live API mapper는 부족하다. |
| 목표 UI 동작 | Catalog 목록을 API 또는 mock으로 hydrate한다. Dataset 선택 시 `selectedDataset`이 안정적으로 갱신된다. SQL 화면 default query의 `FROM`이 선택 Dataset 이름과 일치한다. |
| 사용자 액션 | 1. Catalog 화면을 연다. 2. Dataset을 선택한다. 3. `쿼리 편집기에서 열기`를 누른다. 4. SQL 화면에서 Dataset 이름과 schema를 확인한다. 5. Query editor의 `FROM` 절이 선택 Dataset인지 확인한다. |
| 구현해야 하는 코드 결과물 | Catalog hydrate adapter 계획, backend response mapper, loading/error/fallback 상태, `selectedDataset` 전달 안정화, SQL default query 재계산 |
| 연결해야 하는 API 또는 mock 함수 | `GET /api/catalog/datasets`, `GET /api/catalog/datasets/{datasetId}`, fallback `catalogDatasets` mock data |
| 필요한 request/response shape | 목록 Response: `{ datasets: Dataset[], page?: { cursor?: string, hasNext: boolean } }`. 상세 Response: `Dataset` |
| 화면에서 반드시 보여야 하는 텍스트 | 선택 Dataset 이름, `SQL CONTEXT`, `읽기 전용 SQL 실행`, `SELECT ... FROM customer_review_silver LIMIT 100;` |
| 성공 기준 | Catalog에서 선택한 Dataset 이름이 SQL 화면에 그대로 보인다. schema chip이 Dataset schema와 일치한다. 기본 query의 `FROM`이 선택 Dataset과 일치한다. API 실패 시 mock 목록이 유지된다. |
| 검증 방법 | Catalog 선택 후 SQL 이동 클릭, Network 탭에서 Catalog API 또는 fallback 확인, SQL editor query 확인, console error 확인 |
| 이 마일스톤에서 하지 않는 것 | 서버 검색/정렬 완성, bookmark API, 컬럼 단위 lineage 신규 구현 |
| Fallback | Catalog API가 실패하면 기존 mock Dataset 목록을 사용하고 Toast 또는 audit log에 fallback 사실을 남긴다. |

#### DAY1-C-DASHBOARD-SEED-WIDGET

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY1-C-DASHBOARD-SEED-WIDGET |
| 담당 Pair | Pair C - Dashboard & Integration |
| 마일스톤 이름 | Dashboard Builder가 SQL 결과 fixture로 Table 위젯을 만들 수 있다 |
| 사용자가 보는 최종 결과 | 사용자가 Dashboard 화면에서 SQL result fixture 기반 `대시보드 만들기`를 수행하면, `DashboardRecord` draft 생성이 일어나고, Builder에서 `SQL 결과 테이블` 위젯을 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | `DashboardRecord` fixture, `Widget` fixture, localStorage key, `sourceRunId` sample, console error 없음 |
| 배포 검증 결과 | frontend build command와 env checklist, local frontend 접속 smoke 결과 |
| 대상 화면 / Route | 명세상 `/dashboards`, `/dashboards/{dashboardId}`; 현재 FlowId `dashboard` |
| 현재 UI 동작 | Dashboard 목록/Builder/Published 성격의 화면이 있고 SQL 결과에서 Builder로 진입할 수 있다. 저장은 localStorage 중심이고 dashboard API adapter는 없다. |
| 목표 UI 동작 | SQL 결과가 없어도 fixture로 Builder를 열 수 있다. Table 위젯의 source가 `SqlResultDraft.runId`와 연결된다. 저장/게시 전 Draft 상태가 명확히 보인다. |
| 사용자 액션 | 1. Dashboard 메뉴를 연다. 2. 대시보드 만들기를 누른다. 3. SQL result fixture를 선택한다. 4. Table 위젯을 추가한다. 5. Builder에서 Draft 상태와 위젯 source를 확인한다. |
| 구현해야 하는 코드 결과물 | Dashboard fixture, widget source mapping, localStorage fallback 기준, Day 2 save/publish adapter 계약 |
| 연결해야 하는 API 또는 mock 함수 | Day 1은 fixture/localStorage, Day 2부터 `POST /api/dashboards` 후보 |
| 필요한 request/response shape | `SqlResultDraft -> DashboardRecord`, `DashboardRecord.widgets[] -> Widget` |
| 화면에서 반드시 보여야 하는 텍스트 | `Dashboard`, `SQL Result Dashboard`, `SQL 결과 테이블`, `Draft` |
| 성공 기준 | Dashboard Builder에 최소 1개 Table 위젯이 보인다. 위젯 source가 SQL result fixture와 연결되어 있다. console error가 없다. |
| 검증 방법 | Dashboard 진입, Builder 열기, 위젯 추가, localStorage 확인, console error 확인 |
| 이 마일스톤에서 하지 않는 것 | Dashboard 저장 API 완성, 공유/권한 backend, drag/resize 저장 |
| Fallback | Pair B의 SQL handoff가 늦으면 `SqlResultDraft` fixture로 Builder를 먼저 완성한다. |

#### DAY2-A-RUN-HISTORY-DAG-1GB

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY2-A-RUN-HISTORY-DAG-1GB |
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 마일스톤 이름 | Job 실행 상태와 1GB 처리 증거가 목록, 상세, 실행 이력, DAG에 같이 반영된다 |
| 사용자가 보는 최종 결과 | 사용자가 ETL 목록에서 `즉시 실행` 또는 `다시 실행`을 수행하면, command 응답과 Run state 변경이 일어나고, 목록/상세/실행 이력/DAG에서 같은 Run ID와 1GB 처리 증거를 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | command response, run row, DAG step state, 1GB input bytes, row count, duration, output path artifact |
| 배포 검증 결과 | Job command API smoke curl, backend `/health`, local compose 또는 stub 로그 |
| 대상 화면 / Route | 명세상 `/etl/jobs`, `/etl/jobs/{jobId}`, `/etl/jobs/{jobId}/runs`, `/etl/jobs/{jobId}/dag`; 현재 FlowId `jobs`, `jobDetail`, `jobRuns`, `jobDag` |
| 현재 UI 동작 | 목록과 상세는 `JobRowData` 상태 기반으로 표시된다. 실행 이력과 DAG는 정적 mock 비중이 크고, `runId` 기준 state는 없다. |
| 목표 UI 동작 | command 응답으로 Job 상태, Run row, DAG step, processing evidence를 함께 갱신한다. 목록, 상세, 실행 이력, DAG가 같은 `selectedJob`과 `selectedRun` 기준으로 표시된다. |
| 사용자 액션 | 1. ETL 목록에서 Job을 찾는다. 2. `즉시 실행` 또는 `다시 실행`을 누른다. 3. 목록 카드가 `실행 중`으로 바뀌는지 확인한다. 4. 상세 화면을 연다. 5. 실행 이력 탭에서 1GB 증거를 본다. 6. DAG 탭에서 같은 Run 단계를 본다. |
| 구현해야 하는 코드 결과물 | `runsByJobId` state, `selectedRun`, `dagByRunId` state, command response mapper, 1GB `DataProcessingResult`, 실행 실패 rollback |
| 연결해야 하는 API 또는 mock 함수 | `POST /api/etl/jobs/{jobId}/commands`, `GET /api/etl/jobs/{jobId}/runs`, `GET /api/etl/jobs/{jobId}/dag`, fallback `runJobCommand(job, command)` |
| 필요한 request/response shape | Request: `{ command: "run" \| "retry" \| "pause" \| "cancel" }`. Response: `{ action, apiPath, job, run?, dagSteps?, datasetPatch?, processingResult? }` |
| 화면에서 반드시 보여야 하는 텍스트 | `실행 중`, `1/8 단계 · Source 연결`, `Run ID`, `1.0GB`, `output path` |
| 성공 기준 | 즉시 실행 후 목록/상세/이력/DAG가 같은 Run 상태를 보여준다. 1GB 이상 처리 증거가 화면과 artifact에 남는다. API 실패 시 이전 상태를 유지한다. |
| 검증 방법 | 목록 실행 버튼 클릭, 상세/실행 이력/DAG 탭 확인, command API request/response 확인, artifact 파일 확인 |
| 이 마일스톤에서 하지 않는 것 | 실시간 log streaming, Airflow task log, production 최적화 |
| Fallback | runs/DAG API가 없으면 command 응답으로 local run/DAG를 만들고, 1GB가 늦으면 500MB 이상 실제 처리와 caveat를 남긴다. |

#### DAY2-B-SQL-READONLY-RESULT-1GB

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY2-B-SQL-READONLY-RESULT-1GB |
| 담당 Pair | Pair B - Catalog & SQL Analysis |
| 마일스톤 이름 | 1GB Dataset에서 read-only SQL 실행 결과가 Result preview에 표시된다 |
| 사용자가 보는 최종 결과 | 사용자가 SQL 화면에서 1GB Dataset 기준 `SELECT COUNT(*)`를 수행하면, query run 응답이 일어나고, SQL 화면에서 `Run ID`, row count, 결과 테이블을 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | `POST /api/query/runs` 응답, `SqlResultDraft`, read-only guard 차단 로그, query execution time |
| 배포 검증 결과 | SQL API smoke curl, local/live mode query 결과 비교 |
| 대상 화면 / Route | 명세상 `/catalog`, `/analyze/sql`; 현재 FlowId `catalog`, `sql` |
| 현재 UI 동작 | SQL 실행 mock 함수와 Dashboard 이동 함수는 존재한다. 하지만 변경성 SQL 차단과 결과 테이블의 `SqlResultDraft` 우선 표시가 부족하다. |
| 목표 UI 동작 | SQL 실행 성공 시 API response의 `columns/rows`를 우선 표시한다. 변경성 SQL은 실행 전에 차단한다. SQL 결과는 Dashboard handoff에 사용된다. |
| 사용자 액션 | 1. 1GB Dataset을 SQL로 연다. 2. 기본 query를 `SELECT COUNT(*)` 또는 `GROUP BY`로 실행한다. 3. 결과 테이블을 확인한다. 4. `DROP TABLE` 등 변경성 query가 차단되는지 확인한다. |
| 구현해야 하는 코드 결과물 | SQL result table source를 `SqlResultDraft` 우선으로 변경, read-only SQL guard, SQL 실패 Toast/audit log, query pending/error state |
| 연결해야 하는 API 또는 mock 함수 | `POST /api/query/runs`, fallback `executeQueryDraft(dataset, query)` |
| 필요한 request/response shape | Request: `{ datasetId, query }`. Response: `{ runId, datasetId, datasetName, query, columns, rows, rowCount, executedAt }` |
| 화면에서 반드시 보여야 하는 텍스트 | `RESULT PREVIEW`, `Run ID`, `SELECT COUNT(*)`, `읽기 전용 SQL 실행` |
| 성공 기준 | SELECT/WITH query 실행이 성공한다. `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`가 차단된다. row count와 결과 테이블이 표시된다. |
| 검증 방법 | SELECT query 실행, 변경 query 차단 확인, Network 탭, console error 확인 |
| 이 마일스톤에서 하지 않는 것 | Lake 저장 완성, CSV export 완성, 서버 SQL formatter 완성, multi-dataset join optimizer |
| Fallback | SQL API 실패 시 Dataset `sampleRows`로 `SqlResultDraft`를 만들고 fallback 사실을 audit log에 남긴다. |

#### DAY2-C-DASHBOARD-SAVE-PUBLISH

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY2-C-DASHBOARD-SAVE-PUBLISH |
| 담당 Pair | Pair C - Dashboard & Integration |
| 마일스톤 이름 | Dashboard 저장/게시 결과가 목록과 Published 화면에 유지된다 |
| 사용자가 보는 최종 결과 | 사용자가 Dashboard Builder에서 `저장`과 `Publish`를 수행하면, dashboard record 또는 localStorage snapshot 저장이 일어나고, Dashboard 목록과 Published 화면에서 같은 위젯을 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | dashboard id, widget count, `sourceRunId`, localStorage/API response, publish audit log |
| 배포 검증 결과 | `npm run build`, Vite preview 또는 정적 서빙 접속, Dashboard smoke screenshot |
| 대상 화면 / Route | 명세상 `/dashboards`, `/dashboards/{dashboardId}`; 현재 FlowId `dashboard` |
| 현재 UI 동작 | Builder, list, detail/published 성격의 화면이 있고 localStorage 목록 유지가 일부 있다. API adapter와 실패 fallback은 부족하다. |
| 목표 UI 동작 | API adapter 우선으로 save/publish를 호출하고 실패 시 localStorage snapshot으로 유지한다. 저장 후 목록에 보이고 Publish 후 detail/published view에 보인다. |
| 사용자 액션 | 1. SQL 결과에서 Dashboard 생성. 2. Builder에서 위젯 확인. 3. `저장` 클릭. 4. `Publish` 클릭. 5. 목록과 게시 화면 확인. |
| 구현해야 하는 코드 결과물 | dashboard create/save/publish adapter, `DashboardRecord` type, pending/error state, localStorage fallback, publish status 표시 |
| 연결해야 하는 API 또는 mock 함수 | `POST /api/dashboards`, `PATCH /api/dashboards/{dashboardId}`, `POST /api/dashboards/{dashboardId}/publish`, fallback localStorage |
| 필요한 request/response shape | Response: `{ id, name, datasetId, sourceRunId?, status: "Draft" \| "Published", widgets }` |
| 화면에서 반드시 보여야 하는 텍스트 | `SQL Result Dashboard`, `SQL 결과 테이블`, `Draft`, `Published`, `게시된 대시보드 보기` |
| 성공 기준 | 저장 후 목록에 남는다. Publish 후 Published 화면에 위젯이 보인다. 새로고침 후에도 localStorage fallback 목록이 유지된다. API 실패 시 Error Toast 또는 audit log가 남는다. |
| 검증 방법 | 저장/게시 클릭, 목록 이동, published view 열기, 새로고침, API 실패 fallback 확인 |
| 이 마일스톤에서 하지 않는 것 | drag/resize 저장, 공유/권한 modal 전체 backend, PDF/PNG export |
| Fallback | dashboard API가 없으면 localStorage로 목록/게시 상태를 유지한다. |

#### DAY3-A-10GB-BATCH-RUN-EVIDENCE

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY3-A-10GB-BATCH-RUN-EVIDENCE |
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 마일스톤 이름 | 10GB급 batch 처리 검증 증거가 실행 이력과 DAG에 남는다 |
| 사용자가 보는 최종 결과 | 사용자가 10GB demo Job에서 `즉시 실행`을 수행하면, batch run evidence 생성이 일어나고, 실행 이력과 DAG에서 `10GB`, row count, duration, output path, 성공 Run ID를 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | 10GB processing artifact 또는 scale report, input bytes, row count, output path, duration, output files, retry/error log, checksum |
| 배포 검증 결과 | EC2 또는 팀 VM backend `/health`, Job command API smoke, processing artifact 경로 접근 확인 |
| 대상 화면 / Route | 명세상 `/etl/jobs/{jobId}/runs`, `/etl/jobs/{jobId}/dag`; 현재 FlowId `jobRuns`, `jobDag` |
| 현재 UI 동작 | 앱에는 GB/TB급 예시 텍스트가 일부 있지만 특정 run evidence와 실행 이력이 일관되게 연결되지는 않는다. |
| 목표 UI 동작 | 10GB evidence가 같은 `runId`와 `datasetId`로 실행 이력, DAG, Catalog patch에 연결된다. 실제 10GB가 아니면 caveat가 화면/문서에 명확히 남는다. |
| 사용자 액션 | 1. 10GB demo Job을 선택한다. 2. `즉시 실행`을 누른다. 3. 실행 이력에서 input size/output path/duration을 확인한다. 4. DAG에서 성공 또는 실패/재시도 단계를 확인한다. |
| 구현해야 하는 코드 결과물 | 10GB evidence artifact, `DataProcessingResult` mapper, retry/error log link, artifact index, caveat 표시 규칙 |
| 연결해야 하는 API 또는 mock 함수 | `POST /api/etl/jobs/{jobId}/commands`, `GET /api/etl/runs/{runId}/processing-result`, fallback fixture |
| 필요한 request/response shape | Processing Response: `{ runId, datasetId, inputBytes, inputRows, outputBytes, outputPath, outputFiles, durationMs, status, scaleLabel: "10GB", caveat? }` |
| 화면에서 반드시 보여야 하는 텍스트 | `10GB`, `Run ID`, `input size`, `duration`, `output path`, `success` 또는 `retry` |
| 성공 기준 | 10GB 처리 증거가 화면과 artifact에 동시에 남는다. caveat가 있으면 숨기지 않고 문서와 화면 결과에 남긴다. |
| 검증 방법 | artifact 파일 확인, 실행 이력 확인, DAG 상태 확인, runId/datasetId 일치 확인 |
| 이 마일스톤에서 하지 않는 것 | 실시간 streaming 10GB, 모든 source type 10GB 검증, 운영급 분산 처리 최적화 |
| Fallback | 10GB 원본 준비가 늦으면 1GB 이상 실제 처리와 synthetic 10GB scale report를 남긴다. |

#### DAY3-B-10GB-CATALOG-SQL

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY3-B-10GB-CATALOG-SQL |
| 담당 Pair | Pair B - Catalog & SQL Analysis |
| 마일스톤 이름 | 10GB 처리 결과 Dataset이 Catalog와 SQL에서 조회된다 |
| 사용자가 보는 최종 결과 | 사용자가 Catalog에서 `customer_review_10gb_silver`를 선택하고 SQL로 열어 `SELECT COUNT(*)`를 수행하면, Dataset/SQL state 변경이 일어나고, Catalog/SQL 화면에서 `10GB`, rows, count result를 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | Catalog dataset patch, query runId, count query result, GROUP BY sample, schema/freshness evidence |
| 배포 검증 결과 | 배포 환경 Catalog 목록/상세 API smoke, SQL query smoke curl |
| 대상 화면 / Route | 명세상 `/catalog`, `/catalog/{datasetId}`, `/analyze/sql`; 현재 FlowId `catalog`, `catalogDetail`, `sql` |
| 현재 UI 동작 | Catalog는 mock rows/size를 표시하고 SQL은 dataset sampleRows 기반 result를 보여준다. 10GB evidence와 Dataset/SQL result 연결이 없다. |
| 목표 UI 동작 | 10GB processing evidence가 `Dataset.size`, `Dataset.rows`, `lastUpdated`, SQL count 결과로 반영된다. |
| 사용자 액션 | 1. Catalog에서 10GB Dataset을 선택한다. 2. 상세에서 size/rows/schema를 확인한다. 3. SQL로 연다. 4. `SELECT COUNT(*)`와 `GROUP BY` query를 실행한다. |
| 구현해야 하는 코드 결과물 | 10GB dataset mapper, Catalog empty/error/fallback state, SQL count fixture/adapter, `DataProcessingResult -> Dataset` mapper |
| 연결해야 하는 API 또는 mock 함수 | `GET /api/catalog/datasets/{datasetId}`, `POST /api/query/runs`, fallback `catalogDatasets`와 `executeQueryDraft` |
| 필요한 request/response shape | Dataset: `{ id, name, rows, size, schema, lastUpdated, processingResultId }`. Query Response: `SqlResultDraft` |
| 화면에서 반드시 보여야 하는 텍스트 | `customer_review_10gb_silver`, `10GB`, `12M+ rows`, `SELECT COUNT(*)`, `RESULT PREVIEW` |
| 성공 기준 | Catalog와 SQL에서 같은 Dataset ID가 보인다. 10GB size/rows와 count result가 일치한다. API 실패 시 fallback/caveat가 남는다. |
| 검증 방법 | Catalog 상세 확인, SQL count 실행, Network 탭, runId/datasetId 일치 확인 |
| 이 마일스톤에서 하지 않는 것 | full lineage backend, 서버 검색/정렬 고도화, SQL join optimizer |
| Fallback | SQL backend가 준비되지 않으면 count fixture를 사용하고 caveat를 화면/문서에 남긴다. |

#### DAY3-C-10GB-DASHBOARD-PUBLISHED

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY3-C-10GB-DASHBOARD-PUBLISHED |
| 담당 Pair | Pair C - Dashboard & Integration |
| 마일스톤 이름 | 10GB SQL 결과 기반 Dashboard가 Published view에 표시된다 |
| 사용자가 보는 최종 결과 | 사용자가 10GB SQL 결과에서 `대시보드 생성`과 `Publish`를 수행하면, Dashboard snapshot 저장이 일어나고, Published 화면에서 10GB Dataset 기반 Table/KPI 위젯을 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | `sourceRunId`, dashboard snapshot, widget source consistency, published status, screenshot |
| 배포 검증 결과 | 배포 URL frontend 접속, Dashboard smoke, build artifact |
| 대상 화면 / Route | 명세상 `/dashboards`, `/dashboards/{dashboardId}/published`; 현재 FlowId `dashboard` |
| 현재 UI 동작 | SQL result 기반 Builder는 가능하지만 10GB 표시, published snapshot, sourceRunId 일관성은 약하다. |
| 목표 UI 동작 | Table/KPI 위젯이 10GB SQL result를 source로 사용한다. Published view는 Draft와 분리된 snapshot처럼 보인다. 저장 실패 시 localStorage fallback이 동작한다. |
| 사용자 액션 | 1. 10GB SQL 결과에서 Dashboard 생성. 2. Table/KPI 위젯 확인. 3. 저장 클릭. 4. Publish 클릭. 5. Published view에서 같은 Dataset과 Run ID 확인. |
| 구현해야 하는 코드 결과물 | published snapshot, 10GB badge/source 표시, widget source consistency check, save/publish fallback |
| 연결해야 하는 API 또는 mock 함수 | `POST /api/dashboards`, `PATCH /api/dashboards/{dashboardId}`, `POST /api/dashboards/{dashboardId}/publish`, localStorage fallback |
| 필요한 request/response shape | `SqlResultDraft -> DashboardRecord -> Widget -> PublishedSnapshot` |
| 화면에서 반드시 보여야 하는 텍스트 | `10GB`, `Run ID`, `SQL 결과 테이블`, `KPI`, `Published` |
| 성공 기준 | Published 화면에 10GB Dataset 이름, Run ID, 최소 1개 위젯이 표시된다. 새로고침 후 fallback snapshot이 유지된다. |
| 검증 방법 | Dashboard 생성/저장/게시, published view 열기, 새로고침, sourceRunId consistency 확인 |
| 이 마일스톤에서 하지 않는 것 | 공유/권한 modal 실제 저장, public link 권한 정책, PDF export |
| Fallback | Dashboard API가 늦으면 localStorage published snapshot으로 발표 흐름을 유지한다. |

#### DAY4-A-ETL-HARDENING-RELEASE

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY4-A-ETL-HARDENING-RELEASE |
| 담당 Pair | Pair A - ETL Creation & Job Operations |
| 마일스톤 이름 | ETL 생성/실행 데모가 실패 상황에서도 끊기지 않는다 |
| 사용자가 보는 최종 결과 | 사용자가 ETL 생성과 실행을 반복하거나 API 실패를 만나면, error envelope 처리와 rollback이 일어나고, ETL 화면에서 입력값/이전 Job 상태 유지와 Toast 안내를 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | duplicate guard, rollback result, timeout/500/422 fixture, smoke checklist, console error 없음 |
| 배포 검증 결과 | release candidate 환경 backend `/health`, create/command smoke 최종 기록 |
| 대상 화면 / Route | ETL 전체 FlowId `source`, `schema`, `rules`, `repeat`, `manual`, `once`, `permission`, `target`, `review`, `jobs`, `jobDetail`, `jobRuns`, `jobDag` |
| 현재 UI 동작 | 성공 경로는 mock 중심으로 동작한다. 실패/중복/rollback 보강과 run evidence consistency가 필요하다. |
| 목표 UI 동작 | API 실패, 중복 클릭, 실행 중 재실행 등에서 앱이 멈추지 않는다. Toast가 보이고 이전 안정 상태가 유지된다. |
| 사용자 액션 | 1. Source부터 Review까지 진행한다. 2. 생성 클릭. 3. 즉시 실행 클릭. 4. 상세/이력/DAG 확인. 5. API 실패 상황에서도 Toast와 fallback을 확인한다. |
| 구현해야 하는 코드 결과물 | ETL smoke checklist, duplicate guard, failure rollback, selected consistency fix, error envelope mapper |
| 연결해야 하는 API 또는 mock 함수 | P0 ETL API, `createPipelineDraft`, `runJobCommand`, error fixture |
| 필요한 request/response shape | Error Response: `{ error: { code, message, details? } }`. Rollback state: previous `jobs`, `selectedJob`, `draftPipeline` 유지 |
| 화면에서 반드시 보여야 하는 텍스트 | `API 요청 처리 중...`, `파이프라인 생성 요청에 실패했습니다.`, `작업 명령 처리에 실패했습니다.`, 기존 Job 상태 |
| 성공 기준 | console error 없음. 실패 후 입력값 유지. 이전 Job 상태 유지. 중복 클릭으로 Job이 중복 생성되지 않음. |
| 검증 방법 | API 500/422/timeout fixture, 중복 클릭, 실행 중 취소, 실패 후 재시도 수동 확인 |
| 이 마일스톤에서 하지 않는 것 | 새 ETL 기능 추가, 데모와 무관한 UI redesign, 권한 시스템 전체 구현 |
| Fallback | live API가 불안정하면 mock mode로 전환하고 같은 클릭 순서로 발표한다. |

#### DAY4-B-CATALOG-SQL-HARDENING-RELEASE

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY4-B-CATALOG-SQL-HARDENING-RELEASE |
| 담당 Pair | Pair B - Catalog & SQL Analysis |
| 마일스톤 이름 | Catalog -> SQL 경로가 배포 환경에서도 같은 Dataset 기준으로 안정화된다 |
| 사용자가 보는 최종 결과 | 사용자가 Catalog에서 Dataset 선택 후 SQL 실행을 반복하면, Dataset/SQL state consistency 검증이 일어나고, SQL 화면과 Dashboard handoff에서 같은 Dataset 기반 결과를 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | Catalog/SQL consistency log, SQL result snapshot, read-only guard final, console error 없음 |
| 배포 검증 결과 | release candidate 환경 Catalog/SQL smoke, query API curl, screenshot |
| 대상 화면 / Route | 명세상 `/catalog`, `/catalog/{datasetId}`, `/analyze/sql`; 현재 FlowId `catalog`, `catalogDetail`, `sql` |
| 현재 UI 동작 | 개별 화면과 이동 함수는 존재한다. SQL result rendering, error fallback, Dataset consistency 최종 QA가 필요하다. |
| 목표 UI 동작 | Dataset, SQL result, Dashboard handoff가 같은 `datasetId`와 `runId`를 기준으로 보인다. API 실패 시 mock fallback이 동작한다. |
| 사용자 액션 | 1. Catalog에서 `customer_review_10gb_silver` 선택. 2. SQL 열기. 3. SELECT 실행. 4. 변경성 SQL 차단 확인. 5. Dashboard 생성 버튼까지 확인. |
| 구현해야 하는 코드 결과물 | Catalog/SQL smoke checklist, result rendering final fix, fallback final fix, runId/datasetId consistency check |
| 연결해야 하는 API 또는 mock 함수 | Catalog hydrate, `executeQueryDraft`, `POST /api/query/runs`, fallback fixture |
| 필요한 request/response shape | `selectedDataset.id`, `SqlResultDraft.datasetId`, `SqlResultDraft.runId` 일치 |
| 화면에서 반드시 보여야 하는 텍스트 | Dataset 이름, SQL columns, `Run ID`, `RESULT PREVIEW`, `읽기 전용 SQL 실행` |
| 성공 기준 | Dataset/columns/runId가 일치한다. read-only guard가 동작한다. API 실패 fallback이 보인다. |
| 검증 방법 | 전체 클릭 smoke, API 실패 fallback, Network 탭, console error 확인 |
| 이 마일스톤에서 하지 않는 것 | SQL 저장/Lake 저장/CSV export 완성, multi-dataset 권한 모델 |
| Fallback | API 실패 시 mock/local snapshot으로 계속 진행한다. |

#### DAY4-C-FINAL-DEMO-RUNBOOK

| 항목 | 내용 |
| --- | --- |
| 마일스톤 ID | DAY4-C-FINAL-DEMO-RUNBOOK |
| 담당 Pair | Pair C - Dashboard & Integration |
| 마일스톤 이름 | 발표자가 따라 할 수 있는 최종 runbook과 증거 묶음을 완성한다 |
| 사용자가 보는 최종 결과 | 발표자가 runbook 순서대로 전체 화면 클릭을 수행하면, mock/live toggle과 final fixture가 사용되고, ETL 생성부터 Dashboard Publish 및 10GB 증거까지 확인할 수 있다. |
| 기술적으로 남는 검증 결과 | final runbook, frontend build 결과, API health 결과, P0/P1 smoke 결과, 10GB 검증 결과, known issues, fallback 절차 |
| 배포 검증 결과 | 배포 URL 접속 결과, frontend/Dashboard smoke screenshot, curl 결과, local fallback 절차 |
| 대상 화면 / Route | 전체 FlowId, backend `/health`, P0/P1 API smoke endpoints |
| 현재 UI 동작 | 통합 문서와 발표용 fallback 절차가 부족하다. Dashboard 최종 화면은 있으나 release flow 증거 묶음이 없다. |
| 목표 UI 동작 | 발표자가 5분 안에 전체 데모를 재현한다. 문제가 생기면 mock fallback으로 전환해 같은 클릭 순서를 유지한다. |
| 사용자 액션 | 1. runbook을 연다. 2. demo mode를 선택한다. 3. Source/Review 생성부터 Dashboard Publish까지 클릭한다. 4. 10GB 증거를 확인한다. 5. 실패 시 fallback 절차를 따른다. |
| 구현해야 하는 코드 결과물 | 코드가 아니라 최종 runbook, smoke result, artifact index, fixture index, known issues 문서 |
| 연결해야 하는 API 또는 mock 함수 | mock/live toggle, P0/P1 smoke API, 10GB fixture, mock mode 전체 경로 |
| 필요한 request/response shape | P0 fixture, P1 Catalog/Dashboard fixture, Error envelope, `DataProcessingResult`, `DeploymentCheckResult` sample |
| 화면에서 반드시 보여야 하는 텍스트 | `파이프라인 생성 요청이 접수되었습니다.`, `실행 중`, `RESULT PREVIEW`, `SQL 결과 테이블`, `Published`, `10GB` |
| 성공 기준 | frontend build가 통과한다. live 또는 mock mode로 전체 발표 경로가 통과한다. API fixture와 10GB artifact가 존재한다. known issues와 fallback이 문서화된다. |
| 검증 방법 | build 실행, full browser smoke, API health/smoke 확인, 10GB artifact 확인, 발표자 리허설 |
| 이 마일스톤에서 하지 않는 것 | 새 기능 추가, production-grade 처리 플랫폼 완성, 데모와 무관한 refactor |
| Fallback | live API 실패 시 mock mode로 전환하고, 발표자는 같은 클릭 순서를 유지한다. |

## 10-4. 매일 통합 데모 시나리오

### Day 1 종료 데모

1. 사용자가 `수집/처리` 목록에서 `+ 새 수집/처리 생성`을 눌러 Source부터 Review까지 진입한다.
2. Review에서 `생성` 버튼을 누른다.
3. ETL 목록 최상단에 새 Job이 `스케줄됨` 상태로 보인다.
4. Catalog로 이동하면 새 Dataset이 최상단 또는 preview panel에 보이고, `쿼리 편집기에서 열기`를 누르면 SQL 화면에 Dataset 이름과 기본 query가 채워진다.
5. Dashboard로 이동하면 SQL result fixture 기반 Table 위젯 Draft가 보인다.
6. 기술 검증 증거로 create API request/response, selectedDataset log, Dashboard fixture/localStorage key, console error 없음 기록을 확인한다.
7. 배포 준비 증거로 local `/health` 또는 stub `/health`, frontend env checklist, local smoke screenshot을 남긴다.

### Day 2 종료 데모

1. 사용자가 ETL 목록에서 Day 1에 만든 Job의 `즉시 실행`을 누른다.
2. Job 카드가 `실행 중`과 `1/8 단계 · Source 연결` 진행률로 바뀐다.
3. 상세, 실행 이력, DAG로 이동해 같은 Run ID와 1GB 처리 증거를 확인한다.
4. Catalog에서 1GB Dataset을 SQL로 열고 `SELECT COUNT(*)`를 실행한다.
5. SQL 결과에서 `대시보드 생성`을 누르고 Dashboard Builder에서 Table 위젯을 저장/Publish한다.
6. 기술 검증 증거로 command response, 1GB input bytes/row count/duration/output path, `SqlResultDraft`, dashboard id/sourceRunId를 확인한다.
7. 배포 검증 증거로 local compose 또는 stub의 `/health`, Job command smoke, SQL API smoke, frontend build 결과를 남긴다.

### Day 3 종료 데모

1. 사용자가 10GB demo Job을 선택하고 `즉시 실행`을 누른다.
2. 실행 이력에서 `10GB`, row count, duration, output path, Run ID를 확인한다.
3. Catalog에서 `customer_review_10gb_silver`를 선택해 size/rows/schema/freshness를 확인한다.
4. SQL로 열어 `SELECT COUNT(*)`와 `GROUP BY` query를 실행한다.
5. SQL 결과로 Dashboard를 만들고 Published view에서 10GB Dataset 기반 Table/KPI 위젯을 확인한다.
6. 기술 검증 증거로 10GB processing artifact 또는 caveat 있는 scale report, SQL query result, dashboard published snapshot을 확인한다.
7. 배포 검증 증거로 EC2/VM `/health`, Catalog/SQL smoke, frontend 배포 URL 접속, Dashboard smoke screenshot을 남긴다.

### Day 4 종료 데모

1. 발표자가 final runbook을 열고 demo mode를 선택한다.
2. Source/Schema/Rule/Schedule/Permission/Target/Review를 지나 `생성`을 누른다.
3. ETL 목록, 즉시 실행, 상세, 실행 이력, DAG까지 끊기지 않는지 확인한다.
4. Catalog에서 생성 Dataset 또는 10GB Dataset을 SQL로 열고 read-only query를 실행한다.
5. Dashboard Builder에서 SQL 결과 기반 위젯을 확인하고 저장/Publish한다.
6. 기술 검증 증거로 final build, P0/P1 smoke, 10GB artifact index, known issues, fallback 절차를 확인한다.
7. 배포 환경에서는 frontend URL 접속, backend `/health`, P0 API 3개, Catalog/SQL/Dashboard smoke를 확인하고, 실패 시 local mock fallback으로 같은 클릭 순서를 재현한다.

## 10-5. Pair 간 API / 타입 계약

```ts
type JobStatus = "scheduled" | "running" | "paused" | "failed" | "success" | "canceled";
type Layer = "RAW" | "BRONZE" | "SILVER" | "GOLD";

interface Job {
  id: string;
  name: string;
  owner: string;
  status: JobStatus;
  source: string;
  targetDatasetId: string;
  targetDatasetName: string;
  scheduleLabel: string;
  lastRunId?: string;
  progress?: { label: string; value: number };
}

interface Run {
  id: string;
  jobId: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
  currentStep: string;
  startedAt: string;
  endedAt?: string;
  inputBytes?: number;
  inputRows?: number;
  outputBytes?: number;
  outputPath?: string;
  durationMs?: number;
}

interface Dataset {
  id: string;
  name: string;
  layer: Layer;
  status: "available" | "needs_approval" | "processing" | "failed";
  owner: string;
  rows: number;
  sizeBytes: number;
  qualityScore?: number;
  lastUpdated: string;
  sourceRunId?: string;
  schema: Array<{ name: string; type: string; nullable?: boolean }>;
  sampleRows?: string[][];
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
}

interface Dashboard {
  id: string;
  name: string;
  datasetId: string;
  sourceRunId?: string;
  status: "Draft" | "Published";
  widgets: Widget[];
  updatedAt: string;
}

interface Widget {
  id: string;
  dashboardId: string;
  type: "kpi" | "bar" | "line" | "donut" | "table";
  title: string;
  sourceRunId?: string;
  columns: string[];
}

interface ErrorResponse {
  error: {
    code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "INVALID_JOB_STATE" | "SQL_SYNTAX_ERROR" | "BACKEND_TIMEOUT" | "INTERNAL_ERROR";
    message: string;
    details?: unknown;
  };
}

interface DataProcessingResult {
  runId: string;
  datasetId: string;
  inputBytes: number;
  inputRows: number;
  outputBytes: number;
  outputPath: string;
  outputFiles: number;
  durationMs: number;
  status: "success" | "failed";
  scaleLabel: "100MB" | "500MB" | "1GB" | "10GB";
  retryCount?: number;
  errorLogPath?: string;
  caveat?: string;
}

interface DeploymentCheckResult {
  environment: "local" | "team-vm" | "aws-ec2";
  frontendUrl: string;
  apiBaseUrl: string;
  frontendBuild: "pass" | "fail";
  backendHealth: "pass" | "fail";
  p0Smoke: Array<{ endpoint: string; status: number; passed: boolean }>;
  checkedAt: string;
  fallbackMode?: "mock" | "local-stub";
}
```

## 10-6. 10GB 처리 검증 계획

### [10GB 처리 증거]

- 어떤 데이터셋을 사용할 것인가?: 발표 인사이트용 실제 공개 데이터셋 후보는 NYC TLC Yellow Taxi Trip Records 또는 고객 리뷰 성격의 공개 CSV/Parquet 데이터셋으로 잡는다. 성능 검증용으로는 같은 schema를 synthetic 확장해 `customer_review_10gb_raw`를 만든다.
- 원본 크기는 몇 GB인가?: 최소 10.0GB 이상, 목표 10.4GB.
- 실제 데이터인가 synthetic 확장 데이터인가?: 실제 공개 데이터 일부 + synthetic 확장 데이터를 분리한다. 실제 10GB 원본 확보가 가능하면 caveat 없이 진행하고, 불가능하면 1GB 실제 처리 + 10GB synthetic scale report를 명시한다.
- 몇 row를 처리할 것인가?: 목표 12M rows 이상. 실제 row 수는 artifact의 `inputRows`로 기록한다.
- 처리 시간은 어떻게 측정할 것인가?: ETL command 시작/종료 timestamp와 processing script log의 wall clock duration을 모두 남긴다.
- 결과는 어디에 저장할 것인가?: PoC 기준 local/EC2의 `/data/asklake/output/customer_review_10gb_silver/run_<id>/` 또는 object storage equivalent path.
- 실패/재시도 로그가 남는가?: `retryCount`, `errorLogPath`, 실패 step, error envelope를 `DataProcessingResult`와 runbook artifact index에 남긴다.
- Catalog/SQL/Dashboard에서 확인 가능한가?: Day 4 기준 Catalog `size/rows/lastUpdated`, SQL `SELECT COUNT(*)`, Dashboard `SQL 결과 테이블` 위젯에서 확인한다.

| Day | 처리 목표 | 화면 연결 | 완료 증거 | 담당 |
| --- | --- | --- | --- | --- |
| Day 1 | 100MB~500MB sample 처리 또는 fixture로 전체 UI/API 흐름 검증 | 생성 Job/Dataset, SQL context, Dashboard draft | create response, sample Dataset, SQL default query, Dashboard fixture | A/B/C |
| Day 2 | 1GB sample batch 처리 | 실행 이력, Catalog, SQL Result, Dashboard Publish | input bytes, row count, duration, output path, 1GB runId | A 주, B/C 확인 |
| Day 3 | 10GB 실제 batch run 또는 1GB 실제 + 10GB synthetic scale report | 실행 이력, DAG, Catalog, SQL, Published Dashboard | 10GB artifact, count query, output path, caveat 여부 | A 주, B/C 화면 연결 |
| Day 4 | 10GB 처리 결과를 최종 데모 흐름에 연결 | Source -> ETL -> Catalog -> SQL -> Dashboard -> Published | final artifact index, screenshot, smoke result, runbook | A/B/C |

## 10-7. 최소 배포 검증 계획

### [배포 검증 증거]

- 어떤 환경에 배포할 것인가?: AWS EC2 1대 또는 팀 공유 VM 1대. 실행 방식은 Docker Compose를 우선하고, 시간이 부족하면 frontend 정적 서빙 + backend stub 프로세스로 제한한다.
- frontend와 backend를 각각 어떻게 실행할 것인가?: frontend는 `npm run build` 후 Vite preview 또는 nginx/static server. backend는 `/health`, P0 API 3개, P1 Catalog/SQL/Dashboard smoke endpoint를 제공하는 최소 service 또는 stub.
- 환경 변수는 무엇이 필요한가?: `VITE_API_BASE_URL`, `VITE_USE_MOCK_API`, `ASKLAKE_DEMO_MODE`, `DATA_ROOT`, `PROCESSING_OUTPUT_ROOT`.
- 배포 URL 또는 IP는 무엇인가?: Day 3에 `http://<EC2_PUBLIC_IP>:5173` 또는 `http://<TEAM_VM_IP>:5173`로 확정하고 runbook에 기록한다. API는 `http://<HOST>:8080`.
- backend `/health`는 어떻게 확인할 것인가?: `curl -s http://<HOST>:8080/health`가 `{ "status": "ok" }` 또는 동등한 200 JSON을 반환해야 한다.
- P0 API smoke는 어떤 요청으로 확인할 것인가?: `POST /api/etl/jobs`, `POST /api/etl/jobs/{jobId}/commands`, `POST /api/query/runs`.
- frontend에서 원격 API 응답을 실제로 받는지 어떻게 확인할 것인가?: `VITE_USE_MOCK_API=false`로 배포 URL 접속 후 Network 탭과 audit log에서 원격 API host를 확인한다.
- 배포 실패 시 local fallback은 무엇인가?: local `npm run dev` 또는 `npm run preview` + `VITE_USE_MOCK_API=true`로 같은 클릭 순서를 유지한다.
- 배포 결과로 무엇을 남길 것인가?: build log, `/health` curl 결과, P0/P1 smoke curl 결과, frontend screenshot, Dashboard screenshot, 10GB artifact index, final runbook.

| Day | 배포 목표 | Pair별 분담 | 완료 증거 | 운영급에서 제외할 것 |
| --- | --- | --- | --- | --- |
| Day 1 | local build/env 정리, `/health` stub 확인 | A: backend health 계약, B: Catalog/SQL base URL 확인, C: frontend env/build checklist | env sample, `/health` result, local screenshot | TLS/도메인/CI/CD |
| Day 2 | Docker Compose 또는 단일 실행 스크립트로 backend/frontend smoke | A: Job command smoke, B: SQL smoke, C: Dashboard build/preview smoke | build log, P0 curl, frontend preview URL | 운영급 로그 수집 |
| Day 3 | EC2/VM에서 `/health`와 P0/P1 smoke | A: backend/run health, B: Catalog/SQL remote smoke, C: frontend/Dashboard remote smoke | remote curl, screenshots, smoke table | EKS/ALB/오토스케일링 |
| Day 4 | 배포 URL에서 핵심 경로 smoke | A: ETL create/run, B: Catalog/SQL, C: Dashboard/Published/runbook | final smoke result, known issues, fallback result | 무중단 배포, 완전 자동화 |

P0 smoke 예시:

```bash
curl -s http://<HOST>:8080/health
curl -s -X POST http://<HOST>:8080/api/etl/jobs -H "Content-Type: application/json" -d @fixtures/create-job.json
curl -s -X POST http://<HOST>:8080/api/etl/jobs/JOB-001/commands -H "Content-Type: application/json" -d '{"command":"run"}'
curl -s -X POST http://<HOST>:8080/api/query/runs -H "Content-Type: application/json" -d @fixtures/query-count.json
```

## 10-8. Nice to have

| 제외 기능 | 제외 이유 | 나중에 붙일 위치 |
| --- | --- | --- |
| 모든 Source Type 실제 연결 | 4일 안에 PostgreSQL, S3, CSV, MongoDB, Kafka를 모두 안정화하면 핵심 데모가 위험해진다 | source adapter layer |
| Kafka 실시간 스트리밍 완성 | batch 10GB 검증과 동시에 완성하기 어렵다 | streaming ingestion phase |
| Spark/Trino/Kafka/Airflow 전체 완전 운영 | 운영급 플랫폼 구성은 4일 MVP 범위를 넘는다 | processing platform phase 2 |
| 인증/인가 완성 | demo core flow보다 구현량과 리스크가 크다 | auth/admin module |
| Dashboard 권한 공유 실제 저장 | Published view가 우선이고 공유 권한 backend는 보안 정책 결정이 필요하다 | dashboard permission API |
| 완전한 Airflow DAG 생성기 | DAG 화면 상태 증거가 우선이고 실제 DAG compiler는 별도 영역이다 | orchestration service |
| 10GB 처리와 실시간 streaming을 동시에 완성 | 10GB batch 1회 성공이 MVP 우선순위다 | streaming + batch integration |
| 운영급 모니터링/로깅 체계 | PoC smoke 증거로 충분하고 운영 체계는 시간이 부족하다 | observability stack |
| 완전한 배포 자동화 | 4일 목표는 최소 배포 smoke이며 CI/CD는 후속 과제다 | deploy pipeline |
| EKS/ALB/TLS/도메인/오토스케일링 같은 운영급 클라우드 인프라 구성 | 비용/시간/운영 복잡도가 높고 발표 MVP와 직접 관련이 낮다 | production infrastructure |
| Source/Schema/Rule/Quality 중간 API 전체 구현 | 최종 `POST /api/etl/jobs`에 draft summary를 담는 방식으로 데모 가능하다 | draft/session API |
| SQL 저장, Lake 저장, CSV 대용량 export 완성 | read-only SQL 실행과 Dashboard handoff가 우선이다 | query workspace phase 2 |
| Dashboard drag/resize 저장 | SQL 결과 기반 위젯 표시와 Publish가 우선이다 | dashboard layout engine |
| AI 활용/관리 메뉴 구현 | 현재 placeholder이며 핵심 빅데이터 처리 데모 흐름 밖이다 | RAG/admin phase |

4일 MVP에서 우선할 것:

- 10GB batch 처리 1회 성공 또는 caveat가 명시된 scale report
- 처리 결과가 Catalog에 보임
- SQL로 처리 결과 일부 조회 가능
- Dashboard에 SQL 결과 기반 위젯 1개 이상 표시
- Source -> ETL -> Catalog -> SQL -> Dashboard 흐름이 브라우저에서 끊기지 않음
- 최소 배포 환경에서 frontend 접속, backend `/health`, P0 API smoke 통과
