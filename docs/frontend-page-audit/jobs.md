# /jobs Page UI Audit

상태: `구현 및 QA 완료`
담당 이슈: #440
대상 route: `/jobs`
대표 확인 URL: `http://127.0.0.1:5174/jobs`

## 1. 화면 목적

`/jobs`는 수집/처리 Job 목록을 보는 첫 화면입니다. 사용자는 이 화면에서 전체 Job 상태를 훑고, 검색하거나, 특정 Job의 상세 정보나 실행 이력으로 이동하거나 즉시 실행/재실행 같은 명령을 실행합니다.

이 화면은 이후 `/jobs/:jobId`, `/jobs/:jobId/runs`로 들어가는 입구이기 때문에, 수집/처리 영역의 UI 기준점 역할을 합니다.

## 2. 근거 자료

확인한 주요 파일은 아래입니다.

- `frontend/src/pages/ingest/JobsPages.tsx`
- `frontend/src/components/ui/data-table.tsx`
- `frontend/src/components/ui/data-table-stacked-cell.tsx`
- `frontend/src/components/ui/filter-toolbar.tsx`
- `frontend/src/components/ui/avatar.tsx`
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
3. 작업 목록 panel 안의 검색
4. 작업 목록 table
5. row action
6. 실행 이력 route 이동
7. empty/search-empty 상태

목록 하단에는 페이지 이동 control만 표시하며 한 페이지에 5개 Job을 보여 줍니다. 현재 `/jobs`의 요약 행 수와 페이지 문구는 제거했습니다.

사용하지 않던 `JobsCardSection`, `JobsTableDemoPage`, `/jobs-table-demo` route는 제거했습니다. `/jobs`는 `JobsLandingPage`와 `JobsTableSection`만 사용합니다.

## 4. 현재 사용 중인 공통 컴포넌트

`/jobs`는 이미 공통 컴포넌트를 꽤 많이 사용하고 있습니다.

| 영역 | 현재 컴포넌트 | 판단 |
| --- | --- | --- |
| 페이지 상단 | `PageHeader` | 유지. route 상단 표준으로 적절합니다. |
| 주요 CTA | `Button` | shadcn variant 기본 스타일로 정리했습니다. `/jobs`에서는 `primary-button`, `create-job-button` 의존을 제거했습니다. |
| 작업 현황 섹션 | `Panel`, `PanelHeader`, shadcn `Button` composition | 설명 문구를 제거하고 큰 제목/아이콘 기준으로 정리했습니다. 현황 항목은 선택 가능한 상태 필터이며, 전체 작업만 중립 tone으로 둡니다. |
| 검색 섹션 | `Panel`, `PanelHeader`, `FilterToolbar`, `FilterToolbarSearch`, `FilterToolbarInput` | 검색은 현재 목록에서 보조적으로 찾고, 상태/주기는 server-backed filter로 분리합니다. |
| 작업 목록 | `DataTable` | 유지. TanStack logic + shadcn Table UI 방향과 맞습니다. |
| table action | `IconButton`, `Tooltip` | 기존 접근성 label을 유지하고 shadcn Tooltip을 결합했습니다. |
| 상태/태그 | `StatusBadge`, `Spinner`, `Chip`, `TagList` | 목록 상태는 legacy CSS를 제거하고 `StatusBadge`로 정렬했습니다. `running` 상태에는 공통 `Spinner`를 함께 표시합니다. card/detail의 tag 패턴은 유지합니다. |
| 소유자 | ReUI-style local `Avatar`, `AvatarImage`, `AvatarFallback` | Radix Avatar primitive를 직접 사용합니다. 목록 avatar는 `lg` 크기로 표시하고, mock owner에는 임의의 프로필 사진을 연결합니다. live API에서 이미지가 없으면 이니셜 fallback, 이름, `updatedAt` 우선의 최근 수정 시각을 함께 표시합니다. |
| empty state | `EmptyState` | shadcn `Empty` 기준으로 재정렬 후보입니다. |
| 마지막 실행 이동 | `Button` link | 상태와 관계없이 `실행 이력`으로 `/jobs/:jobId/runs`에 이동합니다. |

