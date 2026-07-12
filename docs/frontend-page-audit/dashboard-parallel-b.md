# Dashboard 병렬 작업 B — 게시 조회 화면

## 담당 화면

- Route: `/dashboards/:dashboardId`
- 기준 문서: `docs/frontend-page-audit/dashboard-view.md`
- 참고만 할 문서: `docs/frontend-page-audit/dashboard-edit.md`

## 목표

게시 dashboard 조회 화면의 share URL/copy feedback, 빈 상태 안내 문구, raw empty action을 정리한다. draft 편집 workspace의 widget·dataset·inspector 동작은 변경하지 않는다.

## B 전용 수정 파일

- `frontend/src/pages/dashboard/runtime/DashboardRuntimeView.tsx`
- `frontend/src/pages/dashboard/runtime/DashboardTopBar.tsx`
- `frontend/src/pages/dashboard/runtime/EmptyDashboardCanvas.tsx`
- B가 새로 만드는 게시 조회 전용 component 파일

## 작업 범위

1. share panel URL을 게시 조회 route `/dashboards/:dashboardId` 기준으로 교정한다.
2. 실제 clipboard copy action과 성공/실패 feedback을 추가해 안내 문구와 동작을 일치시킨다.
3. 게시 revision/page/widget 없음 상태의 안내 문구를 view mode에 맞게 고친다.
4. 게시 조회 empty CTA의 raw button을 shadcn `Button`으로 교체한다.
5. empty `tablist`가 남지 않도록 page가 없는 게시 상태의 navigation markup을 정리한다.

`DashboardRuntimeView.tsx`는 edit mode도 포함하므로 `mode === "published"` 분기와 게시 조회용 prop만 최소 수정하고, edit mode JSX·state·callback은 포맷 변경도 하지 않는다.

## 수정 금지 — A 및 편집 화면과의 충돌 방지

- `frontend/src/pages/dashboard/DashboardLandingPage.tsx`
- `frontend/src/pages/dashboard/components/**`
- `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`
- `frontend/src/pages/dashboard/runtime/DatasetSidebar.tsx`
- `frontend/src/pages/dashboard/runtime/DashboardCanvas.tsx`
- `frontend/src/styles/dashboard.css`
- `frontend/src/styles/dashboard-runtime.css`
- runtime API contract, widget layout serialization, chart engine

## 완료 기준

- `/dashboards/:dashboardId`에서 share URL과 copy feedback이 게시 조회 route를 가리킨다.
- 게시 empty state가 편집 sidebar를 언급하지 않고 편집 진입 CTA를 제공한다.
- B가 수정한 파일 목록이 위 전용 파일 또는 새 게시 조회 전용 component에만 한정된다.
- `cd frontend && npm run verify:ui-regressions`
- `cd frontend && npm run build`
