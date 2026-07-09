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

## 공통 컴포넌트 확장 기록 방식

새 공통 컴포넌트를 만들거나 적용하는 PR은 아래 순서로 기록한다.

1. `rg`로 최소 두 화면 이상에서 반복되는 사용처를 먼저 확인한다.
2. 이 문서의 Service-wide Gap 목록에 패턴, 후보 컴포넌트, 적용하지 않은 이유를 기록한다.
3. 실제 적용 PR에서는 상태를 `관찰됨` -> `설계 필요` -> `구현 후보` -> `부분 해결` 또는 `해결됨`으로 갱신한다.
4. 관련 CSS를 바로 삭제하지 않더라도 `docs/frontend-css-cleanup-inventory.md`에 유지/교체/삭제 판단을 같이 남긴다.
5. `Button`, `Badge`, `Panel` 같은 primitive만 추가로 끼워 넣는 작업과, `PaginationBar`, `DialogShell`, `PreviewPanel`처럼 화면 구조를 줄이는 작업을 구분한다.

권장 기록 단위:

| 항목 | 기록 내용 |
| --- | --- |
| 코드 증거 | 반복 사용처 파일과 대표 selector/className |
| 컴포넌트 후보 | 새로 만들거나 확장할 컴포넌트 이름 |
| 적용 순서 | 먼저 적용할 화면과 보류할 화면 |
| CSS 판단 | 유지, 교체 후보, 부분 정리, 삭제 후보 중 하나 |
| 검증 | build 또는 route QA 범위 |

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
- `EmptyState`
- `Table`
- `DataTable`

## 2026-07-09 코드 스윕 결과

`frontend/src/components/ui`에는 현재 14개 파일 기준으로 primitive와 table/toolbar 계열이 있다. 실제 화면 사용처는 Jobs/Catalog/Dashboard/SQL 일부에 집중되어 있고, ETL과 runtime 복합 UI에는 아직 화면 전용 구조가 많이 남아 있다.

| 반복 패턴 | 확인된 코드 증거 | 판단 | 우선 컴포넌트 후보 |
| --- | --- | --- | --- |
| 버튼/액션 묶음 | `EtlPages.tsx`, `DashboardPage.tsx`, `DashboardParts.tsx`, `SqlAnalysisPage.tsx`, `S3PathField.tsx`, `DatabaseField.tsx`에 raw `<button>` 또는 legacy button class가 남아 있음 | 단순 `Button` 교체보다 action grouping, icon-only, bottom command까지 나누는 편이 안전함 | `ActionGroup`, `CommandBar`, `IconOptionGrid` |
| custom modal/dialog | `CatalogPage.tsx`, `SqlAnalysisPage.tsx`, `JobsPages.tsx`, `DashboardParts.tsx`, `S3PathField.tsx`, `DatabaseField.tsx`에서 role dialog/backdrop/modal class 반복 | 이미 `Dialog` primitive가 있으므로 shell 적용 우선순위가 높음 | `DialogShell`, `PickerDialog` |
| non-table pagination | Catalog search/materialization, SQL context, Dashboard list, Ingest runs가 DataTable 밖에서 별도 pagination 사용 | `DataTable` 내부 pagination과 분리된 list/page pagination 필요 | `PaginationBar` |
| tree/list selector | S3 picker, ETL source asset/json tree, SQL dataset tree, Dashboard dataset tree가 서로 다른 구현으로 존재 | 라이브러리 상태가 달라 바로 통합하지 말고 row/empty/loading shell부터 분리 | `TreePanel`, `PickerTree`, `TreeHoverCard` |
| preview/result shell | Catalog schema preview, SQL result preview, Dashboard widget preview, ETL final preview가 panel/header/empty/CTA 조합을 반복 | 표 자체는 `DataTable`로 일부 해결됐고, 주변 shell이 다음 후보 | `PreviewPanel`, `ResultPanel` |
| key-value/validation summary | `CreationFlow.tsx`, ETL review/permission, Catalog detail, Jobs detail에서 요약/검증 row 반복 | 화면별 문구는 다르지만 레이아웃은 공통화 가능 | `KeyValueList`, `ValidationList` |
| chip/tag/status | Catalog tag/status/type pill, Ingest status/owner/tag, ETL data/target/permission chip, Dashboard row tag가 남아 있음 | `Badge`는 있지만 list/interactive chip 패턴이 별도로 필요 | `Chip`, `TagList`, `StatusBadge` |
| dense settings form | Dashboard widget config, ETL rule builder, SQL materialize form, S3/DB picker form에서 label/input/select/textarea layout 반복 | input primitive만으로 CSS가 줄지 않으므로 form group 컴포넌트 필요 | `SettingsPanel`, `FormFieldGroup`, `NativeSelectField` |
| segmented/selectable option | ETL source stage tabs, source connector cards, schedule cards, target tags, Dashboard widget type picker | 상태/아이콘/설명 조합이 많아 설계 후 적용 | `SegmentedTabs`, `SelectableCard` |

