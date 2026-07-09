# Frontend Component Gap Inventory

## 목적

이 문서는 AskLake UI refactor/polishing 중 현재 `components/ui` primitive로 충분히 커버하지 못하는 화면 패턴을 서비스 전체 기준으로 추적한다.

CSS cleanup inventory가 "어떤 selector를 유지/교체/삭제할지"를 보는 문서라면, 이 문서는 "어떤 공통 컴포넌트가 더 필요해서 CSS가 계속 남는지"를 보는 문서다. 특정 화면에서 무리하게 `Button`, `Card`, `Badge`만 끼워 맞추지 않고, 반복되는 UI 패턴을 발견하면 이 문서에 기록한 뒤 별도 component 확장 PR에서 다룬다.

## 운영 규칙

- UI 전환 PR마다 새 gap을 발견하면 이 문서에 추가한다.
- 하나의 화면에서만 쓰이는 일회성 UI는 바로 공통 컴포넌트로 만들지 않는다.
- 두 화면 이상에서 반복되거나, CSS 삭제를 막는 구조적 패턴만 component gap으로 본다.
- Backend API, 데이터 계약, 도메인 로직은 이 문서의 범위가 아니다.
- gap을 기록했다고 해서 즉시 구현한다는 뜻은 아니다. 우선순위와 담당 PR을 따로 정한다.
- 이미 `DataTable`, `Panel`, `PanelHeader`, `Button`, `Input` 같은 공통 컴포넌트로 대체된 작업은 완료 범위로 기록하고, 남은 항목은 "기능 미완료"가 아니라 후속 공통화/CSS 축소 후보로 구분한다.
- UI 전환이나 CSS cleanup PR에서 "공통 컴포넌트로 아직 대체하지 않은 UI"가 새로 보이면 이 문서와 `docs/frontend-css-cleanup-inventory.md`를 함께 업데이트한다.

## 상태 값

| 상태 | 의미 |
| --- | --- |
| `관찰됨` | 반복 패턴이 확인되었지만 아직 설계하지 않았다. |
| `설계 필요` | 공통 컴포넌트 후보가 뚜렷하며 props/variant 설계가 필요하다. |
| `구현 후보` | 다음 component 확장 PR에서 구현할 수 있다. |
| `부분 해결` | 현재 공통 컴포넌트로 핵심 표/버튼/패널 전환은 끝났지만, 더 큰 shell이나 layout 공통화 후보가 남아 있다. 기능 미완료를 뜻하지 않는다. |
| `보류` | 화면 고유성이 크거나 외부 라이브러리/복잡한 상태와 묶여 있어 당장 공통화하지 않는다. |
| `해결됨` | 공통 컴포넌트가 추가되었고 적용 PR이 진행되었다. |

## 현재 공통 UI 기준

현재 사용 가능한 primitive:

- `Button`
- `IconButton`
- `Badge`
- `Card`
- `Input`
- `Select`
- `Dialog`
- `PageHeader`
- `Panel`
- `PanelHeader`
- `MetricCard`
- `FilterToolbar`
- `FilterToolbarSearch`
- `FilterToolbarActions`
- `FilterToolbarMenu`
- `FilterToolbarDivider`
- `PaginationBar`
- `DialogShell`
- `PickerDialog`
- `CommandBar`
- `EmptyState`
- `Table`
- `DataTable`

## B 작업 반영 기준

현재 B02-B04에서 확인된 적용 범위:

- B02: `DataTable` 기반을 만들고 SQL preview 또는 Dashboard list 같은 표형 화면에 적용할 수 있는 기준을 세웠다.
- B03: SQL preview table과 Catalog schema table은 `DataTable` 기준으로 전환되었다.
- B04: Dashboard list table과 dashboard runtime table widget은 `DataTable` 기준으로 전환되었다.
- #369에서 Jobs/Dashboard list toolbar body/search/actions/menu/divider shell은 `FilterToolbar` 기준으로 전환되었다.
- Catalog preview shell은 `Panel`/`PanelHeader`를 사용하지만, schema preview card, lineage teaser, SQL 이동 CTA 조합은 화면 전용 구조다.

따라서 아래 gap은 B02/B03/B04 누락 목록이 아니라, 지금까지 만든 공통 컴포넌트로 대체되지 않은 UI와 후속 공통화 후보를 모아 둔 목록이다.

## Service-wide Gap 목록