## 5. 이번 구현에서 정리한 영역

### 5.1 검색

현재 `/jobs`는 `FilterToolbarInput` 기반 검색과 server-backed 상태/실행 주기 필터를 제공합니다. 검색어는 현재 hydrate된 결과에서 보조적으로 찾고, 상태 카드/상태 열 메뉴/실행 주기 선택은 `GET /api/etl/jobs`에 query parameter를 전달합니다. 상태 열 메뉴는 `전체`/`실행 대기`/`실행 중`/`자동 실행 중지`를 제공합니다. 실패는 지속 상태가 아니라 최근 Run 결과이므로 별도의 `Alert`에서 독립적으로 필터링합니다. 화면에 이미 로드한 목록만 상태 조건으로 잘라내지 않습니다.

작업 현황은 이전의 색상 면적이 큰 `MetricCard` 대신 shadcn `Button`을 사용한 상태 필터 카드로 바꿨습니다. `확인 필요` 중복 카드는 제거하고 `전체 작업`/`실행 중`/`실행 대기`/`자동 실행 중지` 네 개를 배치합니다. 네 카드는 현재 작업 상태라는 한 축만 나타내므로 서로 겹치지 않습니다. `자동 실행 중지`는 반복 예약이나 실시간 자동 시작이 꺼진 `stopped` 상태만 집계합니다. 비선택 카드는 중립색을 유지하고, 선택된 카드만 상태색과 `aria-pressed` 상태를 표시합니다. `facets.statusCounts`는 전체 목록 기준이므로 필터를 선택해도 현황 수치가 변하지 않습니다.

`최근 실행 실패`는 현재 상태와 다른 축이므로 현황 카드에서 분리해 shadcn `Alert`로 표시합니다. `실패 작업 보기`를 누르면 `lastRunOutcome=failed`가 적용되고, 실행 대기 같은 현재 상태 필터와 함께 조합할 수 있습니다. 결과 필터가 활성화된 동안 버튼은 `전체 작업 보기`로 바뀌며, 선택하면 상태·주기·소유자·최근 결과 query와 로컬 검색어를 모두 초기화해 실제 전체 결과로 돌아갑니다.

Job 명령 응답을 반영할 때는 상태 count뿐 아니라 `latestRunOutcomeCounts`의 성공/실패/취소 집계도 이전 Run 결과에서 새 Run 결과로 함께 이동합니다. 따라서 재실행·취소·수집 중지 후 상단 현황 카드와 목록의 최근 실행 아이콘이 서로 다른 상태로 남지 않습니다.

`실행 주기`는 비교 가능한 연속값이 아니므로 정렬을 제거했습니다. 헤더 메뉴는 `전체`/`매일`/`매주`/`매월`/`실시간`/`스케줄 없음`/`기타`를 제공하며, 같은 `scheduleKind` 값을 서버로 보냅니다.

목록의 `실행 중` 상태 badge는 `Spinner`로 진행 중임을 보조하고, 모든 목록 status badge는 shadcn `Badge`의 `rounded-md` 형태로 통일합니다. 소유자 셀은 Avatar와 이름 아래에 최근 수정일을 표시합니다. live API는 `JobRowData.createdAt`/`updatedAt`을 내려주며, 기존 데이터에 수정일이 없다면 생성일을 fallback으로 사용합니다.

### 5.2 검색 input

긴 class를 붙인 raw `Input` 사용을 제거하고 `FilterToolbarInput`으로 교체했습니다. `/catalog`, `/sql`, `/dashboards`도 같은 기준을 적용할 수 있습니다.

### 5.3 table density와 column sizing

TanStack `DataTable`과 shadcn `Table` 조합은 유지했습니다. 제목/보조 텍스트가 쌓이는 셀은 새 AskLake composition인 `DataTableStackedCell`, `DataTableCellPrimary`, `DataTableCellSecondary`로 분리했습니다. `/jobs`의 모든 컬럼 헤더 텍스트와 정렬·필터 아이콘은 소유자 헤더와 같은 `slate-600`으로 통일합니다.

기존 열 번호 기반 CSS와 아래 화면 전용 class는 삭제했습니다.

