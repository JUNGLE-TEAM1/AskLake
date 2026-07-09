# /jobs Page UI Audit

상태: `초안`
담당 이슈: #440
대상 route: `/jobs`
대표 확인 URL: `http://127.0.0.1:5174/jobs`

## 1. 화면 목적

`/jobs`는 수집/처리 Job 목록을 보는 첫 화면입니다. 사용자는 이 화면에서 전체 Job 상태를 훑고, 검색/필터를 적용하고, 특정 Job의 상세 정보나 실행 이력으로 이동하거나 즉시 실행/재실행 같은 명령을 실행합니다.

이 화면은 이후 `/jobs/:jobId`, `/jobs/:jobId/runs`로 들어가는 입구이기 때문에, 수집/처리 영역의 UI 기준점 역할을 합니다.

## 2. 근거 자료

확인한 주요 파일은 아래입니다.

- `frontend/src/pages/ingest/JobsPages.tsx`
- `frontend/src/components/ui/data-table.tsx`
- `frontend/src/components/ui/filter-toolbar.tsx`
- `frontend/src/components/ui/dialog-shell.tsx`
- `frontend/src/styles/ingest.css`
- `frontend/src/styles/ingest-dag.css`
- `frontend/src/styles/responsive.css`
- `docs/frontend-shadcn-replacement-inventory.md`
- `docs/frontend-component-gap-inventory.md`
- `docs/frontend-css-cleanup-inventory.md`

## 3. 현재 화면 구조

현재 `/jobs`는 `JobsLandingPage`가 렌더링합니다.

큰 구조는 아래 순서입니다.

1. 상단 페이지 헤더
2. 작업 현황 metric panel
3. 검색 및 필터 panel
4. 작업 상태 목록 table
5. row action
6. 로그 modal
7. empty/search-empty 상태

현재 `JobsCardSection`과 `JobsTableDemoPage` 코드도 남아 있지만, `/jobs` 기본 route는 `JobsLandingPage`와 `JobsTableSection` 중심입니다. `/jobs-table-demo`는 이번 감사 대상에서 제외합니다.

## 4. 현재 사용 중인 공통 컴포넌트

`/jobs`는 이미 공통 컴포넌트를 꽤 많이 사용하고 있습니다.

| 영역 | 현재 컴포넌트 | 판단 |
| --- | --- | --- |
| 페이지 상단 | `PageHeader` | 유지. route 상단 표준으로 적절합니다. |
| 주요 CTA | `Button` | 유지. 다만 `primary-button`, `create-job-button` class 의존이 남아 있습니다. |
| 작업 현황 섹션 | `Panel`, `PanelHeader`, `Badge`, `MetricCard` | 유지. 화면별 spacing class만 남아 있습니다. |
| 검색/필터 섹션 | `Panel`, `PanelHeader`, `FilterToolbar`, `FilterToolbarSearch`, `Input`, `Button` | 유지. 내부 input은 `FilterToolbarInput`으로 더 맞출 수 있습니다. |
| 작업 목록 | `DataTable` | 유지. TanStack logic + shadcn Table UI 방향과 맞습니다. |
| table action | `IconButton`, `Button` | 유지. Tooltip 결합 여부를 후속 검토합니다. |
| 상태/태그 | `StatusBadge`, `Chip`, `TagList` | 유지하되 `Badge` 흡수 가능성을 계속 검토합니다. |
| empty state | `EmptyState` | shadcn `Empty` 기준으로 재정렬 후보입니다. |
| 로그 modal | `DialogShell` | 유지 가능. 내부를 shadcn `Dialog`/`ScrollArea` 기준으로 더 정리할 수 있습니다. |

## 5. 아직 약하게 컴포넌트화된 영역

현재 가장 큰 문제는 “공통 컴포넌트를 쓰고 있지만, 화면별 CSS가 여전히 많은 상태”입니다.

### 5.1 검색/필터 버튼

현재 필터 버튼은 `["상태", "소스", "Owner", "태그"]`를 map으로 렌더링하고, 실제 dropdown은 아직 열리지 않습니다.

현재 형태:

- `Button variant="outline"`
- 텍스트 뒤에 `▾` 문자 사용
- `className="min-w-[74px] rounded-[7px]"`

후보:

- `DropdownMenu`
- `FilterToolbarMenu`
- `Button` + icon `ChevronDown`
- 필터 option이 실제로 생기면 `DropdownMenuCheckboxItem` 또는 `DropdownMenuRadioItem`

판단:

- 지금은 클릭 이벤트만 audit log를 남기는 수준이라 기능 구현까지 들어가면 범위가 커집니다.
- 후속 구현에서는 필터 버튼을 진짜 menu primitive로 바꾸는 것이 좋습니다.

### 5.2 검색 input

현재 검색 input은 `FilterToolbarSearch` 안에 `Input`을 직접 넣고, 긴 Tailwind class를 붙여 flat 스타일을 만듭니다.

후보:

- `FilterToolbarInput`
- `InputGroupInput`

판단:

- `FilterToolbarInput`이 이미 있으므로 `/jobs`도 `Input` 직접 사용보다 `FilterToolbarInput`으로 맞추는 편이 좋습니다.
- 이 작업은 `/catalog`, `/sql`, `/dashboards` 검색바와 함께 공통 교체 PR로 묶는 것이 안전합니다.

### 5.3 table density와 column sizing

`DataTable`을 쓰지만, `jobs-table-preview`, `jobs-table-scroll`, `jobs-table-title-cell`, `jobs-flow-cell`, `jobs-table-run-cell`, `jobs-table-next-cell`, `jobs-table-actions` 같은 화면별 class가 여전히 많습니다.

후보:

- `DataTable` meta API 확장
- reusable `DataTableTextCell`
- reusable `DataTableStackedCell`
- reusable `RowActionCell`

판단:

- `DataTable` 자체는 유지합니다.
- 다만 stacked text cell, row action cell, status accent row 같은 table 내부 패턴은 여러 화면에서 반복될 가능성이 높습니다.
- 바로 `/jobs` 안에서만 정리하기보다, 다른 table 화면 감사 후 공통 패턴을 정하는 편이 재작업이 적습니다.

### 5.4 row action icon-only 버튼

현재 row action은 `IconButton`으로 되어 있고 접근성 label도 있습니다. 다만 hover/focus tooltip은 아직 명확하지 않습니다.

후보:

- `Button size="icon"`
- `Tooltip`
- `IconButton` thin wrapper 유지

판단:

- `IconButton`을 즉시 제거할 필요는 없습니다.
- shadcn replacement inventory 기준으로는 장기적으로 `Button size="icon" + Tooltip` 조합으로 흡수할 수 있습니다.
- icon-only action이 여러 화면에서 반복되므로 단독 `/jobs` 작업보다 전체 row action 기준을 잡는 편이 좋습니다.

### 5.5 로그 modal

`DialogShell`을 사용하고 있으나 `job-log-modal-header`, `job-log-modal pre` 등 modal 전용 CSS가 남아 있습니다.

후보:

- `DialogShell` 유지
- 내부 body를 `ScrollArea`로 정리
- 로그 출력용 `CodeBlock` 또는 `LogViewer` composition 후보

판단:

- `/jobs`의 row “로그” 버튼과 `/jobs/:jobId/runs`의 “로그 보기” modal은 같은 계열입니다.
- `/jobs/:jobId/runs` 감사와 함께 `LogViewerDialog` 같은 composition 후보를 검토하는 것이 좋습니다.

## 6. shadcn/ReUI 대체 후보

| 현재 영역 | 대체/정렬 후보 | 우선순위 | 메모 |
| --- | --- | ---: | --- |
| 검색 input | `FilterToolbarInput`, `InputGroupInput` | 높음 | 이미 있는 컴포넌트로 맞출 수 있습니다. |
| 필터 버튼 | `DropdownMenu` | 중간 | 실제 filter option 구현 여부에 따라 범위가 커집니다. |
| 필터 버튼 화살표 | lucide `ChevronDown` | 낮음 | 텍스트 `▾` 제거 후보입니다. |
| row action | `Button size="icon"` + `Tooltip` | 중간 | `IconButton` 흡수 정책과 함께 판단합니다. |
| table stacked cell | AskLake composition 후보 | 중간 | shadcn primitive보다는 `DataTable` 내부 helper 후보입니다. |
| 로그 modal body | `ScrollArea` | 중간 | 긴 로그 스크롤 QA와 함께 처리합니다. |
| 로그 텍스트 | `CodeBlock`/`LogViewer` composition 후보 | 낮음 | `/jobs/:jobId/runs`와 같이 봐야 합니다. |
| empty state | shadcn `Empty` | 중간 | `EmptyState` 흡수 기준과 함께 처리합니다. |
| status/owner/tag pill | `Badge` variant 또는 `StatusBadge` 유지 | 낮음 | 지금 당장 바꾸면 색상 회귀 위험이 있습니다. |

## 7. 관련 CSS

주요 관련 CSS는 `frontend/src/styles/ingest.css`에 있습니다.

### 유지 필요