| 영역 | 패턴 | 상태 | 필요한 컴포넌트 후보 | 메모 |
| --- | --- | --- | --- | --- |
| 전체 | 화면 섹션 헤더 + 아이콘 + 상태 pill + actions | `해결됨` | `PanelHeader` | #367에서 Jobs/Catalog/Dashboard list shell에 1차 적용. ETL/SQL/runtime의 특수 header는 후속 PR에서 추가 적용 판단. |
| 전체 | 강조 패널/작업 패널 | `해결됨` | `Panel` | #367에서 Jobs/Catalog/Dashboard list의 bordered panel shell을 공통화. 화면 고유 body/layout CSS는 유지. |
| 전체 | 하단 고정/반고정 command 영역 | `부분 해결` | `CommandBar` | #378에서 `CommandBar`를 추가하고 Creation top/panel actions, ETL schema/rule bottom bar 대표 사용처에 적용. Dashboard runtime topbar/action grouping은 후속 판단. |
| 전체 | key-value review summary | `설계 필요` | `ReviewSummary` 또는 `KeyValueList` | ETL Review, Catalog detail, Dashboard metadata에서 반복 가능성 있음. |
| 전체 | 상태 검증 목록 | `설계 필요` | `ValidationList` | ETL governance/review validation, backend readiness UI 후보에서 반복 가능성 있음. |
| 전체 | metric summary card grid | `해결됨` | `MetricCard` | #367에서 Ingest Jobs metrics에 1차 적용. Dashboard runtime/ETL detail metric류는 화면별 상태가 달라 후속 적용 판단. |
| 전체 | filter/search toolbar | `부분 해결` | `FilterToolbar` | #369에서 Jobs/Dashboard list의 toolbar body/search/actions를 1차 공통화. Catalog는 tag row, checkbox filter, sort menu가 결합되어 있어 후속 판단으로 유지. |
| 전체 | DataTable 밖 pagination/footer | `부분 해결` | `PaginationBar` | #378에서 SQL context pagination, Dashboard list pagination, Ingest runs footer에 1차 적용. DataTable 내부 pagination과 Catalog 전용 pagination은 이번 범위에서 제외. |
| 전체 | modal/backdrop/dialog shell | `부분 해결` | `DialogShell` | #378에서 SQL materialize dialog, Ingest job/run log dialog, Dashboard delete dialog 대표 사용처에 적용. Dashboard chart/runtime dialog와 DAG modal은 후속 QA 범위. |
| 전체 | picker dialog shell | `부분 해결` | `PickerDialog` | #378에서 S3 path picker와 DB picker의 backdrop/header/footer shell을 공통화. 내부 MUI tree/list/body CSS는 유지. |
| 전체 | preview/result panel | `부분 해결` | `PreviewPanel` 또는 `ResultPanel` | SQL preview table, Catalog schema table, Dashboard table widget의 표 자체는 `DataTable` 기준으로 전환됨. preview header, empty/loading, CTA, overflow shell은 화면별 CSS가 남아 있음. |
| 전체 | dense settings form | `설계 필요` | `SettingsPanel`, `FormFieldGroup` | Dashboard widget config, ETL rule builder, SQL option form에서 input/select/textarea layout CSS가 계속 남음. |
| 전체 | icon-only option grid | `관찰됨` | `IconOptionGrid` | Dashboard widget type picker처럼 icon button grid + selected state + tooltip 조합이 반복될 수 있음. |
| 전체 | color palette picker | `보류` | `ColorPalettePicker` | Dashboard widget color slot/choice/custom color picker는 `react-colorful` 상태와 묶여 있어 별도 설계 필요. |
| 전체 | split panel layout | `보류` | `SplitPanel` | ETL Source browse, SQL context/editor, Dashboard runtime side panel이 유사하지만 상태가 복잡함. |
| 전체 | tree/list hybrid selector | `보류` | `TreePanel` | react-arborist 도입 이후 Source tree/Dataset tree 기준을 다시 잡아야 함. Dashboard dataset tree는 B04에서 arborist로 전환됐지만 공통 wrapper는 아직 없음. |
| 전체 | runtime/widget frame shell | `설계 필요` | `WidgetShell` 또는 `RuntimeFrame` | Dashboard widget frame, table widget viewport, assistant/loading/error state가 화면 고유 CSS로 남아 있음. |

## A03 ETL Seed Gap

