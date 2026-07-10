# SQL Analysis

## Route

- `/sql`

## Screen Purpose

- catalog dataset을 선택하고 schema를 참고해 SQL을 작성, preflight 검증, preview 실행, CSV 다운로드를 수행한다.
- Query AI 제안, autocomplete, 다중 dataset JOIN 보조, derived dataset Job 생성, dashboard draft 진입을 제공한다.
- mock dataset과 query preview fixture를 사용해 editor, result, empty, dialog 상태를 확인할 수 있다.

## Current Shared Components

- shadcn primitive: `Button`, `Checkbox`, `Input`, `Textarea`.
- AskLake composition: `PageHeader`, `ActionGroup`, `FilterToolbarSearch`, `FilterToolbarInput`, `FormFieldGroup`, `NativeSelectField`, `PaginationBar`, `ResultPanel`, `DialogShell`.
- `SqlDatasetTree`: `TreePanel`, `TreeView`, `TreeGroup`, `TreeRow`, `TreeHoverCard`를 조합한 dataset browser다.
- `SqlPreviewTable`: TanStack 기반 `DataTable`로 결과 sorting, pagination, empty state를 처리한다.
- `SchemaDetailsPanel`: 선택 dataset, JOIN, column insert를 담당하는 도메인 panel이다.
- `DashboardPage`: SQL 결과로 dashboard draft를 만드는 embedded flow에 재사용된다.

## Weakly Componentized Areas

- 왼쪽 도구 탭은 raw button과 `role="tablist"`를 사용하지만 shadcn `Tabs`의 keyboard behavior를 사용하지 않는다.
- SQL editor는 `Textarea`, line-number `<pre>`, custom surface, custom footer를 직접 조합한다. autocomplete도 absolute custom popover와 raw button list다.
- `SqlDatasetTreeRow`, `SchemaDetailsPanel`의 add/JOIN/remove/column insert action 일부는 raw `<button>`으로 구현되어 Button variant와 focus style이 일관되지 않다.
- Query AI의 compose/result/error 상태는 `sql-ai-*` 전용 div와 CSS로 구성된다.
- dashboard builder overlay는 raw backdrop와 `section[role="dialog"]`이며 `DialogShell`을 사용하지 않는다.
- schema panel, selected dataset pill, check/result status, result empty state가 전용 markup에 강하게 결합되어 있다.
- `SqlAnalysisPage.tsx` 하나가 query state, AI, autocomplete, materialize dialog, embedded dashboard를 모두 관리한다.

## shadcn/ReUI Replacement Candidates

- `Tabs`: table browser와 Query AI panel 전환을 표준 tab pattern으로 바꾼다.
- `Popover` + `Command`: SQL autocomplete list의 focus 이동, active option, dismiss behavior를 정리한다.
- `Dialog`: raw dashboard builder backdrop를 accessible dialog composition으로 교체한다.
- `ScrollArea`: dataset tree, schema panel, autocomplete, result table의 독립 scroll 영역에 사용한다.
- `Alert`: preflight error, Query AI error, execution error를 공통 feedback 구조로 표시한다.
- `Badge` 또는 `StatusBadge`: layer, RAG, preflight tone, selected dataset metadata를 통일한다.
- `Skeleton`과 `Empty`: dataset loading, schema 미선택, result 미실행 상태를 명확히 분리한다.
- `ResizablePanelGroup`: 좌측 dataset, editor, 우측 schema panel 폭 조절이 제품 요구에 포함될 때 검토한다.
- 전문 SQL editor가 필요해지면 shadcn으로 억지 구현하지 말고 CodeMirror 또는 Monaco 같은 검증된 editor engine을 별도 결정한다.

## Design Options For Existing Components

- `SqlDatasetTree`, `SchemaDetailsPanel`: SQL 도메인 composition으로 유지하되 내부 raw action을 `Button`과 공통 feedback primitive로 교체한다.
- `TreePanel`/`TreeView`: 현재 계층이 단순하고 기존 primitive가 있으므로 유지한다. 대규모 virtual tree가 필요할 때만 `react-arborist` 기반 ReUI style을 검토한다.
- `SqlPreviewTable`: 이미 `DataTable`을 사용하므로 유지한다.
- `ResultPanel`, `ActionGroup`, `DialogShell`: AskLake 공통 composition으로 유지하고 variant를 확장한다.
- editor surface는 별도 `SqlEditor` 컴포넌트로 분리해 autocomplete와 keyboard logic을 한 경계에 둔다.

## Related CSS

- 현재 사용 중: `frontend/src/styles/sql.css`의 `.sql-page`, `.sql-page-header`, `.sql-dataset-panel`, `.sql-sidebar-tabs`, `.sql-sidebar-tab-panel`.
- 현재 사용 중: `.sql-tree-*`, `.sql-schema-panel`, `.sql-selected-dataset-*`, `.sql-card-schema-*`, `.sql-tree-hover-card`.
- 현재 사용 중: `.sql-editor-*`, `.sql-autocomplete-popover`, `.sql-check-*`, `.sql-result-*`, `.sql-preview-table-*`.
- 현재 사용 중: `.sql-ai-*`, `.sql-materialize-*`, `.sql-dashboard-builder-*`.
- 주의: `sql.css`가 약 48KB로 화면 상태와 legacy selector가 섞여 있으므로 component 전환 전 selector-to-markup inventory가 필요하다.

## QA Notes

- process 환경에서 `VITE_USE_MOCK_API=true`로 `/sql`을 열었을 때 dataset/schema/editor UI가 API 오류 없이 렌더링된다.
- 페이지 진입 smoke만 수행했으며 query 실행, CSV download, materialize, dashboard 생성 interaction은 이번 문서 PR에서 재검증하지 않았다.
- autocomplete keyboard, editor focus, sidebar collapse, nested dialog focus trap이 후속 구현의 핵심 QA다.
- mobile에서는 세 column workspace가 순차 layout으로 바뀔 때 editor와 schema가 겹치지 않는지 확인한다.

## Conflict Risk

- #422의 list/search/table/pagination 변경이 dataset browser와 result table에 영향을 줄 수 있다.
- dashboard runtime을 embedded dialog로 재사용하므로 SQL overlay 변경은 dashboard route와 함께 확인해야 한다.
- query contract, mock API, derived dataset payload, dashboard runtime API는 이번 문서 범위에서 변경하지 않는다.