아래 selector는 현재 화면 렌더링에 직접 필요합니다. 바로 삭제하면 안 됩니다.

- `.jobs-landing`
- `.jobs-page-header`
- `.jobs-panel-stack`
- `.jobs-panel-metrics`
- `.jobs-table-preview-card`
- `.jobs-table-preview-header`
- `.jobs-table-scroll`
- `.jobs-table-preview`
- `.jobs-table-title-cell`
- `.jobs-flow-cell`
- `.jobs-table-run-cell`
- `.jobs-table-next-cell`
- `.jobs-table-actions`
- `.jobs-table-actions-column`
- `.jobs-data-table`
- `.job-log-modal-header`

### 교체 후보

아래 selector는 공통 컴포넌트 API가 더 정리되면 줄일 수 있습니다.

- `.create-job-button`
- `.jobs-table-preview`
- `.jobs-table-preview th`
- `.jobs-table-preview td`
- `.jobs-table-preview th:nth-child(...)`
- `.jobs-table-preview td:nth-child(...)`
- `.jobs-table-run-cell button`
- `.jobs-table-actions .job-action-button`
- `.jobs-data-table > div:last-child`

### 보류

아래는 `/jobs/:jobId` 또는 `/jobs/:jobId/runs`와 같이 봐야 합니다.

- `.job-action-button`
- `.status-pill`
- `.owner-chip`
- `.tag-chip`
- `.job-log-modal-header`
- `.job-log-modal pre`
- `responsive.css`의 `.jobs-*`, `.job-*`, `.run-*` 계열

## 8. Interaction States

### 8.1 기본 목록 상태

확인 대상:

- mock Job 4개 표시
- status별 row accent
- running Job progress
- failed Job 로그 링크
- action icon button
- pagination footer

QA 메모:

- column 폭이 고정되어 있어 긴 source/target 이름은 ellipsis 처리됩니다.
- table `min-width: 1180px` 때문에 좁은 화면에서는 가로 스크롤이 정상 동작해야 합니다.

### 8.2 검색 상태

확인 대상:

- 검색어 입력
- 검색 결과 필터링
- 결과 없음 empty state
- 필터 초기화

QA 메모:

- 검색 input 자체는 동작합니다.
- placeholder와 입력 텍스트가 `FilterToolbarInput` 기준으로 완전히 통일되어 있지는 않습니다.

### 8.3 필터 버튼 상태

확인 대상:

- `상태`, `소스`, `Owner`, `태그` 버튼 클릭

QA 메모:

- 현재는 실제 dropdown이 열리지 않고 audit action만 발생하는 구조로 보입니다.
- UI 감사 기준으로는 “필터 버튼처럼 보이지만 실제 menu가 없는 상태”를 후속 작업 후보로 기록해야 합니다.

### 8.4 row action 상태

확인 대상:

- 작업 정보
- 실행 단계
- 즉시 실행
- 재실행
- 수정
- 취소

QA 메모:

- icon-only action은 compact하지만 tooltip이 없으면 의미 파악이 어려울 수 있습니다.
- 클릭 시 route 이동 또는 command 실행이 발생하므로 실제 구현 작업에서는 route/command regression을 조심해야 합니다.

### 8.5 로그 modal

확인 대상:

- failed row의 로그 버튼
- modal width/height
- 긴 로그 scroll
- 닫기 버튼
- ESC/backdrop close 동작

QA 메모:

- `DialogShell` 기반이라 기본 dialog 구조는 있습니다.
- 로그 본문은 `<pre>`에 직접 스타일을 주고 있어, `/jobs/:jobId/runs`의 `RunLogModal`과 함께 `LogViewer` 후보로 볼 수 있습니다.

## 9. 후속 작업 후보

### 공통 교체 후보

1. `FilterToolbarInput` 적용 확대
   - `/jobs` 검색 input
   - `/catalog` 검색 input
   - `/sql` 검색/테이블 검색 input
   - `/dashboards` 검색 input

2. table cell helper 정리
   - stacked title/subtitle cell
   - status/run summary cell
   - row action cell

3. icon-only action 기준 정리
   - `IconButton` 유지 여부
   - `Button size="icon" + Tooltip` 흡수 여부

4. log modal 기준 정리
   - `DialogShell` 유지
   - `ScrollArea` 적용
   - `LogViewer` composition 후보

5. DataTable visual density 정리
   - header height
   - row height
   - footer density
   - horizontal scroll style

### 페이지별 폴리싱 후보

