# Frontend Component Gap Inventory

## 목적

이 문서는 AskLake UI refactor/polishing 중 현재 `components/ui` primitive로 충분히 커버하지 못하는 화면 패턴을 서비스 전체 기준으로 추적한다.

CSS cleanup inventory가 "어떤 selector를 유지/교체/삭제할지"를 보는 문서라면, 이 문서는 "어떤 공통 컴포넌트가 더 필요해서 CSS가 계속 남는지"를 보는 문서다. 특정 화면에서 무리하게 `Button`, `Card`, `Badge`만 끼워 맞추지 않고, 반복되는 UI 패턴을 발견하면 이 문서에 기록한 뒤 별도 component 확장 PR에서 다룬다.

shadcn primitive로 대체 가능한 기본 UI 판단은 `docs/frontend-shadcn-replacement-inventory.md`를 우선 기준으로 본다. 이 문서는 그 위에 남는 AskLake 서비스 전용 composition gap을 추적한다.

## 운영 규칙

- UI 전환 PR마다 새 gap을 발견하면 이 문서에 추가한다.
- 하나의 화면에서만 쓰이는 일회성 UI는 바로 AskLake 조합 컴포넌트로 만들지 않는다.
- 단, 반복되지 않는 UI라도 shadcn primitive가 이미 제공하는 기본 부품이면 `components/ui` 표준 부품으로 교체할 수 있는 후보로 본다.
- shadcn primitive가 이미 있는 UI는 새 AskLake wrapper를 만들기 전에 `docs/frontend-shadcn-replacement-inventory.md`의 `shadcn primitive 추가 필요` 또는 `shadcn으로 교체/흡수` 분류를 먼저 확인한다.
- 두 화면 이상에서 반복되거나, CSS 삭제를 막는 구조적 패턴만 component gap으로 본다.
- Backend API, 데이터 계약, 도메인 로직은 이 문서의 범위가 아니다.
- gap을 기록했다고 해서 즉시 구현한다는 뜻은 아니다. 우선순위와 담당 PR을 따로 정한다.
- 이미 `DataTable`, `Panel`, `PanelHeader`, `Button`, `Input` 같은 공통 컴포넌트로 대체된 작업은 완료 범위로 기록하고, 남은 항목은 "기능 미완료"가 아니라 후속 공통화/CSS 축소 후보로 구분한다.
- UI 전환이나 CSS cleanup PR에서 "공통 컴포넌트로 아직 대체하지 않은 UI"가 새로 보이면 이 문서와 `docs/frontend-css-cleanup-inventory.md`를 함께 업데이트한다.

## shadcn primitive 표준화 원칙

AskLake 조합 컴포넌트는 반복되는 화면 구조를 줄이기 위한 단위이고, shadcn primitive는 기본 UI를 표준화하기 위한 단위다.

- 반복되는 UI는 `FilterToolbar`, `DataTable`, `Panel`, `PaginationBar`처럼 AskLake 조합 컴포넌트로 묶는다.
- 반복되지 않는 UI라도 `Textarea`, `Checkbox`, `Tabs`, `Tooltip`, `DropdownMenu`, `Select`, `Popover`, `Command`, `AlertDialog`처럼 shadcn에 검증된 primitive가 있으면 교체 후보로 본다.
- `SegmentedTabs`, `PaginationBar`, `FormFieldGroup`, `NativeSelectField`, `Chip`, `StatusBadge`, `DialogShell`, `PickerDialog`처럼 shadcn primitive로 흡수 가능한 wrapper는 새 사용처를 늘리기보다 후속 replacement PR에서 정리한다.
- `DataTable`, `FilterToolbar`, `PageHeader`, `Panel`, `PreviewPanel`, `SettingsPanel`, `DetailTableSection`처럼 업무 화면 구조를 묶는 component는 유지하되 내부를 shadcn primitive로 구성한다.
- 화면 고유 상태가 복잡한 경우에도 raw HTML과 화면별 CSS를 계속 늘리기보다, 우선 shadcn primitive를 적용하고 조합 컴포넌트 분리는 후속 PR로 판단한다.
- Tree, React Flow, dashboard grid처럼 외부 라이브러리 DOM과 강하게 묶인 UI는 shadcn primitive만으로 해결하지 않고 별도 설계 PR에서 다룬다.

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
- `FilterToolbarInput`
- `FilterToolbarFieldGroup`
- `FilterToolbarCheckboxGroup`
- `FilterToolbarCheckbox`
- `FilterToolbarActions`
- `FilterToolbarMenu`
- `FilterToolbarDivider`
- `PaginationBar`
- `DialogShell`
- `PickerDialog`
- `CommandBar`
- `ActionGroup`
- `Chip`
- `TagList`
- `StatusBadge`
- `KeyValueList`
- `ValidationList`
- `EmptyState`
- `Table`
- `DataTable`
- `PreviewPanel`
- `ResultPanel`
- `SettingsPanel`
- `FormFieldGroup`
- `NativeSelectField`
- `SegmentedTabs`
- `SelectableCard`
- `CheckableOption`
- `IconOptionGrid`
- `DetailTableSection`
- `TreePanel`
- `TreeHoverCard`
- `TreeView`
- `TreeGroup`
- `TreeRow`
- `TreeStaticRow`

