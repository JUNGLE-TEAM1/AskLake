# SQL Analysis

## Route

- `/sql`

## Screen Purpose

- catalog dataset을 선택하고 schema를 참고해 SQL을 작성, canonical Trino 검증/실행, cursor 결과 탐색, server-side CSV 다운로드를 수행한다. `TRINO_ENABLED=false`에서는 DuckDB compatibility 실행을 유지한다.
- Query AI 제안, autocomplete, 다중 dataset 선택, derived dataset Job 생성, dashboard draft 진입을 제공한다.
- mock dataset과 query preview fixture를 사용해 editor, result, empty, dialog 상태를 확인할 수 있다.

## Current Shared Components

- shadcn primitive: `Button`, `Badge`, `Bubble`, `Checkbox`, `Dialog`, `Empty`, `Field`, `FieldGroup`, `Input`, `NativeSelect`, `ScrollArea`, `Separator`, `Slider`, `Tabs`, `Textarea`.
- tree engine: `react-arborist`와 공통 `ExplorerTree`가 가상화, 키보드 탐색, 선택, 펼침 상태를 담당한다.
- AskLake composition: `PageHeader`, `Panel`, `PanelHeader`, `ActionGroup`, `FilterToolbarSearch`, `FilterToolbarInput`, `PaginationBar`, `DialogShell`.
- `SqlDatasetTree`: 공통 `ExplorerTree`, `TreeHoverCard`, shadcn `Button`을 조합한 dataset browser다.
- `SqlPreviewTable`: TanStack 기반 `DataTable`로 결과 sorting, pagination, empty state를 처리한다.
- `SqlResultsPanel`: `차트 보기`, `데이터 미리보기`, `실행 정보`를 같은 bounded panel에서 전환한다. 실행 정보는 평가와 Trino timeline을 담고 SQL editor 아래 별도 block을 만들지 않는다.
- `SchemaDetailsPanel`: 선택 dataset 전환·해제와 column insert를 담당하는 도메인 panel이다.
- `DashboardPage`: SQL 결과로 dashboard draft를 만드는 embedded flow에 재사용된다.

## Weakly Componentized Areas

- SQL editor는 `Textarea`, line-number `<pre>`, dark surface를 직접 조합한다. autocomplete는 editor focus/selection과 absolute position 계산이 묶인 custom popover다.
- SQL editor와 autocomplete 위치에는 CSS Module 기반 도메인 layout이 남아 있다. dataset tree의 가상화·row·expand·native scroll은 공통 `ExplorerTree`가 소유하고, autocomplete/result의 scroll 동작은 각 컴포넌트 경계가 소유한다.
- global App Shell sidebar가 좁은 viewport의 첫 화면을 점유해 SQL mobile workspace 가독성이 낮다.
- `SqlAnalysisPage.tsx`는 route-level dataset/query/result 연결 상태를 유지한다. 검색·pagination, Query AI, panel rendering, Job wizard의 입력·단계·검증은 별도 hook/component/model로 분리됐으며, 추가 분리는 독립적인 상태 소유권이 생길 때만 진행한다.

## shadcn/ReUI Replacement Candidates

- `Tabs`: #468에서 table browser와 Query AI panel 전환에 적용하고, useLayouts Discrete Tabs 패턴을 참고한 shared `layoutId` indicator를 추가했다.
- `Popover` + `Command`: SQL autocomplete list의 focus 이동, active option, dismiss behavior를 정리한다.
- `Dialog`: #468에서 raw dashboard builder backdrop를 accessible dialog composition으로 교체했다.
- `ScrollArea`: autocomplete와 result table처럼 트리가 아닌 독립 scroll 영역에 사용한다. dataset tree는 `react-arborist`가 자체 viewport를 소유한다.
- `ExplorerTree`: SQL dataset branch/table/column tree에 적용한다. controlled expand, 선택 표시, keyboard 탐색을 공통 컴포넌트가 제공한다.
- `Alert`: preflight error, Query AI error, execution error를 공통 feedback 구조로 표시한다.
- `Badge`: #468에서 layer, RAG, preflight tone, selected dataset metadata에 적용했다.
- `Empty`: #468에서 선택 테이블 없음과 result 미실행 상태에 적용했다. `Skeleton`은 async loading 요구가 생길 때 추가한다.
- `ResizablePanelGroup`: 좌측 dataset, editor, 우측 schema panel 폭 조절이 제품 요구에 포함될 때 검토한다.
- 전문 SQL editor가 필요해지면 shadcn으로 억지 구현하지 말고 CodeMirror 또는 Monaco 같은 검증된 editor engine을 별도 결정한다.

