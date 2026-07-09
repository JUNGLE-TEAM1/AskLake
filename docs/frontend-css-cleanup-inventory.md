# Frontend CSS Cleanup Inventory

## 목적

이 문서는 AskLake 프론트엔드 UI 전환 중 어떤 CSS를 유지하고, 어떤 CSS를 공통 UI primitive 또는 DataTable로 옮긴 뒤 정리할지 추적하는 작업용 인벤토리다.

현재 `frontend/src/styles.css`는 화면별 CSS를 전역으로 import한다. 그래서 작은 selector 삭제나 수정도 다른 화면에 영향을 줄 수 있다. 이 문서는 CSS를 바로 삭제하기 위한 문서가 아니라, A/B가 병렬로 전환 작업을 하면서 같은 기준으로 정리 후보를 표시하기 위한 문서다.

## 운영 규칙

- 이 문서는 계속 업데이트한다. UI 전환, UI 폴리싱, CSS 삭제 PR마다 관련 행의 상태와 메모를 갱신한다.
- CSS 삭제는 공통 컴포넌트 전환이나 cleanup 범위가 명확한 별도 PR에서만 진행한다.
- CSS를 새로 건드리거나, 어떤 selector를 의도적으로 유지/제외하기로 판단한 PR은 이 문서를 함께 업데이트해 기록한다.
- 작업할 때마다 CSS 유지/삭제 판단은 달라질 수 있으므로, PR 본문에서 "왜 유지했는지"를 길게 설명하기보다 이 문서의 관련 행과 업데이트 로그에 남긴다.
- `rg`에서 사용처가 안 보여도 동적 class 조합, 외부 라이브러리 class, responsive selector 가능성을 확인하기 전에는 삭제하지 않는다.
- `responsive.css`에 남은 selector는 데스크톱과 모바일 route QA가 끝나기 전까지 유지한다.
- `styles.css` import 순서는 전체 영향이 크므로 동시 수정 금지 영역으로 본다.
- Backend API, 데이터 계약, 도메인 로직은 CSS 정리 범위가 아니다.
- B가 Catalog/SQL/Dashboard 작업으로 정리하게 될 CSS도 이 문서에서 함께 추적한다.
- CSS가 남는 이유가 공통 컴포넌트 부재라면 `docs/frontend-component-gap-inventory.md`에도 함께 기록한다.
- 반복되지 않는 UI라도 shadcn primitive가 제공하는 기본 부품이면 raw HTML과 화면별 CSS를 늘리지 않고 `components/ui` 기준으로 교체하는 것을 우선한다.

## 상태 값

| 상태 | 의미 |
| --- | --- |
| `사용 중` | 현재 화면 렌더링에 필요하다. 삭제 금지. |
| `교체 후보` | 공통 primitive, DataTable, layout component로 옮긴 뒤 줄일 수 있다. |
| `삭제 후보` | 대체 작업과 route QA가 끝난 뒤 삭제 PR에서 제거할 수 있다. |
| `부분 정리됨` | 표/버튼/패널 같은 핵심 대체는 끝났지만 화면 전용 shell, density, menu, responsive CSS가 남아 있다. 즉시 삭제 대상은 아니다. |
| `보류` | 외부 라이브러리, 복잡한 화면 상태, 트리/그래프/런타임 동작과 묶여 있어 별도 검증이 필요하다. |
| `정리됨` | 대체 작업과 route QA 기준으로 관련 selector 정리가 완료되었다. |

## 현재 스냅샷

기준일: 2026-07-09

기준 브랜치: A03 `feat-#352`, B04 `feat-#350`, #357 `refactor-#357`, #361 `refactor-#361`, #364 `refactor-#364`, #367 `refactor-#367`, #369 `refactor-#369`, #375 `refactor-#375`, #378 `feat-#378`, #385 `feat-#385`, #387 `refactor-#387`, #389 `feat-#389`, #391 `refactor-#391`, #393 `refactor-#393`, #395 `refactor-#395` 확인 기준

주의: 이 문서는 현재 CSS 상태와 진행 중 A/B 작업으로 생길 cleanup 후보를 함께 추적한다. CSS 관련 PR마다 실제 route QA, `rg` 확인 결과, 유지/제외 판단을 반영해 갱신한다.

