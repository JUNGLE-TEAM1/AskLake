# Dashboard Edit

## Route

- `/dashboards/:dashboardId/edit`

## Screen Purpose

- dashboard draft revision에서 page와 widget을 생성, 선택, 이동, 크기 조절, 설정, 삭제하고 게시한다.
- dataset sidebar, canvas, widget inspector, AI assistant inspector, edit toolbar를 하나의 workspace로 제공한다.
- title/page rename, layout undo/redo, share, refresh, published view 이동을 지원한다.

## Current Shared Components

- `DashboardRuntimeShell`, `DashboardTopBar`, `DashboardPageTabs`: runtime chrome과 navigation을 담당한다.
- `DashboardCanvas`: `react-grid-layout`을 사용해 widget drag/resize와 collision validation을 처리한다.
- `DatasetSidebar`: `react-arborist`, `TreePanel`, `TreeRow`, `TreeHoverCard`, shadcn `Tooltip`을 조합한다.
- `WidgetConfigPanel`: `SettingsPanel`, `FormFieldGroup`, `NativeSelectField`, `IconOptionGrid`, `Input`, `Textarea`, `Checkbox`, `Button`을 조합한다.
- `DashboardAssistantPanel`: `Textarea`, `Button`으로 dashboard AI interaction을 제공한다.
- `ActionGroup`: undo/redo, assistant, cursor, widget 생성 toolbar의 layout을 담당한다.
- `WidgetFrame`, `WidgetRenderer`: widget selection, delete, preview, chart/table/metric 렌더링을 담당한다.
- shadcn `Sheet`: share panel에 사용한다.

## Weakly Componentized Areas

- edit toolbar 안의 assistant/cursor/widget type action 일부가 raw `<button>`이며 공통 Button variant와 focus-visible 규칙을 사용하지 않는다.
- dataset sidebar toggle은 raw button이며 subnav/tab CSS에 직접 결합되어 있다.
- page tab wrapper, rename/delete controls, selected state가 custom CSS로 구현되어 있다.
- widget inspector의 color slot, palette, custom color popover는 `react-colorful`과 전용 absolute layer/CSS로 구성된다.
- draft loading/error/no-revision 상태 wrapper가 반복되고 `EmptyDashboardCanvas`가 여러 상태를 동시에 담당한다.
- inspector, dataset sidebar, canvas column layout과 open/closed 상태가 대형 `dashboard-runtime.css` selector에 의존한다.
- assistant message, working overlay, error feedback이 전용 markup이며 공통 Alert/Skeleton을 사용하지 않는다.
- `WidgetConfigPanel.tsx`가 widget type별 form rule과 color UI를 한 파일에 포함해 크기가 크다.

## shadcn/ReUI Replacement Candidates

- `Tabs`: page navigation의 keyboard interaction과 active state를 표준화한다.
- `ToggleGroup`: cursor/assistant/edit tool mode처럼 상호 배타적인 toolbar 상태에 사용한다.
- `Button`: raw toolbar action과 dataset toggle을 icon button variant로 교체한다.
- `Popover`: color picker와 widget type 보조 UI의 layer/focus/escape 처리를 맡긴다.
- `ScrollArea`: dataset sidebar와 inspector form의 독립 scroll을 명확히 한다.
- `Alert`, `Skeleton`, `Empty`: draft error/loading/no widget/no revision 상태를 분리한다.
- `Tooltip`: icon-only edit toolbar action을 일관되게 설명한다.
- ReUI Tree 또는 현재 `react-arborist` + shadcn style: dataset tree virtualization은 유지하고 visual/interaction primitive만 정리한다.
- `ResizablePanelGroup`: dataset/canvas/inspector 폭 조절이 제품 요구로 확정될 때 검토한다.

## Design Options For Existing Components

- `DashboardCanvas`와 `react-grid-layout`: drag/resize/collision 도메인 엔진이므로 유지한다.
- `DatasetSidebar`: 대규모 tree와 hover metadata가 있어 AskLake composition으로 유지하고 `TreePanel`/`Tooltip` 사용을 강화한다.
- `WidgetConfigPanel`: type별 subform으로 분리하되 `SettingsPanel`, `FormFieldGroup`, `NativeSelectField` API는 유지한다.
- `IconOptionGrid`: widget type 선택에 적합하므로 유지하고 tooltip/focus contract를 공통화한다.
- `DashboardAssistantPanel`: 도메인 component로 유지하고 feedback surface만 공통 primitive로 바꾼다.
- chart engine, `react-colorful`, layout data contract는 shadcn으로 대체할 대상이 아니다.

## Related CSS

- 현재 사용 중: `frontend/src/styles/dashboard-runtime.css`의 `.asklake-dashboard-workspace`, `.has-dataset-sidebar`, `.dataset-sidebar-open`, `.has-inspector`.
- 현재 사용 중: `.asklake-dashboard-dataset-sidebar`, `.asklake-dataset-tree-*`, `.asklake-dashboard-inspector`, `.asklake-dashboard-edit-stage`, `.asklake-dashboard-edit-toolbar`.
- 현재 사용 중: `.asklake-dashboard-rgl*`, `.asklake-widget-frame*`, `.asklake-widget-config-*`, `.asklake-widget-type-*`, `.asklake-widget-color-*`.
- 현재 사용 중: `.asklake-assistant-*`, `.asklake-dashboard-tab-*`, `.asklake-dashboard-title-edit-*`, `.asklake-dashboard-share-sheet*`.
- 주의: runtime CSS가 약 46KB이며 view/edit/widget/assistant 상태를 공유한다. component 단위 stylesheet ownership을 먼저 정한 뒤 cleanup한다.

## QA Notes

- process 환경에서 `VITE_USE_MOCK_API=true`로 `/dashboards/dash_sales_demo/edit`를 열었을 때 draft workspace가 API 오류 없이 렌더링된다.
- 현재 mock은 빈 draft에서 시작하므로 populated widget drag/resize와 inspector type별 설정은 이번 최소 smoke에서 실행하지 않았다.
- 후속 구현 QA는 dataset 선택, widget 생성, drag/resize, collision rollback, undo/redo, page rename/delete, publish 순서로 진행한다.
- mobile/narrow viewport에서는 sidebar와 inspector가 canvas를 가리거나 keyboard focus를 가두지 않는지 확인한다.

## Conflict Risk

- dashboard view와 runtime component/CSS를 대부분 공유하므로 edit-only 변경도 published view를 회귀시킬 수 있다.
- #422의 `DataTable` 변경은 table widget에 영향을 줄 수 있다.
- runtime API, layout serialization, widget config schema, AI assistant contract는 이번 문서 범위에서 변경하지 않는다.

