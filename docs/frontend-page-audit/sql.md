# SQL Analysis

## Route

- `/sql`

## Screen Purpose

- catalog dataset을 선택하고 schema를 참고해 SQL을 작성, preflight 검증, preview 실행, CSV 다운로드를 수행한다.
- Query AI 제안, autocomplete, 다중 dataset 선택, derived dataset Job 생성, dashboard draft 진입을 제공한다.
- mock dataset과 query preview fixture를 사용해 editor, result, empty, dialog 상태를 확인할 수 있다.

## Current Shared Components

- shadcn primitive: `Button`, `Badge`, `Bubble`, `Checkbox`, `Command`, `Dialog`, `Empty`, `Field`, `FieldGroup`, `HoverCard`, `Input`, `NativeSelect`, `Popover`, `Resizable`, `ScrollArea`, `Separator`, `Slider`, `Tabs`, `Textarea`.
- shadcn registry component: Shadcnblocks `tree-lines-1`이 설치한 Kibo UI `TreeProvider`, `TreeView`, `TreeNode`, `TreeNodeTrigger`, `TreeExpander`, `TreeIcon`, `TreeLabel`, `TreeNodeContent`.
- AskLake composition: `PageHeader`, `Panel`, `PanelHeader`, `ActionGroup`, `FilterToolbarSearch`, `FilterToolbarInput`, `PaginationBar`, `DialogShell`.
- `SqlDatasetTree`: Shadcnblocks line tree와 shadcn `HoverCard`, `Button`을 조합한 dataset browser다.
- `SqlPreviewTable`: TanStack 기반 `DataTable`로 결과 sorting, pagination, empty state를 처리한다.
- `SchemaDetailsPanel`: 선택 dataset 전환·해제와 column insert를 담당하는 도메인 panel이다.
- `DashboardPage`: SQL 결과로 dashboard draft를 만드는 embedded flow에 재사용된다.

## Weakly Componentized Areas

- SQL editor는 `Textarea`, line-number `<pre>`, dark surface를 직접 조합한다. autocomplete 후보와 overlay는 shadcn `Command`/`Popover`가 소유하고 editor cursor 문맥 계산은 route logic으로 유지한다.
- SQL editor의 dark surface와 line-number 정렬에는 도메인 layout CSS가 남아 있다. dataset tree의 line/row/expand surface는 registry Tree가, dataset/schema/result의 실제 scroll 동작은 `ScrollArea`가 소유한다.
- global App Shell sidebar가 좁은 viewport의 첫 화면을 점유해 SQL mobile workspace 가독성이 낮다.
- `SqlAnalysisPage.tsx` 하나가 query state, AI, autocomplete, materialize dialog, embedded dashboard를 모두 관리한다.

## shadcn/ReUI Replacement Candidates

- `Tabs`: #468에서 table browser와 Query AI panel 전환에 적용하고, useLayouts Discrete Tabs 패턴을 참고한 shared `layoutId` indicator를 추가했다.
- `Popover` + `Command`: 이번 보완에서 SQL autocomplete list의 active option, dismiss, keyboard 후보 이동을 적용했다.
- `Dialog`: #468에서 raw dashboard builder backdrop를 accessible dialog composition으로 교체했다.
- `ScrollArea`: #468에서 dataset panel, schema panel, autocomplete, result table의 독립 scroll 영역에 적용했다.
- Shadcnblocks `tree-lines-1`: #468에서 SQL dataset branch/table/column tree에 적용했다. `showLines`, controlled expand, single dataset preview, keyboard Enter/Space 동작을 사용한다.
- `Alert`: preflight error, Query AI error, execution error를 공통 feedback 구조로 표시한다.
- `Badge`: #468에서 layer, RAG, preflight tone, selected dataset metadata에 적용했다.
- `Empty`: #468에서 schema 미선택과 result 미실행 상태에 적용했다. `Skeleton`은 async loading 요구가 생길 때 추가한다.
- `ResizablePanelGroup`: 이번 보완에서 좌측 dataset, editor, 우측 schema panel에 적용했다. 1,240px 이하에서는 drag handle을 숨기고 기존 2열/1열 responsive layout으로 전환한다.
- 전문 SQL editor가 필요해지면 shadcn으로 억지 구현하지 말고 CodeMirror 또는 Monaco 같은 검증된 editor engine을 별도 결정한다.

## Design Options For Existing Components

