# AskLake 4일 / 6인 결과물 카드 - 쉬운 버전

이 문서는 마일스톤 카드만 모아놓은 문서다.

각 카드는 이렇게 읽으면 된다.

```text
누가 맡나
-> 사용자가 뭘 클릭하나
-> 화면에서 뭐가 보여야 하나
-> 뒤에 어떤 증거가 남아야 하나
-> 안 되면 뭘로 대체하나
```

## 공통 Pair

| Pair | 한 줄 역할 |
| --- | --- |
| Pair A | ETL Job을 만들고 실행 상태를 화면에 남긴다. |
| Pair B | Dataset을 Catalog와 SQL에서 쓸 수 있게 만든다. |
| Pair C | SQL 결과를 Dashboard 위젯과 Published 화면까지 보낸다. |

## DAY1-A-ETL-CREATE

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair A |
| 쉽게 말하면 | Review에서 `생성`을 누르면 Job과 Dataset이 생겨야 한다. |
| 사용자가 보는 것 | ETL 목록 최상단에 새 Job이 보이고, Catalog에도 새 Dataset이 보인다. |
| 클릭 순서 | Source~Target 확인 -> Review -> `생성` 클릭 -> ETL 목록 확인 -> Catalog 확인 |
| 화면에 꼭 보여야 할 텍스트 | `스케줄됨`, 새 Job 이름, 새 Dataset 이름, `파이프라인 생성 요청이 접수되었습니다.` |
| 뒤에 남아야 할 증거 | `POST /api/etl/jobs` 요청/응답, Job ID, Dataset ID, audit log, console error 없음 |
| 연결되는 상태/API | `DraftPipeline -> { job, dataset }`, `selectedJob`, `selectedDataset` |
| 성공 기준 | 생성 후 앱이 죽지 않고 ETL 목록과 Catalog에 새 항목이 보인다. 실패하면 Toast가 뜨고 입력값이 유지된다. |
| 안 하는 것 | 실제 Airflow DAG 생성, 실제 S3/Delta 적재, 중간 Source/Schema API 전체 연결 |
| Fallback | 백엔드가 없으면 `createPipelineDraft()` mock 응답으로 같은 화면 흐름을 유지한다. |

## DAY1-B-CATALOG-SQL-CONTEXT

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair B |
| 쉽게 말하면 | Catalog에서 고른 Dataset이 SQL 화면으로 그대로 넘어가야 한다. |
| 사용자가 보는 것 | SQL 화면에 선택한 Dataset 이름, schema chip, 기본 SELECT query가 보인다. |
| 클릭 순서 | Catalog -> Dataset 선택 -> `쿼리 편집기에서 열기` -> SQL 화면 확인 |
| 화면에 꼭 보여야 할 텍스트 | `SQL CONTEXT`, `읽기 전용 SQL 실행`, 선택 Dataset 이름, `SELECT ... FROM ... LIMIT 100` |
| 뒤에 남아야 할 증거 | `selectedDataset` 값, SQL default query, Catalog fallback log, console error 없음 |
| 연결되는 상태/API | `GET /api/catalog/datasets`, `GET /api/catalog/datasets/{datasetId}`, `selectedDataset -> SqlAnalysisPage` |
| 성공 기준 | SQL query의 `FROM`이 Catalog에서 선택한 Dataset과 같다. schema도 같은 Dataset 기준이다. |
| 안 하는 것 | 서버 검색/정렬 완성, bookmark API, 컬럼 단위 lineage 신규 구현 |
| Fallback | Catalog API가 실패하면 기존 mock Dataset 목록을 사용한다. |

## DAY1-C-DASHBOARD-SEED-WIDGET

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair C |
| 쉽게 말하면 | SQL 결과가 아직 없어도 fixture로 Dashboard Table 위젯을 먼저 만들 수 있어야 한다. |
| 사용자가 보는 것 | Dashboard Builder에 `SQL 결과 테이블` 위젯이 Draft 상태로 보인다. |
| 클릭 순서 | Dashboard 열기 -> 대시보드 만들기 -> SQL result fixture 선택 -> Table 위젯 확인 |
| 화면에 꼭 보여야 할 텍스트 | `Dashboard`, `SQL Result Dashboard`, `SQL 결과 테이블`, `Draft` |
| 뒤에 남아야 할 증거 | `DashboardRecord` fixture, `Widget` fixture, localStorage key, `sourceRunId` sample |
| 연결되는 상태/API | `SqlResultDraft fixture -> DashboardRecord -> Widget` |
| 성공 기준 | Builder에 Table 위젯 1개가 보이고, 위젯 source가 SQL result fixture와 연결된다. |
| 안 하는 것 | Dashboard 저장 API 완성, 공유/권한 backend, drag/resize 저장 |
| Fallback | Pair B의 SQL handoff가 늦으면 fixture result로 Builder를 먼저 완성한다. |