## Design Options For Existing Components

- `SqlDatasetTree`: SQL 도메인 composition으로 유지하되 내부 action은 shadcn `Button`, 계층 UI는 공통 `ExplorerTree`를 사용한다.
- SQL tree는 `react-arborist` 가상화와 공통 AskLake row surface를 사용한다. drag-and-drop은 제품 요구가 없어 비활성화한다.
- `SqlPreviewTable`: 이미 `DataTable`을 사용하므로 유지한다.
- `Panel`/`PanelHeader`, `ActionGroup`, `DialogShell`: AskLake 공통 composition으로 유지하고 내부는 shadcn primitive를 사용한다.
- editor surface는 별도 `SqlEditor` 컴포넌트로 분리해 autocomplete와 keyboard logic을 한 경계에 둔다.

## Related CSS

- `/sql` 본문과 처리 Job/Dashboard Dialog는 `--jobs-font-family`를 상속해 `/jobs`의 SUIT typography 기준을 사용한다. SQL editor와 line-number gutter의 monospace는 코드 가독성을 위해 유지한다.
- route layout과 editor/result workspace는 `SqlAnalysisPage.module.css`, dataset row·Nessie·preview table의 세부 style은 각각 co-located CSS Module이 소유한다.
- SQL preflight와 결과 실행 상태는 Jobs 기준 `StatusBadge`를 사용한다. SQL editor의 직접 작성 JOIN 문법은 유지하지만 선택 테이블의 자동 JOIN action은 제공하지 않는다.
- SQL editor는 Trino 통합 전과 같은 높이·toolbar·단일 textarea scroll을 유지한다. `실행 정보`는 `쿼리 실행`, `첫 결과 준비`, `전체 결과 수집`의 실제 가능한 지표만 표시한다.
- global `frontend/src/styles/sql.css`는 제거했다. App Shell의 `.page-body.sql-body` gutter 외에는 SQL 전용 selector를 global stylesheet에 두지 않는다.
- shadcn이 소유하는 panel/header/form/list/separator/table/scroll/tree surface는 CSS Module에서도 다시 정의하지 않는다.