- `jobs-table-preview*`
- `jobs-table-scroll`
- `jobs-table-title-cell`
- `jobs-flow-cell`
- `jobs-table-run-cell`
- `jobs-table-next-cell`
- `jobs-table-actions*`
- `jobs-data-table`

열 너비는 기존 `DataTableColumnMeta.widthClassName`을 사용하며, status accent는 row 상태에서 명시적으로 결정합니다.

### 5.4 row action icon-only 버튼

`IconButton`의 접근성 label을 유지하고 각 row action에 shadcn `Tooltip`을 적용했습니다. `IconButton` 자체를 전역 변경하지 않아 Topbar, Dialog, Sheet에는 영향을 주지 않습니다.

목록의 기본 액션 순서는 `작업 정보 → 수정 → 스케줄 제어 → 실행 제어`입니다. 배치 스케줄 제어는 최근 Run 결과와 독립적으로 계산하므로, 즉시 실행을 취소하거나 실행이 실패해도 반복 Job의 `스케줄 일시중지`는 유지됩니다. 최근 실패에는 `재실행`, 최근 취소·성공·실행 전에는 `즉시 실행`을 제공합니다. 배치 실행 중에는 `실행 취소`만 제공하고 취소 뒤 실행 대기로 복귀합니다. 실시간은 배치와 달리 실행 중이면 `Square` 아이콘의 `실행 중지`, 실행 중이 아니면 `Play` 아이콘의 `실행`만 실행 제어로 제공합니다. `즉시 실행`, `스케줄 일시중지/재개` 문구를 실시간 Job에 사용하지 않습니다. Spark checkpoint가 아직 없으므로 `실행 일시정지/실행 재개`는 목록에서 노출하지 않습니다. 실패·취소는 마지막 실행 셀의 실제 시각, 결과 아이콘, 실행 이력으로 표현하고 별도의 실패 `Alert`로 결과 기준 필터링합니다.

### 5.5 마지막 실행의 상세 이동

목록에서 긴 실패 로그를 modal로 바로 열지 않습니다. 상태와 관계없이 `실행 이력` link로 `/jobs/:jobId/runs`에 이동하고, 로그와 DAG는 실행 이력에서 해당 Run을 선택한 뒤 확인하는 흐름으로 통일합니다. 목록의 날짜 아래 실행 결과 텍스트는 제거합니다.

### 5.6 panel hierarchy와 table 정보 순서

작업 현황, 검색, 작업 목록의 반복 설명과 헤더 배지를 제거하고 `PanelHeader` 제목과 아이콘을 한 단계 키웠습니다. 목록 table은 사용자가 다음 실행 시점을 빠르게 비교할 수 있도록 아래 순서로 재구성했습니다.

1. 상태
2. 데이터셋
3. 실행 주기
4. 다음 예정 실행
5. 마지막 실행
6. 소유자
7. 액션

최근 실행 날짜와 실행 이력 접근은 `마지막 실행` 셀에만 남겼습니다. 최근 Run이 성공이면 날짜 옆에 28px 초록 체크와 `최근 실행 성공` tooltip만 표시하고, 날짜의 28px line-height와 같은 중앙축에 정렬합니다. 성공은 Job의 지속 상태가 아니라 마지막 Run의 결과이므로, 성공 후 Job 상태는 다음 스케줄을 기다리는 `실행 대기`로 돌아갑니다. 데이터셋 아래 보조 정보는 자동 생성 Job 이름/ID 대신 실제 Source를 표시합니다. 상태와 실행 주기, 소유자 열은 header `DropdownMenu` 필터로 통일하며, 소유자 옵션은 API facets의 전체 등록 소유자를 사용합니다. 액션 header와 row action은 `DataTable.rowActionsAlign="center"` 기준으로 같은 축에 정렬했습니다. Action `IconButton`은 `sm` size와 18px icon으로 키웠습니다.

### 5.7 PageHeader 크기 기준