| 파일 | 줄 수 | 주 담당 | 현재 판단 | 메모 |
| --- | ---: | --- | --- | --- |
| `frontend/src/styles/base.css` | 706 | A/B 공통 | `교체 후보` | reset, token, `.icon-button` 등 공통 기반. #369에서 Jobs 전용으로 남아 있던 global `.filter-chip` selector 제거. |
| `frontend/src/styles/layout.css` | 713 | A | `교체 후보` | App Shell, Sidebar, Topbar, Page title, legacy button class 포함. |
| `frontend/src/styles/ingest.css` | 1,760 | A | `부분 정리됨` | A02에서 Jobs 목록에 PageHeader/primitive/DataTable 적용. #361에서 Jobs shell legacy naming은 `jobs-panel-*`로 rename. #364에서 legacy table footer/empty selector 제거. #367에서 Jobs panel shell/metric selector를 `Panel`/`PanelHeader`/`MetricCard`로 이동. #369에서 Jobs toolbar body/search/filter chip selector를 `FilterToolbar`로 이동. #378에서 runs footer는 `PaginationBar`, job/run log modal은 `DialogShell`로 이동. #385에서 status/owner/tag pill, job row/detail action group, Jobs detail key-value markup은 공통 컴포넌트로 전환했고 #393에서 Jobs tab, #395에서 run history table shell은 공통 컴포넌트로 전환. `.status-pill`, `.owner-chip`, `.tag-chip`, `.job-row-details`, `.job-row-actions`, `.runs-table*` density CSS는 유지. |
| `frontend/src/styles/ingest-dag.css` | 537 | A | `보류` | Run DAG modal/graph 전용. 화면 QA 전 삭제 금지. |
| `frontend/src/styles/etl.css` | 9,064 | A | `부분 정리됨` | A03에서 PageHeader/Button primitive 일부 적용. #357에서 ETL 내부 legacy xflow naming은 AskLake 도메인 이름으로 rename. #378에서 S3/DB picker shell은 `PickerDialog`, schema/rule bottom bar는 `CommandBar`로 이동. #385에서 target tag row, rule action footer, permission/review validation, review key-value summary를 공통 컴포넌트로 전환. Source/Schema/Schedule/form/tree selector는 component gap 범위가 커서 유지. |
| `frontend/src/styles/responsive.css` | 561 | A/B 공통 | `보류` | 여러 화면의 모바일 대응이 섞여 있음. #364에서 Jobs legacy footer responsive selector 제거. #369에서 Jobs/Dashboard toolbar responsive selector를 `FilterToolbar` responsive utility로 이동. 각 route 모바일 QA 후 추가 정리. |
| `frontend/src/styles/catalog.css` | 1,441 | B | `부분 정리됨` | Catalog 목록/상세, lineage, schema preview. #361에서 Catalog shell은 `catalog-panel-*`, lineage graph는 `lineage-*` selector로 rename. #367에서 검색/결과/미리보기 panel shell selector를 `Panel`/`PanelHeader`로 이동. #375에서 검색 box/tag row/filter row shell selector를 `FilterToolbar` 계열로 이동. Catalog schema table은 `DataTable` 기준으로 전환됐지만 preview card, lineage teaser, result card, sort menu, tag/chip 시각 상태 CSS는 유지. |
| `frontend/src/styles/sql.css` | 2,576 | B | `부분 정리됨` | SQL panel/editor/preview. B02/B03에서 SQL preview table은 `DataTable` 기준으로 전환됐고 action button/dialog primitive 적용이 진행됨. #375에서 분석 테이블 검색 shell selector를 `FilterToolbarSearch`/`FilterToolbarInput`으로 이동. #378에서 context pagination은 `PaginationBar`, materialize dialog shell은 `DialogShell`로 이동. #385에서 AI/editor/result action rows는 `ActionGroup`으로 전환. editor/result shell, 실행 상태, preview wrapper CSS는 유지. |
| `frontend/src/styles/schema-transform-adapter.css` | 119 | A | `보류` | `SchemaTransformWorkbench` adapter 전용. 외부 editor DOM 구조에 의존하므로 schema transform QA 전 삭제 금지. |
| `frontend/src/styles/schema-transform-source.css` | 1 | A | `보류` | Tailwind import 역할을 유지한다. Tailwind entry 통합 전 삭제 금지. |
| `frontend/src/styles/dashboard.css` | 1,286 | B | `부분 정리됨` | Dashboard list가 `DataTable`, `Panel`, `PanelHeader`, `Button`, `Input`, `FilterToolbar` 기준으로 일부 전환됨. #361에서 list shell legacy naming은 `dashboard-panel-*`로 rename. #367에서 list toolbar/table panel shell selector를 `Panel`/`PanelHeader`로 이동. #369에서 list toolbar body/search/actions/divider selector를 `FilterToolbar`로 이동. #378에서 list pagination은 `PaginationBar`, delete confirm dialog는 `DialogShell`로 이동. #385에서 dashboard header/workspace action row, row tag/status, list status meta는 공통 컴포넌트로 전환. builder preview, menu option, table density selector는 계속 유지. |
| `frontend/src/styles/dashboard-runtime.css` | 2,148 | B | `부분 정리됨` | Runtime topbar, widget frame, table widget, config panel, dataset tree가 B04에서 일부 전환됨. table widget은 `DataTable` 기준으로 전환됐고 #364에서 Dashboard dataset tree의 legacy MUI TreeItem selector 제거. #385에서 edit toolbar wrapper는 `ActionGroup`으로 전환. grid/runtime 상태, widget frame, config panel, color picker selector는 삭제 금지. |

