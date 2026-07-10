# Frontend Shadcn Replacement Inventory

## 목적

이 문서는 AskLake frontend refactor/polish에서 `frontend/src/components/ui`를 shadcn primitive 기준으로 재정렬하기 위한 기준 문서다.

기존 refactor 작업은 화면별 CSS와 반복 markup을 줄이기 위해 AskLake 공통 컴포넌트를 빠르게 늘려 왔다. 다음 단계에서는 그 컴포넌트들을 모두 유지하는 것이 아니라, shadcn에 이미 검증된 primitive가 있는 UI는 shadcn-style local component로 옮기고, AskLake 서비스 고유 패턴만 composition component로 남긴다.

참고 기준:

- shadcn components: https://ui.shadcn.com/docs/components
- shadcn Data Table guide: https://ui.shadcn.com/docs/components/data-table
- ReUI Tree visual reference: https://reui.io/components/tree

## 운영 원칙

- shadcn은 런타임 패키지 import가 아니라 `frontend/src/components/ui`에 로컬 코드로 소유한다.
- 기존 `@/components`, `@/lib/utils` alias를 유지한다. `#components` package import 전환은 이번 refactor 범위가 아니다.
- shadcn primitive가 있는 raw HTML은 화면별 CSS를 늘리지 말고 primitive로 교체한다.
- AskLake composition component는 삭제 대상이 아니라 업무 화면 패턴을 묶는 상위 조립 단위다.
- composition component 내부도 가능한 한 `Button`, `Input`, `Dialog`, `Table`, `Checkbox`, `Tabs`, `Dropdown Menu` 같은 shadcn primitive로 구성한다.
- CSS selector 삭제는 primitive 교체와 route QA가 끝난 뒤 별도 cleanup PR에서만 진행한다.
- Tree 계열은 `react-arborist`를 엔진 표준으로 두고, ReUI의 File Explorer Tree 스타일을 참고한 shadcn-style row/label/icon UI를 입힌다.
- `TreePanel`은 tree 엔진이 아니라 header/body/footer/loading/error/empty를 감싸는 shell이다.
- Backend API, 데이터 계약, React Router 구조, 도메인 로직은 이 문서의 범위가 아니다.

## 분류 기준

| 분류 | 의미 | 후속 처리 |
| --- | --- | --- |
| `shadcn primitive 유지` | 현재 구현이 shadcn-style primitive 역할을 한다. | variant/API만 정리하며 계속 사용한다. |
| `shadcn primitive 추가 필요` | 공식 shadcn에 있지만 아직 로컬 `components/ui`에 없다. | foundation PR에서 추가하고 화면 교체는 후속 PR로 나눈다. |
| `AskLake composition 유지` | shadcn 1개 컴포넌트로 대체되지 않는 서비스 업무 패턴이다. | 내부를 shadcn primitive로 정리하고 props를 줄인다. |
| `shadcn으로 교체/흡수` | 임시 wrapper 성격이 강하거나 shadcn primitive 조합으로 표현 가능하다. | 후속 PR에서 deprecated 후보로 표시하고 점진적으로 제거한다. |

## 현재 컴포넌트 분류

### shadcn primitive 유지

| 컴포넌트 | 현재 판단 | 후속 메모 |
| --- | --- | --- |
| `Button` | 유지 | shadcn `Button` 계열로 계속 사용한다. `primary-button`, `secondary-button`, raw `<button>` 제거 기준점이다. |
| `Input` | 유지 | raw text input의 기본 대체 대상이다. 검색 input처럼 container와 충돌하는 경우 wrapper별 flat variant를 분리한다. |
| `Dialog` | 유지 | custom modal/backdrop의 기본 대체 대상이다. destructive confirm은 후속 `AlertDialog` 추가 후 분리한다. |
| `Select` | 유지 | Radix Select 기반이다. native select가 필요한 곳은 후속 `Native Select` primitive 추가 후 기준을 나눈다. |
| `Table` | 유지 | shadcn table visual primitive다. TanStack logic은 `DataTable`에서 유지한다. |
| `Badge` | 유지 | 단순 상태/라벨 pill의 기본 대체 대상이다. interactive chip은 `Badge` variant 또는 별도 composition으로 판단한다. |
| `Card` | 유지 | 단순 framed item의 기본 대체 대상이다. page section을 card로 감싸는 용도는 피한다. |

### shadcn primitive 추가 필요

