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
- `useWorkspaceHydration`: 초기 hydrate, 수동 refresh, Job filter의 latest-request ownership
- `usePipelineMutations`: ETL create/update와 SQL Job 생성 lifecycle
- `useJobController`: Job command, optimistic Run, Continuous/Snapshot polling, Job navigation
- `useCatalogController`: materialization 삭제와 Catalog/SQL navigation
- `useAskLakeWorkspace`: 위 도메인 controller를 기존 public shape로 조합

Browser localStorage는 versioned ETL 편집 복구와 mock Catalog 호환에만 사용한다. Job·Run·Catalog의 durable source of truth는 backend API다.

## 동시성·rollback 계약

- 조회는 resource/query/version lease가 최신인 응답만 반영한다.
- Job별 command는 동시에 하나만 처리한다.
- optimistic rollback은 `MutationRevisionGate`가 발급한 같은 Job revision을 여전히 소유할 때만 실행한다.
- edit/delete가 시작되거나 더 최신 command가 시작되면 이전 rollback lease는 무효다.
- Continuous polling은 server runtime revision·updated time 정책을 통과한 관측만 반영한다.
- Snapshot polling은 실제 server Run ID만 추적하며 terminal success 뒤 Catalog를 갱신한다.

## 호환·rollback

- 공개 API, DB schema, persisted Job/Run/Dataset shape는 변경하지 않는다.
- 화면 class name과 기존 정적 UI regression 계약을 유지한다.
- rollback은 `jobs/` 화면 모듈, `state/asklake/` controller, façade와 verifier 목록을 함께 되돌린다.
- browser storage나 backend data migration은 필요 없다.

## 검증

```bash
cd frontend
npm run test:request-ownership
npm run test:jobs-data-boundary
npm run verify:ui-regressions
npm run build
```

`jobs-data-boundary`는 façade export, 모듈 크기 예산, controller 조합과 revision-gated rollback을 고정한다.