## A 작업으로 정리될 CSS

| 범위 | 관련 파일 | 상태 | 정리 기준 |
| --- | --- | --- | --- |
| App Shell / Topbar / Sidebar | `layout.css`, `base.css`, `responsive.css` | `교체 후보` | Router Shell과 layout component 기준으로 active/navigation 스타일을 정리한다. |
| Page title | `layout.css`, `ingest.css`, `catalog.css`, `dashboard.css`, `styles.css` | `교체 후보` | `PageHeader` primitive 적용 화면이 늘어난 뒤 중복 title selector를 줄인다. |
| Legacy button class | `layout.css`, `ingest.css`, `etl.css`, `catalog.css`, `sql.css`, `dashboard.css` | `교체 후보` | `.primary-button`, `.secondary-button`, `.ghost-button`, `.icon-button` 사용처를 `Button`/`IconButton`으로 옮긴 뒤 제거한다. |
| Jobs 목록 shell / toolbar | `ingest.css`, `responsive.css`, `base.css` | `정리됨` | #367에서 Jobs metrics/filter/table panel shell과 metrics card selector를 `Panel`/`PanelHeader`/`MetricCard`로 이동. #369에서 Jobs toolbar body/search/filter chip/reset responsive selector를 `FilterToolbar`로 이동. Jobs table detail selector는 유지. |
| Jobs table legacy footer/empty | `ingest.css`, `responsive.css` | `정리됨` | A02에서 `JobsPages.tsx` 사용처가 제거된 뒤 CSS만 남아 있던 `jobs-table-empty`, `jobs-table-preview-footer` selector를 #364에서 삭제. |
| Jobs status/owner/tag chip | `ingest.css` | `부분 정리됨` | #385에서 `StatusBadge`, `Chip`, `TagList`로 markup을 전환. `.status-pill`, `.run-status-pill`, `.owner-chip`, `.tag-chip`은 기존 색/간격 보존을 위해 유지. |
| Run History table | `ingest.css`, `ingest-dag.css` | `부분 정리됨` | #378에서 `.runs-pagination` markup은 `PaginationBar`로 전환. #395에서 `.runs-table-card`와 `.runs-table-scroll` shell은 `DetailTableSection`으로 전환. `.runs-table*` density와 DAG modal/graph는 별도 QA 전 유지한다. |
| ETL Source/Schema flow | `etl.css`, `schema-transform-adapter.css`, `schema-transform-source.css` | `부분 정리됨` | A03에서 PageHeader와 주요 action button은 primitive 적용. #357에서 legacy naming은 정리. #378에서 S3/DB picker shell과 schema/rule bottom command wrapper를 공통화했고, #385에서 Review summary/validation, Target tag, rule action footer를 공통 컴포넌트로 전환. card, segmented tabs, schema workbench, form/tree selector는 유지. |
| Tree UI | `etl.css`, `schema-transform-adapter.css` | `보류` | MUI TreeView 유지가 아니라 `react-arborist` 기준 교체가 목표다. 단, 실제 교체 전 tree 관련 CSS는 삭제하지 않는다. |
| Service-wide legacy xflow naming | `ingest.css`, `catalog.css`, `dashboard.css`, `etl.css`, `pages/ingest`, `pages/catalog`, `pages/dashboard`, `pages/etl` | `정리됨` | #357에서 ETL, #361에서 Ingest/Catalog/Dashboard의 legacy naming을 AskLake 도메인 이름으로 rename. 문서에 남은 `xflow` 문자열은 cleanup 추적 기록이다. |

## B 작업으로 정리될 CSS