| 추가할 primitive | 우선 사용처 | 메모 |
| --- | --- | --- |
| `Label` | ETL/SQL/Dashboard form label | `FormFieldGroup` 축소의 기반이다. |
| `Field` | label/control/hint/error 조합 | shadcn field 기준으로 form layout을 통일한다. |
| `Input Group` | 검색창, prefix/suffix icon input | `FilterToolbarInput`, Catalog/SQL 검색 UI의 내부 box 중복을 줄인다. |
| `Native Select` | browser native select 유지 영역 | `NativeSelectField` 흡수 대상이다. |
| `Checkbox` | filter, permission role, config toggle | raw `type="checkbox"` 제거 기준이다. |
| `Radio Group` | partition option, exclusive card selection | raw radio와 selectable card 기준을 나눈다. |
| `Switch` | on/off setting | dashboard/ETL 설정성 boolean에 적용한다. |
| `Tabs` | sidebar/tool tabs, detail tabs | `SegmentedTabs` 대체 후보의 기본값이다. |
| `Toggle Group` | segmented view switch, compact mode switch | 단순 선택 버튼 묶음에 적용한다. |
| `Dropdown Menu` | sort/filter/action menu | #420에서 Catalog sort menu에 1차 적용. Dashboard filter/action menu는 후속. |
| `Tooltip` | icon-only action, chart/widget option | icon button accessibility 기준과 함께 적용한다. |
| `Popover` | lightweight picker/filter panel | menu보다 상태가 많은 filter/picker에 적용한다. |
| `Alert Dialog` | delete/destructive confirm | `DialogShell` destructive 사용처를 분리한다. |
| `Sheet` | share panel, side config panel | #420에서 Dashboard runtime share panel에 1차 적용. side config panel은 후속 판단. |
| `Textarea` | SQL/editor assistant, widget text | raw `<textarea>` 제거 기준이다. |
| `Separator` | toolbar/menu/panel divider | 화면별 divider CSS 축소 기준이다. |
| `Skeleton` | loading state | table/panel loading placeholder를 통일한다. |
| `Scroll Area` | dataset tree/list/result overflow | browser scrollbar CSS를 줄일 수 있는 영역에만 적용한다. |
| `Pagination` | DataTable 밖 pagination | `PaginationBar` 재구성 기준이다. |
| `Button Group` | action cluster | `ActionGroup` 내부 또는 단순 wrapper 대체 후보로 본다. |
| `Empty` | empty state | `EmptyState`를 shadcn `Empty` 기준으로 정렬한다. |
| `Slider` | SQL Preview 최대 행 수 | #468에서 실제 query `limit`을 변경하는 control로 적용했다. |
| `Bubble` | Query AI 응답/안내/오류 | #468에서 제안 결과와 상태 surface에 적용했다. |

### AskLake composition 유지

| 컴포넌트 | 유지 이유 | 내부 정리 방향 |
| --- | --- | --- |
| `DataTable` | TanStack Table logic과 shadcn Table UI를 묶는 서비스 표준 table이다. | shadcn Data Table 가이드와 맞춰 pagination/sort/loading API를 정리한다. |
| `FilterToolbar` 계열 | 검색, filter, actions, divider를 한 화면 toolbar로 묶는 서비스 패턴이다. | 내부 input/checkbox/menu는 `Input Group`, `Checkbox`, `Dropdown Menu`, `Button`으로 교체한다. |
| `PageHeader` | route 상단 제목/설명/actions 패턴이다. | action slot은 `Button Group`/`ActionGroup` 기준으로 정리한다. |
| `Panel` / `PanelHeader` | 화면 섹션 shell과 header pattern이다. | shadcn `Card`와 역할을 혼동하지 않도록 page section 용도로 유지한다. |
| `MetricCard` | dashboard/jobs metric summary pattern이다. | 내부는 `Card`/`Badge` 기반으로 정렬한다. |
| `CommandBar` | ETL/Creation 하단 command 영역이다. | 내부 action은 `Button`/`Button Group` 기반으로 정리한다. |
| `ActionGroup` | 화면별 action row spacing/wrap pattern이다. | 단순 button cluster는 후속 `Button Group`으로 흡수 가능한지 재평가한다. |
| `TagList` | 여러 tag/chip 행을 다루는 서비스 pattern이다. | 단순 tag는 `Badge`; interactive tag는 명확한 variant로 제한한다. |
| `KeyValueList` | detail/review metadata summary pattern이다. | shadcn `Item` 또는 semantic dl 구조와 맞춘다. |
| `ValidationList` | 검증 상태와 설명 목록 pattern이다. | icon/status는 `Badge`/`Alert` 계열과 맞춘다. |
| `PreviewPanel` / `ResultPanel` | SQL/Dashboard/ETL preview/result shell pattern이다. | header/status/empty/loading/action slot은 shadcn primitive로 구성한다. |
| `SettingsPanel` | dashboard/ETL/SQL 설정 panel shell pattern이다. | form body는 `Field`, `Input Group`, `Native Select`, `Checkbox`로 교체한다. |
| `DetailTableSection` | 상세 화면의 table title/body/footer shell pattern이다. | table body는 `DataTable` 또는 shadcn `Table` 기준으로 유지한다. |
| `TreePanel` | S3/ETL/SQL/Dashboard tree의 wrapper와 loading/error/empty state shell이다. | 내부 tree는 `react-arborist` 기준으로 통일하고, row UI는 shadcn-style file explorer pattern으로 정리한다. |
| `SelectableCard` | 아이콘, 설명, selected/check 상태가 있는 업무 선택 card pattern이다. | checkbox/radio 의미가 있으면 `Radio Group`/`Checkbox` 기반으로 재설계한다. |
| `IconOptionGrid` | dashboard widget/chart type icon grid pattern이다. | `Tooltip`, `Toggle Group`, `Button` 기반으로 내부를 정리한다. |