## DAY2-A-RUN-HISTORY-DAG-1GB

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair A |
| 쉽게 말하면 | Job을 실행하면 목록/상세/이력/DAG가 같은 Run을 보여야 한다. |
| 사용자가 보는 것 | Job 카드가 `실행 중`으로 바뀌고, 실행 이력에는 `Run ID`, `1GB`, row count, output path가 보인다. |
| 클릭 순서 | ETL 목록 -> `즉시 실행` -> 상세 -> 실행 이력 -> DAG |
| 화면에 꼭 보여야 할 텍스트 | `실행 중`, `1/8 단계 · Source 연결`, `Run ID`, `1.0GB`, `output path` |
| 뒤에 남아야 할 증거 | command response, Run row, DAG step state, 1GB input bytes, row count, duration, output path |
| 연결되는 상태/API | `POST /api/etl/jobs/{jobId}/commands`, `Run`, `dagSteps`, `DataProcessingResult` |
| 성공 기준 | 목록/상세/이력/DAG가 같은 Run ID를 보여준다. 1GB 증거가 화면과 artifact에 남는다. |
| 안 하는 것 | 실시간 log streaming, Airflow task log, production 최적화 |
| Fallback | Run/DAG API가 없으면 command 응답 fixture로 local Run/DAG를 만든다. 1GB가 늦으면 500MB 이상 실제 처리 + caveat를 남긴다. |

## DAY2-B-SQL-READONLY-RESULT-1GB

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair B |
| 쉽게 말하면 | SQL은 읽기 전용만 실행되고, 결과가 Result Preview에 보여야 한다. |
| 사용자가 보는 것 | `SELECT COUNT(*)` 결과, row count, 결과 테이블, Run ID가 보인다. |
| 클릭 순서 | 1GB Dataset SQL로 열기 -> SELECT 실행 -> 결과 확인 -> 변경성 SQL 차단 확인 |
| 화면에 꼭 보여야 할 텍스트 | `RESULT PREVIEW`, `Run ID`, `SELECT COUNT(*)`, `읽기 전용 SQL 실행` |
| 뒤에 남아야 할 증거 | `POST /api/query/runs` 응답, `SqlResultDraft`, read-only guard 차단 로그 |
| 연결되는 상태/API | `{ datasetId, query } -> SqlResultDraft`, fallback `executeQueryDraft()` |
| 성공 기준 | SELECT/WITH만 실행된다. INSERT/UPDATE/DELETE/DROP/ALTER/CREATE는 차단된다. |
| 안 하는 것 | Lake 저장 완성, CSV export 완성, 서버 SQL formatter 완성 |
| Fallback | SQL API 실패 시 Dataset `sampleRows`로 `SqlResultDraft`를 만든다. |

## DAY2-C-DASHBOARD-SAVE-PUBLISH

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair C |
| 쉽게 말하면 | Dashboard를 저장하고 Publish하면 목록과 Published 화면에 남아야 한다. |
| 사용자가 보는 것 | 저장 후 Dashboard 목록에 남고, Publish 후 Published 화면에 같은 위젯이 보인다. |
| 클릭 순서 | SQL 결과 -> Dashboard 생성 -> `저장` -> `Publish` -> 목록 -> 게시된 대시보드 보기 |
| 화면에 꼭 보여야 할 텍스트 | `SQL Result Dashboard`, `SQL 결과 테이블`, `Draft`, `Published`, `게시된 대시보드 보기` |
| 뒤에 남아야 할 증거 | dashboard id, widget count, `sourceRunId`, localStorage/API response, publish audit log |
| 연결되는 상태/API | `POST /api/dashboards`, `PATCH /api/dashboards/{dashboardId}`, `POST /publish`, localStorage fallback |
| 성공 기준 | 저장 후 목록에 남는다. Publish 후 Published 화면에 위젯이 보인다. 새로고침 후에도 fallback 목록이 유지된다. |
| 안 하는 것 | drag/resize 저장, 공유/권한 modal 전체 backend, PDF/PNG export |
| Fallback | Dashboard API가 없으면 localStorage snapshot으로 저장/게시 상태를 유지한다. |