| 범위 | 관련 파일 | 상태 | 정리 기준 |
| --- | --- | --- | --- |
| UI primitive 적용 | `catalog.css`, `sql.css`, `dashboard.css`, `dashboard-runtime.css` | `교체 후보` | B01의 `Button`, `Card`, `Badge`, `Input`, `Select`, `Dialog`, `EmptyState` 적용 후 화면별 중복 selector를 줄인다. |
| DataTable 적용 | `sql.css`, `dashboard.css`, `catalog.css` | `부분 정리됨` | B02-B04에서 SQL preview table, Catalog schema table, Dashboard list table, Dashboard runtime table widget은 `DataTable` 기준으로 전환됨. 남은 것은 table 주변 shell, density, overflow, menu, empty/loading wrapper CSS다. |
| SQL preview table | `sql.css` | `부분 정리됨` | `SqlPreviewTable`은 공통 `DataTable`로 전환됨. `.sql-preview-table-wrap`, `.sql-preview-table` 같은 wrapper/density class는 `/sql` QA와 result shell 공통화 전까지 유지한다. |
| SQL editor/action buttons | `sql.css` | `부분 정리됨` | #378에서 context pagination/materialize dialog shell을 공통화했고, #385에서 `.sql-ai-actions`, `.sql-editor-actions`, `.sql-result-actions` wrapper를 `ActionGroup`으로 전환. 기존 button 색/폭/반응형 CSS는 유지. |
| Catalog result/list cards | `catalog.css` | `교체 후보` | #367에서 Catalog search/result/preview panel shell은 `Panel`/`PanelHeader`로 이동. #375에서 Catalog search/tag/filter row shell은 `FilterToolbar`로 이동. 결과 card, badge, schema preview, lineage selector와 sort menu는 계속 유지. |
| Catalog lineage graph | `catalog.css` | `보류` | React Flow node/edge class와 연결되어 있어 lineage QA 전 삭제 금지. #361에서 graph 내부 selector는 `lineage-*` 기준으로 rename. |
| Dashboard list/table | `dashboard.css` | `부분 정리됨` | B04에서 Dashboard 목록 table이 `DataTable` 기준으로 전환됨. #367에서 list toolbar/table panel shell은 `Panel`/`PanelHeader`로 이동. #369에서 toolbar body/search/actions/divider selector는 `FilterToolbar`로 이동. #378에서 `dashboard-pagination`은 `PaginationBar`, delete confirm shell은 `DialogShell`로 전환. #385에서 header action row, row tag/status, list status meta를 공통 컴포넌트로 전환. menu option/filter button과 table density selector는 `/dashboards` QA 후 추가 축소한다. |
| Dashboard builder preview | `dashboard.css` | `보류` | builder canvas, widget preview, draft widget 상태가 많아 B04 QA 후 판단한다. |
| Dashboard runtime canvas/widget | `dashboard-runtime.css` | `보류` | `react-grid-layout`, `react-resizable`, widget selected/editing/AI state와 묶여 있어 runtime route QA 전 삭제 금지. Table widget은 DataTable 기준으로 전환되어 `.asklake-table-widget*` selector가 새 기준이 됨. #385에서 edit toolbar wrapper만 `ActionGroup`으로 전환했지만 `.asklake-dashboard-edit-toolbar` CSS는 유지. |
| Dashboard dataset tree | `dashboard-runtime.css` | `보류` | B04에서 runtime dataset tree가 `react-arborist` 기준으로 전환됨. 기존 `.MuiTreeItem-*` selector는 #364에서 삭제. arborist row/hover card CSS는 `TreePanel` gap 기준으로 유지한다. |
| Dashboard widget form/buttons | `dashboard-runtime.css` | `교체 후보` | Config panel의 text/number input, select, action/color/type button은 primitive 또는 shadcn-style wrapper로 옮김. checkbox, textarea, color picker, layout selector는 계속 유지한다. |

## 우선 정리 순서

1. CSS 파일 삭제 없이 이 문서부터 최신화한다.
2. A02, B02, B03, B04, A03 PR이 merge될 때마다 관련 행을 `사용 중`, `교체 후보`, `부분 정리됨`, `삭제 후보`, `보류`로 업데이트한다.
3. 작은 삭제 후보부터 별도 cleanup PR로 제거한다.
4. 전역 button/page title selector는 여러 화면이 같이 쓰므로 마지막에 정리한다.
5. primitive로 커버하지 못하는 반복 UI는 `docs/frontend-component-gap-inventory.md`에 기록한다.
6. `etl.css`와 `dashboard-runtime.css`는 가장 늦게 건드린다.

## Component 확장 PR 기록 방식

