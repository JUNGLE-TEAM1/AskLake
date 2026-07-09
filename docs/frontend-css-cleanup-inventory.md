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

기준 브랜치: A03 `feat-#352`, B04 `feat-#350`, #357 `refactor-#357`, #361 `refactor-#361`, #364 `refactor-#364`, #367 `refactor-#367`, #369 `refactor-#369` 확인 기준

주의: 이 문서는 현재 CSS 상태와 진행 중 A/B 작업으로 생길 cleanup 후보를 함께 추적한다. CSS 관련 PR마다 실제 route QA, `rg` 확인 결과, 유지/제외 판단을 반영해 갱신한다.

| 파일 | 줄 수 | 주 담당 | 현재 판단 | 메모 |
| --- | ---: | --- | --- | --- |
| `frontend/src/styles/base.css` | 706 | A/B 공통 | `교체 후보` | reset, token, `.icon-button` 등 공통 기반. #369에서 Jobs 전용으로 남아 있던 global `.filter-chip` selector 제거. |
| `frontend/src/styles/layout.css` | 713 | A | `교체 후보` | App Shell, Sidebar, Topbar, Page title, legacy button class 포함. |
| `frontend/src/styles/ingest.css` | 1,760 | A | `교체 후보` | A02에서 Jobs 목록에 PageHeader/primitive/DataTable 적용. #361에서 Jobs shell legacy naming은 `jobs-panel-*`로 rename. #364에서 legacy table footer/empty selector 제거. #367에서 Jobs panel shell/metric selector를 `Panel`/`PanelHeader`/`MetricCard`로 이동. #369에서 Jobs toolbar body/search/filter chip selector를 `FilterToolbar`로 이동. |
| `frontend/src/styles/ingest-dag.css` | 537 | A | `보류` | Run DAG modal/graph 전용. 화면 QA 전 삭제 금지. |
| `frontend/src/styles/etl.css` | 9,064 | A | `보류` | A03에서 PageHeader/Button primitive 일부 적용. #357에서 ETL 내부 legacy xflow naming은 AskLake 도메인 이름으로 rename. Source/Schema/Schedule/Permission/Target/Review selector는 component gap 범위가 커서 단계적 분리 필요. |
| `frontend/src/styles/responsive.css` | 561 | A/B 공통 | `보류` | 여러 화면의 모바일 대응이 섞여 있음. #364에서 Jobs legacy footer responsive selector 제거. #369에서 Jobs/Dashboard toolbar responsive selector를 `FilterToolbar` responsive utility로 이동. 각 route 모바일 QA 후 추가 정리. |
| `frontend/src/styles/catalog.css` | 1,441 | B | `부분 정리됨` | Catalog 목록/상세, lineage, schema preview. #361에서 Catalog shell은 `catalog-panel-*`, lineage graph는 `lineage-*` selector로 rename. #367에서 검색/결과/미리보기 panel shell selector를 `Panel`/`PanelHeader`로 이동. #375에서 검색 box/tag row/filter row shell selector를 `FilterToolbar` 계열로 이동. Catalog schema table은 `DataTable` 기준으로 전환됐지만 preview card, lineage teaser, result card, sort menu, tag/chip 시각 상태 CSS는 유지. |
| `frontend/src/styles/sql.css` | 2,576 | B | `부분 정리됨` | SQL panel/editor/preview. B02/B03에서 SQL preview table은 `DataTable` 기준으로 전환됐고 action button/dialog primitive 적용이 진행됨. #375에서 분석 테이블 검색 shell selector를 `FilterToolbarSearch`/`FilterToolbarInput`으로 이동. editor/result shell, 실행 상태, preview wrapper CSS는 유지. |
| `frontend/src/styles/schema-transform-adapter.css` | 119 | A | `보류` | `SchemaTransformWorkbench` adapter 전용. 외부 editor DOM 구조에 의존하므로 schema transform QA 전 삭제 금지. |
| `frontend/src/styles/schema-transform-source.css` | 1 | A | `보류` | Tailwind import 역할을 유지한다. Tailwind entry 통합 전 삭제 금지. |
| `frontend/src/styles/dashboard.css` | 1,286 | B | `부분 정리됨` | Dashboard list가 `DataTable`, `Panel`, `PanelHeader`, `Button`, `Input`, `FilterToolbar` 기준으로 일부 전환됨. #361에서 list shell legacy naming은 `dashboard-panel-*`로 rename. #367에서 list toolbar/table panel shell selector를 `Panel`/`PanelHeader`로 이동. #369에서 list toolbar body/search/actions/divider selector를 `FilterToolbar`로 이동. builder preview, menu option, table density selector는 계속 유지. |
| `frontend/src/styles/dashboard-runtime.css` | 2,148 | B | `부분 정리됨` | Runtime topbar, widget frame, table widget, config panel, dataset tree가 B04에서 일부 전환됨. table widget은 `DataTable` 기준으로 전환됐고 #364에서 Dashboard dataset tree의 legacy MUI TreeItem selector 제거. grid/runtime 상태, widget frame, config panel, color picker selector는 삭제 금지. |

