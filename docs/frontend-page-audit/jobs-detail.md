# /jobs/:jobId Page UI Audit

상태: `초안`
담당 이슈: #441
대상 route: `/jobs/:jobId`
대표 확인 URL: `http://127.0.0.1:5174/jobs/JOB-001`

## 1. 화면 목적

`/jobs/:jobId`는 수집/처리 Job 하나의 상세 정보를 확인하는 화면입니다. 사용자는 이 화면에서 작업 상태, 소스/타깃 설정, 스키마/변환 규칙, 스케줄/권한 정보를 확인하고 즉시 실행, 재실행, 수정, 삭제 같은 작업 명령을 실행합니다.

이 화면은 `/jobs` 목록과 `/jobs/:jobId/runs` 실행 이력 사이의 중간 화면입니다. 따라서 header, tab, action, status, detail table, key-value summary 기준을 세우기 좋은 화면입니다.

## 2. 근거 자료

확인한 주요 파일은 아래입니다.

- `frontend/src/pages/ingest/JobsPages.tsx`
- `frontend/src/components/ui/action-group.tsx`
- `frontend/src/components/ui/segmented-tabs.tsx`
- `frontend/src/components/ui/key-value-list.tsx`
- `frontend/src/components/ui/detail-table-section.tsx`
- `frontend/src/components/ui/status-badge.tsx`
- `frontend/src/components/ui/chip.tsx`
- `frontend/src/styles/ingest.css`
- `frontend/src/styles/responsive.css`
- `docs/frontend-page-audit/jobs.md`
- `docs/frontend-shadcn-replacement-inventory.md`
- `docs/frontend-component-gap-inventory.md`
- `docs/frontend-css-cleanup-inventory.md`

## 3. 현재 화면 구조

현재 `/jobs/:jobId`는 `JobDetailPage`가 렌더링합니다.

큰 구조는 아래 순서입니다.

1. 상세 header
2. 목록으로 돌아가는 breadcrumb button
3. Job title, status, owner, tag
4. Job action group
5. 상세/실행 이력 tab
6. 작업 핵심 정보 summary
7. 기본 메타 key-value card
8. 소스/타깃 설정 disclosure
9. 스키마/변환 disclosure
10. Schedule/Permission disclosure

## 4. 현재 사용 중인 공통 컴포넌트

| 영역 | 현재 컴포넌트 | 판단 |
| --- | --- | --- |
| 상세 상단 action | `ActionGroup`, `Button` | 유지. `/jobs` 목록 row action과 action density 기준을 공유할 수 있습니다. |
| 상태/메타 | `StatusBadge`, `Chip`, `TagList` | 유지. 단순 read-only pill은 장기적으로 `Badge` variant 흡수 후보입니다. |
| 상세 tab | `SegmentedTabs` | 유지 가능. shadcn `Tabs` 또는 `ToggleGroup`으로 흡수할 수 있는지 후속 판단합니다. |
| 기본 메타 | `KeyValueList` | 유지. 상세/리뷰/카탈로그 metadata에 반복되는 좋은 composition입니다. |
| 소스/타깃 설정 | legacy `Field` from `components/common` | 교체 후보. `KeyValueList` 또는 shadcn `Field` 계열로 정렬할 수 있습니다. |
| 스키마/변환 table shell | `DetailTableSection` | 유지. 내부 table은 아직 raw table입니다. |
| action button | `Button` + `job-action-button` class | 유지하되 class 의존을 줄일 후보입니다. |

## 5. 아직 약하게 컴포넌트화된 영역

### 5.1 상세 header

`JobDetailHeader`는 재사용 가능한 내부 함수처럼 보이지만 아직 `components/ui` 또는 `components/ingest`로 분리되어 있지 않습니다.

현재 포함하는 것:

- breadcrumb button
- title row
- status/owner/tag meta
- action buttons
- detail/runs tab

후보:

- `PageHeader` 확장
- `DetailPageHeader`
- `BreadcrumbButton`
- `ActionGroup`
- `Tabs` 또는 `SegmentedTabs`

판단:

- `/jobs/:jobId`와 `/jobs/:jobId/runs`가 같은 `JobDetailHeader`를 공유합니다.
- 이 header는 이미 코드 함수로 묶여 있으므로, 후속 구현에서는 파일 분리나 shadcn `Tabs` 정렬을 검토할 수 있습니다.
- 단, title/action/tab이 한 덩어리라서 너무 빨리 일반화하면 props가 과해질 수 있습니다.

### 5.2 disclosure section

상세 정보는 native `<details>`/`<summary>`와 `.job-detail-disclosure` CSS로 구성되어 있습니다.

후보:

- shadcn `Collapsible`
- shadcn `Accordion`
- AskLake `DisclosureSection`

판단:

- 현재 shadcn foundation 목록에 `Collapsible`/`Accordion`은 아직 명확히 표준으로 들어와 있지 않습니다.
- 상세 화면, ETL review, Catalog detail에서 접고 펼치는 패턴이 반복되면 `DisclosureSection` 또는 shadcn `Accordion` 도입을 검토할 가치가 있습니다.
- 지금 당장 CSS만 지우면 summary indicator와 spacing이 깨질 가능성이 큽니다.

### 5.3 상세 card layout

`job-ops-summary-card`, `job-detail-card`, `metadata-card`, `detail-summary-stat` 등이 화면 CSS에 강하게 묶여 있습니다.

후보:

- `Panel`
- `Card`
- `MetricCard`
- `KeyValueList`
- `DetailSummaryCard` composition

판단:

- page section은 `Panel`, 반복 item은 `Card`라는 원칙을 적용하면 정리가 쉬워집니다.
- `job-ops-summary-card`는 status tone과 action이 섞여 있어 단순 `Card` 교체만으로는 부족합니다.
- `detail-summary-stat`은 `/jobs/:jobId/runs`의 `RunSummaryMetric`과 비슷하므로 metric summary composition 후보입니다.

### 5.4 key-value 영역

기본 메타는 `KeyValueList`로 정리되어 있지만, 소스/타깃/Schedule/Permission은 legacy `Field`와 `.detail-kv-grid`를 사용합니다.

후보:

- `KeyValueList`
- shadcn `Field`
- read-only `DescriptionList`

판단:

- read-only metadata는 `KeyValueList`로 통일하는 편이 가장 단순합니다.
- form 입력이 아닌 read-only 값이므로 shadcn `Field`보다 `KeyValueList`가 더 자연스럽습니다.
- `/etl/review`, `/catalog/:datasetId`, `/dashboards/:dashboardId`에서도 같은 패턴이 나올 수 있습니다.

### 5.5 상세 table

`DetailTableSection`으로 shell은 정리되어 있지만 내부는 raw `<table className="schema-table detail-table">`입니다.

후보:

- shadcn `Table`
- `DataTable`
- `DetailTableSection` + shadcn `Table`

판단:

- 정렬/필터/페이지네이션이 필요 없는 작은 read-only table이므로 `DataTable`까지 올릴 필요는 낮습니다.
- shadcn `Table` primitive를 쓰면 CSS selector를 줄일 수 있습니다.
- `/jobs/:jobId/runs` 실행 이력 table은 행 수와 액션이 더 많아 `DataTable` 후보로 보는 게 낫습니다.

## 6. shadcn/ReUI 대체 후보