- `SqlDatasetTree`, `SchemaDetailsPanel`: SQL 도메인 composition으로 유지하되 내부 action은 shadcn `Button`, 계층 UI는 Shadcnblocks/Kibo Tree를 사용한다.
- SQL tree는 `tree-lines-1` 패턴으로 교체했다. drag-and-drop은 제품 요구가 없어 추가하지 않고, 대규모 virtualization이 필요할 때만 별도 engine을 검토한다.
- `SqlPreviewTable`: 이미 `DataTable`을 사용하므로 유지한다.
- `Panel`/`PanelHeader`, `ActionGroup`, `DialogShell`: AskLake 공통 composition으로 유지하고 내부는 shadcn primitive를 사용한다.
- editor surface는 별도 `SqlEditor` 컴포넌트로 분리해 autocomplete와 keyboard logic을 한 경계에 둔다.

## Related CSS

- 현재 사용 중: `frontend/src/styles/sql.css`의 `.sql-page`, `.sql-page-header`, `.sql-dataset-panel`, `.sql-schema-panel`.
- 현재 사용 중: `.sql-resizable-*`, `.sql-editor-surface`, `.sql-editor-footer*`, `.sql-result-scroll`, `.sql-preview-table*`, `.sql-dashboard-builder-dialog`.
- #468 보완까지 `sql.css`를 2,547줄에서 328줄로 줄였다. shadcn이 소유하는 panel/header/form/list/separator/table/scroll/tree/autocomplete/hover surface CSS는 제거했다.

## Pre-#468 QA Notes

- process 환경에서 `VITE_USE_MOCK_API=true`로 `/sql`을 열었을 때 dataset/schema/editor UI가 API 오류 없이 렌더링된다.
- 페이지 진입 smoke만 수행했으며 query 실행, CSV download, materialize, dashboard 생성 interaction은 이번 문서 PR에서 재검증하지 않았다.
- autocomplete keyboard, editor focus, sidebar collapse, nested dialog focus trap을 route QA의 핵심 항목으로 유지한다.
- mobile에서는 세 column workspace가 순차 layout으로 바뀔 때 editor와 schema가 겹치지 않는지 확인한다.

## Pre-#468 Rendered Audit Findings

### Desktop Findings

- [PASS] initial state는 editor와 실행 button을 disabled하고 `먼저 분석 테이블에서 데이터셋을 선택`하라는 empty guidance를 제공한다.
- [PASS] `commerce_orders_daily`를 선택하면 default SQL, `점검 통과`, enabled 실행 button, selected schema panel이 함께 갱신됐다.
- [MEDIUM] SQL editor textarea는 초기 placeholder가 accessible name처럼 노출되지만 지속적인 visible/ARIA label이 없다. query 입력 후에도 유지되는 `aria-label="SQL editor"` 또는 실제 label이 필요하다.
- [PASS] `분석 테이블`/`Query AI`는 `tablist`, `tab`, `aria-selected`를 제공한다. dataset tree와 column insert button도 구체적인 accessible name을 제공한다.
- [MEDIUM] browser click가 두 번 timeout되어 Preview 실행 결과는 이번 감사에서 확인하지 못했다. 제품 오류로 단정하지 않고 coverage limitation으로 남긴다.

### Narrow Viewport Findings

- [HIGH] 360px에서 global app sidebar가 첫 viewport를 차지해 SQL workspace가 아래로 밀린다.
- [HIGH] dataset tree의 긴 이름이 약 48px 폭으로 줄어 12개 후보 대부분이 심하게 잘린다. dataset browser를 mobile `Sheet`로 이동하거나 최소 폭/ellipsis/tooltip 정책을 적용해야 한다.
- [PASS] page-level horizontal overflow는 없었지만 이는 column을 좁혀 숨긴 결과에 가깝다. 정보 가독성 기준으로는 통과가 아니다.

### Verification Coverage

- 확인함: desktop 1280x900, narrow 360x800, initial empty/disabled state, dataset 선택, default query, preflight pass, selected schema, tab semantics, console warning/error.
- 확인하지 못함: Preview result table, CSV download, materialize dialog, Query AI response, dashboard builder overlay, execution error/retry.

### shadcn Review

- Structure: mixed - route composition은 분리돼 있지만 editor/autocomplete/dashboard overlay 책임이 크다.
- Tokens: pass - form/action/result surface는 현재 theme과 일치한다.
- Composition: issues - editor label, autocomplete popover, raw embedded dashboard dialog를 기존 primitive로 보완할 수 있다.
- Responsive/a11y: issues - mobile dataset browser clipping과 editor persistent label이 핵심이다.
- Install/search notes: `Tabs`, `Popover`, `Dialog`, `ScrollArea`는 설치돼 있다. `Alert`는 추가 설치 또는 기존 feedback composition 확장 중 선택하고 editor engine 교체는 별도 결정한다.

### Recommended Order

