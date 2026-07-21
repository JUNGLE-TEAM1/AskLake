# Dashboard 수동 갱신 전환과 Job Binding 제거 계획

## 1. 결정과 범위

Dashboard는 Job과 별도 binding을 만들지 않는다. Widget이 저장한 Catalog Dataset ID가 데이터 연결의 source of truth이며, 사용자는 권한이 있는 Dataset을 직접 선택한다.

이번 전환의 사용자 계약은 다음과 같다.

- Dashboard 진입 시 현재 페이지의 Dataset Widget을 최신 물리 데이터로 조회한다.
- 보기 모드와 편집 모드의 새로고침 버튼은 현재 페이지 Widget의 query API를 명시적으로 호출한다.
- Dataset revision이 증가했으면 저장된 Widget 결과의 `appliedRevision`과 비교해 증분 계산을 시도하고, 증분 계산이 불가능하면 전체 재계산한다.
- 갱신 실패 시 마지막 성공 결과를 유지하고 Widget 단위 오류를 표시한다.
- background prefetch, Dataset freshness polling, SSE 자동 갱신은 사용하지 않는다.
- ETL, 반복 Trino SQL, Continuous SQL 생성 화면의 Dashboard 연동 옵션과 Dashboard 자동 생성은 제거한다.
- 별도 범위인 SQL Job 생성 직후 실행은 유지한다. 배치 SQL은 생성 후 1회 실행하고 Continuous SQL은 생성 후 시작한다.

다음 항목은 이번 전환 범위가 아니다.

- 실시간 Dataset을 사용한 일반 배치 SQL의 자동 Continuous 전환
- Job 의존성 및 실행 트리
- Kafka 고급 설정
- Dashboard 자동 갱신, polling, SSE

## 2. 2026-07-21 기준 현행 조사

### 2.1 Git과 배포 기준

- 로컬 작업 브랜치 `feat-#1106`의 HEAD는 `7542ad92`다.
- EC2 배포 기준은 `3a5307d18d51a19b6760491aa8b0e220f09bef7a`다.
- 두 기준 사이의 Dashboard filter 커밋 6개는 현재 EC2에 배포되지 않았다.
- Phase 0은 읽기 전용 코드·DB 조사와 이 계획 문서만 다루며 배포 기준을 변경하지 않는다.

### 2.2 운영 DB 보존 대상

EC2 운영 DB를 읽기 전용으로 조사한 결과는 다음과 같다.

| 대상 | 수량 | 전환 원칙 |
| --- | ---: | --- |
| Dashboard | 9 | 모두 보존 |
| Dashboard revision | 43 | 모두 보존 |
| Dashboard widget row | 134 | 모두 보존 |
| Dashboard Job binding | 10 | 제거 |
| orphan binding | 3 | 제거 |
| binding delivery | 조사 중 1,622개 이상 | 제거 |
| Dataset freshness row | 11 | 보존 |
| Dataset revision commit | 4,604 | 보존 |

실제 Dashboard가 남아 있는 binding은 7개다. 이 중 Widget이 있는 Dashboard는 4개이고 draft/published revision을 합쳐 25개의 Widget row가 있다. 해당 Widget은 이미 binding output과 같은 `dashboard_widgets.dataset_id`를 저장하고 있으므로 Dashboard, revision, page, Widget을 수정하거나 삭제할 필요가 없다.

3개 binding은 존재하지 않는 Dashboard ID를 가리킨다. `dashboard_job_bindings.dashboard_id`에는 Dashboard foreign key가 없으므로 생긴 orphan이며 전환 과정에서 별도 복원 없이 제거한다.

binding output 중 3개는 Catalog Dataset이 아직 없고, 4개는 Dataset revision이 0이다. 이런 준비 전 Dashboard도 일반 Dashboard card로 보존하되 존재하지 않는 Dataset을 참조하는 새 Widget은 만들지 않는다. 이미 존재하는 Widget이 이후 삭제된 Dataset을 참조하면 현재의 Dataset unavailable 표시를 유지한다.

delivery는 조사 사이에도 추가됐고 대부분 `degraded` 상태였다. 자동 갱신 기능 플래그가 꺼져도 continuous worker가 binding delivery를 계속 생성하므로 code cutover에서 enqueue/worker 호출을 먼저 제거해야 한다.