### shadcn으로 교체/흡수

| 컴포넌트 | 대체 기준 | 후속 처리 |
| --- | --- | --- |
| `SegmentedTabs` | `Tabs` 또는 `Toggle Group` | 단순 tab/view switch부터 교체한다. rename/edit 상태가 섞인 runtime tab은 보류한다. |
| `PaginationBar` | `Pagination` | 현재 API를 유지하되 내부 markup을 shadcn Pagination으로 재구성한다. |
| `FormFieldGroup` | `Field` + `Label` + `Input Group` | deprecated 후보로 두고 신규 form은 shadcn field 기준으로 작성한다. |
| `NativeSelectField` | `Native Select` + `Field` | native select가 필요한 곳만 유지하고 wrapper 이름은 shadcn 기준으로 맞춘다. |
| `Chip` | `Badge` variant 또는 `Toggle` | read-only chip은 `Badge`, 선택 chip은 `Toggle`/`Checkbox` 기반으로 나눈다. |
| `StatusBadge` | `Badge` variant | status tone mapper만 남기고 visual component는 `Badge`로 흡수한다. |
| `IconButton` | `Button size="icon"` + `Tooltip` | 접근성 label helper가 필요하면 thin wrapper만 남긴다. |
| `DialogShell` | `Dialog` / `Alert Dialog` / `Sheet` | 일반 dialog, destructive confirm, side panel을 분리한다. |
| `PickerDialog` | `Dialog` + `Command`/`Scroll Area`/tree wrapper | S3/DB picker shell만 유지할지 후속 tree/picker PR에서 판단한다. |
| `EmptyState` | `Empty` | shadcn Empty를 추가한 뒤 naming과 variant를 맞춘다. |

## Raw UI 교체 스윕 기준

후속 PR은 아래 검색으로 raw UI 사용처를 줄인다.

```bash
rg "<input|<select|<textarea|type=\"checkbox|type=\"radio|role=\"dialog|role=\"tablist|<button" frontend/src
```

우선순위:

1. `type="checkbox"`, `type="radio"`, raw `<textarea>`는 foundation primitive 추가 직후 교체한다.
2. raw `<select>`는 `Select`와 `Native Select` 중 하나로 분류한 뒤 교체한다.
3. `role="tablist"`는 `Tabs` 또는 `Toggle Group` 기준으로 교체한다.
4. `role="dialog"`와 custom backdrop은 `Dialog`, `Alert Dialog`, `Sheet`로 분리한다.
5. raw `<button>`은 의미에 따라 `Button`, `Button size="icon"`, `Toggle`, `Dropdown Menu` trigger로 교체한다.

## 추천 PR 순서