권장 확장 순서:

1. `PaginationBar`, `DialogShell`부터 시작한다. 화면 도메인 의존이 낮고 여러 route에서 중복 CSS를 줄일 수 있다.
2. `Chip`/`TagList`/`StatusBadge`, `KeyValueList`, `ValidationList`로 요약/상태 UI를 줄인다.
3. `PreviewPanel`/`ResultPanel`로 SQL/Catalog/Dashboard/ETL preview shell을 묶는다.
4. `SettingsPanel`/`FormFieldGroup`으로 Dashboard config와 ETL rule builder의 form CSS를 줄인다.
5. `TreePanel`/`SelectableCard`는 MUI tree, react-arborist, 화면 상태 차이가 커서 별도 설계 PR에서 다룬다.

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
| 전체 | 하단 고정/반고정 command 영역 | `관찰됨` | `CommandBar` | ETL schema/rule bottom bar, Dashboard runtime action 영역 등에서 반복 가능성 있음. |
| 전체 | key-value review summary | `설계 필요` | `ReviewSummary` 또는 `KeyValueList` | ETL Review, Catalog detail, Dashboard metadata에서 반복 가능성 있음. |
| 전체 | 상태 검증 목록 | `설계 필요` | `ValidationList` | ETL governance/review validation, backend readiness UI 후보에서 반복 가능성 있음. |
| 전체 | metric summary card grid | `해결됨` | `MetricCard` | #367에서 Ingest Jobs metrics에 1차 적용. Dashboard runtime/ETL detail metric류는 화면별 상태가 달라 후속 적용 판단. |
| 전체 | filter/search toolbar | `부분 해결` | `FilterToolbar` | #369에서 Jobs/Dashboard list의 toolbar body/search/actions를 1차 공통화. Catalog는 tag row, checkbox filter, sort menu가 결합되어 있어 후속 판단으로 유지. |
| 전체 | DataTable 밖 pagination/footer | `구현 후보` | `PaginationBar` | Catalog search/materialization, SQL context, Dashboard list, Ingest runs에서 반복된다. `DataTable` 내부 pagination은 그대로 두고 외부 list pagination만 먼저 묶는다. |
| 전체 | modal/backdrop/dialog shell | `구현 후보` | `DialogShell`, `PickerDialog` | Catalog/SQL/Jobs/Dashboard/S3/DB picker에 custom role dialog가 남아 있다. 기존 `Dialog` primitive를 화면 shell로 확장하는 방향이 우선이다. |
| 전체 | tag/chip/status row | `구현 후보` | `Chip`, `TagList`, `StatusBadge` | `Badge` primitive는 있지만 interactive tag, owner chip, type pill, status pill이 화면별 CSS로 남아 있다. |
| 전체 | segmented tabs/selectable card | `설계 필요` | `SegmentedTabs`, `SelectableCard` | ETL source stage/source card/schedule card, Dashboard widget type picker, target chip grid에서 선택 상태 패턴이 반복된다. |
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
| Bottom command bar | `schema-bottom-bar`, `hegun-rule-bottom-bar` | `설계 필요` | `CommandBar` | Button 전환만 진행. layout CSS는 유지. |