## 2026-07-09 코드 스윕 결과

`frontend/src/components/ui`에는 현재 20개 파일 기준으로 primitive, table/toolbar, action/chip/status/summary 계열이 있다. 실제 화면 사용처는 Jobs/Catalog/Dashboard/SQL 일부에 집중되어 있고, ETL과 runtime 복합 UI에는 아직 화면 전용 구조가 남아 있다.

| 반복 패턴 | 확인된 코드 증거 | 판단 | 우선 컴포넌트 후보 |
| --- | --- | --- | --- |
| 버튼/액션 묶음 | `EtlPages.tsx`, `DashboardPage.tsx`, `DashboardParts.tsx`, `SqlAnalysisPage.tsx`, `S3PathField.tsx`, `DatabaseField.tsx`에 raw `<button>` 또는 legacy button class가 남아 있음 | 단순 `Button` 교체보다 action grouping, icon-only, bottom command까지 나누는 편이 안전함 | `ActionGroup`, `CommandBar`, `IconOptionGrid` |
| custom modal/dialog | `CatalogPage.tsx`, `SqlAnalysisPage.tsx`, `JobsPages.tsx`, `DashboardParts.tsx`, `S3PathField.tsx`, `DatabaseField.tsx`에서 role dialog/backdrop/modal class 반복 | 이미 `Dialog` primitive가 있으므로 shell 적용 우선순위가 높음 | `DialogShell`, `PickerDialog` |
| non-table pagination | Catalog search/materialization, SQL context, Dashboard list, Ingest runs가 DataTable 밖에서 별도 pagination 사용 | `DataTable` 내부 pagination과 분리된 list/page pagination 필요 | `PaginationBar` |
| tree/list selector | S3 picker, ETL source asset/json tree, SQL dataset tree, Dashboard dataset tree가 서로 다른 구현으로 존재 | #421에서 MUI TreeView를 제거하고 row/group shell은 `TreeView`/`TreeRow`로 표준화. Dashboard `react-arborist` engine과 hover/detail density는 화면별로 유지 | `TreePanel`, `TreeView`, `TreeRow`, `TreeHoverCard` |
| preview/result shell | Catalog schema preview, SQL result preview, Dashboard widget preview, ETL final preview가 panel/header/empty/CTA 조합을 반복 | 표 자체는 `DataTable`로 일부 해결됐고, 주변 shell이 다음 후보 | `PreviewPanel`, `ResultPanel` |
| key-value/validation summary | `CreationFlow.tsx`, ETL review/permission, Catalog detail, Jobs detail에서 요약/검증 row 반복 | 화면별 문구는 다르지만 레이아웃은 공통화 가능 | `KeyValueList`, `ValidationList` |
| chip/tag/status | Catalog tag/status/type pill, Ingest status/owner/tag, ETL data/target/permission chip, Dashboard row tag가 남아 있음 | `Badge`는 있지만 list/interactive chip 패턴이 별도로 필요 | `Chip`, `TagList`, `StatusBadge` |
| dense settings form | Dashboard widget config, ETL rule builder, SQL materialize form, S3/DB picker form에서 label/input/select/textarea layout 반복 | input primitive만으로 CSS가 줄지 않으므로 form group 컴포넌트 필요 | `SettingsPanel`, `FormFieldGroup`, `NativeSelectField` |
| segmented/selectable option | ETL source stage tabs, source connector cards, schedule cards, target tags, checkbox/radio option cards, Dashboard widget type picker | 상태/아이콘/설명 조합이 많아 설계 후 적용 | `SegmentedTabs`, `SelectableCard`, `CheckableOption` |

권장 확장 순서:

1. `PreviewPanel`/`ResultPanel`로 SQL/Catalog/Dashboard/ETL preview shell을 묶는다.
2. `FormFieldGroup`/`NativeSelectField`로 input/select/textarea 주변 label, hint, error CSS를 먼저 줄인다.
3. `SettingsPanel`은 form group 적용 뒤 header/body/footer shell을 설계한다.
4. `SegmentedTabs`/`SelectableCard`/`IconOptionGrid`는 단순 선택 UI부터 적용하고 rename/edit 상태나 runtime 상태가 섞인 사용처는 보류한다.
5. `DetailTableSection`은 작은 table 주변 title/action/empty shell을 `DataTable`과 같이 잡는 후보로 둔다.
6. `TreePanel` wrapper 다음 단계로 #421에서 `TreeView`/`TreeRow` row shell을 추가했다. 남은 tree 작업은 runtime engine 고유 상태와 route QA 기준으로 분리한다.
7. `WidgetShell`/`ColorPalettePicker`는 외부 라이브러리와 runtime 상태 차이가 커서 별도 설계 PR에서 다룬다.

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
| 전체 | 화면 상단 masthead + 아이콘 + 설명 + actions | `부분 해결` | `PageHeader` | Jobs/ETL에 이어 #384에서 Catalog/SQL/Dashboard list 상단 헤더를 `PageHeader`로 맞춤. Module placeholder, ETL schedule standalone, Dashboard runtime/compact header는 route 성격이 달라 후속 판단. |
| 전체 | 화면 섹션 헤더 + 아이콘 + 상태 pill + actions | `해결됨` | `PanelHeader` | #367에서 Jobs/Catalog/Dashboard list shell에 1차 적용. ETL/SQL/runtime의 특수 header는 후속 PR에서 추가 적용 판단. |
| 전체 | 강조 패널/작업 패널 | `해결됨` | `Panel` | #367에서 Jobs/Catalog/Dashboard list의 bordered panel shell을 공통화. 화면 고유 body/layout CSS는 유지. |
| 전체 | header/action row 버튼 묶음 | `부분 해결` | `ActionGroup` | #385에서 SQL AI/editor/result actions, Dashboard list/workspace/runtime toolbar, Jobs card/detail actions, ETL rule action footer에 대표 적용. 버튼 자체와 화면별 density CSS는 유지. |
| 전체 | key-value review summary | `부분 해결` | `KeyValueList` | #385에서 Creation summary, Jobs detail metadata, ETL Review basic/destination/permission 요약에 적용. Catalog detail과 Dashboard metadata는 후속 판단. |
| 전체 | 상태 검증 목록 | `부분 해결` | `ValidationList` | #385에서 ETL Permission governance check와 Review validation rows에 적용. backend readiness UI 후보는 유지. |
| 전체 | metric summary card grid | `해결됨` | `MetricCard` | #367에서 Ingest Jobs metrics에 1차 적용. Dashboard runtime/ETL detail metric류는 화면별 상태가 달라 후속 적용 판단. |
| 전체 | filter/search toolbar | `부분 해결` | `FilterToolbar` | #369에서 Jobs/Dashboard list의 toolbar body/search/actions를 1차 공통화. #375에서 Catalog 검색/태그/checkbox filter와 SQL 분석 테이블 검색까지 `FilterToolbar` 계열로 확장. Catalog sort menu와 tag/chip 시각 상태는 후속 `DropdownMenu`/`Chip`/`TagList` 후보로 유지. |
| 전체 | tag/chip/status row | `부분 해결` | `Chip`, `TagList`, `StatusBadge` | #385에서 Jobs status/owner/tag, ETL target tag, Dashboard row tags/status, Dashboard list 상태 meta에 적용. Catalog tag/status와 일부 ETL data chip은 후속 판단. |
| 전체 | 하단 고정/반고정 command 영역 | `부분 해결` | `CommandBar` | #378에서 `CommandBar`를 추가하고 Creation top/panel actions, ETL schema/rule bottom bar 대표 사용처에 적용. Dashboard runtime topbar/action grouping은 후속 판단. |
| 전체 | DataTable 밖 pagination/footer | `부분 해결` | `PaginationBar` | #378에서 SQL context pagination, Dashboard list pagination, Ingest runs footer에 1차 적용. DataTable 내부 pagination과 Catalog 전용 pagination은 이번 범위에서 제외. |
| 전체 | modal/backdrop/dialog shell | `부분 해결` | `DialogShell` | #378에서 SQL materialize dialog, Ingest job/run log dialog, Dashboard delete dialog 대표 사용처에 적용. Catalog modal, Dashboard chart/runtime dialog, DAG modal은 후속 QA 범위. |
| 전체 | picker dialog shell | `부분 해결` | `PickerDialog` | #378에서 S3 path picker와 DB picker의 backdrop/header/footer shell을 공통화. S3 내부 MUI tree는 #421에서 제거했고, DB list/body CSS는 유지. |
| 전체 | segmented tabs/selectable card | `부분 해결` | `SegmentedTabs`, `SelectableCard`, `CheckableOption` | #389에서 ETL source stage/source card, schedule run type card, Dashboard period/widget type card에 1차 적용. #393에서 Jobs 보기 전환/상세 탭과 ETL rule category tabs를 `SegmentedTabs`로 추가 전환. #414에서 checkbox/radio 의미가 있는 Target partition과 Permission role option은 `CheckableOption`으로 분리. rename/edit tab은 보류한다. |
| 전체 | preview/result panel | `부분 해결` | `PreviewPanel`, `ResultPanel` | #389에서 SQL result, Dashboard builder preview, dashboard runtime table widget에 1차 적용. ETL final preview와 Catalog preview shell은 후속 판단. |
| 전체 | dense settings form | `부분 해결` | `SettingsPanel`, `FormFieldGroup`, `NativeSelectField`, shadcn `Field`/`Input`/`NativeSelect`/`InputGroup` | #389에서 Dashboard config shell을 1차 적용했고, #391에서 WidgetConfigPanel chart/table select, S3/DB picker toolbar, ETL source/schedule field, SQL materialize field까지 확장. #414에서 ETL rule builder/target/permission form label/select wrapper를 추가 전환. #418에서 ETL source/rule/schedule/target/permission의 대표 raw input/select와 S3/DB picker 검색 control을 shadcn primitive로 1차 교체. 기존 form wrapper는 route QA 전까지 compatibility layer로 유지한다. color picker 세부 layout은 후속. |
| 전체 | icon-only option grid | `부분 해결` | `IconOptionGrid` | #389에서 Dashboard runtime widget type icon grid에 1차 적용. tooltip/focus state는 기존 runtime 흐름 유지. |
| 전체 | detail table section | `부분 해결` | `DetailTableSection` | #389에서 Jobs detail schema/rule 작은 table section, #395에서 Jobs run history table shell에 적용. ETL detail과 schema transform editor는 후속. |
| 전체 | color palette picker | `보류` | `ColorPalettePicker` | Dashboard widget color slot/choice/custom color picker는 `react-colorful` 상태와 묶여 있어 별도 설계 필요. |
| 전체 | split panel layout | `보류` | `SplitPanel` | ETL Source browse, SQL context/editor, Dashboard runtime side panel이 유사하지만 상태가 복잡함. |
| 전체 | tree/list hybrid selector | `부분 해결` | `TreePanel`, `TreeHoverCard`, `TreeView`, `TreeRow` | #401에서 S3 picker, ETL source asset tree, SQL dataset tree, Dashboard dataset sidebar의 wrapper/state shell을 `TreePanel`로 분리. #416에서 SQL/Dashboard dataset tree hover card shell을 `TreeHoverCard`로 분리. #421에서 S3/ETL JSON/ETL asset/SQL/Dashboard row shell을 `TreeView`/`TreeRow` 기준으로 표준화하고 MUI TreeView/Tooltip 의존을 제거. Dashboard arborist engine과 route별 density는 유지. |
| 전체 | runtime/widget frame shell | `설계 필요` | `WidgetShell` 또는 `RuntimeFrame` | Dashboard widget frame, table widget viewport, assistant/loading/error state가 화면 고유 CSS로 남아 있음. |