| ETL 위치 | 현재 패턴 | 상태 | 필요한 컴포넌트 후보 | 이번 PR 처리 |
| --- | --- | --- | --- | --- |
| Source/Target/Permission/Review card | `etl-review-card`, `target-config-card`, `permission-config-card` | `설계 필요` | `Panel` | Naming cleanup 완료. 후속 component 확장 후보로 유지. |
| Source stage tabs | `source-stage-tabs` | `관찰됨` | `SegmentedTabs` | custom stage state가 있어 이번 PR에서는 유지. |
| Source connector cards | `source-choice-card` | `보류` | `SelectableCard` | 선택 상태, 아이콘, 설명, check 표시를 포함해 설계 필요. |
| Schedule run type cards | `schedule-config-mode-card` | `보류` | `SelectableCard` | Source connector card와 함께 설계 가능. |
| Schema transform workbench | `SchemaTransformWorkbench`, `schema-transform-*` | `보류` | `TransformWorkbench` | Naming cleanup 완료. 공통 workbench component 분리는 후속 범위. |
| Rule builder | `hegun-builder-panel`, `hegun-rule-field`, `hegun-rule-form-actions` | `설계 필요` | `RuleBuilderPanel`, `FormFieldGroup` | Button 전환만 진행. form/select 구조는 유지. |
| Review edit action | `etl-review-edit` | `구현 후보` | `SectionAction` | `ReviewEditButton` wrapper로 반복 제거. |
| Validation rows | `etl-review-validation`, `permission-config-validation` | `설계 필요` | `ValidationList` | Naming cleanup 완료. 후속 component 확장 후보. |
| Review key-value rows | `etl-review-kv` | `설계 필요` | `KeyValueList` | Naming cleanup 완료. 후속 component 확장 후보. |
| Bottom command bar | `schema-bottom-bar`, `hegun-rule-bottom-bar` | `부분 해결` | `CommandBar` | #378에서 `CommandBar` wrapper로 전환. layout/density CSS는 route QA 전까지 유지. |

## B02-B04 Dashboard/B Seed Gap

| 위치 | 현재 패턴 | 상태 | 필요한 컴포넌트 후보 | 이번 작업 기준 처리 |
| --- | --- | --- | --- | --- |
| SQL/Catalog/Dashboard preview | SQL result preview, Catalog schema preview, Dashboard widget preview | `부분 해결` | `PreviewPanel`, `ResultPanel` | B02/B03/B04에서 SQL preview table, Catalog schema table, Dashboard table widget은 `DataTable` 기준으로 전환됨. 남은 범위는 preview shell/header/CTA/empty/loading/overflow layout 공통화 후보다. |
| Dashboard list toolbar | search input + owner/tag/sort/action cluster | `해결됨` | `FilterToolbar` | #369에서 toolbar body/search/actions/menu/divider shell을 공통 컴포넌트로 이동. menu option과 filter button의 화면 고유 스타일은 유지. |
| Dashboard table action slot | row action icon button column | `구현 후보` | `RowActionCell` | B04에서 DataTable `renderRowActions`를 사용함. 반복되면 row action sizing/label/disabled 패턴을 분리할 수 있음. |
| Dashboard list pagination/delete dialog | list footer pagination + destructive confirm dialog | `부분 해결` | `PaginationBar`, `DialogShell` | #378에서 DashboardPagination과 dashboard/delete widget delete 확인 dialog를 공통 shell로 전환. table density와 builder/chart modal은 유지. |
| Dashboard runtime topbar | title edit + publish/draft/share/refresh actions | `설계 필요` | `RuntimeTopbar`, `ActionGroup` | B04에서 `Button`/`Input`만 적용. action grouping, dirty state, publish state shell은 화면 전용으로 유지. |
| Dashboard widget frame | selected/editable frame + delete action + widget chrome | `설계 필요` | `WidgetShell` | B04에서 delete action만 `Button`으로 전환. frame chrome, selected state, resize/grid integration은 유지. |
| Dashboard table widget | widget 내부 DataTable viewport | `부분 해결` | `EmbeddedDataTablePanel` | B04에서 `DataTable`로 전환됨. widget 내부 padding, min width, compact density를 runtime CSS에 남긴 것은 기능 미완료가 아니라 후속 CSS 축소 후보다. |
| Dashboard widget config panel | dense chart/table settings form | `설계 필요` | `SettingsPanel`, `FormFieldGroup`, `NativeSelectField` | B04에서 text/number input, select, button만 primitive/shadcn-style wrapper로 전환. checkbox, textarea, color picker, layout은 유지. |
| Dashboard widget type picker | icon-only chart type grid + tooltip | `관찰됨` | `IconOptionGrid` | 선택 state와 tooltip layer가 결합되어 있어 단순 `Button`만으로는 CSS를 제거하기 어려움. |
| Dashboard color controls | color slot list + swatches + custom color picker | `보류` | `ColorPalettePicker` | `react-colorful`과 custom color state가 묶여 있어 후속 component 설계 전까지 유지. |
| Dashboard dataset tree | arborist tree row + hover card + type icon | `보류` | `TreePanel`, `TreeHoverCard` | B04에서 `react-arborist`로 전환했고 #364에서 legacy MUI TreeItem selector는 제거. 공통 tree wrapper/hover card primitive는 아직 없음. |
| Catalog lineage / graph preview | React Flow node/edge canvas | `보류` | `FlowCanvasPanel` | graph library class와 묶여 있어 Catalog QA 전 공통화하지 않음. |
| SQL editor/action surface | editor toolbar + execution status + result shell | `부분 해결` | `QueryActionBar`, `ResultPanel`, `PaginationBar`, `DialogShell` | #378에서 context pagination과 materialize dialog shell은 공통화. editor action grouping/result shell은 화면 전용으로 유지. |