`PageHeader`에는 route별 `iconClassName`, `titleClassName`, `descriptionClassName` 슬롯을 추가했습니다. `/jobs`는 이후 list page 폴리싱의 기준 예시로 아이콘 `64px`, 제목 `36px`, 설명 `20px`을 사용합니다. 아이콘은 제목의 첫 줄과 같은 시작축에 두고, 설명은 제목 바로 아래에 둡니다. 아직 감사하지 않은 페이지의 기본 크기를 전역으로 바꾸지 않으며, Catalog/SQL/Dashboard를 폴리싱할 때 같은 위치와 크기 기준을 의도적으로 적용합니다.

### 5.8 글꼴 기준

`/jobs` 화면 전체는 SUIT 공식 variable font인 `SUIT Variable`을 사용합니다. 아직 감사하지 않은 다른 route에는 강제로 전파하지 않고, 각 페이지 폴리싱 시 같은 글꼴 기준을 적용할지 확인합니다.

## 6. shadcn/ReUI 대체 후보

| 현재 영역 | 대체/정렬 후보 | 우선순위 | 메모 |
| --- | --- | ---: | --- |
| 검색 input | `FilterToolbarInput` | 완료 | raw `Input`과 긴 class를 제거했습니다. |
| 서버 목록 필터 | API query + `DropdownMenu` | 부분 완료 | 상태, 실행 주기, 소유자, 최근 실행 실패는 `GET /api/etl/jobs` query/facet으로 적용했습니다. 검색과 pagination은 후속입니다. |
| row action | `IconButton` + `Tooltip` | 완료 | `/jobs` row action에 적용했습니다. 전역 흡수는 보류합니다. |
| table stacked cell | AskLake composition | 완료 | `DataTableStackedCell` 계열을 추가했습니다. |
| owner identity | ReUI-style local `Avatar` + `AvatarImage` + `AvatarFallback` | 완료 | Radix Avatar primitive 위에 이미지, 이니셜 fallback, owner label을 조합했습니다. |
| 실행 상세 이동 | route link | 완료 | 목록의 긴 로그 modal을 제거하고 실행 이력 route로 보냅니다. |
| 실행 이력 로그/DAG | `RunLogModal`, `RunDagModal` | 중간 | `/jobs/:jobId/runs` 내부의 선택 흐름과 deep link는 후속 정리 대상입니다. |
| empty state | shadcn `Empty` | 중간 | `EmptyState` 흡수 기준과 함께 처리합니다. |
| status/owner/tag pill | `Badge` variant 또는 `StatusBadge` 유지 | 낮음 | 지금 당장 바꾸면 색상 회귀 위험이 있습니다. |

## 7. 관련 CSS

주요 관련 CSS는 `frontend/src/styles/ingest.css`에 있습니다.

### 유지 필요

아래 selector는 현재 화면 렌더링에 직접 필요합니다. 바로 삭제하면 안 됩니다.

- `.jobs-landing`
- `.jobs-panel-stack`
- `.jobs-panel-metrics`
- `.owner-chip`
- `.tag-chip`

### 이번 작업에서 삭제

아래 selector는 공통 컴포넌트와 Tailwind class로 대체되어 삭제했습니다.

- `.jobs-table-preview-card`
- `.jobs-table-preview-header*`
- `.jobs-table-scroll`
- `.jobs-table-preview*`
- `.jobs-table-sort-button*`
- `.jobs-table-title-cell*`
- `.jobs-flow-cell*`
- `.jobs-table-run-cell*`
- `.jobs-table-next-cell*`
- `.jobs-table-actions*`
- `.jobs-data-table*`
- `.jobs-table-actions-column`
- `.status-pill*`
- `.danger-text`
- `.detail-metric-card*`
- `.detail-status-strip`
- `.runs-dag-card*`
- `.runs-dag-flow`
- `.summary-kv`

### 보류

아래는 `/jobs/:jobId` 또는 `/jobs/:jobId/runs`와 같이 봐야 합니다.

- `.job-action-button`
- `.owner-chip`
- `.tag-chip`
- `.job-log-modal-header`
- `responsive.css`의 `.jobs-*`, `.job-*`, `.run-*` 계열

사용하지 않는 카드형 작업 목록, `JobsTableDemoPage`, `/jobs-table-demo` route와 연결되던 `.jobs-page-header`, `.jobs-view-switch`, `.job-row*`, `.job-progress*`, `.job-table-footer`, `.jobs-table-demo-page` selector는 이번 작업에서 제거했습니다.