## A03 ETL Seed Gap

| ETL 위치 | 현재 패턴 | 상태 | 필요한 컴포넌트 후보 | 이번 PR 처리 |
| --- | --- | --- | --- | --- |
| Source/Target/Permission/Review card | `etl-review-card`, `target-config-card`, `permission-config-card` | `설계 필요` | `Panel` | Naming cleanup 완료. 후속 component 확장 후보로 유지. |
| Source stage tabs | `source-stage-tabs` | `부분 해결` | `SegmentedTabs` | #389에서 `SegmentedTabs`로 1차 전환. 기존 className은 route QA 전까지 유지. |
| Source connector cards | `source-choice-card` | `부분 해결` | `SelectableCard` | #389에서 `SelectableCard`로 1차 전환. 선택 상태, 아이콘, 설명, check 표시 className은 유지. |
| Schedule run type cards | `schedule-config-mode-card`, `run-card` | `부분 해결` | `SelectableCard` | #389에서 ETL 내부 schedule config card와 schedule page run type card를 `SelectableCard`로 전환. target chip grid는 후속. |
| Schema transform workbench | `SchemaTransformWorkbench`, `schema-transform-*` | `보류` | `TransformWorkbench` | Naming cleanup 완료. 공통 workbench component 분리는 후속 범위. |
| Detail table section | run/detail/history와 transform preview의 작은 table section | `부분 해결` | `DetailTableSection` | #389에서 Jobs detail schema/rule table section, #395에서 Jobs run history table shell에 적용. ETL transform preview는 후속. |
| Rule builder | `hegun-builder-panel`, `hegun-rule-field`, `hegun-rule-form-actions` | `부분 해결` | `RuleBuilderPanel`, `FormFieldGroup`, `ActionGroup`, `SegmentedTabs`, shadcn `Input`/`NativeSelect` | #385에서 rule form action footer와 failed-row action footer를 `ActionGroup`으로 전환. #391에서는 source/schedule field까지 전환했고, #393에서 rule category tabs를 `SegmentedTabs`로 전환. #414에서 rule builder label/select/input wrapper를 `FormFieldGroup`/`NativeSelectField`로 전환. #418에서 rule builder 내부 raw input/select를 `Input`/`NativeSelect`로 교체. builder panel shell은 유지. |
| Source/Schedule/Target/Permission forms | `.source-flow-fields`, `.schedule-config-form-grid`, `.target-config-form-grid`, `.permission-config-form-grid` | `부분 해결` | shadcn `Field`, `Input`, `NativeSelect`, `InputGroup`, `Checkbox` | #418에서 실제 ETL flow의 대표 입력/선택 control을 primitive로 교체했다. `.field` grid와 `FormFieldGroup` wrapper는 기존 CSS cleanup 전까지 유지한다. |
| Review edit action | `etl-review-edit` | `구현 후보` | `SectionAction` | `ReviewEditButton` wrapper로 반복 제거. |
| Target tags/partition option | `target-chip-grid`, `target-chip`, `target-partition-option` | `부분 해결` | `TagList`, `Chip`, `CheckableOption` | #385에서 target tag row와 clickable chip을 공통 컴포넌트로 전환. #414에서 radio 성격의 partition option shell을 `CheckableOption`으로 전환. partition grid density CSS는 유지. |
| Validation rows | `etl-review-validation`, `permission-config-validation` | `부분 해결` | `ValidationList` | #385에서 Permission governance check와 Review validation rows를 `ValidationList`로 전환. schedule validation rows는 유지. |
| Review key-value rows | `etl-review-kv` | `부분 해결` | `KeyValueList` | #385에서 Review basic/destination/permission summary를 `KeyValueList`로 전환. |
| Bottom command bar | `schema-bottom-bar`, `hegun-rule-bottom-bar` | `부분 해결` | `CommandBar` | #378에서 `CommandBar` wrapper로 전환. layout/density CSS는 route QA 전까지 유지. |

