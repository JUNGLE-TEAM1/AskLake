# Frontend Common Component Expansion Candidates

## 목적

이 문서는 AskLake frontend에서 추가로 공통 컴포넌트로 확장할 수 있는 후보를 빠르게 고르기 위한 목록이다.

`docs/frontend-component-gap-inventory.md`가 전체 gap 추적 문서라면, 이 문서는 다음 component 확장 PR에서 바로 후보를 고를 수 있도록 범위를 좁힌 작업용 문서다.

## 제외 범위

이번 목록에서는 아래 항목을 제외한다.

- 검색바, 검색 입력, filter/search toolbar 계열
- Catalog 전용 UI와 Catalog 전용 CSS
- 이미 `DataTable`, `Panel`, `PanelHeader`, `MetricCard`, `FilterToolbar`로 정리된 완료 범위

Catalog가 아닌 화면에서도 같이 쓰일 수 있는 컴포넌트 후보는 포함하되, 적용 예시에서는 Catalog 사용처를 제외한다.

단, 이 제외 범위는 "다음 AskLake 조합 컴포넌트 후보"를 고르기 위한 제한이다. 반복되지 않는 화면이라도 shadcn primitive가 제공하는 기본 UI(`Textarea`, `Checkbox`, `Tabs`, `Tooltip`, `DropdownMenu`, `Select`, `Popover`, `Command`, `AlertDialog` 등)는 별도 표준화 작업에서 교체 후보로 본다.

## 바로 확장하기 좋은 후보

| 후보 컴포넌트 | 바꿀 수 있는 UI | 대표 사용처 | 판단 |
| --- | --- | --- | --- |
| `PaginationBar` | DataTable 밖 목록/페이지 footer | `frontend/src/pages/sql/SqlAnalysisPage.tsx`, `frontend/src/pages/dashboard/components/DashboardPagination.tsx`, `frontend/src/pages/ingest/JobsPages.tsx` | 화면 의존이 낮아 첫 확장 PR 후보로 적합하다. |
| `DialogShell` | backdrop + dialog + header + footer | `frontend/src/pages/sql/SqlAnalysisPage.tsx`, `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/dashboard/DashboardParts.tsx`, `frontend/src/pages/dashboard/components/DashboardDeleteConfirmDialog.tsx` | 기존 `Dialog` primitive가 있어 custom modal을 줄이기 쉽다. |
| `PickerDialog` | 선택용 modal shell + loading/error/empty state | `frontend/src/components/s3/S3PathField.tsx`, `frontend/src/components/target/DatabaseField.tsx` | S3/DB picker 구조가 비슷해서 먼저 묶기 좋다. |
| `CommandBar` | 하단 고정/반고정 action bar | `frontend/src/components/creation/CreationFlow.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/dashboard/runtime/DashboardTopBar.tsx` | 다음/이전/저장/실행 같은 command 묶음을 일관되게 만들 수 있다. |
| `ActionGroup` | header/action row의 버튼 묶음 | `frontend/src/pages/sql/SqlAnalysisPage.tsx`, `frontend/src/pages/dashboard/DashboardParts.tsx`, `frontend/src/pages/dashboard/runtime/DashboardRuntimeView.tsx`, `frontend/src/pages/etl/EtlPages.tsx` | 버튼 자체보다 간격, 정렬, wrap 규칙이 반복된다. |
| `Chip` | 단일 chip/pill | `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/dashboard/components/DashboardTable.tsx` | `Badge`보다 클릭/선택/compact 상태를 다루기 좋다. |
| `TagList` | 여러 chip을 묶은 행/grid | `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/dashboard/components/DashboardTable.tsx`, `frontend/src/pages/ingest/JobsPages.tsx` | tag/chip row CSS를 줄일 수 있다. |
| `StatusBadge` | 상태값별 label/tone badge | `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/dashboard/DashboardLandingPage.tsx`, `frontend/src/pages/dashboard/components/DashboardTable.tsx` | status meta와 badge variant 매핑을 공통화할 수 있다. |
| `KeyValueList` | label/value 요약 목록 | `frontend/src/components/creation/CreationFlow.tsx`, `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/etl/EtlPages.tsx` | review/detail summary에서 반복된다. |
| `ValidationList` | 검증 항목 + 상태 + 설명 목록 | `frontend/src/components/creation/CreationFlow.tsx`, `frontend/src/pages/etl/EtlPages.tsx` | 검증 결과 UI를 화면별 class 대신 공통 패턴으로 묶을 수 있다. |

## #385 처리 결과

- `ActionGroup`: SQL AI/editor/result actions, Dashboard list/workspace/runtime toolbar, Jobs card/detail actions, ETL rule action footer에 1차 적용.
- `Chip` / `TagList` / `StatusBadge`: Jobs status/owner/tag, ETL target tag, Dashboard row tags/status, Dashboard list 상태 meta에 1차 적용.
- `KeyValueList` / `ValidationList`: Creation summary, Jobs detail metadata, ETL Permission/Review summary와 validation rows에 1차 적용.
- 남은 사용처: Catalog tag/status, 일부 ETL data chip, Catalog/Dashboard metadata, preview/result shell은 `docs/frontend-component-gap-inventory.md`에서 후속 후보로 유지한다.