1. mobile dataset browser를 Sheet/overlay pattern으로 전환하고 long-name policy를 적용한다.
2. SQL editor에 지속적인 accessible label과 execution feedback을 추가한다.
3. autocomplete와 embedded dashboard overlay를 shadcn primitive로 정리한다.

## Conflict Risk

- #422의 list/search/table/pagination 변경이 dataset browser와 result table에 영향을 줄 수 있다.
- dashboard runtime을 embedded dialog로 재사용하므로 SQL overlay 변경은 dashboard route와 함께 확인해야 한다.
- query contract, mock API, derived dataset payload, dashboard runtime API는 이번 문서 범위에서 변경하지 않는다.

## #468 Applied Refactor

2026-07-10 구현에서는 API와 Dashboard runtime 계약을 유지하면서 SQL route의 raw UI와 중복 CSS를 shadcn 기준으로 정리했다.

- 왼쪽 도구 전환을 `Tabs`로 바꿔 keyboard/ARIA 동작을 primitive에 맡겼다.
- 선택된 SQL 도구 탭의 흰 배경만 `motion` shared `layoutId`로 이동시켜 기존 Tabs 구조와 focus/ARIA 계약을 유지한다. 전환값은 `spring`, `stiffness: 420`, `damping: 32`다.
- editor footer에 `Slider`를 추가해 Preview 최대 행 수를 10~100, 10행 단위로 실제 변경한다. 선택값은 preflight key와 `executeQueryPreview`의 `limit`에 함께 반영된다.
- Query AI 안내, 응답, 오류 surface를 `Bubble`/`BubbleContent`로 교체했다.
- embedded Dashboard builder는 raw backdrop과 `role="dialog"` 대신 `Dialog`/`DialogContent`를 사용한다.
- SQL 도구, editor, schema, result surface는 `Panel`, 상태/metadata는 `Badge`, 빈 상태는 `Empty`, action은 `Button`, label/control 조합은 `Field`를 사용한다.
- dataset 추가, 제거, column 삽입 action을 `Button`으로 통일했다. dataset 추가는 회색 `ghost` 아이콘 버튼으로 단순화했다.
- 미사용 `SqlDatasetSchemaPreview.tsx`를 삭제했다.
- 최초 #468 구현에서 `sql.css`를 2,547줄에서 401줄로 줄였고, 보완에서 `Command`/`HoverCard`/`Resizable`을 적용해 328줄로 더 줄였다.
- 처리 Job 모달은 `FormFieldGroup`/`NativeSelectField`와 `sql-materialize-*` CSS 대신 `DialogShell` + `FieldGroup` + `Field` + `NativeSelect` grid를 사용한다.
- schema list는 `Panel` + `PanelHeader` + `Separator`, result header는 `PanelHeader`, autocomplete surface는 `Panel` + `Button` + `Badge`로 구성한다.
- dataset/schema/autocomplete/result의 native `overflow: auto`를 제거하고 shadcn `ScrollArea`를 실제 scroll container로 사용한다. SQL 영역은 `type="always"`로 thumb를 명확히 노출하고 result는 vertical/horizontal scrollbar를 모두 제공한다.
- Slider track/range/thumb는 AskLake의 slate/blue token으로 명시해 track과 현재 값이 배경에서 확실히 구분되도록 했다.
- SQL 도구의 후보/검색 건수와 schema의 선택 건수 badge를 제거하고, Page/Panel/Dialog title 아래의 반복 설명문을 제거해 heading hierarchy를 한 줄로 정리했다.
- Query AI panel의 `Query AI 생성`, `테이블 선택 필요` badge도 제거해 탭 아래에서 같은 상태를 반복하지 않는다.
- SQL dataset tree를 Shadcnblocks `tree-lines-1` registry로 교체하고 Kibo UI Tree source를 프로젝트에 설치했다. `motion`은 registry의 expand/collapse animation 의존성으로 추가했다.
- 기존 `.sql-tree-node`, `.sql-tree-branch`, `.sql-tree-table-*`, `.sql-tree-column-*` selector를 제거했고, 보완에서 fixed hover card selector도 제거했다.
- SQL page가 `page-body`의 실제 남은 높이를 사용하도록 grid row를 제한하고, 후보 Tree만 `ScrollArea`로 스크롤되게 해 검색/페이징을 고정했다.
- 중앙 `sql-workspace`의 auto row는 `max-content`로 고정해 제한된 viewport 안에서도 editor/result Panel이 내부 콘텐츠보다 작아지거나 서로 겹치지 않게 했다.
- 다크 SQL editor에서는 shadcn `Textarea`의 파란 focus ring/offset을 제거해 line-number gutter 옆에 이중 세로선이 생기지 않게 했다. 다른 form control의 focus ring은 유지한다.
- 선택 테이블 row의 연한 파란 hover/active 배경을 정보 버튼과 해제 action을 포함한 전체 row wrapper에 적용했다.
- 우측 선택 테이블 row와 schema header의 반복 컬럼 수 badge, 자동 JOIN action을 제거해 테이블명과 선택/해제 흐름에 집중하도록 정리했다. 사용자가 SQL editor에 직접 작성한 JOIN 문법 지원은 유지한다.
- 1,200px 콘텐츠 폭에서 3열 최소폭이 밀리던 문제를 막기 위해 1,240px부터 2열 layout으로 전환한다.