### 2.3 Binding 제거 대상

Frontend 제거 대상:

- `frontend/src/services/dashboardJobBindingApi.ts`
- `frontend/src/pages/etl/ReviewPage.tsx`의 Dashboard 연동 section
- `frontend/src/pages/sql/SqlJobWizardDialog.tsx`의 Dashboard 연동 option
- `frontend/src/pages/sql/ContinuousSqlJoinDialog.tsx`와 `useContinuousSqlJoin.ts`의 Dashboard 생성 경로
- `frontend/src/state/asklake/usePipelineMutations.ts`의 Dashboard 생성 및 binding 실패 처리
- `frontend/src/pages/dashboard/DashboardPage.tsx`의 binding 조회와 `managedDatasetId`
- Dashboard runtime, Widget 설정, Assistant action의 managed Dataset 강제 처리와 문구

Phase 2에서 위 frontend 대상과 `dashboardJobBindingApi.ts`를 제거했다. `npm run test:dashboard-job-binding-removal`이 생성 화면, runtime과 API client에 binding 참조가 다시 생기지 않는지 검증한다.

Backend 제거 대상:

- `/api/dashboard-job-bindings` router와 API schema
- binding model, repository, service
- `DashboardRuntimeService._managed_widget_dataset_id()`와 managed Dataset `409`
- Dashboard Assistant의 binding output Dataset 제한
- continuous worker의 binding delivery enqueue/calculate 호출
- binding delivery 전용 검증 command와 테스트

Phase 3에서 위 backend 대상과 delivery worker 호출을 제거했다. `/api/dashboard-job-bindings`는 OpenAPI에서 사라졌고 Widget/Assistant는 binding table을 조회하지 않는다. `npm run verify:dashboard-job-binding-removal`이 route/schema, runtime 제한, worker/bootstrap 참조와 제거된 module을 검증한다. Alembic `0021_dashboard_job_bindings`와 실제 DB table은 이 단계에서 보존한다.

DB 제거 대상:

- `dashboard_binding_deliveries`
- `dashboard_job_bindings`
- 두 테이블의 index와 constraint

Phase 4에서 Alembic `0022_remove_dashboard_job_bindings`를 추가했다. upgrade는 `dashboard_binding_deliveries`를 먼저 삭제하고 `dashboard_job_bindings`를 삭제한다. 기존 row가 있으면 기본적으로 중단하며, 모든 Phase 3 replica 교체와 table backup을 확인한 뒤 migration process에만 `ASKLAKE_CONFIRM_DROP_DASHBOARD_JOB_BINDINGS=true`를 설정해야 한다. downgrade는 빈 table만 복원하고 삭제된 row는 복원하지 않는다.

기존 Dashboard, Dashboard revision/page/widget, Widget 계산 결과, Dataset freshness/commit/event는 제거 대상이 아니다.

## 3. Dataset revision과 수동 조회 기반

현재 backend에는 수동 갱신에 필요한 공통 기반이 이미 있다.

- `POST /api/dashboards/{dashboardId}/widgets/query`는 Widget Dataset의 최신 revision과 저장된 `appliedRevision`을 비교한다.
- append revision이고 계산 state가 호환되면 증분 merge를 시도한다.
- revision gap, replace, 계산 계약 변경 또는 증분 미지원이면 최신 물리 Dataset을 전체 재계산한다.
- 계산 실패 시 마지막 성공 Widget 결과를 반환한다.
- 배치/ETL publication, Kafka Continuous, Iceberg Continuous SQL, ClickHouse Continuous SQL은 durable publication 뒤 Dataset revision을 기록한다.

현재 Dashboard 진입은 runtime shell을 `includeData=false`로 먼저 받은 뒤 선택 페이지의 pending Widget을 query API로 조회한다. 이 경로는 유지한다.

Phase 1에서 보기·편집 모드 새로고침 버튼을 현재 페이지 Widget query에 직접 연결했다. `usePreparedPublishedDashboard` background prefetch와 Dashboard polling/SSE hook은 제거했으며, 화면·페이지 진입 시 pending Widget 조회와 사용자의 강제 재조회만 남겼다. 재조회 실패 시 기존 성공 결과를 그대로 유지한다.

새 Dataset revision 저장소나 별도 Dashboard delivery 저장소는 만들지 않는다. 기존 Dataset freshness/revision commit과 Widget query API를 재사용한다.