| 현재 영역 | 대체/정렬 후보 | 우선순위 | 메모 |
| --- | --- | ---: | --- |
| 상세 tab | shadcn `Tabs` 또는 `ToggleGroup` | 중간 | `SegmentedTabs` 흡수 정책과 함께 판단합니다. |
| disclosure | shadcn `Accordion`/`Collapsible` 또는 AskLake `DisclosureSection` | 중간 | 현재 foundation에 없으면 먼저 inventory 업데이트가 필요합니다. |
| read-only field grid | `KeyValueList` | 높음 | legacy `Field`를 줄일 수 있습니다. |
| summary stat | `MetricCard` variant 또는 `SummaryStat` composition | 중간 | `/jobs-runs`와 함께 보면 반복성이 더 명확합니다. |
| 상세 table | shadcn `Table` | 중간 | 작은 read-only table에 적합합니다. |
| action cluster | `ActionGroup` 유지 + button variant 정리 | 높음 | 이미 적용되어 있고 CSS 의존만 줄이면 됩니다. |
| status/tag | `Badge` variant 또는 `StatusBadge` 유지 | 낮음 | 색상 회귀 위험이 있어 천천히 봅니다. |

## 7. 관련 CSS

주요 관련 CSS는 `frontend/src/styles/ingest.css`와 `frontend/src/styles/responsive.css`에 있습니다.

### 유지 필요

- `.job-detail-page`
- `.job-detail-header`
- `.job-detail-breadcrumb`
- `.job-detail-title-row`
- `.job-detail-meta`
- `.job-detail-actions`
- `.job-detail-tabs`
- `.job-detail-section`
- `.job-detail-overview-grid`
- `.job-ops-summary-card`
- `.job-summary-stat-grid`
- `.detail-summary-stat`
- `.job-detail-card`
- `.detail-kv-grid`
- `.detail-plain-kv-grid`
- `.job-detail-disclosure`
- `.job-detail-disclosure-body`
- `.detail-table-card`
- `.detail-table-header`
- `.detail-table`

### 교체 후보

- `.job-detail-card .field`
- `.job-detail-card .input`
- `.detail-kv-grid`
- `.detail-plain-kv-grid`
- `.detail-summary-stat`
- `.detail-table th`
- `.detail-table td`
- `.detail-row-danger`
- `.detail-row-running`

### 보류

- `.job-action-button`
- `.status-pill`
- `.owner-chip`
- `.tag-chip`
- `.job-detail-disclosure`
- `responsive.css`의 `.job-detail-*`, `.detail-*` 계열

## 8. Interaction States

### 8.1 기본 상세 상태

확인 대상:

- title과 Job ID가 긴 경우
- status/owner/tag pill 간격
- action button wrap
- 상세 tab 선택 상태
- summary card tone

QA 메모:

- 상세 header는 정보가 많아서 좁은 화면에서 줄바꿈이 중요합니다.
- action button이 많아지는 failed/paused 상태에서 overflow를 확인해야 합니다.

### 8.2 disclosure open/close 상태

확인 대상:

- 소스/타깃 설정 접기/펼치기
- 스키마/변환 접기/펼치기
- Schedule/Permission 접기/펼치기

QA 메모:

- native `<details>`는 동작 자체는 안정적입니다.
- 다만 shadcn 스타일과 시각적으로 맞추려면 `Accordion`/`Collapsible` 기준을 먼저 정해야 합니다.

### 8.3 상세 table 상태

확인 대상:

- schema rows
- rule rows
- failed/running row tone
- 긴 cell text
- 모바일 가로 overflow

QA 메모:

- 작은 table은 shadcn `Table`로 정리 가능성이 큽니다.
- 행 상태 색상은 `Badge`/tone helper와 맞출 수 있는지 봐야 합니다.

## 9. `/jobs` 문서와 함께 봐야 할 공통 후보

`/jobs` 목록 문서에도 같이 반영할 후보입니다.

1. `ActionGroup` + action button variant 기준
   - 목록 row action, 상세 header action, 실행 이력 table action이 모두 같은 계열입니다.

2. status/tag pill 기준
   - 목록, 상세, 실행 이력에서 `StatusBadge`, `Chip`, `TagList`가 반복됩니다.

3. detail/log dialog 기준
   - 목록의 `JobLogModal`과 실행 이력의 `RunLogModal`은 같은 `LogViewerDialog` 후보입니다.