## 8. Interaction States

### 8.1 기본 목록 상태

확인 대상:

- mock Job 4개 표시
- status별 row accent
- 실행 주기와 다음 예정 실행
- 마지막 실행 날짜와 실행 이력 link
- action icon button
- pagination footer

QA 메모:

- 공통 stacked cell이 긴 source/target 이름을 ellipsis 처리합니다.
- table `min-width: 1242px`와 viewport 가로 스크롤이 유지됩니다.
- mock Job 4개, status accent, row action, pagination을 브라우저에서 확인했습니다.
- action header와 icon button 묶음이 중앙 정렬되는 것을 확인했습니다.

### 8.2 검색 상태

확인 대상:

- 검색어 입력
- 검색 결과 필터링
- 결과 없음 empty state
- 검색어 지우기

QA 메모:

- `FilterToolbarInput` 적용과 검색 결과 필터링을 확인했습니다.
- 검색 결과가 없으면 생성 CTA 대신 검색어 지우기 CTA를 표시합니다.

### 8.3 서버 목록 필터 검증

상태 카드, 상태/실행 주기/소유자 컬럼 필터, 최근 실행 실패 Alert는 `GET /api/etl/jobs` 서버 query로 검증합니다. 명령 실행 뒤 같은 query를 다시 조회하므로 상태가 바뀐 행이 활성 필터에 잘못 남지 않습니다. 빠르게 필터를 연속 변경할 때는 마지막 요청만 화면에 반영합니다. 서버 검색과 pagination은 별도 API 확장 작업에서 추가합니다. 이 화면에는 임시 로컬 상태 필터를 제공하지 않습니다.

### 8.4 row action 상태

확인 대상:

- 작업 정보
- 실행 이력
- 즉시 실행
- 재실행
- 수정
- 취소

QA 메모:

- icon-only action에 hover/focus 설명을 제공하는 Tooltip을 적용했습니다.
- 클릭 시 route 이동 또는 command 실행이 발생하므로 실제 구현 작업에서는 route/command regression을 조심해야 합니다.

### 8.5 실행 이력 이동

확인 대상:

- 모든 row의 `실행 이력` link
- `/jobs/:jobId/runs` route 이동

QA 메모:

- 목록 row는 long log를 직접 열지 않고 실행 이력 route로 이동합니다.
- 실행 이력에서 Run을 선택해 DAG와 원문 로그를 확인하는 흐름을 유지합니다.

## 9. 후속 작업 후보

### 공통 교체 후보

1. `DataTableStackedCell` 재사용 검증
   - `/jobs/:jobId/runs`
   - Catalog와 Dashboard의 table/list

2. icon-only action 기준 확장
   - 다른 table action에도 `Tooltip`이 필요한지 확인
   - `IconButton` 전역 동작 변경은 전체 사용처 QA 후 판단

3. 실행 이력 deep link
   - runId가 있는 URL query로 해당 Run의 DAG를 자동 선택할지 #442에서 검토

4. status/tag primitive 정리
   - `StatusBadge`, `Chip`, `TagList`의 역할이 `Badge` variant로 흡수 가능한지 #441에서 검증

### 페이지별 폴리싱 후보

1. 실제 긴 backend Job 이름과 source/target 값으로 ellipsis 확인
2. 10개를 넘는 Job에서 서버 페이지네이션과 필터 조합 확인
3. 실패/진행 중 row가 올바른 실행 이력 화면으로 이동하는지 확인
4. 모바일 shell이 상단 navigation을 세로로 쌓는 현상은 App Shell 공통 폴리싱 범위에서 재검토

## 10. 우선순위