## DAY3-A-10GB-BATCH-RUN-EVIDENCE

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair A |
| 쉽게 말하면 | 10GB 처리 증거가 실행 이력과 DAG에 남아야 한다. |
| 사용자가 보는 것 | 실행 이력에서 `10GB`, row count, duration, output path, 성공 Run ID가 보인다. |
| 클릭 순서 | 10GB demo Job 선택 -> `즉시 실행` -> 실행 이력 확인 -> DAG 확인 |
| 화면에 꼭 보여야 할 텍스트 | `10GB`, `Run ID`, `input size`, `duration`, `output path`, `success` 또는 `retry` |
| 뒤에 남아야 할 증거 | 10GB artifact 또는 scale report, input bytes, input rows, output path, duration, output files, retry/error log |
| 연결되는 상태/API | `Run -> DataProcessingResult`, `GET /api/etl/runs/{runId}/processing-result`, fallback fixture |
| 성공 기준 | 10GB 증거가 화면과 파일에 같이 남는다. 실제 10GB가 아니면 caveat가 숨겨지지 않는다. |
| 안 하는 것 | 실시간 streaming 10GB, 모든 source type 10GB 검증, 운영급 분산 처리 최적화 |
| Fallback | 10GB 원본 준비가 늦으면 1GB 이상 실제 처리 + synthetic 10GB scale report를 남긴다. |

## DAY3-B-10GB-CATALOG-SQL

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair B |
| 쉽게 말하면 | 10GB 처리 결과 Dataset이 Catalog와 SQL에서 조회되어야 한다. |
| 사용자가 보는 것 | Catalog에 `10GB` Dataset이 보이고, SQL에서 `SELECT COUNT(*)` 결과가 보인다. |
| 클릭 순서 | Catalog -> `customer_review_10gb_silver` 선택 -> SQL로 열기 -> COUNT/GROUP BY 실행 |
| 화면에 꼭 보여야 할 텍스트 | `customer_review_10gb_silver`, `10GB`, `12M+ rows`, `SELECT COUNT(*)`, `RESULT PREVIEW` |
| 뒤에 남아야 할 증거 | Catalog dataset patch, query runId, count query result, schema/freshness evidence |
| 연결되는 상태/API | `DataProcessingResult -> Dataset`, `POST /api/query/runs`, fallback `catalogDatasets` |
| 성공 기준 | Catalog와 SQL이 같은 Dataset ID를 본다. size/rows와 SQL count가 같은 결과를 가리킨다. |
| 안 하는 것 | full lineage backend, 서버 검색/정렬 고도화, SQL join optimizer |
| Fallback | SQL backend가 준비되지 않으면 count fixture를 사용하고 caveat를 남긴다. |

## DAY3-C-10GB-DASHBOARD-PUBLISHED

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair C |
| 쉽게 말하면 | 10GB SQL 결과가 Dashboard Published 화면까지 가야 한다. |
| 사용자가 보는 것 | Published Dashboard에 10GB Dataset 기반 Table/KPI 위젯이 보인다. |
| 클릭 순서 | 10GB SQL 결과 -> Dashboard 생성 -> Table/KPI 위젯 확인 -> 저장 -> Publish -> Published view |
| 화면에 꼭 보여야 할 텍스트 | `10GB`, `Run ID`, `SQL 결과 테이블`, `KPI`, `Published` |
| 뒤에 남아야 할 증거 | `sourceRunId`, dashboard snapshot, widget source consistency, published status, screenshot |
| 연결되는 상태/API | `SqlResultDraft -> DashboardRecord -> Widget -> PublishedSnapshot` |
| 성공 기준 | Published 화면에 10GB Dataset 이름, Run ID, 위젯 1개 이상이 보인다. 새로고침 후 fallback snapshot이 유지된다. |
| 안 하는 것 | 공유/권한 modal 실제 저장, public link 권한 정책, PDF export |
| Fallback | Dashboard API가 늦으면 localStorage published snapshot으로 발표 흐름을 유지한다. |