공통 컴포넌트 확장 PR에서는 CSS를 바로 삭제하지 않더라도 아래 기준으로 이 문서를 갱신한다.

| 컴포넌트 후보 | CSS 기록 기준 |
| --- | --- |
| `PaginationBar` | DataTable 밖 pagination selector를 `교체 후보` 또는 `부분 정리됨`으로 갱신한다. 예: `catalog-pagination`, `catalog-materialization-pagination`, `sql-context-pagination`, `dashboard-pagination`, `runs-pagination`. |
| `DialogShell` / `PickerDialog` | custom backdrop/dialog selector를 route QA 전까지 `부분 정리됨` 또는 `보류`로 남긴다. 예: `catalog-modal-*`, `sql-materialize-dialog-*`, `job-log-modal`, `run-dag-modal`, `s3-picker-*`, `dashboard-*-modal`. |
| `ActionGroup` | header/action row와 footer action selector는 wrapper만 공통화하고, 버튼 자체 색/폭/반응형 CSS는 route QA 전까지 유지한다. 예: `sql-ai-actions`, `sql-editor-actions`, `sql-result-actions`, `dashboard-header-actions`, `job-row-actions`, `job-detail-actions`, `hegun-rule-form-actions`. |
| `Chip` / `TagList` / `StatusBadge` | 기존 `Badge`로 대체된 범위와 interactive chip으로 유지한 범위를 분리한다. 예: `status-pill`, `run-status-pill`, `owner-chip`, `tag-chip`, `target-chip`, `*-type-pill`. |
| `KeyValueList` / `ValidationList` | ETL/Creation/Catalog/Jobs detail의 summary/validation row selector를 화면별로 유지할지, 공통 row로 옮길지 기록한다. |
| `PreviewPanel` / `ResultPanel` | `DataTable` 적용이 끝난 표 주변의 header, empty/loading, CTA, overflow shell selector를 추적한다. |
| `SettingsPanel` / `FormFieldGroup` / `NativeSelectField` | input/select primitive 적용 후에도 남은 label/grid/textarea/checkbox/color picker/native select selector를 유지 사유와 함께 적는다. |
| `SegmentedTabs` / `SelectableCard` | 단계 전환, source connector, schedule mode, widget type card의 selected/disabled/focus selector를 추적한다. rename/edit 상태가 있는 탭은 route QA 전 `보류`로 유지한다. |
| `IconOptionGrid` | icon-only option button grid, selected state, tooltip, keyboard focus selector를 추적한다. |
| `DetailTableSection` | 작은 detail table 주변 title, action, empty state, overflow shell selector를 추적한다. table 자체보다 section wrapper CSS를 먼저 기록한다. |
| `TreePanel` | MUI TreeView, react-arborist, React Flow처럼 외부 라이브러리 class와 묶인 selector는 route QA 전 삭제하지 않고 `보류`로 유지한다. |

현재 코드 스윕 기준으로 먼저 시도하기 좋은 순서는 `PreviewPanel/ResultPanel` -> `FormFieldGroup/NativeSelectField` -> `SettingsPanel` -> `SegmentedTabs/SelectableCard` -> `IconOptionGrid` -> `DetailTableSection`이다. `TreePanel`, `WidgetShell`, `ColorPalettePicker`는 상태와 라이브러리 차이가 커서 별도 설계 PR로 분리한다.

## #387 UI Shell 후보 CSS 기록

이번 문서화 작업은 CSS 파일을 직접 삭제하지 않는다. 대신 다음 component 확장 PR에서 어떤 selector를 유지하거나 교체 후보로 볼지 기준을 좁힌다.

