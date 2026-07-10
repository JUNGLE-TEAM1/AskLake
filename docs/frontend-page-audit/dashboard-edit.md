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

## Rendered Audit Findings

### Desktop Findings

- [HIGH] dataset tree에서 react-arborist node wrapper와 내부 `TreeRow`가 모두 `treeitem`으로 노출되어 각 node가 중첩·중복 announcement된다. 하나의 semantic treeitem owner만 남겨야 한다.
- [HIGH] widget color palette의 기본 swatch button 여러 개가 accessible name을 제공하지 않는다. 이번 snapshot에서 직접 색상 action을 제외한 swatch 11개가 이름 없는 button으로 노출됐다.
- [MEDIUM] `openByDefault`로 11개 dataset과 column group이 다수 펼쳐져 처음부터 tree density가 높다. long dataset name도 sidebar 폭에서 잘리므로 default open level과 tooltip/search 정책을 조정한다.
- [MEDIUM] H1은 list의 friendly title 대신 raw ID `dash_sales_demo`를 표시한다.
- [PASS] edit toolbar의 assistant/cursor/add/undo/redo icon button은 모두 aria-label과 title을 제공한다.
- [PASS] dataset을 선택하면 inspector의 dataset, title, description, widget type, axis, aggregation form이 활성화되고 label/combobox/radiogroup semantics가 제공된다.

### Narrow Viewport Findings

- [HIGH] 360px에서 workspace container가 약 `288px`인데 내부 scroll width는 `600px`로 유지된다. dataset/canvas/inspector 3-column editor가 horizontal scroll에 의존해 primary editing workflow가 어렵다.
- [HIGH] page tab strip도 별도 horizontal scrollbar를 만들며 global app sidebar가 첫 viewport를 차지한다.
- [MEDIUM] mobile은 dataset과 inspector를 동시에 두기보다 각각 `Sheet`로 열고 canvas를 primary surface로 유지하는 구조가 적합하다.

### Verification Coverage

- 확인함: desktop 1280x900, narrow 360x800, draft empty state, dataset tree, dataset 선택, inspector 활성화, toolbar names, tab semantics, color swatch names, overflow measurement, console warning/error.
- 확인하지 못함: widget 생성, drag/resize, collision rollback, color picker interaction, undo/redo, page rename/delete, publish, assistant response.

### shadcn Review

- Structure: mixed - domain composition은 적절하지만 tree semantics와 대형 inspector file의 책임이 크다.
- Tokens: pass - editor surface와 form control은 theme과 일치한다.
- Composition: issues - color picker layer, mobile side panels, feedback state를 `Popover`, `Sheet`, `Alert`, `Skeleton`으로 보완할 수 있다.
- Responsive/a11y: issues - duplicate treeitem, unnamed swatches, 600px mobile workspace가 높은 우선순위다.
- Install/search notes: 기존 `Sheet`, `Popover`, `ScrollArea`, `Tabs`, `ToggleGroup`, `Tooltip`로 먼저 정리하고 react-arborist/react-grid-layout은 유지한다.

### Recommended Order

1. color swatch accessible name과 duplicate treeitem semantics를 수정한다.
2. mobile에서 dataset/inspector를 Sheet로 분리하고 canvas 중심 layout으로 바꾼다.
3. tree default expansion/long-name 정책과 raw dashboard title을 정리한다.
4. populated widget flow를 추가로 검증한다.

## Conflict Risk

- dashboard view와 runtime component/CSS를 대부분 공유하므로 edit-only 변경도 published view를 회귀시킬 수 있다.
- #422의 `DataTable` 변경은 table widget에 영향을 줄 수 있다.
- runtime API, layout serialization, widget config schema, AI assistant contract는 이번 문서 범위에서 변경하지 않는다.

