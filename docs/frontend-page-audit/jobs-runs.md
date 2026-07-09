# /jobs/:jobId/runs Page UI Audit

상태: `초안`
담당 이슈: #442
대상 route: `/jobs/:jobId/runs`
대표 확인 URL: `http://127.0.0.1:5174/jobs/JOB-001/runs`

## 1. 화면 목적

`/jobs/:jobId/runs`는 특정 수집/처리 Job의 실행 이력을 보는 화면입니다. 사용자는 이 화면에서 성공률, 평균 소요시간, 총 실행 수를 확인하고, 각 Run의 상태/시간/입출력 row/실패 단계/로그를 확인합니다.

이 화면의 핵심은 단순한 페이지 하나가 아니라 아래 세 가지 상태를 함께 검증하는 것입니다.

1. 실행 이력 table
2. Run 로그 modal
3. 실행 단계/DAG modal

## 2. 근거 자료

확인한 주요 파일은 아래입니다.

- `frontend/src/pages/ingest/JobsPages.tsx`
- `frontend/src/components/ui/detail-table-section.tsx`
- `frontend/src/components/ui/dialog-shell.tsx`
- `frontend/src/components/ui/pagination-bar.tsx`
- `frontend/src/components/ui/status-badge.tsx`
- `frontend/src/components/ui/button.tsx`
- `frontend/src/styles/ingest.css`
- `frontend/src/styles/ingest-dag.css`
- `frontend/src/styles/responsive.css`
- `docs/frontend-page-audit/jobs.md`
- `docs/frontend-page-audit/jobs-detail.md`
- `docs/frontend-shadcn-replacement-inventory.md`
- `docs/frontend-component-gap-inventory.md`
- `docs/frontend-css-cleanup-inventory.md`

## 3. 현재 화면 구조

현재 `/jobs/:jobId/runs`는 `JobRunsPage`가 렌더링합니다.

큰 구조는 아래 순서입니다.

1. `JobDetailHeader`
2. 실행 통계 요약
3. 실행 이력 filter bar
4. 실행 이력 table
5. table footer pagination
6. `RunLogModal`
7. `RunDagModal`
8. DAG modal 내부 search panel

## 4. 현재 사용 중인 공통 컴포넌트

| 영역 | 현재 컴포넌트 | 판단 |
| --- | --- | --- |
| 상세 공통 header | `JobDetailHeader`, `ActionGroup`, `SegmentedTabs` | `/jobs/:jobId`와 공유합니다. header/tab 전환은 두 route를 함께 QA해야 합니다. |
| 실행 통계 요약 | custom `RunSummaryMetric` | 공통화 후보입니다. 상세 화면의 `DetailSummaryStat`과 유사합니다. |
| 필터/새로고침 | `Button` | 유지. 다만 menu/datepicker는 아직 실제 primitive가 아닙니다. |
| 실행 이력 table shell | `DetailTableSection` | shell은 공통화되어 있으나 내부 table은 raw table입니다. |
| pagination | `PaginationBar` | 유지. 실행 이력 table footer에 잘 맞습니다. |
| 상태 pill | `StatusBadge` | 유지. `RunStatusPill` tone mapper만 남기는 방식이 자연스럽습니다. |
| 로그 modal | `DialogShell`, `Button` | 유지 가능. 내부 로그 body는 `ScrollArea`/`LogViewer` 후보입니다. |
| DAG modal | `DialogShell`, `StatusBadge`, `Button` 일부 raw button | shell은 공통화됐지만 내부 canvas/search/control은 화면 전용 CSS가 강합니다. |

## 5. 아직 약하게 컴포넌트화된 영역

### 5.1 실행 통계 요약

현재 `RunSummaryMetric`은 이 파일 내부 함수이고 `.runs-stats-summary`, `.run-summary-metric` CSS에 의존합니다.

후보:

- `MetricCard`
- `SummaryMetric`
- `StatsSummaryPanel`

판단:

- `/jobs/:jobId`의 `DetailSummaryStat`과 거의 같은 계열입니다.
- 목록의 `MetricCard`와는 화면 밀도가 다르므로, 무조건 `MetricCard`로 바꾸기보다 compact metric variant가 필요할 수 있습니다.

### 5.2 실행 이력 filter bar

현재 상태/날짜 필터는 `Button`으로만 표시되고 실제 `DropdownMenu`나 date picker는 없습니다.

후보:

- `FilterToolbar`
- `DropdownMenu`
- `Popover`
- future `Calendar`

판단:

- `/jobs` 목록의 filter button과 같은 문제입니다.
- 실제 filter 기능을 구현하지 않는다면 버튼처럼 보이지만 menu가 없는 상태를 줄이거나, 후속 구현 후보임을 문서화해야 합니다.

### 5.3 실행 이력 table

현재 table은 raw `<table className="runs-table">`입니다.

후보:

- `DataTable`
- shadcn `Table`
- `DetailTableSection` + shadcn `Table`

판단:

- 실행 이력은 row action, status, pagination, empty row가 있으므로 `DataTable` 전환 후보입니다.
- 단, column이 10개라 폭/scroll QA가 중요합니다.
- 간단히 shadcn `Table`만 적용하면 기능은 유지되지만 column sizing CSS는 계속 많이 남을 수 있습니다.

### 5.4 로그 modal

`RunLogModal`은 `JobLogModal`과 거의 같은 구조입니다.

공통점:

- `DialogShell`
- close button
- `pre` 기반 로그 본문
- 긴 로그 scroll
- job/run metadata header

후보:

- `LogViewerDialog`
- `DialogShell` + `ScrollArea`
- `CodeBlock`

판단:

- `/jobs` 목록의 failed row 로그 modal과 같이 묶는 것이 좋습니다.
- body는 shadcn `ScrollArea`를 적용하기 좋습니다.

### 5.5 DAG modal

`RunDagModal`은 `DialogShell`로 감싸져 있지만 내부는 매우 화면 고유적입니다.

현재 특징:

- run selector button
- summary grid
- DAG canvas
- node button
- legend/status pill
- search toggle
- raw input search panel

후보:

- `FlowCanvasPanel`
- `DagNode`
- `SummaryMetric`
- `InputGroup`
- `Button size="icon"`
- `Tooltip`
- `ScrollArea`

판단:

- 이 영역은 shadcn primitive만으로 완전히 대체하기 어렵습니다.
- React Flow나 DAG 전용 컴포넌트가 아니고 직접 그린 구조라, 큰 변경은 별도 “DAG surface polish” PR로 빼는 것이 안전합니다.
- 지금 페이지 PR에서는 search input/button 같은 작은 primitive 교체와 overflow/텍스트 QA부터 접근하는 게 좋습니다.

## 6. shadcn/ReUI 대체 후보

| 현재 영역 | 대체/정렬 후보 | 우선순위 | 메모 |
| --- | --- | ---: | --- |
| 실행 filter bar | `FilterToolbar`, `DropdownMenu`, `Popover` | 중간 | `/jobs` filter와 함께 정리합니다. |
| runs table | `DataTable` 또는 shadcn `Table` | 높음 | row action과 pagination 때문에 `DataTable` 후보가 큽니다. |
| table action | `Button`/`Button size="icon"` + `Tooltip` | 중간 | “로그 보기”, “실행 단계 보기” 액션 기준이 필요합니다. |
| log modal body | `ScrollArea`, `LogViewerDialog` | 높음 | `/jobs` 로그 modal과 거의 같습니다. |
| DAG search panel | `InputGroup`, `Button size="icon"` | 중간 | raw `<input>`과 raw `<button>`가 남아 있습니다. |
| DAG canvas scroll | `ScrollArea` | 중간 | canvas overflow를 shadcn 기준으로 정렬할 수 있습니다. |
| summary metric | compact `MetricCard` 또는 `SummaryMetric` | 중간 | 상세 페이지와 같이 봐야 합니다. |

## 7. 관련 CSS

주요 관련 CSS는 `frontend/src/styles/ingest.css`, `frontend/src/styles/ingest-dag.css`, `frontend/src/styles/responsive.css`에 있습니다.

### 유지 필요

- `.job-runs-page`
- `.runs-body-content`
- `.runs-stats-summary`
- `.run-summary-metric`
- `.runs-filter-bar`
- `.runs-filters-left`
- `.runs-filters-right`
- `.runs-table-card`
- `.runs-table-scroll`
- `.runs-table`
- `.run-row`
- `.run-status-pill`
- `.runs-pagination`
- `.run-dag-modal-panel`
- `.run-dag-modal-body`
- `.dag-body-content`
- `.dag-summary-grid`
- `.dag-flow-card`
- `.dag-canvas-scroll`
- `.dag-canvas-expanded`
- `.dag-step-node`

### 교체 후보

- `.runs-filter-button`
- `.runs-refresh-button`
- `.runs-detail-button`
- `.runs-log-button`
- `.runs-table th`
- `.runs-table td`
- `.runs-table th:nth-child(...)`
- `.runs-table td:nth-child(...)`
- `.dag-run-select`
- `.dag-flow-controls button`
- `.dag-search-panel input`
- `.dag-summary-card`

### 보류

- `.dag-graph`
- `.dag-row`
- `.dag-arrow`
- `.dag-step-node`
- `.dag-step-dot`
- `.dag-step-footer`
- `.dag-selected-strip`

DAG canvas 관련 selector는 단순 CSS cleanup으로 지우기 어렵습니다. 먼저 컴포넌트 설계가 필요합니다.

## 8. Interaction States

### 8.1 기본 실행 이력 상태

확인 대상:

- 실행 통계 3개 표시
- runs count
- status/date filter button
- refresh button
- runs table 10개 column
- empty run row
- pagination footer

QA 메모:

- column이 많아 좁은 화면에서는 horizontal scroll이 필수입니다.
- 버튼 label이 길어지면 row height가 커질 수 있습니다.

### 8.2 로그 보기 modal

확인 대상:

- “로그 보기” 클릭
- modal header metadata
- 긴 로그 scroll
- close button
- ESC/backdrop close

QA 메모:

- `/jobs`의 `JobLogModal`과 같은 형태로 정리할 수 있습니다.
- 로그 본문은 shadcn `ScrollArea` 또는 `LogViewerDialog`로 묶기 좋습니다.

### 8.3 실행 단계 보기 modal

확인 대상:

- “실행 단계 보기” 클릭
- DAG summary cards
- run selector button
- DAG node hover/focus/click
- search toggle
- search input panel
- canvas scroll

QA 메모:

- modal 안에 정보량이 많아 mobile/short viewport에서 overflow가 중요합니다.
- raw input/button이 남아 있어 primitive 교체 후보가 있습니다.

### 8.4 DAG search state

확인 대상:

- search icon button click
- search panel open/close
- input text alignment
- found count label

QA 메모:

- 현재는 defaultValue가 들어간 UI 상태라 실제 검색 기능과 별개로 보입니다.
- `InputGroup`으로 교체할 수 있지만, 기능 구현과 섞이지 않게 주의해야 합니다.

## 9. 앞선 페이지 문서에 반영할 공통 후보

`/jobs`와 `/jobs/:jobId` 문서에도 같이 반영할 후보입니다.

| 공통 후보 | 관련 화면 | 판단 |
| --- | --- | --- |
| `LogViewerDialog` | `/jobs`, `/jobs/:jobId/runs` | 두 로그 modal이 같은 구조입니다. |
| compact summary metric | `/jobs/:jobId`, `/jobs/:jobId/runs` | `DetailSummaryStat`, `RunSummaryMetric`, `DagSummaryCard`가 유사합니다. |
| runs/detail table 기준 | `/jobs/:jobId`, `/jobs/:jobId/runs` | 작은 read-only table과 실행 이력 table을 구분해야 합니다. |
| filter menu 기준 | `/jobs`, `/jobs/:jobId/runs` | 둘 다 “버튼처럼 보이지만 실제 menu는 없는” 상태입니다. |
| DAG/flow surface | `/jobs/:jobId/runs`, ETL rules | 그래프/룰 빌더 계열은 복합 화면 폴리싱 후보입니다. |

## 10. 후속 작업 후보

### 공통 교체 후보

1. `LogViewerDialog` 추가
2. compact `SummaryMetric` 또는 `MetricCard` variant 설계
3. runs table을 `DataTable`로 전환할지 shadcn `Table`로 정리할지 결정
4. `FilterToolbar` + `DropdownMenu` 기준으로 filter bar 통일
5. DAG modal 내부 raw input/button을 `InputGroup`, `Button`, `ScrollArea`로 교체

### 페이지별 폴리싱 후보

1. runs table column width와 overflow 확인
2. 로그 modal scroll/focus/close 상태 확인
3. DAG modal height와 scroll 영역 분리
4. DAG search panel text/input alignment 확인
5. 실행 이력 empty state 문구/spacing 확인

## 11. 우선순위

| 우선순위 | 작업 | 이유 |
| --- | --- | --- |
| P1 | `RunLogModal`/`JobLogModal`을 `LogViewerDialog` 후보로 정리 | 두 화면에서 거의 동일하게 반복됩니다. |
| P1 | runs table의 `DataTable` 전환 가능성 검토 | row action/pagination/empty가 있어 공통 table 기준과 맞습니다. |
| P2 | DAG modal 내부 primitive 교체 | raw input/button이 보이지만 canvas 자체는 별도 설계가 필요합니다. |
| P2 | compact summary metric 후보화 | 상세/runs/DAG summary에서 반복됩니다. |
| P3 | filter button 실제 menu화 | 기능 범위가 커질 수 있어 후속으로 둡니다. |

## 12. 이번 문서에서 확정하지 않는 것

- DAG canvas 자체를 새 라이브러리로 교체할지 여부
- 실행 이력 table을 바로 `DataTable`로 바꾸는 구현
- 실제 filter/date picker 기능 구현
- CSS selector 삭제
- Backend API, 데이터 계약, 도메인 로직 변경

## 13. 다음 액션

수집/처리 Job 세 페이지를 함께 보면 우선순위는 아래처럼 정리됩니다.

1. `LogViewerDialog`
2. action button/tooltip 기준
3. detail/runs table 기준
4. compact summary metric 기준
5. filter toolbar/dropdown 기준

이후 ETL flow 페이지를 감사하면서 form, tree, rule builder, command bar 쪽 후보를 별도로 쌓아야 합니다.