## B02-B04 Dashboard/B Seed Gap

| 위치 | 현재 패턴 | 상태 | 필요한 컴포넌트 후보 | 이번 작업 기준 처리 |
| --- | --- | --- | --- | --- |
| SQL/Catalog/Dashboard preview | SQL result preview, Catalog schema preview, Dashboard widget preview | `부분 해결` | `PreviewPanel`, `ResultPanel` | #389에서 SQL result card, Dashboard builder preview, dashboard runtime table widget shell에 1차 적용. Catalog schema preview와 ETL final preview는 후속 판단. |
| Dashboard list toolbar | search input + owner/tag/sort/action cluster | `해결됨` | `FilterToolbar` | #369에서 toolbar body/search/actions/menu/divider shell을 공통 컴포넌트로 이동. menu option과 filter button의 화면 고유 스타일은 유지. |
| Dashboard table action slot | row action icon button column | `구현 후보` | `RowActionCell` | B04에서 DataTable `renderRowActions`를 사용함. 반복되면 row action sizing/label/disabled 패턴을 분리할 수 있음. |
| Dashboard list pagination/delete dialog | list footer pagination + destructive confirm dialog | `부분 해결` | `PaginationBar`, `DialogShell` | #378에서 DashboardPagination과 dashboard/delete widget delete 확인 dialog를 공통 shell로 전환. table density와 builder/chart modal은 유지. |
| Dashboard runtime topbar | title edit + publish/draft/share/refresh actions | `부분 해결` | `RuntimeTopbar`, `ActionGroup` | #385에서 runtime edit toolbar는 `ActionGroup`으로 전환. title/publish/share topbar와 dirty state shell은 화면 전용으로 유지. |
| Dashboard widget frame | selected/editable frame + delete action + widget chrome | `설계 필요` | `WidgetShell` | B04에서 delete action만 `Button`으로 전환. frame chrome, selected state, resize/grid integration은 유지. |
| Dashboard table widget | widget 내부 DataTable viewport | `부분 해결` | `EmbeddedDataTablePanel` | B04에서 `DataTable`로 전환됨. widget 내부 padding, min width, compact density를 runtime CSS에 남긴 것은 기능 미완료가 아니라 후속 CSS 축소 후보다. |
| Dashboard widget config panel | dense chart/table settings form | `부분 해결` | `SettingsPanel`, `FormFieldGroup`, `NativeSelectField` | #389에서 config panel shell과 기본 field를 적용했고, #391에서 chart/table select와 number field를 `WidgetSelectField`/`FormFieldGroup` 기준으로 확장. checkbox와 color picker layout은 유지. |
| Dashboard widget type picker | icon-only chart type grid + tooltip | `부분 해결` | `IconOptionGrid` | #389에서 `IconOptionGrid`로 전환. 기존 tooltip positioning과 selected state className은 유지. |
| Dashboard color controls | color slot list + swatches + custom color picker | `보류` | `ColorPalettePicker` | `react-colorful`과 custom color state가 묶여 있어 후속 component 설계 전까지 유지. |
| Dashboard dataset tree | arborist tree row + hover card + type icon | `부분 해결` | `TreePanel`, `TreeHoverCard`, `TreeRow` | #401에서 loading/error/empty/body wrapper를 `TreePanel`로 전환. #416에서 hover card shell을 `TreeHoverCard`로 전환. #421에서 arborist row button을 `TreeRow`로 연결하고 MUI Tooltip을 shadcn Tooltip으로 교체. arborist engine과 runtime density CSS는 유지. |
| Catalog lineage / graph preview | React Flow node/edge canvas | `보류` | `FlowCanvasPanel` | graph library class와 묶여 있어 Catalog QA 전 공통화하지 않음. |
| SQL editor/action surface | editor toolbar + execution status + result shell | `부분 해결` | `QueryActionBar`, `ResultPanel`, `PaginationBar`, `DialogShell`, `ActionGroup` | #378에서 context pagination과 materialize dialog shell을 공통화했고, #385에서 SQL AI/editor/result button rows를 `ActionGroup`으로 전환. execution status와 result shell은 후속 `ResultPanel` 후보로 유지. |

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
- `PreviewPanel`
- `ResultPanel`
- `SettingsPanel`
- `FormFieldGroup`
- `NativeSelectField`
- `IconOptionGrid`
- `DetailTableSection`

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
| 2026-07-09 | 코드 스윕으로 버튼/모달/페이지네이션/트리/프리뷰/요약/칩/form/선택형 카드 반복 패턴을 확인하고 component 확장 기록 방식과 권장 순서를 추가. |
| 2026-07-09 | #375에서 `FilterToolbarInput`, `FilterToolbarFieldGroup`, `FilterToolbarCheckboxGroup`, `FilterToolbarCheckbox`를 추가하고 Catalog/SQL 검색 UI에 적용. 반복되지 않아도 shadcn primitive가 있으면 표준화 후보로 본다는 원칙을 추가. |
| 2026-07-09 | #384에서 Catalog/SQL/Dashboard list 상단 헤더를 `PageHeader` 기준으로 맞추고, page masthead 공통화 상태를 `부분 해결`로 기록. |
| 2026-07-09 | #385에서 `ActionGroup`, `Chip`, `TagList`, `StatusBadge`, `KeyValueList`, `ValidationList`를 추가하고 Jobs/ETL/Dashboard/SQL/Creation 대표 사용처에 적용. Catalog와 preview/result shell은 후속 후보로 유지. |
| 2026-07-09 | #387에서 `PreviewPanel`, `ResultPanel`, `SettingsPanel`, `FormFieldGroup`, `NativeSelectField`, `SegmentedTabs`, `SelectableCard`, `IconOptionGrid`, `DetailTableSection` 후보의 적용 순서와 보류 기준을 문서화. |
| 2026-07-09 | #389에서 UI shell 컴포넌트 8종을 추가하고 SQL/Dashboard/ETL/Ingest 대표 사용처에 1차 적용. CSS 삭제는 route QA 후 후속 cleanup으로 분리. |
| 2026-07-09 | #391에서 Form/Settings 계열 적용 범위를 확장. WidgetConfigPanel chart/table select, S3/DB picker toolbar, ETL source/schedule field, SQL materialize field를 공통 field component로 전환하고 보류 범위를 기록. |
| 2026-07-09 | #393에서 Selection UI 계열을 추가 정리. Jobs 보기 전환/상세 탭과 ETL rule category tabs를 `SegmentedTabs`로 전환하고 checkbox/radio 성격의 card 후보는 보류로 기록. |
| 2026-07-09 | #395에서 `DetailTableSection` footer slot을 추가하고 Jobs run history table shell에 적용. ETL/SchemaTransformEditor detail table은 후속 설계 대상으로 유지. |
| 2026-07-09 | #400에서 shadcn replacement inventory를 추가하고, shadcn primitive로 대체 가능한 wrapper와 유지할 AskLake composition component를 구분하는 기준을 연결. |
| 2026-07-09 | #401에서 `TreePanel`을 추가하고 S3 picker, ETL SourceAssetTree, SQL dataset tree, Dashboard dataset sidebar의 wrapper/state shell에 적용. row/hover card와 tree library 통합은 후속 gap으로 유지. |
| 2026-07-09 | #410에서 Catalog schema/lineage modal, Ingest DAG run detail modal, Dashboard chart expanded modal, ETL TransformFunctionModal shell을 `DialogShell` 기준으로 전환. menu/popover, DAG graph/canvas, quick function chip/form layout은 후속 gap으로 유지. |
| 2026-07-09 | #414에서 `CheckableOption`을 추가하고 ETL rule builder/target/permission form과 option card wrapper를 공통화. 기존 CSS selector는 route QA 전까지 유지. |
| 2026-07-09 | #416에서 `TreeHoverCard`를 추가하고 SQL dataset tree hover card와 Dashboard dataset sidebar hover card shell을 공통화. tree row renderer와 외부 tree library 통합은 후속으로 유지. |
| 2026-07-09 | #421에서 `TreeView`, `TreeGroup`, `TreeRow`, `TreeStaticRow`를 추가하고 S3/ETL JSON/ETL asset/SQL/Dashboard tree row shell을 표준화. MUI TreeView/Tooltip과 MUI/Emotion package 의존을 제거. |

