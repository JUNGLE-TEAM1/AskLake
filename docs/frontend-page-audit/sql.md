# SQL Analysis

## Route

- `/sql`

## Screen Purpose

- catalog dataset을 선택하고 schema를 참고해 SQL을 작성, preflight 검증, preview 실행, CSV 다운로드를 수행한다.
- Query AI 제안, autocomplete, 다중 dataset JOIN 보조, derived dataset Job 생성, dashboard draft 진입을 제공한다.
- mock dataset과 query preview fixture를 사용해 editor, result, empty, dialog 상태를 확인할 수 있다.

## Current Shared Components

- shadcn primitive: `Button`, `Badge`, `Bubble`, `Checkbox`, `Dialog`, `Empty`, `Field`, `Input`, `Slider`, `Tabs`, `Textarea`.
- AskLake composition: `PageHeader`, `ActionGroup`, `FilterToolbarSearch`, `FilterToolbarInput`, `FormFieldGroup`, `NativeSelectField`, `PaginationBar`, `ResultPanel`, `DialogShell`.
- `SqlDatasetTree`: `TreePanel`, `TreeView`, `TreeGroup`, `TreeRow`, `TreeHoverCard`를 조합한 dataset browser다.
- `SqlPreviewTable`: TanStack 기반 `DataTable`로 결과 sorting, pagination, empty state를 처리한다.
- `SchemaDetailsPanel`: 선택 dataset, JOIN, column insert를 담당하는 도메인 panel이다.
- `DashboardPage`: SQL 결과로 dashboard draft를 만드는 embedded flow에 재사용된다.

## Weakly Componentized Areas

- SQL editor는 `Textarea`, line-number `<pre>`, dark surface를 직접 조합한다. autocomplete는 editor focus/selection과 absolute position 계산이 묶인 custom popover다.
- dataset tree, schema list, result table에는 도메인 density/overflow/hover 위치 CSS가 남아 있다.
- global App Shell sidebar가 좁은 viewport의 첫 화면을 점유해 SQL mobile workspace 가독성이 낮다.
- `SqlAnalysisPage.tsx` 하나가 query state, AI, autocomplete, materialize dialog, embedded dashboard를 모두 관리한다.

## shadcn/ReUI Replacement Candidates

- `Tabs`: #468에서 table browser와 Query AI panel 전환에 적용했다.
- `Popover` + `Command`: SQL autocomplete list의 focus 이동, active option, dismiss behavior를 정리한다.
- `Dialog`: #468에서 raw dashboard builder backdrop를 accessible dialog composition으로 교체했다.
- `ScrollArea`: dataset tree, schema panel, autocomplete, result table의 독립 scroll 영역에 사용한다.
- `Alert`: preflight error, Query AI error, execution error를 공통 feedback 구조로 표시한다.
- `Badge`: #468에서 layer, RAG, preflight tone, selected dataset metadata에 적용했다.
- `Empty`: #468에서 schema 미선택과 result 미실행 상태에 적용했다. `Skeleton`은 async loading 요구가 생길 때 추가한다.
- `ResizablePanelGroup`: 좌측 dataset, editor, 우측 schema panel 폭 조절이 제품 요구에 포함될 때 검토한다.
- 전문 SQL editor가 필요해지면 shadcn으로 억지 구현하지 말고 CodeMirror 또는 Monaco 같은 검증된 editor engine을 별도 결정한다.

## Design Options For Existing Components

- `SqlDatasetTree`, `SchemaDetailsPanel`: SQL 도메인 composition으로 유지하되 내부 raw action을 `Button`과 공통 feedback primitive로 교체한다.
- `TreePanel`/`TreeView`: 현재 계층이 단순하고 기존 primitive가 있으므로 유지한다. 대규모 virtual tree가 필요할 때만 `react-arborist` 기반 ReUI style을 검토한다.
- `SqlPreviewTable`: 이미 `DataTable`을 사용하므로 유지한다.
- `ResultPanel`, `ActionGroup`, `DialogShell`: AskLake 공통 composition으로 유지하고 variant를 확장한다.
- editor surface는 별도 `SqlEditor` 컴포넌트로 분리해 autocomplete와 keyboard logic을 한 경계에 둔다.

