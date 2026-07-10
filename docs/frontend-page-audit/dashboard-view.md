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

## Rendered Audit Findings

### Desktop Findings

- [HIGH] 게시 화면에서 `공유`를 열면 안내는 `현재 대시보드 링크를 복사했습니다`라고 말하지만 실제 panel에는 code와 닫기 button만 있고 copy action이 없다.
- [HIGH] 게시 화면에서 만든 share URL이 `/dashboards/dash_sales_demo/edit`를 가리킨다. view 공유 의도와 URL 권한/모드가 어긋나므로 `/dashboards/:id`를 사용하거나 명확히 draft 공유라고 표시해야 한다.
- [MEDIUM] list에서는 사람이 읽는 dashboard name이 있지만 view H1은 raw ID `dash_sales_demo`를 표시한다.
- [MEDIUM] published empty state는 `왼쪽 사이드바`, `오른쪽 사이드바`를 안내하지만 view mode에는 두 sidebar가 없다. CTA `위젯 편집`과 맞는 편집 진입 문구로 바꿔야 한다.
- [MEDIUM] mock runtime은 page가 없어 빈 `tablist`만 렌더링한다. screen reader에는 이름 있는 빈 navigation landmark가 남는다.
- [PASS] share panel 자체는 title/description/close focus가 있는 shadcn `Sheet` dialog로 노출된다.

### Narrow Viewport Findings

- [HIGH] 360px에서 global app sidebar가 첫 viewport를 점유한다.
- [PASS] empty published view 자체는 page-level horizontal overflow를 만들지 않았다.
- [MEDIUM] populated widget fixture가 없어 mobile chart/table/grid layout은 검증할 수 없었다.

### Verification Coverage

- 확인함: desktop 1280x900, narrow 360x800, published empty state, edit CTA, refresh/share accessible names, share Sheet content/URL, console warning/error.
- 확인하지 못함: populated page tabs, chart/table widgets, refresh failure/retry, actual clipboard mutation, published widget responsive grid.

### shadcn Review

- Structure: mostly pass - runtime shell과 share `Sheet` composition은 명확하다.
- Tokens: pass - topbar, empty surface, action tone이 일관된다.
- Composition: issues - empty action과 runtime notice를 `Button`, `Empty`, `Alert`로 통일할 여지가 있다.
- Responsive/a11y: issues - misleading empty copy, empty tablist, mobile shell이 남아 있다.
- Install/search notes: `Empty`, `Button`, `Tabs`, `Sheet`는 설치돼 있다. `Alert`는 추가 설치 또는 기존 runtime notice 개선 중 선택한다.

### Recommended Order

1. share URL을 published route로 교정하고 실제 copy action/feedback을 일치시킨다.
2. published empty copy와 raw dashboard ID title을 수정한다.
3. populated runtime fixture를 추가한 뒤 view widget 반응형을 다시 감사한다.

## Conflict Risk

- view와 edit가 `DashboardRuntimeView`, `DashboardRuntimeShell`, `dashboard-runtime.css`를 공유한다.
- runtime API revision/widget contract와 chart engine은 이번 문서 범위에서 변경하지 않는다.
- #422의 table 변경이 table widget `DataTable`에 영향을 줄 수 있어 merge 후 재확인이 필요하다.

## Implementation Follow-up

- 게시 조회 share URL은 `/dashboards/:dashboardId`로 고정하고, share `Sheet` 안에서 사용자가 직접 실행하는 copy action과 성공/실패 feedback을 제공한다.
- 게시 revision/page/widget 없음 상태는 shadcn `Empty`와 `Button` composition을 사용하며 편집 모드 진입을 안내한다.
- 게시 page가 없으면 빈 `tablist`를 렌더링하지 않는다.