## #410 Modal Shell 꼬리 정리 반영

`DialogShell` 적용 범위를 한 번 더 넓혔다. 이번 PR은 3단계 꼬리 정리 stack의 첫 번째이며, modal/backdrop 계열만 다룬다.

| 영역 | 이번에 공통화한 UI | 사용한 공통 컴포넌트 | 남은 gap |
| --- | --- | --- | --- |
| Catalog | schema 전체 보기 modal, lineage modal | `DialogShell` | sort menu, result card 내부 chip/status, React Flow lineage canvas는 별도 후보로 유지 |
| Ingest | DAG run detail modal shell | `DialogShell` | DAG graph/canvas, node row, run selector button은 runtime/special UI 후보로 유지 |
| Dashboard | chart expanded modal shell | `DialogShell` | list/custom menu, chart body density, builder/runtime 특수 상태는 별도 후보로 유지 |
| ETL | `TransformFunctionModal` fixed backdrop/card shell | `DialogShell`, `ActionGroup`, `Button` | quick function chip, AI toggle button, expression field layout은 form/option cleanup 후보로 유지 |

이번 반영 뒤 `custom modal/dialog` gap은 `부분 해결` 상태를 유지한다. 직접 만든 backdrop wrapper는 줄었지만, menu/popover와 graph/runtime 특수 UI는 다음 stack PR에서 따로 다룬다.