## #387 문서화 기준

이번 문서는 새 컴포넌트를 바로 구현하지 않고, #385 이후 남은 shell 후보를 다음 component 확장 PR에서 바로 고를 수 있게 좁힌다.

- `PreviewPanel` / `ResultPanel`은 `DataTable`로 표 전환이 끝난 뒤 남은 header, empty/loading, CTA, overflow shell을 다룬다.
- `SettingsPanel` / `FormFieldGroup` / `NativeSelectField`는 input/select primitive 적용 뒤에도 남은 label, hint, error, footer, native select tone을 다룬다.
- `SegmentedTabs` / `SelectableCard` / `IconOptionGrid`는 선택 상태와 icon/description 조합이 있는 옵션 UI를 다룬다.
- `DetailTableSection`은 작은 detail table에 title, action, empty state가 붙는 section shell을 다룬다.
- Tree, widget frame, color picker처럼 라이브러리 DOM이나 runtime 상태와 강하게 묶인 후보는 "나중에 분리하는 후보"로 유지한다.

## #389 처리 결과

- `PreviewPanel` / `ResultPanel`: dashboard builder preview와 SQL result, dashboard runtime table widget 주변 shell에 1차 적용.
- `SettingsPanel` / `FormFieldGroup` / `NativeSelectField`: Dashboard runtime `WidgetConfigPanel`의 panel, title/description field, dataset native select에 1차 적용.
- `SegmentedTabs`: Dashboard 기간 필터와 ETL source stage tabs에 1차 적용. rename/edit 상태가 있는 `DashboardPageTabs`는 보류.
- `SelectableCard`: ETL source connector, ETL schedule run type, Dashboard builder widget type card에 1차 적용.
- `IconOptionGrid`: Dashboard runtime widget type icon grid에 1차 적용.
- `DetailTableSection`: Ingest Jobs detail의 schema/rule 작은 table section에 1차 적용.
- CSS selector 삭제는 하지 않고 기존 className을 공통 컴포넌트에 전달해 route QA 전까지 스타일 계약을 유지한다.

## #391 처리 결과

- `FormFieldGroup` / `NativeSelectField`: Dashboard runtime `WidgetConfigPanel`의 chart/table select와 number/HEX field, S3/DB picker toolbar field, ETL source/schedule field, SQL materialize field까지 추가 적용.
- `SettingsPanel`: 신규 panel 확대는 하지 않고 기존 Dashboard config shell을 유지했다. ETL/SQL의 큰 settings panel shell은 상태 결합이 커서 후속 판단으로 남긴다.
- ETL rule builder, target/permission form, color picker 세부 layout, route QA 전 CSS selector 삭제는 보류한다.

## #393 처리 결과

- `SegmentedTabs`: Jobs 목록 보기 전환, Jobs 상세 탭, ETL rule category tabs에 추가 적용.
- `SelectableCard`: ETL permission role과 partition option은 checkbox/radio 의미가 있어 이번 PR에서는 전환하지 않는다.
- Dashboard runtime page tabs는 rename/delete/edit 상태가 섞여 있어 계속 보류한다.

## #395 처리 결과

- `DetailTableSection`: Jobs run history table card와 horizontal scroll shell에 추가 적용.
- `DetailTableSection`에 optional `footer` slot을 추가해 table scroll 영역 밖에 `PaginationBar`를 유지할 수 있게 했다.
- `runs-table-card`, `runs-table-scroll`, `runs-pagination` className은 그대로 전달해 route QA 전까지 기존 density와 pagination 스타일을 유지한다.
- ETL detail table과 `SchemaTransformEditor` preview table은 편집/preview 상태가 강하게 묶여 있어 후속 설계 대상으로 남긴다.

## #401 처리 결과

- `TreePanel`: S3 picker, ETL `SourceAssetTree`, SQL dataset tree, Dashboard runtime dataset sidebar의 tree wrapper/state shell에 1차 적용.
- S3/ETL/SQL/Dashboard의 기존 tree className은 그대로 전달해 CSS 삭제 없이 route QA 전 스타일 계약을 유지한다.
- Dashboard dataset sidebar의 loading/error/empty/body 분기는 `TreePanel` state slot으로 모았다.
- MUI TreeView와 react-arborist 자체, row renderer, SQL/Dashboard hover card는 이번 PR에서 통합하지 않고 후속 후보로 유지한다.

## #403 처리 결과

- `WidgetShell`: Dashboard runtime `WidgetFrame`의 outer frame, header, body, AI working overlay shell에 1차 적용.
- `RuntimeTopbar`: Dashboard runtime `DashboardTopBar`의 title slot과 actions slot shell에 1차 적용.
- `ColorPalettePicker`: Dashboard runtime `WidgetConfigPanel`의 color slot list, swatch choice, custom color panel shell에 1차 적용.
- 기존 `.asklake-widget-frame*`, `.asklake-dashboard-topbar`, `.asklake-widget-color-*` className은 유지해 CSS 삭제 없이 route QA 전 스타일 계약을 보존한다.
- react-grid-layout resize/drag 상태, publish/share/rename 로직, `react-colorful` color 계산은 이번 PR에서 통합하지 않고 화면 전용 로직으로 유지한다.

