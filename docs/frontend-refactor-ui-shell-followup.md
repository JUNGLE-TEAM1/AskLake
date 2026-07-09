# Frontend UI Shell Follow-up

## 목적

이 문서는 #387에서 정리한 "나중에 분리하는 후보"와 #389, #393에서 실제 적용한 frontend UI shell component 범위를 추적하는 작업 문서다.

`docs/frontend-component-gap-inventory.md`는 전체 gap 추적 문서이고, `docs/frontend-css-cleanup-inventory.md`는 CSS 유지/교체 판단 문서다. 이 문서는 두 문서에서 #385 이후 남은 UI shell 후보만 뽑아 적용 순서와 보류 기준을 좁힌다.

## #387 작업 기준

- 새 컴포넌트 구현은 하지 않는다.
- CSS 파일 삭제는 하지 않는다.
- 이미 `DataTable`, `Panel`, `PanelHeader`, `FilterToolbar`, `PaginationBar`, `DialogShell`, `PickerDialog`, `CommandBar`, `ActionGroup`, `Chip`, `TagList`, `StatusBadge`, `KeyValueList`, `ValidationList`로 처리된 범위는 완료 또는 부분 해결로 둔다.
- 표 자체가 아니라 표 주변 shell, form label/control shell, 선택형 option shell처럼 아직 화면별 CSS가 남는 구조를 후속 후보로 본다.

## #389 적용 결과

| 컴포넌트 | 1차 적용 파일 | 남은 범위 |
| --- | --- | --- |
| `PreviewPanel` | `frontend/src/pages/dashboard/DashboardPage.tsx` | ETL final preview, Catalog preview shell |
| `ResultPanel` | `frontend/src/pages/sql/SqlAnalysisPage.tsx`, `frontend/src/pages/dashboard/runtime/WidgetRenderer.tsx` | SQL materialize/settings form shell, 추가 result CTA |
| `SettingsPanel` | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | ETL rule builder, SQL option form |
| `FormFieldGroup` | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | ETL/S3/DB picker form field 반복 |
| `NativeSelectField` | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | 나머지 chart-specific native select 반복 |
| `SegmentedTabs` | `frontend/src/pages/dashboard/DashboardPage.tsx`, `frontend/src/pages/etl/EtlPages.tsx` | rename/edit 상태가 있는 dashboard runtime tabs |
| `SelectableCard` | `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/etl/schedule/SchedulePage.tsx`, `frontend/src/pages/dashboard/DashboardPage.tsx` | target chip grid와 runtime-specific card |
| `IconOptionGrid` | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | 다른 icon-only option grid가 생기면 재사용 |
| `DetailTableSection` | `frontend/src/pages/ingest/JobsPages.tsx` | ETL detail, SchemaTransformEditor detail table |

## #393 적용 결과

| 컴포넌트 | 추가 적용 파일 | 남은 범위 |
| --- | --- | --- |
| `SegmentedTabs` | `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/etl/EtlPages.tsx` | Dashboard runtime page tabs는 rename/delete/edit 상태가 있어 보류 |
| `SelectableCard` | 추가 신규 사용처 없음 | ETL permission role, partition option은 checkbox/radio 의미가 있어 보류 |

## 우선 구현 후보

| 순서 | 후보 | 바꿀 수 있는 UI | 대표 사용처 | 이번 판단 |
| ---: | --- | --- | --- | --- |
| 1 | `PreviewPanel` | preview header + body + empty/loading/action shell | `frontend/src/pages/sql/SqlAnalysisPage.tsx`, `frontend/src/pages/dashboard/DashboardPage.tsx`, `frontend/src/pages/etl/EtlPages.tsx` | `DataTable` 이후 남은 주변 shell이라 다음 PR 후보로 가장 작다. |
| 2 | `ResultPanel` | 실행 결과, row count, status, CTA shell | `frontend/src/pages/sql/SqlAnalysisPage.tsx`, `frontend/src/pages/sql/SqlPreviewTable.tsx`, `frontend/src/pages/dashboard/runtime/WidgetRenderer.tsx` | SQL result와 dashboard table widget 주변 구조를 같이 줄일 수 있다. |
| 3 | `FormFieldGroup` | label + control + hint/error layout | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/components/s3/S3PathField.tsx`, `frontend/src/components/target/DatabaseField.tsx` | input/select/textarea primitive 적용 뒤에도 남는 form CSS를 줄이는 선행 후보다. |
| 4 | `NativeSelectField` | native select + label + tone | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`, `frontend/src/pages/etl/EtlPages.tsx` | shadcn `Select`로 바꾸기 어려운 native select를 별도 기준으로 다룬다. |
| 5 | `SettingsPanel` | 설정 panel header/body/footer | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/sql/SqlAnalysisPage.tsx` | form 상태가 많아 `FormFieldGroup` 적용 뒤 panel shell을 잡는 편이 안전하다. |
| 6 | `SegmentedTabs` | tablist 형태의 단계/상세 전환 | `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/dashboard/runtime/DashboardPageTabs.tsx` | 단순 tab부터 적용하고 rename/edit 상태가 있는 탭은 보류한다. |
| 7 | `SelectableCard` | 선택 가능한 card option | `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/pages/etl/schedule/SchedulePage.tsx`, `frontend/src/pages/dashboard/DashboardPage.tsx` | source connector, schedule mode, widget type card에 반복되지만 icon/description/check 상태 설계가 필요하다. |
| 8 | `IconOptionGrid` | icon-only option grid + selected state | `frontend/src/pages/dashboard/DashboardPage.tsx`, `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | dashboard chart/widget type 선택 UI부터 적용 가능하다. tooltip과 focus 상태를 같이 본다. |
| 9 | `DetailTableSection` | 상세 화면의 작은 table + title + empty state | `frontend/src/pages/ingest/JobsPages.tsx`, `frontend/src/pages/etl/EtlPages.tsx`, `frontend/src/components/etl/SchemaTransformEditor.jsx` | 단순 `DataTable` 적용보다 section title/action/empty shell을 같이 잡아야 한다. |