4. small detail table 기준
   - 상세의 schema/rule table과 실행 이력의 runs table은 서로 다르지만, table shell/density 기준은 같이 봐야 합니다.

5. detail header/tab 기준
   - 상세와 실행 이력이 같은 header를 공유하므로, shadcn `Tabs` 전환 시 두 route를 같이 QA해야 합니다.

## 10. 후속 작업 후보

### 공통 교체 후보

1. `JobDetailHeader` 파일 분리 또는 `DetailPageHeader` 후보화
2. read-only metadata를 `KeyValueList`로 통일
3. 작은 read-only table을 shadcn `Table`로 정리
4. disclosure를 shadcn `Accordion`/`Collapsible` 또는 AskLake `DisclosureSection`으로 정리
5. `detail-summary-stat`과 `RunSummaryMetric`을 summary metric component로 묶기

### 페이지별 폴리싱 후보

1. 긴 Job name과 action button wrap 확인
2. disclosure spacing과 indicator 정리
3. summary card tone이 shadcn palette와 맞는지 확인
4. detail table density와 모바일 overflow 확인
5. legacy `Field`와 `.detail-kv-grid` 제거 가능성 검토

## 11. 우선순위

| 우선순위 | 작업 | 이유 |
| --- | --- | --- |
| P1 | legacy `Field` read-only 영역을 `KeyValueList`로 통일 | 입력 UI가 아니라 정보 표시라 안전하게 줄일 수 있습니다. |
| P1 | 상세/실행 이력 header QA | 두 route가 공유하므로 깨지면 영향이 큽니다. |
| P2 | 작은 table을 shadcn `Table`로 정리 | CSS selector를 줄일 수 있습니다. |
| P2 | disclosure 표준 후보 결정 | 여러 상세/리뷰 화면에 반복될 수 있습니다. |
| P3 | status/chip `Badge` 흡수 | 색상 회귀 위험이 있어 나중에 봅니다. |

## 12. 이번 문서에서 확정하지 않는 것

- `/jobs/:jobId/runs` 실행 이력 table과 DAG modal 구현 정리
- `SegmentedTabs`를 즉시 shadcn `Tabs`로 교체할지 여부
- shadcn `Accordion`/`Collapsible` 추가 여부
- CSS selector 삭제
- Backend API, 데이터 계약, 도메인 로직 변경

## 13. 다음 액션

`/jobs/:jobId/runs` 문서에서 실행 이력 table, 로그 modal, DAG modal을 감사한 뒤 아래 세 묶음을 다시 판단합니다.

1. 상세/실행 공통 header와 tab
2. log/detail modal
3. table shell과 summary metric

## 14. #442 실행 이력 페이지 감사에서 되돌아온 공통 후보

`/jobs/:jobId/runs` 감사 결과, 상세 페이지에서도 함께 봐야 할 후보가 더 구체화되었습니다.

| 공통 후보 | 관련 화면 | 판단 |
| --- | --- | --- |
| compact summary metric | `/jobs/:jobId`, `/jobs/:jobId/runs` | `DetailSummaryStat`, `RunSummaryMetric`, `DagSummaryCard`가 모두 유사합니다. `MetricCard`보다 더 작은 summary metric variant가 필요할 수 있습니다. |
| header/tab QA | `/jobs/:jobId`, `/jobs/:jobId/runs` | 같은 `JobDetailHeader`를 공유하므로 shadcn `Tabs` 전환은 두 route를 같이 검증해야 합니다. |
| table 기준 분리 | `/jobs/:jobId`, `/jobs/:jobId/runs` | 상세의 작은 table은 shadcn `Table`, 실행 이력 table은 `DataTable` 후보로 나누는 것이 좋습니다. |
| DAG/flow surface | `/jobs/:jobId/runs`, `/etl/rules` | DAG modal은 ETL rule builder와 함께 복합 화면 폴리싱 후보로 추적합니다. |