## A 작업으로 정리될 CSS

| 범위 | 관련 파일 | 상태 | 정리 기준 |
| --- | --- | --- | --- |
| App Shell / Topbar / Sidebar | `layout.css`, `base.css`, `responsive.css` | `교체 후보` | Router Shell과 layout component 기준으로 active/navigation 스타일을 정리한다. |
| Page title | `layout.css`, `ingest.css`, `catalog.css`, `dashboard.css`, `styles.css` | `교체 후보` | `PageHeader` primitive 적용 화면이 늘어난 뒤 중복 title selector를 줄인다. |
| Legacy button class | `layout.css`, `ingest.css`, `etl.css`, `catalog.css`, `sql.css`, `dashboard.css` | `교체 후보` | `.primary-button`, `.secondary-button`, `.ghost-button`, `.icon-button` 사용처를 `Button`/`IconButton`으로 옮긴 뒤 제거한다. |
| Jobs 목록 shell / toolbar | `ingest.css`, `responsive.css`, `base.css` | `정리됨` | #367에서 Jobs metrics/filter/table panel shell과 metrics card selector를 `Panel`/`PanelHeader`/`MetricCard`로 이동. #369에서 Jobs toolbar body/search/filter chip/reset responsive selector를 `FilterToolbar`로 이동. Jobs table detail selector는 유지. |
| Jobs table legacy footer/empty | `ingest.css`, `responsive.css` | `정리됨` | A02에서 `JobsPages.tsx` 사용처가 제거된 뒤 CSS만 남아 있던 `jobs-table-empty`, `jobs-table-preview-footer` selector를 #364에서 삭제. |
| Jobs status/owner/tag chip | `ingest.css` | `교체 후보` | `Badge` primitive로 톤이 안정되면 `.status-pill`, `.run-status-pill`, `.owner-chip`, `.tag-chip`을 줄인다. |
| Run History table | `ingest.css`, `ingest-dag.css` | `교체 후보` | DataTable 적용 후 `.runs-table*`, `.runs-pagination*`을 정리한다. DAG modal은 별도 QA 전 유지한다. |
| ETL Source/Schema flow | `etl.css`, `schema-transform-adapter.css`, `schema-transform-source.css` | `보류` | A03에서 PageHeader와 주요 action button은 primitive 적용. #357에서 legacy naming은 정리. card, segmented tabs, schema workbench, review summary는 component gap으로 분리한다. |
| Tree UI | `etl.css`, `schema-transform-adapter.css` | `보류` | MUI TreeView 유지가 아니라 `react-arborist` 기준 교체가 목표다. 단, 실제 교체 전 tree 관련 CSS는 삭제하지 않는다. |
| Service-wide legacy xflow naming | `ingest.css`, `catalog.css`, `dashboard.css`, `etl.css`, `pages/ingest`, `pages/catalog`, `pages/dashboard`, `pages/etl` | `정리됨` | #357에서 ETL, #361에서 Ingest/Catalog/Dashboard의 legacy naming을 AskLake 도메인 이름으로 rename. 문서에 남은 `xflow` 문자열은 cleanup 추적 기록이다. |

## B 작업으로 정리될 CSS