## 보류 후보

| 후보 | 대표 사용처 | 보류 이유 |
| --- | --- | --- |
| `TreePanel` | `frontend/src/pages/sql/SqlDatasetRow.tsx`, `frontend/src/pages/dashboard/runtime/DatasetSidebar.tsx`, `frontend/src/pages/etl/SourceAssetTree.tsx`, `frontend/src/components/s3/S3PathField.tsx` | custom tree, MUI TreeView, react-arborist가 섞여 있어 row shell부터 별도 설계가 필요하다. |
| `TreeHoverCard` | `frontend/src/pages/sql/SqlDatasetRow.tsx`, `frontend/src/pages/dashboard/runtime/DatasetSidebar.tsx` | hover 위치 계산과 tree library 상태가 먼저 맞아야 한다. |
| `WidgetShell` | `frontend/src/pages/dashboard/runtime/WidgetFrame.tsx`, `frontend/src/pages/dashboard/runtime/WidgetRenderer.tsx` | grid, resize, selected/editing state와 강하게 묶여 있다. |
| `RuntimeTopbar` | `frontend/src/pages/dashboard/runtime/DashboardTopBar.tsx`, `frontend/src/pages/dashboard/runtime/DashboardRuntimeShell.tsx` | dashboard runtime 전용 publish/share/dirty/title edit 상태가 많다. |
| `ColorPalettePicker` | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | `react-colorful`과 custom color state가 묶여 있어 마지막 단계가 안전하다. |

## CSS 기록 연결

| 후보 | CSS cleanup 문서에서 볼 판단 |
| --- | --- |
| `PreviewPanel` / `ResultPanel` | `DataTable` 이후에도 남은 header, empty/loading, CTA, overflow shell selector를 `교체 후보` 또는 `부분 정리됨`으로 둔다. |
| `SettingsPanel` / `FormFieldGroup` / `NativeSelectField` | label, grid, hint, error, textarea, checkbox, native select tone selector를 유지 사유와 함께 적는다. |
| `SegmentedTabs` / `SelectableCard` / `IconOptionGrid` | selected, disabled, focus, tooltip, check indicator selector를 같이 추적한다. |
| `DetailTableSection` | 작은 table의 title/action/empty state와 overflow wrapper를 table 자체와 분리해 추적한다. |
| `TreePanel` / `WidgetShell` / `ColorPalettePicker` | 외부 라이브러리 DOM과 runtime state가 묶인 selector는 route QA 전 `보류`로 둔다. |

## 후속 PR 권장 단위

1. ETL final preview와 Catalog preview shell에 `PreviewPanel` 추가 적용
2. ETL/S3/DB picker form에 `FormFieldGroup` / `NativeSelectField` 추가 적용
3. 상세 화면 table section에 `DetailTableSection` 추가 적용
4. SQL materialize form과 ETL rule builder에 `SettingsPanel` 추가 적용
5. route QA 후 `dashboard.css`, `dashboard-runtime.css`, `etl.css`, `ingest.css`, `sql.css`의 wrapper selector 축소
6. 상태 결합이 큰 `TreePanel`, `WidgetShell`, `ColorPalettePicker` 별도 설계

각 PR은 구현 파일 변경과 함께 `docs/frontend-component-gap-inventory.md`와 `docs/frontend-css-cleanup-inventory.md`의 상태를 같이 갱신한다.