1. `docs-#400`: 이 문서와 기존 gap/CSS cleanup 문서에 shadcn replacement 기준을 추가한다.
2. Foundation PR: `components.json`과 빠진 shadcn primitive를 추가한다. 화면 교체는 최소화한다.
3. Forms/Controls PR: ETL/SQL/Dashboard/S3/DB picker의 input/select/textarea/checkbox/radio를 교체한다.
4. Navigation/Menu/Overlay PR: tabs, toggle group, dropdown menu, alert dialog, sheet를 적용한다.
5. Table/List/Search PR: `DataTable` footer, `PaginationBar`, `FilterToolbar` 내부와 Catalog/Dashboard menu를 shadcn primitive 기준으로 정리한다. Catalog result card 자체는 별도 list/card cleanup 후보로 둔다.
6. Tree Standardization PR: S3/ETL/SQL의 MUI/custom tree를 `react-arborist`로 교체하고 ReUI File Explorer Tree 스타일의 shadcn-style row UI를 적용한다.
7. Complex Surface Polish PR: dashboard runtime, ETL rule builder, SQL result/editor shell을 화면별로 폴리싱한다.
8. CSS Cleanup + Visual QA PR: 교체 완료 selector만 삭제하고 주요 route를 검증한다.

## 업데이트 로그

| 날짜 | 변경 |
| --- | --- |
| 2026-07-09 | #400에서 shadcn replacement inventory를 생성하고 현재 `components/ui` 32개 컴포넌트를 분류했다. |
| 2026-07-09 | #401의 `TreePanel` 추가를 반영하고, tree 계열 후속 표준을 `react-arborist` 엔진 + shadcn-style File Explorer Tree UI로 기록했다. |
| 2026-07-09 | #418에서 ETL/Schedule/S3/DB picker의 대표 form control을 `Input`, `NativeSelect`, `InputGroup`, `Checkbox` 기준으로 1차 교체했다. |
| 2026-07-09 | #419에서 SQL/Dashboard runtime/config의 대표 form control을 `Textarea`, `Input`, `Checkbox`, `Button` 기준으로 2차 교체하고 Dashboard runtime compact 보정을 추가했다. |
| 2026-07-09 | #420에서 Catalog sort menu를 `DropdownMenu`, Dashboard runtime share panel을 `Sheet`로 교체했다. |
| 2026-07-09 | #422에서 `PaginationBar`/`DataTable` footer, `FilterToolbar` internals, Catalog/Dashboard `DropdownMenu` 적용 상태를 반영했다. Catalog result card는 후속 list/card cleanup 후보로 유지한다. |

## #417 Shadcn Primitive Foundation 반영

이번 PR에서 후속 화면 교체의 기준이 되는 shadcn-style foundation을 추가했다. 화면별 raw UI 교체는 포함하지 않고, `frontend/src/components/ui` 안에서 공통 import/API 기준만 먼저 맞췄다.

추가된 기준:

- `frontend/components.json`: shadcn CLI가 `frontend` 앱 기준으로 `@/components`, `@/components/ui`, `@/lib/utils` alias를 인식하도록 추가했다.
- Forms/Controls: `Label`, `Field`, `InputGroup`, `NativeSelect`, `Textarea`, `Checkbox`, `RadioGroup`, `Switch`
- Selection/Navigation: `Tabs`, `ToggleGroup`, `Pagination`
- Overlay/Menu: `DropdownMenu`, `Tooltip`, `Popover`, `AlertDialog`, `Sheet`
- Feedback/Layout: `Separator`, `Skeleton`, `ScrollArea`, `Empty`

분류 변경:

- 위 primitive들은 더 이상 "추가 필요" 상태가 아니라 "foundation 추가됨, 화면별 적용 필요" 상태로 본다.
- 기존 `FormFieldGroup`/`NativeSelectField`, `EmptyState`, `PaginationBar`, `DialogShell` 같은 AskLake composition wrapper는 즉시 제거하지 않는다. 후속 PR에서 새 primitive 기반으로 내부를 줄이거나 사용처를 갈아끼운다.
- `DropdownMenu`, `Tooltip`, `Popover`, `AlertDialog`, `Sheet`는 Navigation/Menu/Overlay PR에서 실제 화면 적용을 시작한다.

검증:

- `cd frontend && npm run build` 통과.

## #420 Navigation/Menu/Overlay Primitive 1차 반영

이번 PR은 #419 Forms/Controls 작업과 겹치지 않는 navigation/menu/overlay 표면만 먼저 교체한다. 화면 데이터, API, dashboard page tab rename/delete 상태는 변경하지 않는다.

적용 범위:

- `frontend/src/pages/catalog/CatalogPage.tsx`
  - custom sort menu state, document outside-click listener, button-based `role="menuitemradio"`를 제거했다.
  - `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`으로 정렬 메뉴를 전환했다.
- `frontend/src/pages/dashboard/runtime/DashboardRuntimeShell.tsx`
  - inline custom `role="dialog"` share panel을 `Sheet`/`SheetContent`/`SheetHeader`/`SheetFooter`로 전환했다.
  - 공유 링크 표시와 닫기 동작은 기존 prop 흐름을 유지한다.
