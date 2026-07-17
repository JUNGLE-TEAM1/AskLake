# Frontend Job 화면·데이터 Hook 경계

## 목적

Job 목록, 상세, 실행 이력과 앱 전체 서버 상태를 각각 독립적으로 변경·검증할 수 있게 하면서 기존 route, API payload, 화면 DOM/CSS 계약을 유지한다.

## 화면 경계

- `frontend/src/pages/ingest/JobsPages.tsx`는 기존 import 경로를 보존하는 re-export façade다.
- `jobs/JobsLandingPage.tsx`는 검색·필터·목록 표현을 소유한다.
- `jobs/JobDetailPage.tsx`와 `jobDetailModel.tsx`는 상세 표현과 표시 모델을 소유한다.
- `jobs/ContinuousJobRunsPage.tsx`는 Continuous session, batch, lag, checkpoint와 유지보수 화면을 소유한다.
- `jobs/SnapshotJobRunsPage.tsx`는 finite Run, 로그와 DAG 화면을 소유한다.
- 공용 상태·표시 함수는 `jobShared.tsx`, 실행 이력 계약은 `jobRunsModel.tsx`에 둔다.

기존 `JobsLandingPage`, `JobDetailPage`, `JobRunsPage` export와 `/jobs`, `/jobs/:id`, `/jobs/:id/runs` URL은 바꾸지 않는다.

## 서버 상태와 명령 경계

`frontend/src/hooks/useAskLakeData.ts`는 `App.tsx` 호환 façade이며 신규 기능 구현을 추가하지 않는다. 실제 책임은 다음 모듈이 소유한다.

- `useAskLakeWorkspaceState`: Job, Run, Catalog, ETL draft, SQL draft의 React state와 파생 실행 근거
- `routeDataRequirements`: 현재 route가 Job 또는 Catalog 목록을 실제로 사용하는지 결정
- `useJobsHydration`: Jobs route 진입 hydrate, 현재 route refresh, Job filter의 latest-request ownership
- `useCatalogHydration`: Catalog·SQL·AI route 진입 hydrate와 현재 route refresh의 latest-request ownership
- `usePipelineMutations`: ETL create/update와 SQL Job 생성 lifecycle
- `useJobController`: Job command, optimistic Run, Continuous polling, Job navigation
- `useSnapshotJobStatusPolling`: Jobs 계열 route의 active Snapshot 상태 일괄 조회
- `useCatalogController`: materialization 삭제와 Catalog/SQL navigation
- `useAskLakeWorkspace`: 위 도메인 controller를 기존 public shape로 조합

Browser localStorage는 versioned ETL 편집 복구와 mock Catalog 호환에만 사용한다. Job·Run·Catalog의 durable source of truth는 backend API다.

## 동시성·rollback 계약

- 조회는 resource/query/version lease가 최신인 응답만 반영한다.
- Jobs·Job 상세·실행 이력 route는 Job 목록만 요청한다. Catalog·Catalog 상세·SQL·AI route는 Catalog 목록만 요청한다.
- Dashboard 목록은 workspace Catalog 목록을 요청하지 않는다. Dashboard runtime/builder에서 필요한 Dataset은 Dashboard feature loader가 소유한다.
- Job과 Catalog의 `loading`·`error`는 분리하며 route 이탈은 해당 domain lease를 무효화한다.
- 기존 `refreshData` 반환 필드는 유지하되 현재 route가 소유한 domain 하나만 갱신한다.
- 목록 `JobRowData.runHistory`는 최신 Run 요약만 가진다. `/jobs/:jobId`와 `/jobs/:jobId/runs` 진입 시 `GET /api/etl/jobs/{jobId}`로 전체 상세와 Run history를 별도 hydrate한다.
- Job별 command는 동시에 하나만 처리한다.
- optimistic rollback은 `MutationRevisionGate`가 발급한 같은 Job revision을 여전히 소유할 때만 실행한다.
- edit/delete가 시작되거나 더 최신 command가 시작되면 이전 rollback lease는 무효다.
- Continuous polling은 server runtime revision·updated time 정책을 통과한 관측만 반영한다.
- Snapshot 상태 조회는 가장 최근의 실제 server Run이 `queued`/`running`인 Job ID를 모아 `GET /api/etl/jobs/statuses` 한 번으로 요청한다. Job 개수만큼 요청을 만들지 않는다.
- 기본 간격은 5초다. hidden tab, Jobs 계열 route 이탈, active Job 부재 시 중지하고 연속 실패는 10·20·30초까지 backoff한 뒤 성공 시 5초로 복구한다. 요청은 겹치지 않는다.
- `updatedAt`이 오래된 응답과 같은 Run의 terminal-to-active 역행은 버린다. terminal success 뒤 전체 Catalog 목록을 자동 조회하지 않고 Catalog route 진입 시 최신 목록을 읽는다.

## 호환·rollback

- 공개 API, DB schema, persisted Job/Run/Dataset shape는 변경하지 않는다.
- 화면 class name과 기존 정적 UI regression 계약을 유지한다.
- rollback은 `jobs/` 화면 모듈, `state/asklake/` controller, façade와 verifier 목록을 함께 되돌린다.
- browser storage나 backend data migration은 필요 없다.

## 검증

```bash
cd frontend
npm run test:request-ownership
npm run test:route-data-loading
npm run test:jobs-data-boundary
npm run test:snapshot-status-polling
npm run verify:ui-regressions
npm run build
```

`route-data-loading`은 route별 domain 선택, Job/Catalog API import 격리, stale response 차단, Dashboard 조건부 Dataset 조회를 고정한다. `jobs-data-boundary`는 façade export, 모듈 크기 예산, controller 조합과 revision-gated rollback을 고정한다. `snapshot-status-polling`은 active ID 선택, 이력 보존 merge, stale/역행 차단과 5~30초 backoff를 고정한다.