## Pre-#468 QA Notes

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
- 선택된 SQL 도구 탭의 흰 배경만 `motion` shared `layoutId`로 이동시켜 기존 Tabs 구조와 focus/ARIA 계약을 유지한다. 전환값은 `spring`, `stiffness: 420`, `damping: 32`다.
- editor footer에 `Slider`를 추가해 Preview 최대 행 수를 10~100, 10행 단위로 실제 변경한다. 선택값은 preflight key와 `executeQueryPreview`의 `limit`에 함께 반영된다.
- Query AI 안내, 응답, 오류 surface를 `Bubble`/`BubbleContent`로 교체했다.
- embedded Dashboard builder는 raw backdrop과 `role="dialog"` 대신 `Dialog`/`DialogContent`를 사용한다.
- SQL 도구, editor, schema, result surface는 `Panel`, 실행 상태는 Jobs 기준 `StatusBadge`, metadata는 `Badge`, 빈 상태는 `Empty`, action은 `Button`, label/control 조합은 `Field`를 사용한다.
- 오른쪽 선택 테이블/schema 패널을 제거하고, 왼쪽 tree table 행 클릭으로 선택한다. 기준 테이블과 추가 참조 테이블 모두 재클릭으로 해제한다. 기준 테이블 해제 시 참조 테이블이 남아 있으면 첫 참조 테이블을 기준으로 승격하고, 남은 선택이 없으면 editor context를 비운다. 선택 행은 왼쪽 파란 체크로 표시한다. 자동 JOIN과 column 삽입 action은 제공하지 않는다.
- desktop 2열 layout에서 왼쪽 SQL 도구 panel은 콘텐츠 높이만 사용한다. dataset ScrollArea는 250px로 제한해 `결과 대기 중` panel과 비슷한 높이를 유지하고, 데이터가 많으면 내부 스크롤로 탐색한다.
- 미사용 `SqlDatasetSchemaPreview.tsx`를 삭제했다.
- `sql.css`는 2,547줄에서 401줄로 줄였다. `PanelHeader`, `FieldGroup`, `NativeSelect`, `Separator`, shadcn Table/ScrollArea와 Shadcnblocks Tree 기본 surface로 header/form/list/table/scroll/tree CSS를 추가 제거했다.
- 처리 Job 모달은 `FormFieldGroup`/`NativeSelectField`와 `sql-materialize-*` CSS 대신 `DialogShell` + `FieldGroup` + `Field` + `NativeSelect` grid를 사용한다.
- schema list는 `Panel` + `PanelHeader` + `Separator`, result header는 `PanelHeader`, autocomplete surface는 `Panel` + `Button` + `Badge`로 구성한다.
- dataset/schema/autocomplete/result의 native `overflow: auto`를 제거하고 shadcn `ScrollArea`를 실제 scroll container로 사용한다. SQL 영역은 `type="always"`로 thumb를 명확히 노출하고 result는 vertical/horizontal scrollbar를 모두 제공한다.
- Slider track/range/thumb는 AskLake의 slate/blue token으로 명시해 track과 현재 값이 배경에서 확실히 구분되도록 했다.
- SQL 도구의 후보/검색 건수와 schema의 선택 건수 badge를 제거하고, Page/Panel/Dialog title 아래의 반복 설명문을 제거해 heading hierarchy를 한 줄로 정리했다.
- Query AI panel의 `Query AI 생성`, `테이블 선택 필요` badge도 제거해 탭 아래에서 같은 상태를 반복하지 않는다.
- SQL dataset tree는 서비스 공통 `ExplorerTree`로 통합했으며 `react-arborist`가 가상화와 키보드 탐색을 담당한다.
- 기존 `.sql-tree-node`, `.sql-tree-branch`, `.sql-tree-table-*`, `.sql-tree-column-*` selector는 제거하고 fixed hover card selector만 유지했다.
- SQL page가 `page-body`의 실제 남은 높이를 사용하도록 grid row를 제한하고, 후보 Tree만 `ScrollArea`로 스크롤되게 해 검색/페이징을 고정했다.
- 중앙 `sql-workspace`의 auto row는 `max-content`로 고정해 제한된 viewport 안에서도 editor/result Panel이 내부 콘텐츠보다 작아지거나 서로 겹치지 않게 했다.
- 다크 SQL editor에서는 shadcn `Textarea`의 파란 focus ring/offset을 제거해 line-number gutter 옆에 이중 세로선이 생기지 않게 했다. 다른 form control의 focus ring은 유지한다.
- 선택된 tree table row는 전체 행의 연한 파란 배경과 왼쪽 파란 체크로 구분한다.
- 1,200px 콘텐츠 폭에서 3열 최소폭이 밀리던 문제를 막기 위해 1,240px부터 2열 layout으로 전환한다.

### #468 Verification

- `commerce_orders_daily` 선택 후 Slider를 50행으로 조작하고 실행해 `50행 조회됨`, `최대 50행 표시`, 2-page result를 확인했다.
- Slider track, blue range, thumb가 모두 표시되고 keyboard로 설정한 50행이 label과 실행 limit에 반영되는 것을 확인했다.
- dataset/schema/result의 scrollbar가 shadcn `ScrollArea` thumb로 렌더링되고 native scrollbar가 중첩되지 않는 것을 확인했다.
- 공통 ExplorerTree에서 아이콘과 행이 표시되고 table row click으로 선택 상태가 바뀌며, 선택 후 SQL editor가 활성화되는 것을 확인한다.
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

- SQL autocomplete의 surface/action/status/scroll은 shadcn으로 바꿨지만 editor focus/selection과 absolute position 계산은 유지했다.
- dataset hover card의 fixed 위치, dark editor, ScrollArea의 높이/배치, embedded Dashboard 크기는 도메인 layout이라 유지했다. Tree 연결선/row/expand surface는 registry component가 소유한다.
- global sidebar의 mobile 동작은 `layout.css`/`responsive.css` 소유이며 SQL route CSS에서 우회하지 않는다.

## #582 Structure And Style Modularization

2026-07-12 리팩토링은 SQL 동작과 API 계약을 바꾸지 않고 route composition, domain logic, Job wizard, style ownership을 분리했다.