| 후보 | 관련 CSS 파일 | CSS 판단 |
| --- | --- | --- |
| `PreviewPanel` | `sql.css`, `dashboard.css`, `etl.css` | preview header/body/empty/loading/action shell은 `DataTable` 적용 이후에도 남아 있어 `교체 후보`로 유지. |
| `ResultPanel` | `sql.css`, `dashboard-runtime.css` | row count, execution status, result CTA, widget table viewport 주변 selector는 result shell 공통화 전까지 `부분 정리됨`으로 유지. |
| `SettingsPanel` | `dashboard-runtime.css`, `etl.css`, `sql.css` | config/rule/materialize form의 panel header/body/footer selector는 props 설계 전까지 `교체 후보`로 유지. |
| `FormFieldGroup` | `dashboard-runtime.css`, `etl.css`, `sql.css` | label/control/hint/error grid selector는 input primitive만으로 없어지지 않으므로 `교체 후보`로 추적. |
| `NativeSelectField` | `dashboard-runtime.css`, `etl.css` | native select와 shadcn `Select` 사용 기준을 나눈 뒤 select label/tone selector를 축소한다. |
| `SegmentedTabs` | `etl.css`, `ingest.css`, `dashboard-runtime.css` | 단순 tablist selector는 `교체 후보`, rename/edit 상태가 있는 tab selector는 `보류`. |
| `SelectableCard` | `etl.css`, `dashboard.css` | source connector, schedule mode, widget type card의 selected/disabled/check selector는 설계 후 축소한다. |
| `IconOptionGrid` | `dashboard.css`, `dashboard-runtime.css` | icon-only chart/widget option grid는 `구현 후보`; tooltip/focus/selected selector를 함께 확인한다. |
| `DetailTableSection` | `ingest.css`, `etl.css`, `schema-transform-adapter.css` | detail table의 title/action/empty/overflow shell은 `DataTable` 전환과 별도로 `교체 후보`로 기록한다. |

## #389 UI Shell Component 적용 CSS 기록

이번 PR은 공통 컴포넌트를 추가하고 대표 사용처에 적용하지만 CSS selector 삭제는 하지 않는다. 기존 화면 className을 새 컴포넌트에 전달해 route QA 전까지 스타일을 유지한다.

| 범위 | 관련 selector | 이번 판단 |
| --- | --- | --- |
| PreviewPanel | `.dashboard-widget-preview-panel`, `.dashboard-card-header` | Dashboard builder preview shell을 공통 component로 전환. direct child button selector만 descendant 기준으로 완화. |
| ResultPanel | `.sql-result-card`, `.sql-result-header`, `.sql-result-status`, `.asklake-table-widget` | SQL result와 dashboard runtime table widget shell을 공통 component로 전환. result toolbar/scroll/density CSS는 유지. |
| SettingsPanel/FormFieldGroup/NativeSelectField | `.asklake-widget-config-panel`, `.asklake-widget-config-heading`, `.asklake-widget-config-form`, `.asklake-widget-select` | WidgetConfigPanel shell과 일부 field/select를 공통 component로 전환. chart-specific select/checkbox/color picker selector는 유지. |
| SegmentedTabs | `.dashboard-segmented`, `.source-stage-tabs` | 단순 segmented/tablist markup을 공통 component로 전환. rename/edit tab selector는 보류. |
| SelectableCard | `.source-choice-card`, `.schedule-config-mode-card`, `.run-card`, `.dashboard-widget-type-list button` | source connector, schedule mode, dashboard widget type card를 공통 component로 전환. selected/check/density CSS는 유지. |
| IconOptionGrid | `.asklake-widget-type-grid`, `.asklake-widget-type-button`, `.asklake-widget-type-tooltip-layer` | runtime widget type grid를 공통 component로 전환. tooltip 위치 계산과 selected CSS는 유지. |
| DetailTableSection | `.detail-table-card`, `.detail-table-header` | Jobs detail schema/rule table section을 공통 component로 전환. table density/row state CSS는 유지. |

## #391 Form Settings 적용 CSS 기록

이번 PR은 Form/Settings 계열 사용처를 추가 전환하지만 CSS selector 삭제는 하지 않는다. 기존 className을 `FormFieldGroup`/`NativeSelectField`에 전달해 route QA 전까지 density와 layout을 유지한다.

| 범위 | 관련 selector | 이번 판단 |
| --- | --- | --- |
| WidgetConfigPanel field/select | `.asklake-widget-config-form`, `.asklake-widget-select`, `.asklake-widget-hex-input` | chart/table select와 number/HEX field를 공통 field component로 전환. checkbox와 color picker 세부 selector는 유지. |
| S3/DB picker toolbar | `.s3-picker-toolbar`, `.database-picker-toolbar`, `.field`, `.input.control-input`, `.s3-picker-search` | toolbar label/control shell을 공통 field component로 전환. picker body/tree/list selector는 유지. |
| ETL source/schedule field | `.source-flow-fields`, `.schedule-config-form-grid`, `.field`, `.field.wide`, `.input.control-input` | source 연결 입력과 schedule 반복 설정 field를 공통 field component로 전환. rule builder/target/permission form selector는 유지. |
| SQL materialize form | `.sql-materialize-form`, `.wide`, `.sql-materialize-checkbox` | materialize dialog의 text/select field를 공통 field component로 전환. checkbox row는 유지. |

## #393 Selection UI 적용 CSS 기록