- `frontend/src/components/ui/dropdown-menu.tsx`
  - vendored lucide export와 맞지 않던 radio indicator icon을 `CircleDot`으로 정리했다.

유지/보류:

- SQL autocomplete popover, Dashboard filter/action menu, audit popover, destructive confirm은 후속 #420 확장 또는 별도 PR 범위로 둔다.
- `DashboardPageTabs`는 rename/delete/edit 상태가 섞여 있어 이번 PR에서 `Tabs`로 억지 전환하지 않는다.

검증:

- `cd frontend && npm run build` 통과. Vite chunk size warning은 기존 번들 크기 이슈로 유지.

## #418 Forms/Controls Primitive 1차 반영

이번 PR은 foundation에서 추가된 primitive를 실제 ETL 계열 화면에 적용하는 첫 replacement 작업이다. Backend API, 데이터 계약, React Router 구조, ETL draft 상태 로직은 변경하지 않는다.

적용 범위:

- `frontend/src/pages/etl/EtlPages.tsx`
  - Source 연결 입력, Rule builder의 operation/validation/severity/failure select, transform parameter 입력, Schedule 반복 시간/Cron 입력, Target 기본 정보/태그 입력, Permission owner 입력을 `Input`/`NativeSelect`로 교체했다.
  - `FormFieldGroup`과 `NativeSelectField`는 기존 grid/density CSS와 label 구조를 보존하기 위해 compatibility wrapper로 유지했다.
- `frontend/src/components/s3/S3PathField.tsx`
  - S3 path action button은 `Button`으로 교체했다.
  - Bucket select는 `Field` + `FieldLabel` + `NativeSelect`, 주소 검색은 `InputGroup` + `InputGroupInput`으로 교체했다.
- `frontend/src/components/target/DatabaseField.tsx`
  - DB picker action button은 `Button`, 검색 입력은 `Field` + `InputGroup`으로 교체했다.
- `frontend/src/pages/etl/schedule/SchedulePage.tsx`
  - 현재 App Router에서 직접 import되지는 않지만, 이슈 범위에 포함된 legacy schedule 파일의 input/select/checkbox를 `Input`/`NativeSelect`/`Checkbox`로 맞췄다.

유지/보류:

- `FormFieldGroup`/`NativeSelectField`는 즉시 삭제하지 않는다. 여러 ETL grid와 legacy `.field` selector가 label/density를 공유하므로, wrapper 제거는 route QA와 CSS cleanup 이후 단계에서 진행한다.
- `CheckableOption` 내부 radio/checkbox, target format custom menu, MUI TreeView row/button은 이번 Forms/Controls 1차 범위가 아니다.
- 화면별 CSS는 삭제하지 않는다. 교체가 끝난 selector의 삭제 판단은 `docs/frontend-css-cleanup-inventory.md`에서 추적한다.

## #419 Forms/Controls Primitive 2차 반영

이번 PR은 #418에서 다루지 않은 SQL/Dashboard runtime/config 사용처의 대표 raw form control을 shadcn-style primitive로 교체한다. Backend API, 데이터 계약, Dashboard runtime 저장 로직, SQL 실행 로직은 변경하지 않는다.

적용 범위:

- `frontend/src/pages/sql/SqlAnalysisPage.tsx`
  - Query AI prompt, SQL editor, SQL materialize description을 `Textarea`로 교체했다.
  - SQL materialize RAG toggle을 `Checkbox`로 교체했다.
- `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`
  - widget description을 `Textarea`로 교체했다.
  - table column picker와 area chart stacked toggle을 `Checkbox`로 교체했다.
- `frontend/src/pages/dashboard/runtime/DashboardAssistantPanel.tsx`
  - assistant prompt input을 `Textarea`, submit control을 `Button`으로 교체했다.
- `frontend/src/pages/dashboard/runtime/WidgetRenderer.tsx`
  - visualization request input을 `Input`, inline text widget body를 `Textarea`, submit controls를 `Button`으로 교체했다.
- `frontend/src/pages/dashboard/runtime/DashboardPageTabs.tsx`
  - page rename input과 tab action buttons를 `Input`/`Button`으로 교체했다.
  - Shadcn 기본 크기가 tab strip에는 커서 `size`/`variant`와 dashboard 전용 compact class를 함께 적용했다.