## Legacy xflow Naming Gap

`xflow|XFlow|XFLOW` 잔재는 단순 CSS 문제가 아니라 imported 서비스의 흔적을 AskLake 도메인 언어로 바꾸는 cleanup 작업이다.
이 섹션에 남아 있는 `xflow` 문자열은 cleanup 추적을 위한 문서 기록이며, frontend 코드 식별자/className 잔재가 아니다.

#357 기준 처리 결과:

- ETL 내부 file/component/className/CSS selector의 legacy xflow naming은 AskLake 도메인 언어로 rename한다.
- `XFlowSchemaTransformEditor`는 `SchemaTransformWorkbench`로 rename한다.
- `xflow-adapter.css`는 `schema-transform-adapter.css`로 rename한다.
- `xflow-source.css`는 Tailwind import 역할을 유지하되 `schema-transform-source.css`로 rename한다.
- `xflow-review-*`, `schema-xflow-*`, `source-xflow-*`, `schedule-xflow-*`, `target-xflow-*`, `permission-xflow-*`는 ETL 도메인 className으로 rename한다.

#361 기준 처리 결과:

- Ingest Jobs shell의 `jobs-xflow-*` className/CSS selector는 `jobs-panel-*`로 rename한다.
- Catalog card shell의 `catalog-xflow-*` className/CSS selector는 `catalog-panel-*`로 rename한다.
- Catalog lineage graph의 `xflow-schema-*`, `xflow-column-*` className/CSS selector는 `lineage-schema-*`, `lineage-column-*`로 rename한다.
- Dashboard list shell의 `dashboard-xflow-*` className/CSS selector는 `dashboard-panel-*`로 rename한다.
- `rg "xflow|XFlow|XFLOW" frontend` 기준으로 frontend 코드 잔재가 없어야 한다.

후속 component 확장 후보:

- `Panel`
- `SegmentedTabs`
- `SelectableCard`
- `TransformWorkbench`
- `ValidationList`
- `KeyValueList`

## 업데이트 로그

| 날짜 | 변경 |
| --- | --- |
| 2026-07-09 | A03에서 서비스 전체 component gap inventory 초기 생성. ETL에서 발견한 gap을 seed로 기록. |
| 2026-07-09 | #357에서 ETL 내부 legacy xflow naming을 AskLake 도메인 이름으로 rename한 상태를 반영. |
| 2026-07-09 | Issue #358에서 B02-B04 Dashboard/B 작업 중 공통 primitive로 대체하지 않은 preview, toolbar, widget frame, config panel, color picker, tree, graph/editor gap을 기록. |
| 2026-07-09 | #361에서 Ingest/Catalog/Dashboard까지 남은 legacy xflow naming을 AskLake 도메인 이름으로 rename한 상태를 반영. |
| 2026-07-09 | #364에서 Dashboard dataset tree의 legacy MUI TreeItem selector 제거 상태를 반영. TreePanel/TreeHoverCard gap은 유지. |
| 2026-07-09 | #367에서 `Panel`, `PanelHeader`, `MetricCard`를 추가하고 Jobs/Catalog/Dashboard list shell에 1차 적용. FilterToolbar, PreviewPanel, WidgetShell, TreePanel gap은 유지. |
| 2026-07-09 | #369에서 `FilterToolbar` 계열 컴포넌트를 추가하고 Jobs/Dashboard list에 1차 적용. Catalog 검색/필터는 구조 차이로 후속 판단. |
| 2026-07-09 | #372에서 B02/B03/B04 완료 범위와 후속 공통화 후보를 구분. `DataTable`/primitive 적용이 끝난 표와 `FilterToolbar` 적용 범위를 기능 미완료가 아닌 `부분 해결`/`해결됨` 상태로 정리. |
| 2026-07-09 | #378에서 `PaginationBar`, `DialogShell`, `PickerDialog`, `CommandBar`를 추가하고 SQL/Dashboard/Ingest/Creation/ETL/S3/DB picker 대표 사용처에 1차 적용. Catalog와 검색바/FilterToolbar 계열은 제외. |