이번 PR은 단순 tab/segmented 사용처를 `SegmentedTabs`로 추가 전환하지만 CSS selector 삭제는 하지 않는다. 기존 wrapper className을 유지해 route QA 전까지 스타일을 유지한다.

| 범위 | 관련 selector | 이번 판단 |
| --- | --- | --- |
| Jobs view/detail tabs | `.jobs-view-switch`, `.job-detail-tabs` | Jobs 목록 보기 전환과 상세 탭을 `SegmentedTabs`로 전환. button density/active selector는 유지. |
| ETL rule category tabs | `.hegun-rule-category-list`, `.hegun-rule-category`, `.hegun-rule-category-icon` | rule mode tablist를 `SegmentedTabs`로 전환. icon/copy/active selector는 유지. |
| 보류 Selection card | `.permission-config-role`, `.target-partition-option` | checkbox/radio 의미가 있는 선택 UI라 `SelectableCard`로 억지 전환하지 않는다. |

## #395 Detail Table Section 적용 CSS 기록

이번 PR은 Jobs run history table 주변 shell을 `DetailTableSection`으로 옮기지만 CSS selector 삭제는 하지 않는다. 기존 className을 그대로 전달해 `/jobs/:jobId/runs` route QA 전까지 table density와 footer 스타일을 유지한다.

| 범위 | 관련 selector | 이번 판단 |
| --- | --- | --- |
| DetailTableSection footer | `.runs-table-card`, `.runs-table-scroll`, `.runs-pagination` | run history table card/overflow/footer shell을 공통 component로 전환. `PaginationBar`는 `footer` slot에 두어 table overflow 밖에 유지한다. |
| Run table density | `.runs-table`, `.run-row`, `.run-status-pill`, `.runs-detail-button`, `.runs-log-button` | row height, column width, status color, compact action style은 화면 QA 전까지 유지한다. |
| 보류 범위 | `.runs-dag-card`, `ingest-dag.css`, `schema-transform-adapter.css` | DAG modal/graph와 SchemaTransformEditor preview는 외부/편집 상태가 묶여 있어 이번 PR에서 건드리지 않는다. |

## #378 Component 확장 CSS 기록

이번 PR은 CSS 파일을 직접 삭제하지 않고, 공통 컴포넌트가 기존 화면 className을 받을 수 있게 만든 뒤 대표 사용처를 전환했다. 따라서 아래 selector는 즉시 삭제가 아니라 route QA 후 후속 cleanup PR에서 정리한다.

| 범위 | 관련 selector | 이번 판단 |
| --- | --- | --- |
| PaginationBar | `.sql-context-pagination`, `.dashboard-pagination`, `.runs-pagination` | 공통 component로 markup을 옮겼지만 화면별 density/compact CSS는 유지. route QA 후 공통 variant로 흡수 가능. |
| DialogShell | `.sql-materialize-dialog`, `.job-log-modal-header`, `.dashboard-delete-modal*` | dialog shell은 공통화. content/header/body density selector는 일부 유지. `.sql-materialize-dialog-backdrop`, `.job-log-modal`, `.job-log-modal section`, `.job-log-modal pre`, `.dashboard-delete-modal` wrapper 계열은 사용처가 제거되어 삭제 후보. |
| PickerDialog | `.s3-picker-dialog`, `.s3-picker-header`, `.s3-picker-toolbar`, `.s3-picker-footer`, `.database-picker-*` | backdrop/header/footer shell은 공통화. tree/list/search/body CSS는 외부 MUI tree와 picker 상태가 있어 유지. `.s3-picker-backdrop`은 사용처가 제거되어 삭제 후보. |
| CommandBar | `.creation-top-actions`, `.summary-actions`, `.schema-bottom-bar`, `.hegun-rule-bottom-bar` | wrapper를 공통 component로 전환. ETL absolute/sticky 위치와 button density CSS는 유지. |

## 삭제 전 확인 명령

```bash
rg "selector-name" frontend/src
rg "selector-name" frontend/src/styles
cd frontend
npm run build
```

권장 route QA:

| 영역 | route |
| --- | --- |
| Ingest | `/jobs`, `/jobs/:jobId`, `/jobs/:jobId/runs` |
| ETL | `/etl/source`, `/etl/schema`, `/etl/schedule`, `/etl/permission`, `/etl/target`, `/etl/review` |
| Catalog | `/catalog`, `/catalog/:datasetId` |
| SQL | `/sql` |
| Dashboard | `/dashboards`, `/dashboards/:dashboardId`, `/dashboards/:dashboardId/edit` |