1. 필터 버튼이 실제 dropdown이 아닌 점을 UI에서 덜 헷갈리게 만들기
2. table action icon hover/focus 상태 확인
3. failed row 로그 요약/로그 버튼 간격 확인
4. 모바일에서 PageHeader action과 filter toolbar 줄바꿈 확인
5. empty/search-empty 상태의 spacing 확인

## 10. 우선순위

| 우선순위 | 작업 | 이유 |
| --- | --- | --- |
| P1 | `FilterToolbarInput`으로 검색 input 통일 | 이미 컴포넌트가 있고 여러 페이지에 반복됩니다. |
| P1 | 실제 화면에서 `/jobs` table overflow/row action QA | 목록 화면은 진입점이라 깨지면 눈에 잘 띕니다. |
| P2 | row action tooltip/icon button 기준 정리 | 여러 table/list에 반복될 가능성이 큽니다. |
| P2 | 로그 modal을 `/jobs-runs`와 함께 정리 | 같은 계열 modal이므로 한 번에 보는 게 안전합니다. |
| P3 | status/chip을 `Badge`로 흡수할지 재검토 | 색상/상태 회귀 위험이 있어 급하지 않습니다. |

## 11. 이번 문서에서 확정하지 않는 것

- `/jobs/:jobId` 상세 화면의 disclosure/card/table CSS 정리
- `/jobs/:jobId/runs` 실행 이력 table과 DAG modal 정리
- 실제 필터 기능 구현
- CSS selector 삭제
- `IconButton` 제거
- `DialogShell` 제거
- Backend API, 데이터 계약, 도메인 로직 변경

## 12. 다음 액션

이 문서 작성 후 바로 구현에 들어가기보다, A 담당 페이지 전체 문서화가 끝난 뒤 아래 묶음으로 공통 교체 후보를 다시 정렬하는 것이 좋습니다.

1. Search/Filter toolbar 묶음
2. DataTable/table cell/row action 묶음
3. Dialog/log modal 묶음
4. ETL form/input/select/checkbox 묶음
5. Tree/Scroll/Tooltip 묶음

`/jobs`만 놓고 보면 가장 먼저 손대기 좋은 후보는 `FilterToolbarInput` 적용과 table row action/tooltip 기준 정리입니다.

## 13. #441 상세 페이지 감사에서 되돌아온 공통 후보

`/jobs/:jobId` 감사 결과, `/jobs` 목록과 함께 봐야 할 공통 후보가 추가로 확인되었습니다.

| 공통 후보 | 관련 화면 | 판단 |
| --- | --- | --- |
| action button variant 기준 | `/jobs`, `/jobs/:jobId`, `/jobs/:jobId/runs` | `ActionGroup`, `Button`, `IconButton`을 모두 쓰고 있어 tone/size/tooltip 기준을 한 번에 정리하는 편이 좋습니다. |
| status/tag pill 기준 | `/jobs`, `/jobs/:jobId` | `StatusBadge`, `Chip`, `TagList`가 반복됩니다. 당장 제거보다 `Badge` 흡수 가능성을 문서로 추적합니다. |
| log modal 기준 | `/jobs`, `/jobs/:jobId/runs` | `JobLogModal`과 `RunLogModal`은 `DialogShell` + `<pre>` 구조가 거의 같아서 `LogViewerDialog` 후보입니다. |
| small table/read-only table 기준 | `/jobs/:jobId`, `/jobs/:jobId/runs` | 작은 read-only table은 shadcn `Table`, 실행 이력 table은 `DataTable` 후보로 나눠 보는 것이 좋습니다. |
| detail header/tab 기준 | `/jobs/:jobId`, `/jobs/:jobId/runs` | 같은 `JobDetailHeader`를 공유하므로 tab/header 교체는 두 route를 함께 QA해야 합니다. |

## 14. #442 실행 이력 페이지 감사에서 되돌아온 공통 후보

`/jobs/:jobId/runs` 감사 결과, `/jobs` 목록에도 영향을 주는 후보가 더 명확해졌습니다.

| 공통 후보 | 관련 화면 | 판단 |
| --- | --- | --- |
| filter menu 기준 | `/jobs`, `/jobs/:jobId/runs` | 둘 다 실제 menu가 없는 filter button이 있어 `DropdownMenu`/`Popover` 적용 기준을 같이 잡아야 합니다. |
| log viewer 기준 | `/jobs`, `/jobs/:jobId/runs` | 목록 row 로그와 실행 이력 로그는 같은 `LogViewerDialog` 후보로 묶을 수 있습니다. |
| table action label/tooltip | `/jobs`, `/jobs/:jobId/runs` | 목록은 icon-only, runs는 text button이라 action density와 tooltip 기준을 함께 정리해야 합니다. |