## #414 Form/Option 꼬리 정리 반영

Form/Option 계열은 input/select wrapper와 checkbox/radio option shell을 분리해서 처리했다. `SelectableCard`는 button 기반이라 form 의미가 있는 option에는 쓰지 않고, label+input 기반 `CheckableOption`을 추가했다.

| 영역 | 이번에 공통화한 UI | 사용한 공통 컴포넌트 | 남은 gap |
| --- | --- | --- | --- |
| ETL Rule builder | preset/column/operation/output/option/error field wrapper | `FormFieldGroup`, `NativeSelectField` | builder panel header/collapse shell은 화면 전용으로 유지 |
| Target config | basic/destination input label wrapper | `FormFieldGroup` | format dropdown menu와 S3/DB picker 내부 body는 별도 후보로 유지 |
| Target partition | radio option card shell | `CheckableOption` | partition grid density와 disabled/active CSS는 route QA 전까지 유지 |
| Permission policy | select/input field wrapper | `FormFieldGroup`, `NativeSelectField` | permission card shell은 유지 |
| Permission role grants | checkbox option card shell | `CheckableOption` | access chip row density CSS는 유지 |

## #416 Tree Hover Card 꼬리 정리 반영

Tree 계열은 wrapper/state shell 다음으로 hover card shell만 공통화했다. #416 시점에는 SQL DOM tree와 Dashboard `react-arborist` 구현 차이 때문에 row renderer를 합치지 않았고, #421에서 row shell을 `TreeRow` 기준으로 1차 표준화했다.