## 업데이트 로그

| 날짜 | 변경 |
| --- | --- |
| 2026-07-09 | Issue #347에서 초기 인벤토리 생성. A 작업 CSS와 B 작업 CSS를 한 문서에서 함께 추적하도록 정리. |
| 2026-07-09 | A02에서 Jobs 목록 PageHeader/primitive/DataTable 적용 상태를 반영. `jobs-table-empty`, `jobs-table-preview-footer`는 CSS-only 삭제 후보로 표시. |
| 2026-07-09 | A03에서 ETL PageHeader/주요 action button primitive 적용 상태를 반영. component gap inventory와 xflow rename 후속 cleanup 기준을 연결. |
| 2026-07-09 | #357에서 ETL 내부 legacy xflow naming을 AskLake 도메인 이름으로 rename한 상태를 반영. |
| 2026-07-09 | Issue #350 B04에서 Dashboard list/table, runtime topbar/widget frame/table widget/config panel/dataset tree 전환 범위를 반영. `dashboard.css`, `dashboard-runtime.css` 줄 수와 cleanup 후보를 갱신하고 MUI TreeItem selector 삭제 후보를 기록. |
| 2026-07-09 | #361에서 Ingest/Catalog/Dashboard까지 남은 legacy xflow naming을 AskLake 도메인 이름으로 rename한 상태를 반영. |
| 2026-07-09 | #364에서 Jobs legacy footer/empty selector와 Dashboard dataset tree legacy MUI TreeItem selector를 제거하고 CSS 줄 수를 갱신. |
| 2026-07-09 | #367에서 `Panel`, `PanelHeader`, `MetricCard`를 추가하고 Jobs/Catalog/Dashboard list shell의 legacy panel selector를 제거. CSS 줄 수를 갱신. |
| 2026-07-09 | #369에서 `FilterToolbar` 계열 컴포넌트를 추가하고 Jobs/Dashboard list toolbar body/search/actions selector를 제거. Catalog toolbar는 구조 차이로 후속 판단. |
| 2026-07-09 | #372에서 CSS 관련 PR마다 이 문서를 함께 업데이트하는 운영 규칙을 보강. B02-B04와 #369에서 이미 `DataTable`/primitive/`FilterToolbar`로 전환된 범위와 아직 유지하는 wrapper/menu/runtime CSS를 `부분 정리됨`으로 구분. |
| 2026-07-09 | #378에서 `PaginationBar`, `DialogShell`, `PickerDialog`, `CommandBar` 적용에 따른 CSS 판단을 기록. CSS 파일 삭제는 하지 않고, 사용처가 사라진 backdrop/wrapper selector를 후속 삭제 후보로 분리. |
| 2026-07-09 | component 확장 PR에서 `PaginationBar`, `DialogShell`, `Chip/TagList`, `ValidationList`, `PreviewPanel`, `SettingsPanel`, `TreePanel` 후보별 CSS 기록 기준을 추가. |
| 2026-07-09 | #375에서 Catalog 검색 box/tag row/filter row shell selector와 SQL 분석 테이블 검색 selector를 `FilterToolbar` 계열로 이동하고, shadcn primitive 전면 적용 원칙을 CSS cleanup 기준에 추가. |
| 2026-07-09 | #385에서 `ActionGroup`, `Chip`, `TagList`, `StatusBadge`, `KeyValueList`, `ValidationList` 적용에 따른 CSS 판단을 기록. CSS 삭제는 하지 않고 wrapper/density/status selector를 route QA 전까지 유지한다. |
| 2026-07-09 | #387에서 preview/result/settings/form/select/tab/card/icon option/detail table shell 후보별 CSS 추적 기준과 다음 정리 순서를 갱신. |
| 2026-07-09 | #389에서 UI shell component 8종 적용에 따른 CSS 판단을 기록. 기존 selector 삭제 없이 className 전달 방식으로 route QA 전 스타일을 유지한다. |
| 2026-07-09 | #391에서 Form/Settings 계열 추가 적용에 따른 CSS 판단을 기록. 기존 field/select selector는 삭제하지 않고 route QA 후 축소한다. |
| 2026-07-09 | #393에서 Selection UI 추가 적용에 따른 CSS 판단을 기록. 단순 tab selector는 유지하고 checkbox/radio card 후보는 보류한다. |
| 2026-07-09 | #395에서 Jobs run history table card/scroll/footer shell을 `DetailTableSection`으로 전환하고 `.runs-table*` density CSS는 route QA 전까지 유지하기로 기록. |