## 다음 단계 후보

| 후보 컴포넌트 | 바꿀 수 있는 UI | 대표 사용처 | 판단 |
| --- | --- | --- | --- |
| `PreviewPanel` | preview header + body + empty/loading/action shell | `frontend/src/pages/dashboard/DashboardPage.tsx`, `frontend/src/pages/etl/EtlPages.tsx` | #389에서 builder preview에 1차 적용. ETL final preview와 Catalog preview는 후속 판단. |
| `ResultPanel` | 실행 결과, row count, status, CTA shell | `frontend/src/pages/sql/SqlAnalysisPage.tsx`, `frontend/src/pages/dashboard/runtime/WidgetRenderer.tsx` | #389에서 SQL result와 dashboard runtime table widget에 1차 적용. |
| `SettingsPanel` | 설정 panel header/body/footer | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/sql/SqlAnalysisPage.tsx` | #389에서 Dashboard widget config panel에 1차 적용. #391에서는 큰 panel 확대 없이 field 전환을 우선했다. |
| `FormFieldGroup` | label + control + hint/error layout | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/components/s3/S3PathField.tsx`, `frontend/src/components/target/DatabaseField.tsx`, `frontend/src/pages/sql/SqlAnalysisPage.tsx` | #391에서 WidgetConfigPanel chart/table field, S3/DB picker, ETL source/schedule, SQL materialize form에 추가 적용. ETL rule builder/target/permission form은 후속. |
| `NativeSelectField` | native select + label + tone | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/components/s3/S3PathField.tsx`, `frontend/src/pages/sql/SqlAnalysisPage.tsx` | #391에서 Dashboard chart/table select, S3 bucket select, ETL schedule select, SQL materialize layer select까지 추가 전환. |
| `SegmentedTabs` | tablist 형태의 단계/상세 전환 | `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/dashboard/DashboardPage.tsx`, `frontend/src/pages/dashboard/runtime/DashboardPageTabs.tsx` | #393에서 Jobs 보기 전환/상세 탭과 ETL rule category tabs까지 추가 적용. rename/edit 상태가 있는 탭은 보류한다. |
| `SelectableCard` | 선택 가능한 card option | `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/etl/schedule/SchedulePage.tsx`, `frontend/src/pages/dashboard/DashboardPage.tsx` | #389에서 source connector, schedule mode, dashboard widget type card에 1차 적용. checkbox/radio 의미가 있는 permission/partition option은 보류한다. |
| `IconOptionGrid` | icon-only option grid + selected state | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | #389에서 dashboard runtime widget type 선택 UI에 1차 적용. |
| `DetailTableSection` | 상세 화면의 작은 table + title + empty state | `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/components/etl/SchemaTransformEditor.jsx` | #389에서 Jobs detail schema/rule table, #395에서 Jobs run history table에 적용. ETL/SchemaTransformEditor는 후속. |
| `TreePanel` | dataset/source/path tree shell | `frontend/src/pages/sql/SqlDatasetRow.tsx`, `frontend/src/pages/dashboard/runtime/DatasetSidebar.tsx`, `frontend/src/pages/etl/SourceAssetTree.tsx`, `frontend/src/components/s3/S3PathField.tsx` | #401에서 wrapper/state shell에 1차 적용. row renderer/hover card/tree library 통합은 후속. |
| `WidgetShell` / `RuntimeTopbar` / `ColorPalettePicker` | dashboard runtime frame/topbar/color shell | `frontend/src/pages/dashboard/runtime/WidgetFrame.tsx`, `frontend/src/pages/dashboard/runtime/DashboardTopBar.tsx`, `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | #403에서 wrapper shell에 1차 적용. grid/color/publish 상태 로직은 후속 판단. |

## 나중에 분리하는 후보

| 후보 컴포넌트 | 바꿀 수 있는 UI | 대표 사용처 | 보류 이유 |
| --- | --- | --- | --- |
| `TreeHoverCard` | tree row hover detail card | `frontend/src/pages/sql/SqlDatasetRow.tsx`, `frontend/src/pages/dashboard/runtime/DatasetSidebar.tsx` | hover 위치 계산과 tree library 상태를 먼저 맞춰야 한다. |

## 추천 PR 순서

1. `PreviewPanel` + `ResultPanel`
2. `DetailTableSection`
3. `SettingsPanel` 큰 panel 확대
4. `SelectableCard` 순수 button card 사용처 재검토
5. `IconOptionGrid`
6. `TreeHoverCard`와 runtime 내부 상태 cleanup

#389에서 위 후보군은 대표 사용처에 1차 적용됐고, #391에서 Form/Settings 계열 field 전환, #393에서 Selection UI 계열 추가 전환, #395에서 Jobs detail table shell 추가 전환, #401에서 Tree wrapper/state shell 전환, #403에서 Dashboard runtime shell 전환을 진행했다. 다음 PR은 남은 settings shell cleanup과 ETL/SchemaTransformEditor table section 판단을 이어간다.