| 영역 | 이번에 공통화한 UI | 사용한 공통 컴포넌트 | 남은 gap |
| --- | --- | --- | --- |
| SQL dataset tree | table/column hover card shell | `TreeHoverCard` | fixed position 계산과 row hover event는 SQL 전용으로 유지 |
| Dashboard dataset sidebar | dataset/group/column tooltip card shell | `TreeHoverCard` | MUI Tooltip wrapper는 #421에서 shadcn Tooltip으로 교체. react-arborist engine은 유지 |
| Tree UI 전체 | icon/title/subtitle/detail rows/description 구조 | `TreeHoverCard` | S3 picker, ETL source tree, JSON sample tree row shell은 #421에서 `TreeRow` 기준으로 전환 |

## #417 Shadcn Primitive Foundation 반영

이번 PR은 새 화면 적용보다 foundation 추가가 목적이다. 따라서 gap 상태는 "공통 컴포넌트가 없음"에서 "공통 primitive는 생겼고, 화면별 적용이 남음"으로 바뀐다.

새로 해결된 기반 gap:

- Form 기본 단위: `Label`, `Field`, `InputGroup`, `NativeSelect`, `Textarea`
- 선택/boolean control: `Checkbox`, `RadioGroup`, `Switch`, `Tabs`, `ToggleGroup`
- 메뉴/보조 패널: `DropdownMenu`, `Tooltip`, `Popover`, `AlertDialog`, `Sheet`
- 상태/레이아웃 보조: `Separator`, `Skeleton`, `ScrollArea`, `Pagination`, `Empty`

아직 남은 component gap:

- 화면 적용 gap: ETL/SQL/Dashboard/S3/DB picker의 raw input/select/textarea/checkbox/radio를 새 primitive로 교체해야 한다.
- composition gap: `FormFieldGroup`, `NativeSelectField`, `PaginationBar`, `DialogShell`, `EmptyState`, `SegmentedTabs`는 후속 PR에서 새 primitive 기반으로 축소하거나 유지 범위를 다시 판단한다.
- 고유 UI gap: `WidgetShell`, `ColorPalettePicker`, `SplitPanel`, dashboard grid/widget frame은 여전히 별도 설계가 필요하다. tree row renderer는 #421에서 1차 표준화했다.

이번 PR에서 직접 적용한 범위:

- `NativeSelectField` 내부 select를 새 `NativeSelect` primitive로 연결했다.
- 그 외 화면 사용처는 충돌을 줄이기 위해 변경하지 않았다.

## #421 Tree 표준화 및 MUI 제거 반영

Tree 계열은 wrapper/state shell과 hover card shell 다음으로 row/group shell을 공통화했다. 이번 PR은 backend/API나 DAG/React Flow를 건드리지 않고, S3/ETL/SQL/Dashboard tree UI의 외부 MUI 의존을 제거하는 범위다.

| 영역 | 이번에 공통화한 UI | 사용한 공통 컴포넌트 | 남은 gap |
| --- | --- | --- | --- |
| S3 path picker | bucket prefix tree row, loading/retry/empty/more row | `TreePanel`, `TreeView`, `TreeGroup`, `TreeRow` | picker toolbar/search/body density는 기존 CSS 유지 |
| ETL SourceAssetTree | folder/file row, nested group, selected row | `TreePanel`, `TreeView`, `TreeGroup`, `TreeRow` | folder lazy loading 상태와 source list domain 로직은 화면 전용 유지 |
| ETL SourceJsonSampleTree | JSON object/array/primitive row와 nested group | `TreeView`, `TreeGroup`, `TreeRow` | SchemaTransformEditor adapter tree는 별도 QA 전 유지 |
| SQL dataset tree | branch label, table row, column row | `TreePanel`, `TreeView`, `TreeGroup`, `TreeStaticRow`, `TreeRow`, `TreeHoverCard` | fixed hover position과 table add action은 SQL 전용 유지 |
| Dashboard dataset sidebar | arborist row button, tooltip wrapper | `TreePanel`, `TreeRow`, `TreeHoverCard`, shadcn `Tooltip` | `react-arborist` engine, row height, runtime density CSS는 유지 |

의존성 정리:

- `@mui/x-tree-view`, `@mui/material`, `@mui/system`, `@emotion/react`, `@emotion/styled` 제거.
- tree row shell은 해결됐지만 `WidgetShell`, `ColorPalettePicker`, `SplitPanel`, dashboard grid/widget frame은 아직 별도 component gap으로 남긴다.
