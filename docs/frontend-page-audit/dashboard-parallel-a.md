# Dashboard 병렬 작업 A — 목록 화면

## 담당 화면

- Route: `/dashboards`
- 기준 문서: `docs/frontend-page-audit/dashboards.md`

## 목표

대시보드 목록의 loading, API error, 빈 결과 상태를 shadcn `Skeleton`, `Alert`, `Empty` 중심으로 정리한다. 목록 조회·검색·필터·정렬·페이지네이션의 기존 계약은 유지한다.

## A 전용 수정 파일

- `frontend/src/pages/dashboard/DashboardLandingPage.tsx`
- `frontend/src/pages/dashboard/components/DashboardTable.tsx`
- `frontend/src/pages/dashboard/components/DashboardDeleteConfirmDialog.tsx`
- `frontend/src/pages/dashboard/components/DashboardPagination.tsx`
- `frontend/src/pages/dashboard/dashboardListUtils.ts`
- A가 새로 만드는 목록 전용 component/CSS 파일

## 작업 범위

1. `dashboard-list-count`에 섞여 있는 loading/create/delete/API error를 semantic 상태 UI로 분리한다.
2. 목록 loading에는 table row 높이를 유지하는 `Skeleton`을 적용한다.
3. 검색 결과 없음과 dashboard 자체가 없음 상태를 `Empty` variant로 구분한다.
4. 삭제 dialog의 error feedback을 dialog 문맥에 맞는 `Alert`로 바꾼다.
5. 모바일 table overflow는 목록 전용 wrapper 또는 새 목록 전용 stylesheet 안에서만 containment를 보완한다.

## 수정 금지 — B와의 충돌 방지

- `frontend/src/pages/dashboard/runtime/**`
- `frontend/src/styles/dashboard-runtime.css`
- `frontend/src/App.tsx`
- dashboard API client, mock fixture, runtime data contract
- 기존 `frontend/src/styles/dashboard.css`의 광범위 selector 정리

## 완료 기준

- `/dashboards`의 loading, error, empty, populated list가 기존 data/action 계약을 유지한다.
- A가 수정한 파일 목록이 위 전용 파일 또는 새 목록 전용 파일에만 한정된다.
- `cd frontend && npm run verify:ui-regressions`
- `cd frontend && npm run build`