## Related CSS

- 현재 사용 중: `frontend/src/styles/sql.css`의 `.sql-page`, `.sql-page-header`, `.sql-dataset-panel`, `.sql-sidebar-tab-panel`.
- 현재 사용 중: `.sql-tree-*`, `.sql-schema-panel`, `.sql-selected-dataset-*`, `.sql-card-schema-*`, `.sql-tree-hover-card`.
- 현재 사용 중: `.sql-editor-*`, `.sql-autocomplete-popover`, `.sql-check-*`, `.sql-result-*`, `.sql-preview-table-*`.
- 현재 사용 중: Query AI/editor/result의 배치용 `.sql-ai-*`, `.sql-materialize-*`, embedded Dashboard 크기용 `.sql-dashboard-builder-dialog`.
- #468에서 `sql.css`를 2,547줄에서 1,255줄로 줄였으며, shadcn이 소유하는 tab/button/status/empty/dialog surface CSS는 제거했다.

## QA Notes

- process 환경에서 `VITE_USE_MOCK_API=true`로 `/sql`을 열었을 때 dataset/schema/editor UI가 API 오류 없이 렌더링된다.
- 페이지 진입 smoke만 수행했으며 query 실행, CSV download, materialize, dashboard 생성 interaction은 이번 문서 PR에서 재검증하지 않았다.
- autocomplete keyboard, editor focus, sidebar collapse, nested dialog focus trap이 후속 구현의 핵심 QA다.
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
- editor footer에 `Slider`를 추가해 Preview 최대 행 수를 10~100, 10행 단위로 실제 변경한다. 선택값은 preflight key와 `executeQueryPreview`의 `limit`에 함께 반영된다.
- Query AI 안내, 응답, 오류 surface를 `Bubble`/`BubbleContent`로 교체했다.
- embedded Dashboard builder는 raw backdrop과 `role="dialog"` 대신 `Dialog`/`DialogContent`를 사용한다.
- SQL 도구, editor, schema, result surface는 `Panel`, 상태/metadata는 `Badge`, 빈 상태는 `Empty`, action은 `Button`, label/control 조합은 `Field`를 사용한다.
- dataset `+ 추가`, JOIN, 제거, column 삽입 action을 `Button`으로 통일했다. `+ 추가`는 pill CSS를 제거하고 기본 `rounded-lg`의 직사각형 `size="sm"` 버튼으로 바꿨다.
- 미사용 `SqlDatasetSchemaPreview.tsx`를 삭제했다.
- `sql.css`는 2,547줄에서 1,255줄로 줄였다. 3-column workspace, dark editor, tree/hover positioning, result table density, embedded Dashboard 크기처럼 도메인 layout에 필요한 selector는 유지했다.

### #468 Verification

- `commerce_orders_daily` 선택 후 Slider를 50행으로 조작하고 실행해 `50행 조회됨`, `최대 50행 표시`, 2-page result를 확인했다.
- Query AI prompt를 실행해 Bubble 안에 생성 SQL과 `SQL에 적용` action이 표시되는 것을 확인했다.
- Dashboard builder Dialog가 열리고 `Escape`로 닫히는 것을 확인했다.
- 1024x768 override에서 SQL page/workspace/result toolbar의 horizontal overflow가 없음을 확인했다.
- 360px에서 page-level horizontal overflow는 없지만, 기존 global sidebar가 첫 viewport를 점유하는 문제는 그대로다. App Shell mobile navigation은 #468 범위를 넓히지 않고 별도 작업으로 유지한다.
- browser console warning/error가 없음을 확인했다.

### #468 Remaining Deliberate CSS

- SQL autocomplete는 editor focus/selection과 absolute position 계산이 묶여 있어 `Popover`/`Command`로 무리하게 바꾸지 않았다.
- dataset tree와 schema/result table은 각 도메인 density와 overflow가 있어 구조/layout selector를 유지했다.
- global sidebar의 mobile 동작은 `layout.css`/`responsive.css` 소유이며 SQL route CSS에서 우회하지 않는다.