## B02-B04 Dashboard/B Seed Gap

| 위치 | 현재 패턴 | 상태 | 필요한 컴포넌트 후보 | 이번 작업 기준 처리 |
| --- | --- | --- | --- | --- |
| SQL/Catalog/Dashboard preview | SQL result preview, Catalog schema preview, Dashboard widget preview | `부분 해결` | `PreviewPanel`, `ResultPanel` | B02/B03/B04에서 SQL preview table, Catalog schema table, Dashboard table widget은 `DataTable` 기준으로 전환됨. 남은 범위는 preview shell/header/CTA/empty/loading/overflow layout 공통화 후보다. |
| Dashboard list toolbar | search input + owner/tag/sort/action cluster | `해결됨` | `FilterToolbar` | #369에서 toolbar body/search/actions/menu/divider shell을 공통 컴포넌트로 이동. menu option과 filter button의 화면 고유 스타일은 유지. |
| Dashboard table action slot | row action icon button column | `구현 후보` | `RowActionCell` | B04에서 DataTable `renderRowActions`를 사용함. 반복되면 row action sizing/label/disabled 패턴을 분리할 수 있음. |
| Dashboard runtime topbar | title edit + publish/draft/share/refresh actions | `설계 필요` | `RuntimeTopbar`, `ActionGroup` | B04에서 `Button`/`Input`만 적용. action grouping, dirty state, publish state shell은 화면 전용으로 유지. |
| Dashboard widget frame | selected/editable frame + delete action + widget chrome | `설계 필요` | `WidgetShell` | B04에서 delete action만 `Button`으로 전환. frame chrome, selected state, resize/grid integration은 유지. |
| Dashboard table widget | widget 내부 DataTable viewport | `부분 해결` | `EmbeddedDataTablePanel` | B04에서 `DataTable`로 전환됨. widget 내부 padding, min width, compact density를 runtime CSS에 남긴 것은 기능 미완료가 아니라 후속 CSS 축소 후보다. |
| Dashboard widget config panel | dense chart/table settings form | `설계 필요` | `SettingsPanel`, `FormFieldGroup`, `NativeSelectField` | B04에서 text/number input, select, button만 primitive/shadcn-style wrapper로 전환. checkbox, textarea, color picker, layout은 유지. |
| Dashboard widget type picker | icon-only chart type grid + tooltip | `관찰됨` | `IconOptionGrid` | 선택 state와 tooltip layer가 결합되어 있어 단순 `Button`만으로는 CSS를 제거하기 어려움. |
| Dashboard color controls | color slot list + swatches + custom color picker | `보류` | `ColorPalettePicker` | `react-colorful`과 custom color state가 묶여 있어 후속 component 설계 전까지 유지. |
| Dashboard dataset tree | arborist tree row + hover card + type icon | `보류` | `TreePanel`, `TreeHoverCard` | B04에서 `react-arborist`로 전환했고 #364에서 legacy MUI TreeItem selector는 제거. 공통 tree wrapper/hover card primitive는 아직 없음. |
| Catalog lineage / graph preview | React Flow node/edge canvas | `보류` | `FlowCanvasPanel` | graph library class와 묶여 있어 Catalog QA 전 공통화하지 않음. |
| SQL editor/action surface | editor toolbar + execution status + result shell | `관찰됨` | `QueryActionBar`, `ResultPanel` | B03/B02 전환 이후에도 editor-specific action grouping과 result shell은 화면 전용으로 남을 수 있음. |

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
| 2026-07-09 | 코드 스윕으로 버튼/모달/페이지네이션/트리/프리뷰/요약/칩/form/선택형 카드 반복 패턴을 확인하고 component 확장 기록 방식과 권장 순서를 추가. |
