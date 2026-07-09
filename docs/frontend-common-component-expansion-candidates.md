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

## 다음 단계 후보

| 후보 컴포넌트 | 바꿀 수 있는 UI | 대표 사용처 | 판단 |
| --- | --- | --- | --- |
| `PreviewPanel` | preview header + body + empty/loading/action shell | `frontend/src/pages/sql/SqlAnalysisPage.tsx`, `frontend/src/pages/dashboard/DashboardPage.tsx`, `frontend/src/pages/etl/EtlPages.tsx` | 표는 `DataTable`로 일부 해결됐고, 주변 preview shell이 남아 있다. |
| `ResultPanel` | 실행 결과, row count, status, CTA shell | `frontend/src/pages/sql/SqlAnalysisPage.tsx`, `frontend/src/pages/sql/SqlPreviewTable.tsx`, `frontend/src/pages/dashboard/runtime/WidgetRenderer.tsx` | SQL/result/widget table 주변 구조를 정리할 수 있다. |
| `SettingsPanel` | 설정 panel header/body/footer | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/sql/SqlAnalysisPage.tsx` | form 상태가 많아 props 설계가 먼저 필요하다. |
| `FormFieldGroup` | label + control + hint/error layout | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/components/s3/S3PathField.tsx`, `frontend/src/components/target/DatabaseField.tsx` | input/select/textarea 주변 CSS를 줄일 수 있다. |
| `NativeSelectField` | native select + label + tone | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`, `frontend/src/pages/etl/EtlPages.tsx` | `Select` primitive와 native select 사용처를 정리할 기준이 필요하다. |
| `SegmentedTabs` | tablist 형태의 단계/상세 전환 | `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/dashboard/runtime/DashboardPageTabs.tsx` | 단순 tab부터 적용하고 rename/edit 상태가 있는 탭은 보류한다. |
| `SelectableCard` | 선택 가능한 card option | `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/etl/schedule/SchedulePage.tsx`, `frontend/src/pages/dashboard/DashboardPage.tsx` | source connector, schedule mode, widget type card에 반복된다. |
| `IconOptionGrid` | icon-only option grid + selected state | `frontend/src/pages/dashboard/DashboardPage.tsx`, `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | dashboard chart/widget type 선택 UI부터 적용 가능하다. |
| `DetailTableSection` | 상세 화면의 작은 table + title + empty state | `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/components/etl/SchemaTransformEditor.jsx` | 단순 `DataTable` 적용보다 section shell을 같이 잡아야 한다. |

## 나중에 분리하는 후보

| 후보 컴포넌트 | 바꿀 수 있는 UI | 대표 사용처 | 보류 이유 |
| --- | --- | --- | --- |
| `TreePanel` | dataset/source/path tree shell | `frontend/src/pages/sql/SqlDatasetRow.tsx`, `frontend/src/pages/dashboard/runtime/DatasetSidebar.tsx`, `frontend/src/pages/etl/SourceAssetTree.tsx`, `frontend/src/components/s3/S3PathField.tsx` | custom tree, MUI TreeView, react-arborist가 섞여 있어 한 번에 묶기 어렵다. |
| `TreeHoverCard` | tree row hover detail card | `frontend/src/pages/sql/SqlDatasetRow.tsx`, `frontend/src/pages/dashboard/runtime/DatasetSidebar.tsx` | hover 위치 계산과 tree library 상태를 먼저 맞춰야 한다. |
| `WidgetShell` | dashboard runtime widget frame | `frontend/src/pages/dashboard/runtime/WidgetFrame.tsx`, `frontend/src/pages/dashboard/runtime/WidgetRenderer.tsx` | grid, resize, selected/editing state와 강하게 묶여 있다. |
| `RuntimeTopbar` | runtime title/edit/share/publish topbar | `frontend/src/pages/dashboard/runtime/DashboardTopBar.tsx`, `frontend/src/pages/dashboard/runtime/DashboardRuntimeShell.tsx` | dashboard runtime 전용 상태가 많아 별도 설계가 필요하다. |
| `ColorPalettePicker` | color slot/swatches/custom color picker | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | `react-colorful`과 custom color state가 묶여 있어 마지막 단계가 안전하다. |

## 추천 PR 순서

1. `PaginationBar`
2. `DialogShell` + `PickerDialog`
3. `Chip` + `TagList` + `StatusBadge`
4. `KeyValueList` + `ValidationList`
5. `PreviewPanel` + `ResultPanel`
6. `CommandBar` + `ActionGroup`
7. `SettingsPanel` + `FormFieldGroup`
8. `SegmentedTabs` + `SelectableCard`
9. `TreePanel`, `WidgetShell`, `ColorPalettePicker`

첫 PR은 `PaginationBar`가 가장 작다. Catalog와 검색바를 제외해도 SQL, Dashboard, Ingest에 반복 사용처가 있고, CSS cleanup 문서에 유지/교체 판단을 남기기 쉽다.