| 우선순위 | 작업 | 이유 |
| --- | --- | --- |
| 완료 | 검색 primitive 교체 | `FilterToolbarInput`을 적용했습니다. |
| 완료 | table cell과 row action 정리 | 공통 stacked cell과 Tooltip을 적용했습니다. |
| 완료 | panel hierarchy와 현황 필터 | 설명을 제거하고 큰 제목/아이콘, shadcn Button 기반 상태 필터, server facet count를 적용했습니다. |
| 완료 | 목록 컬럼 재구성 | 상태부터 액션까지 운영자가 비교하는 순서로 정리했습니다. |
| 완료 | Source/실행 이력/소유자 정보 정리 | Source 보조 정보, 실행 이력 link, ReUI Avatar fallback을 적용했습니다. |
| P2 | 실행 이력 deep link | runId와 DAG 선택 상태를 URL에 반영할지 #442에서 결정합니다. |
| P3 | status/chip을 `Badge`로 흡수할지 재검토 | 색상/상태 회귀 위험이 있어 급하지 않습니다. |

## 11. 이번 문서에서 확정하지 않는 것

- `/jobs/:jobId` 상세 화면의 disclosure/card/table CSS 정리
- `/jobs/:jobId/runs` 실행 이력 table과 DAG modal 정리
- `IconButton` 제거
- `DialogShell` 제거
- Job 목록 filter/facet 외 Backend API, 데이터 계약, 도메인 로직 변경

## 12. 다음 액션

`#440` merge 후 `#441` 브랜치를 최신 `refactor` 기준으로 갱신합니다. `/jobs/:jobId` 구현에서는 이번에 추가한 table cell/action 기준을 무조건 확대하지 않고, 역할과 interaction이 실제로 같을 때만 재사용합니다.

`GET /api/etl/jobs`의 status/scheduleKind query와 facet contract를 적용했습니다. 다음 단계에서는 서버 페이지네이션과 검색 query를 같은 계약에 포함할지 검토합니다. `#442`에서는 실행 이력 route에 runId/DAG 선택 상태를 URL로 유지할지 결정합니다.

## 13. #441 상세 페이지 감사에서 되돌아온 공통 후보

`/jobs/:jobId` 감사 결과, `/jobs` 목록과 함께 봐야 할 공통 후보가 추가로 확인되었습니다.

| 공통 후보 | 관련 화면 | 판단 |
| --- | --- | --- |
| action button variant 기준 | `/jobs`, `/jobs/:jobId`, `/jobs/:jobId/runs` | `ActionGroup`, `Button`, `IconButton`을 모두 쓰고 있어 tone/size/tooltip 기준을 한 번에 정리하는 편이 좋습니다. |
| status/tag pill 기준 | `/jobs`, `/jobs/:jobId` | `StatusBadge`, `Chip`, `TagList`가 반복됩니다. 당장 제거보다 `Badge` 흡수 가능성을 문서로 추적합니다. |
| 실행 이력 이동 기준 | `/jobs`, `/jobs/:jobId/runs` | 목록은 실행 이력 route로 이동합니다. #442에서 runId/DAG 선택 상태의 deep link 여부를 검증합니다. |
| small table/read-only table 기준 | `/jobs/:jobId`, `/jobs/:jobId/runs` | 작은 read-only table은 shadcn `Table`, 실행 이력 table은 `DataTable` 후보로 나눠 보는 것이 좋습니다. |
| detail header/tab 기준 | `/jobs/:jobId`, `/jobs/:jobId/runs` | 같은 `JobDetailHeader`를 공유하므로 tab/header 교체는 두 route를 함께 QA해야 합니다. |

## 14. #442 실행 이력 페이지 감사에서 되돌아온 공통 후보

`/jobs/:jobId/runs` 감사 결과, `/jobs` 목록에도 영향을 주는 후보가 더 명확해졌습니다.

| 공통 후보 | 관련 화면 | 판단 |
| --- | --- | --- |
| 서버 목록 filter 기준 | `/jobs`, `/jobs/:jobId/runs` | `/jobs`의 임시 로컬 필터는 제거했습니다. 서버 query/facet contract가 정해진 뒤 각 화면에 필요한 filter UI를 결정합니다. |
| 실행 상세 기준 | `/jobs`, `/jobs/:jobId/runs` | 목록은 실행 이력 route로 이동하고, 로그와 DAG는 실행 이력에서 Run을 선택해 확인합니다. |
| table action label/tooltip | `/jobs`, `/jobs/:jobId/runs` | 목록 icon-only action에는 Tooltip을 적용했습니다. runs text action의 밀도와 비교해 공통 기준을 확정합니다. |