### #468 Verification

- `commerce_orders_daily` 선택 후 Slider를 50행으로 조작하고 실행해 `50행 조회됨`, `최대 50행 표시`, 2-page result를 확인했다.
- Slider track, blue range, thumb가 모두 표시되고 keyboard로 설정한 50행이 label과 실행 limit에 반영되는 것을 확인했다.
- dataset/schema/result의 scrollbar가 shadcn `ScrollArea` thumb로 렌더링되고 native scrollbar가 중첩되지 않는 것을 확인했다.
- Shadcnblocks Tree에서 connector line과 icon이 표시되고 table row mouse click, Enter key 접기, column group 노출, `+ 추가` 후 editor/schema 활성화를 확인했다.
- 720px viewport에서 panel 하단 634px, pagination 하단 613px, footer 시작 658px로 `이전`/`다음`이 잘리지 않음을 확인하고 실제 1→2→1 page 이동을 검증했다.
- Query AI 탭에서 `Query AI 생성`, `테이블 선택 필요` 문구가 렌더링되지 않는 것을 확인했다.
- 720px viewport에서 editor Panel 462px, result Panel 250px의 자체 높이를 확보하고 두 Panel 사이 12px gap이 유지되며 Tree 펼침 후에도 overlap이 없음을 확인했다.
- 분석 테이블↔Query AI 전환 시 흰 indicator가 shared `layoutId` spring으로 좌우 이동하고 선택 tab의 ARIA state가 함께 변경됨을 확인했다.
- 1,200px와 860px viewport에서 Tree와 page의 horizontal overflow가 없음을 확인했다.
- Query AI prompt를 실행해 Bubble 안에 생성 SQL과 `SQL에 적용` action이 표시되는 것을 확인했다.
- Dashboard builder Dialog가 열리고 `Escape`로 닫히는 것을 확인했다.
- 실제 1,200x750 CSS viewport에서 2열 전환 후 SQL page/table의 horizontal overflow가 없음을 확인했다.
- 처리 Job 모달은 768px 폭에서 field 4개와 RAG checkbox, 기본 close button이 표시되고 body horizontal/vertical overflow가 없음을 확인했다.
- 360px에서 page-level horizontal overflow는 없지만, 기존 global sidebar가 첫 viewport를 점유하는 문제는 그대로다. App Shell mobile navigation은 #468 범위를 넓히지 않고 별도 작업으로 유지한다.
- browser console warning/error가 없음을 확인했다.

### #468 Remaining Deliberate CSS

- SQL autocomplete의 surface/action/list/overlay는 `Popover` + `Command`로 바꾸고 editor focus/selection 문맥 계산만 유지했다.
- dataset hover detail은 `HoverCard`로 바꿔 fixed 위치 계산과 전용 hover selector를 제거했다. dark editor, ScrollArea의 높이/배치, embedded Dashboard 크기는 도메인 layout이라 유지했다.
- 3열 폭은 `ResizablePanelGroup`이 소유하며 `.sql-resizable-*`는 inline panel sizing을 desktop/2열/1열 breakpoint에 맞게 전환하는 layout CSS만 담당한다.
- global sidebar의 mobile 동작은 `layout.css`/`responsive.css` 소유이며 SQL route CSS에서 우회하지 않는다.

### #468 Shadcn Follow-up

- SQL 자동완성을 shadcn `Popover` + `Command`로 교체하고 ArrowUp/ArrowDown, Tab 삽입, Escape dismiss와 editor focus 계약을 유지했다.
- dataset/table/column 상세를 shadcn `HoverCard`로 교체해 mouse 좌표와 viewport를 직접 계산하던 fixed overlay를 제거했다.
- dataset/editor/schema 3열을 shadcn `ResizablePanelGroup`으로 교체했다. 데스크톱에서는 두 handle로 폭을 조절하고, 1,240px 이하에서는 2열, 860px 이하에서는 1열로 안전하게 전환한다.
- 전역 앱 Sidebar, API 로그 Popover, 프로필 Avatar는 SQL route 범위를 넘어 기존 화면과 충돌할 수 있어 별도 App Shell PR로 분리한다.