| 범위 | 관련 파일 | 상태 | 정리 기준 |
| --- | --- | --- | --- |
| UI primitive 적용 | `catalog.css`, `sql.css`, `dashboard.css`, `dashboard-runtime.css` | `교체 후보` | B01의 `Button`, `Card`, `Badge`, `Input`, `Select`, `Dialog`, `EmptyState` 적용 후 화면별 중복 selector를 줄인다. |
| DataTable 적용 | `sql.css`, `dashboard.css`, `catalog.css` | `부분 정리됨` | B02-B04에서 SQL preview table, Catalog schema table, Dashboard list table, Dashboard runtime table widget은 `DataTable` 기준으로 전환됨. 남은 것은 table 주변 shell, density, overflow, menu, empty/loading wrapper CSS다. |
| SQL preview table | `sql.css` | `부분 정리됨` | `SqlPreviewTable`은 공통 `DataTable`로 전환됨. `.sql-preview-table-wrap`, `.sql-preview-table` 같은 wrapper/density class는 `/sql` QA와 result shell 공통화 전까지 유지한다. |
| SQL editor/action buttons | `sql.css` | `교체 후보` | B03에서 editor action button을 `Button` primitive로 옮긴 뒤 `.sql-editor-actions .primary-button` 계열을 축소한다. |
| Catalog result/list cards | `catalog.css` | `교체 후보` | #367에서 Catalog search/result/preview panel shell은 `Panel`/`PanelHeader`로 이동. #375에서 Catalog search/tag/filter row shell은 `FilterToolbar`로 이동. 결과 card, badge, schema preview, lineage selector와 sort menu는 계속 유지. |
| Catalog lineage graph | `catalog.css` | `보류` | React Flow node/edge class와 연결되어 있어 lineage QA 전 삭제 금지. #361에서 graph 내부 selector는 `lineage-*` 기준으로 rename. |
| Dashboard list/table | `dashboard.css` | `부분 정리됨` | B04에서 Dashboard 목록 table이 `DataTable` 기준으로 전환됨. #367에서 list toolbar/table panel shell은 `Panel`/`PanelHeader`로 이동. #369에서 toolbar body/search/actions/divider selector는 `FilterToolbar`로 이동. menu option/filter button과 table density selector는 `/dashboards` QA 후 추가 축소한다. |
| Dashboard builder preview | `dashboard.css` | `보류` | builder canvas, widget preview, draft widget 상태가 많아 B04 QA 후 판단한다. |
| Dashboard runtime canvas/widget | `dashboard-runtime.css` | `보류` | `react-grid-layout`, `react-resizable`, widget selected/editing/AI state와 묶여 있어 runtime route QA 전 삭제 금지. Table widget은 DataTable 기준으로 전환되어 `.asklake-table-widget*` selector가 새 기준이 됨. |
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
| `Chip` / `TagList` / `StatusBadge` | 기존 `Badge`로 대체된 범위와 interactive chip으로 유지한 범위를 분리한다. 예: `status-pill`, `run-status-pill`, `owner-chip`, `tag-chip`, `target-chip`, `*-type-pill`. |
| `KeyValueList` / `ValidationList` | ETL/Creation/Catalog/Jobs detail의 summary/validation row selector를 화면별로 유지할지, 공통 row로 옮길지 기록한다. |
| `PreviewPanel` / `ResultPanel` | `DataTable` 적용이 끝난 표 주변의 header, empty/loading, CTA, overflow shell selector를 추적한다. |
| `SettingsPanel` / `FormFieldGroup` | input/select primitive 적용 후에도 남은 label/grid/textarea/checkbox/color picker selector를 유지 사유와 함께 적는다. |
| `TreePanel` / `SelectableCard` | MUI TreeView, react-arborist, React Flow처럼 외부 라이브러리 class와 묶인 selector는 route QA 전 삭제하지 않고 `보류`로 유지한다. |

현재 코드 스윕 기준으로 먼저 시도하기 좋은 순서는 `PaginationBar` -> `DialogShell` -> `Chip/TagList/StatusBadge` -> `KeyValueList/ValidationList` -> `PreviewPanel/ResultPanel` -> `SettingsPanel/FormFieldGroup`이다. `TreePanel`과 `SelectableCard`는 상태와 라이브러리 차이가 커서 별도 설계 PR로 분리한다.

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
| 2026-07-09 | component 확장 PR에서 `PaginationBar`, `DialogShell`, `Chip/TagList`, `ValidationList`, `PreviewPanel`, `SettingsPanel`, `TreePanel` 후보별 CSS 기록 기준을 추가. |
| 2026-07-09 | #375에서 Catalog 검색 box/tag row/filter row shell selector와 SQL 분석 테이블 검색 selector를 `FilterToolbar` 계열로 이동하고, shadcn primitive 전면 적용 원칙을 CSS cleanup 기준에 추가. |