- `SqlAnalysisPage.tsx`의 panel markup을 `SqlDatasetContextPanel`, `SqlQueryEditorPanel`, `SqlResultsPanel`로 나누고 검색·pagination과 Query AI 상태를 전용 hook으로 이동했다.
- `SqlJobWizardDialog.tsx`에서 단계 UI, field control, 초기값·검증·request formatting을 각각 `SqlJobWizardSteps.tsx`, `SqlJobWizardFields.tsx`, `sqlJobWizardModel.ts`로 분리했다.
- 기존 `sqlLogic.ts`는 import 호환 façade만 남기고 AST, preflight, autocomplete, JOIN, identifier, CSV formatting, derived dataset helper를 독립 모듈로 분리했다.
- 전역 `styles/sql.css`와 `responsive.css`의 SQL selector를 제거하고 route/component 전용 CSS Module로 이동했다. 공용 shadcn surface는 계속 primitive가 소유한다.
- `verify:ui-regressions`는 삭제된 전역 CSS 파일이 아니라 새 component·hook·model·CSS Module 경계를 검사한다.
- API path, query payload, derived dataset Job payload, audit event 이름은 변경하지 않았다.

### #582 Verification

- `npm run build`와 `npm run verify:ui-regressions` 58개 항목을 통과했다.
- 1280×900에서 `/sql` 진입, `commerce_orders_daily` 선택, 기본 SQL 생성, Preview 실행과 결과 table 표시를 확인했다. framework overlay와 browser console warning/error는 없었다.
- 처리 Job 모달을 열어 기본 정보에서 스케줄 단계로 이동하고 `매일 실행` 선택 시 시간·시간대 control이 렌더링되는 것을 확인했다.
- 860×800과 390×844에서 SQL workspace가 단일 열로 전환되고 page horizontal overflow가 없음을 확인했다.
- 좁은 viewport에서 global App Shell sidebar가 SQL 본문보다 먼저 표시되고 긴 dataset 이름과 pagination label이 협소한 문제는 기존 범위로 남는다. SQL CSS Module에서 우회하지 않는다.

## #591 SQL Job Target Settings Alignment

2026-07-12 작업은 SQL 결과 처리 Job의 마지막 단계를 실제 ETL Target 설정과 같은 정보 구조로 맞췄다.

- 기존 압축·단일 파티션·경로 입력을 `SqlJobTargetSettings.tsx`로 분리하고 DB 선택, 파일 포맷, 압축, S3 경로 찾아보기/복사, 태그 추가·삭제, 다중 파티션 선택을 구성했다.
- `DatabaseField`와 `S3PathField`를 재사용해 ETL Target과 SQL Job wizard의 picker 동작을 동일하게 유지했다.
- SQL 결과 컬럼 타입은 원본 dataset schema를 우선 사용하고, alias/집계 컬럼은 preview 값에서 `integer`, `decimal`, `boolean`, `date`, `timestamp`, `string`을 추론해 파티션 후보에 표시한다.
- `CreateDerivedDatasetRequest.job`과 `DraftPipeline.target`에 database, format, tags, `partitionColumns`를 연결했다. 기존 `partitionColumn`은 첫 번째 선택값으로 유지해 하위 호환한다.
- 신규 CSS selector는 추가하지 않았고 기존 shadcn Card, Field, Select, Checkbox, Button 및 공용 Target component를 조합했다.

### #591 Verification

- `npm run verify:ui-regressions` 64개 항목과 `npm run build`를 통과했다.
- mock browser에서 `/sql` 진입, `commerce_orders_daily` 선택, Preview 실행, 처리 Job wizard 마지막 단계 진입을 확인했다.
- `commerce` 태그 추가와 `order_date`, `channel` 다중 파티션 선택 후 Job을 생성했고, Job 상세에서 `parquet`, `Snappy`, `order_date/channel`이 유지되는 것을 확인했다.
- 브라우저 console warning/error가 없음을 확인했다.

## #594 Searchable Chart Select Alignment

- SQL 차트 설정은 Dashboard `WidgetConfigPanel`의 기본 searchable combobox를 그대로 사용한다.
- 데이터셋, X축, Y축, 집계 방식, 그룹 컬럼, 방향 등 단일 선택 필드에 검색 입력과 아래 화살표를 제공한다.
- 선택된 옵션은 체크 아이콘 대신 원형 점으로 표시한다.
- 좁은 SQL 도구 패널에서는 combobox와 색상 영역이 ScrollArea viewport 안쪽 폭을 넘지 않도록 `w-full`, `min-w-0`, `max-w-full` 경계를 유지한다.

### #594 Verification

- `npm run verify:ui-regressions` 64개 항목과 `npm run build`를 통과했다.
- mock browser에서 Preview 실행 후 SQL 차트 설정을 열어 X축 검색, `channel` 선택, 원형 선택 표시와 패널 horizontal overflow가 없음을 확인했다.
