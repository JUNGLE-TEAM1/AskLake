# Dashboard View

## Route

- `/dashboards/:dashboardId`

## Screen Purpose

- 게시된 dashboard revision의 page와 widget을 읽기 전용으로 표시한다.
- draft 편집 이동, refresh, share, page tab 전환을 제공한다.
- 게시 revision이나 widget이 없으면 편집 진입 action이 포함된 empty state를 표시한다.

## Current Shared Components

- `DashboardPage` -> `DashboardRuntimeView` -> `DashboardRuntimeShell`: route state, runtime state, 화면 shell의 계층을 구성한다.
- `DashboardTopBar`: shadcn 기반 `Button`으로 편집, refresh, share action을 제공한다.
- `DashboardPageTabs`: `Button`과 `Input`을 사용해 page tab 및 draft rename UI를 공유한다.
- `Sheet`: share link panel에 shadcn `SheetContent`, `SheetHeader`, `SheetTitle`, `SheetDescription`, `SheetFooter`를 사용한다.
- `DashboardCanvas`, `WidgetFrame`, `WidgetRenderer`: widget layout과 chart/table/metric rendering을 담당한다.
- `DataTable`, `ResultPanel`: table widget의 data presentation에 사용한다.
- `react-apexcharts`: chart widget engine으로 사용한다.

## Weakly Componentized Areas

- page tab shell은 `role="tablist"`와 Button을 조합하지만 shadcn `Tabs`의 roving focus와 keyboard contract를 사용하지 않는다.
- runtime notice는 `role="status"` raw div와 tone class로 구현되어 있다.
- 게시 revision/widget 없음, loading, error가 모두 `EmptyDashboardCanvas`와 여러 wrapper div 조합으로 반복된다.
- empty state action은 raw `<button class="asklake-dashboard-empty-action">`이다.
- published widget grid와 `WidgetFrame` surface는 `asklake-dashboard-*` 전용 CSS에 강하게 결합되어 있다.
- chart/table/metric별 empty/error 표시는 서로 다른 raw div와 text를 사용한다.
- 상단 share Sheet는 shadcn을 사용하지만 link copy action이 없어 read-only code block만 제공한다.

## shadcn/ReUI Replacement Candidates

- `Tabs`: dashboard page navigation을 표준 tab keyboard interaction으로 정리한다.
- `Alert`: runtime notice와 published loading/error 상태를 semantic feedback으로 표현한다.
- `Empty`: revision 없음, page 없음, widget 없음 상태를 공통 empty composition의 variant로 통합한다.
- `Skeleton`: published widget loading 시 최종 grid 크기를 유지한다.
- `Tooltip`: icon-only refresh와 widget action의 설명을 보완한다.
- `Button`: empty state의 raw action을 공통 variant로 교체한다.
- `ScrollArea`: page tab overflow와 긴 dashboard canvas 주변 scroll ownership을 명확히 한다.
- `Sheet`: share panel은 이미 적절하게 적용되어 있으며 copy action만 `Button`/clipboard feedback으로 보완한다.

## Design Options For Existing Components

- `DashboardRuntimeShell`, `DashboardTopBar`, `DashboardCanvas`, `WidgetFrame`, `WidgetRenderer`: dashboard 도메인 composition으로 유지한다.
- `DashboardPageTabs`: 도메인 API는 유지하되 내부 primitive를 shadcn `Tabs`로 교체한다.
- `EmptyDashboardCanvas`: loading/error/empty를 모두 받는 범용 component보다 `Empty` 기반 상태 variant를 명확히 나누는 편이 낫다.
- `react-apexcharts`, widget data transformation: shadcn 교체 대상이 아니다. chart container와 token만 AskLake theme에 맞춘다.
- published layout은 view 전용 grid를 유지하고 edit의 `react-grid-layout` dependency를 불필요하게 끌어오지 않는지 확인한다.

## Related CSS

- 현재 사용 중: `frontend/src/styles/dashboard-runtime.css`의 `.asklake-dashboard-runtime`, `.asklake-dashboard-topbar`, `.asklake-dashboard-title`, `.asklake-dashboard-actions`.
- 현재 사용 중: `.asklake-dashboard-subnav`, `.asklake-dashboard-tabs`, `.asklake-dashboard-page-tab`, `.asklake-dashboard-canvas-wrap`.
- 현재 사용 중: `.asklake-dashboard-empty-canvas`, `.asklake-dashboard-empty-action`, `.asklake-dashboard-widget-grid`, `.asklake-widget-frame`, `.asklake-widget-empty`.
- 현재 사용 중: `.asklake-dashboard-runtime-notice`, `.asklake-dashboard-share-sheet*`, chart/table widget selector.
- 주의: view와 edit가 같은 runtime CSS를 공유하므로 mode selector를 확인하지 않고 삭제하면 안 된다.

## QA Notes

- process 환경에서 `VITE_USE_MOCK_API=true`로 `/dashboards/dash_sales_demo`를 열었을 때 route와 published empty state가 오류 없이 렌더링된다.
- 현재 mock runtime은 published widget이 채워진 fixture가 아니라 revision/widget 없음 상태를 반환한다. 따라서 실제 chart/table widget의 populated visual QA는 이번 audit에서 수행하지 못했다.
- page identity, topbar, share/edit action, empty state 구조는 확인 가능하다.
- populated fixture가 추가되면 widget grid overflow, chart resize, table pagination, page switching을 다시 확인해야 한다.

## Conflict Risk

- view와 edit가 `DashboardRuntimeView`, `DashboardRuntimeShell`, `dashboard-runtime.css`를 공유한다.
- runtime API revision/widget contract와 chart engine은 이번 문서 범위에서 변경하지 않는다.
- #422의 table 변경이 table widget `DataTable`에 영향을 줄 수 있어 merge 후 재확인이 필요하다.