## DAY4-A-ETL-HARDENING-RELEASE

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair A |
| 쉽게 말하면 | ETL 생성/실행이 실패해도 앱이 멈추면 안 된다. |
| 사용자가 보는 것 | 실패 시 Toast가 보이고, 입력값과 이전 Job 상태가 유지된다. |
| 클릭 순서 | 생성 -> 중복 클릭 -> 실패 fixture -> 재시도 -> 실행 -> 취소 |
| 화면에 꼭 보여야 할 텍스트 | `API 요청 처리 중...`, `파이프라인 생성 요청에 실패했습니다.`, `작업 명령 처리에 실패했습니다.` |
| 뒤에 남아야 할 증거 | duplicate guard, rollback result, timeout/500/422 fixture, smoke checklist, console error 없음 |
| 연결되는 상태/API | P0 ETL API, `createPipelineDraft`, `runJobCommand`, error fixture |
| 성공 기준 | 실패 후에도 앱이 죽지 않는다. 입력값이 유지된다. Job이 중복 생성되지 않는다. |
| 안 하는 것 | 새 ETL 기능 추가, 데모와 무관한 UI redesign, 권한 시스템 전체 구현 |
| Fallback | live API가 불안정하면 mock mode로 전환하고 같은 클릭 순서로 발표한다. |

## DAY4-B-CATALOG-SQL-HARDENING-RELEASE

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair B |
| 쉽게 말하면 | Catalog에서 SQL로 여러 번 이동해도 Dataset이 꼬이면 안 된다. |
| 사용자가 보는 것 | SQL 화면의 Dataset 이름, schema, query, result가 항상 같은 Dataset 기준이다. |
| 클릭 순서 | Catalog -> Dataset 선택 -> SQL 열기 -> SELECT 실행 -> Dashboard handoff 확인 |
| 화면에 꼭 보여야 할 텍스트 | Dataset 이름, SQL columns, `Run ID`, `RESULT PREVIEW`, `읽기 전용 SQL 실행` |
| 뒤에 남아야 할 증거 | Catalog/SQL consistency log, SQL result snapshot, read-only guard final, console error 없음 |
| 연결되는 상태/API | `selectedDataset.id`, `SqlResultDraft.datasetId`, `SqlResultDraft.runId` 일치 |
| 성공 기준 | Dataset/columns/runId가 일치한다. read-only guard가 동작한다. API 실패 fallback이 보인다. |
| 안 하는 것 | SQL 저장/Lake 저장/CSV export 완성, multi-dataset 권한 모델 |
| Fallback | API 실패 시 mock/local snapshot으로 계속 진행한다. |

## DAY4-C-FINAL-DEMO-RUNBOOK

| 항목 | 내용 |
| --- | --- |
| 담당 | Pair C |
| 쉽게 말하면 | 발표자가 이 문서만 보고 전체 데모를 재현할 수 있어야 한다. |
| 사용자가 보는 것 | ETL 생성부터 Dashboard Publish와 10GB 증거 확인까지 5분 안에 이어진다. |
| 클릭 순서 | runbook 열기 -> Source/Review 생성 -> 실행 -> Catalog -> SQL -> Dashboard -> Publish -> 10GB 증거 |
| 화면에 꼭 보여야 할 텍스트 | `파이프라인 생성 요청이 접수되었습니다.`, `실행 중`, `RESULT PREVIEW`, `SQL 결과 테이블`, `Published`, `10GB` |
| 뒤에 남아야 할 증거 | final runbook, frontend build 결과, API health 결과, P0/P1 smoke 결과, 10GB artifact, known issues |
| 연결되는 상태/API | mock/live toggle, P0/P1 smoke API, 10GB fixture, mock mode 전체 경로 |
| 성공 기준 | 발표자가 runbook만 보고 전체 경로를 재현한다. 실패하면 fallback 절차로 같은 클릭 순서를 유지한다. |
| 안 하는 것 | 새 기능 추가, production-grade 처리 플랫폼 완성, 데모와 무관한 refactor |
| Fallback | live API 실패 시 mock mode로 전환하고, 발표자는 같은 클릭 순서를 유지한다. |

## 마지막으로 기억할 것

```text
카드의 핵심은 기능명이 아니다.
사용자가 뭘 클릭했고,
화면에 뭐가 보였고,
뒤에 어떤 증거가 남았는지가 핵심이다.
```