- `frontend/src/pages/dashboard/runtime/DashboardTopBar.tsx`
  - title rename input은 기존 `Input`/`Button` 유지 기준으로 두되, 긴 자동 생성 제목이 과하게 커지지 않도록 compact edit 스타일을 보정했다.

유지/보류:

- `FormFieldGroup`/`NativeSelectField`는 SQL materialize form과 WidgetConfigPanel의 compatibility wrapper로 유지한다.
- `HexColorInput`, `HexColorPicker` 기반 color picker는 Complex Surface Polish에서 별도 설계한다.
- SQL autocomplete popover, dashboard share panel, tree UI는 이번 Forms/Controls 2차 범위가 아니다.
- 화면별 CSS는 삭제하지 않는다. 기존 selector는 route QA와 cleanup PR 전까지 유지한다.
- Dashboard runtime tab/title edit처럼 좁은 복합 UI는 primitive만 교체하면 충분하지 않다. Shadcn primitive를 유지하되 compact composition style을 같이 관리한다.

## #422 Table/List/Search Primitive 반영

이번 PR은 목록/검색/표 footer에서 이미 만든 AskLake composition component를 유지하되, 내부 구현을 shadcn-style primitive로 줄이는 작업이다. Backend API, route 구조, table engine 교체는 포함하지 않는다.

적용 범위:

- `PaginationBar`
  - 내부 markup을 shadcn `Pagination`/`PaginationContent`/`PaginationItem` 기준으로 재구성했다.
  - Catalog 검색 결과 footer와 materialization run footer도 `PaginationBar`로 연결했다.
- `DataTable`
  - 내부 pagination footer를 `PaginationBar`로 연결하고 page size select는 `NativeSelect`로 교체했다.
  - TanStack sorting/loading/empty/table API는 유지했다.
- `FilterToolbar`
  - 검색 wrapper는 `InputGroup`, 입력 control은 `InputGroupInput`, checkbox control은 `Checkbox` primitive를 사용한다.
- Catalog/Dashboard menu
  - Catalog sort menu는 #420에서 `DropdownMenuRadioGroup`/`DropdownMenuRadioItem` 기준으로 먼저 전환됐다.
  - Dashboard owner/tag/sort menu는 `DropdownMenuItem`/`DropdownMenuCheckboxItem`/`DropdownMenuRadioItem` 기준으로 전환했다.

유지/보류:

- Catalog result card 자체, tag/status visual state, lineage/schema preview shell은 후속 list/card cleanup 후보로 유지한다.
- Dashboard menu option/filter button/table density CSS는 route QA 전까지 유지한다.
- `frontend/src/vendor/lucide.ts`에는 이번에 실제로 쓰기 시작한 `MoreHorizontal` 아이콘 export만 추가했다.

## #468 SQL Analysis Shadcn Refactor 반영

적용 범위:

- sidebar의 raw tablist를 shadcn `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`로 교체했다.
- SQL Preview 최대 행 수를 shadcn `Slider`로 추가하고 실제 `executeQueryPreview`의 `limit`에 연결했다.
- Query AI 안내/결과/오류를 공식 `Bubble` composition으로 교체했다.
- embedded Dashboard raw overlay를 shadcn `Dialog`로 교체했다.
- editor/result/schema/tool surface를 `Panel`, 상태와 metadata를 `Badge`, empty state를 `Empty`, form label을 `Field`, raw action을 `Button`으로 교체했다.
- dataset의 `+ 추가` action은 custom pill CSS를 제거하고 shadcn `Button size="sm" variant="subtle"`로 맞췄다.
- 2차 정리에서 header를 `PanelHeader`, schema/list row 구분을 `Separator`, 처리 Job form을 `FieldGroup`/`Field`/`NativeSelect`, SQL result cell surface를 shadcn `Table` 기본값으로 전환했다.
- SQL result의 legacy `ResultPanel` wrapper를 `Panel` + `PanelHeader` composition으로 줄였다.

CSS/의존성 판단:

- `sql.css`의 button, tab, status pill, Query AI bubble, empty state, dialog form/header/footer, schema list, result table density selector를 삭제해 2,547줄에서 591줄로 줄였다.
- workspace responsive grid, SQL editor, dataset tree hover/branch, autocomplete position, result overflow, embedded Dashboard sizing은 도메인 layout이라 유지한다.
- Slider는 monolithic `radix-ui`가 아니라 `@radix-ui/react-slider` 직접 의존을 사용한다.
- autocomplete는 editor focus/selection 회귀 위험 때문에 이번 범위에서 `Popover`/`Command`로 전환하지 않는다.