## 4. 마이그레이션 순서

1. 배포 직전에 application DB snapshot 또는 두 binding 테이블의 schema/data backup을 만든다.
2. 새 frontend에서 Dashboard 연동 UI와 managed Dataset 처리를 제거한다.
3. 새 backend에서 binding API, runtime 제한, Assistant 제한을 제거한다.
4. continuous worker에서 delivery enqueue/calculate를 제거한다.
5. 수동 새로고침이 현재 페이지 Widget query API를 직접 호출하도록 전환한다.
6. 기존 Dashboard 9개와 Widget row 134개가 유지되고 기존 Widget Dataset 조회가 성공하는지 확인한다.
7. 모든 backend/worker replica가 새 코드인지 확인하고 두 table을 backup한 뒤 `ASKLAKE_CONFIRM_DROP_DASHBOARD_JOB_BINDINGS=true`를 준 migration process에서 `0022_remove_dashboard_job_bindings`를 적용한다.
8. OpenAPI, frontend bundle, worker process와 DB schema에서 binding 참조가 없는지 검증한다.

테이블 삭제를 code cutover보다 먼저 수행하면 이전 backend와 worker가 실패하므로 허용하지 않는다.

## 5. 롤백 기준

DB 테이블 삭제 전에는 코드만 이전 release로 되돌리면 된다.

DB 테이블 삭제 후 롤백은 다음 순서를 따른다.

1. 배포 전 DB snapshot 또는 binding table backup에서 두 테이블과 데이터를 복원한다.
2. binding row 10개와 delivery row 수, constraint/index를 검증한다.
3. 이전 backend와 continuous worker를 배포한다.
4. 이전 frontend를 배포한다.
5. managed Dataset 조회와 delivery worker 상태를 확인한다.

이전 코드를 먼저 배포하면 binding table 조회와 worker loop가 실패할 수 있으므로 허용하지 않는다. Dashboard와 Widget 본체는 이번 migration에서 수정하지 않으므로 binding backup만 복구하면 된다.

## 6. Phase별 검증 게이트

수동 새로고침:

- Dashboard 첫 진입에서 현재 페이지 Widget이 최신 Dataset 결과를 표시한다.
- 보기/편집 모드 새로고침 한 번당 현재 페이지의 Widget query가 한 번만 실행된다.
- 새 Dataset revision 뒤 새로고침하면 `appliedRevision`이 최신 revision에 도달한다.
- 실패 시 이전 차트가 유지된다.
- 화면을 열어 둔 상태에서 background freshness/widget request가 발생하지 않는다.

Binding 제거:

- ETL, 반복 Trino SQL, Continuous SQL UI에 Dashboard 연동 option이 없다.
- OpenAPI에 `/api/dashboard-job-bindings`가 없다.
- Dataset이 다른 이유만으로 Widget create/update가 managed conflict `409`를 반환하지 않는다.
- 권한 없는 Dataset query는 기존처럼 `403`을 유지한다.
- continuous worker가 binding delivery를 생성하지 않는다.
- DB에 binding/delivery table이 없다.
- 기존 Dashboard와 Widget 수 및 ID가 migration 전과 같다.
- populated legacy schema는 확인 변수 없이 migration되지 않는다.
- downgrade 뒤 legacy table은 비어 있으며 과거 row 복구는 backup을 사용한다.

SQL Job 즉시 실행:

- 반복 Trino SQL Job은 생성 성공 뒤 1회 실행 요청을 보낸다.
- Continuous SQL은 생성 성공 뒤 start command를 보낸다.
- 실행 실패가 Job 생성을 rollback하지 않는다.
- 실시간 Dataset 기반 일반 배치 SQL의 종류나 실행 계약은 변경하지 않는다.

Phase 5에서 DuckDB compatibility 처리 Job과 반복 Trino SQL Job은 create 성공 뒤 별도 `run` command를 한 번 보내고, Continuous SQL은 기존 create→`start` 순서를 유지하면서 create 실패와 start 실패를 분리했다. 두 command 실패 모두 durable Job을 유지하고 부분 성공 toast/error와 별도 audit action을 남긴다. `npm run test:sql-job-immediate-run`이 호출 순서와 실패 경계를 검증한다.
