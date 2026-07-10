# /jobs/:jobId Page UI Audit

상태: `1차 컴포넌트 교체 및 QA 완료`
담당 이슈: #441
대상 route: `/jobs/:jobId`
대표 확인 URL: `http://127.0.0.1:5206/jobs/JOB-001`

## 1. 화면 목적

`/jobs/:jobId`는 수집/처리 Job 하나의 상태와 설정을 확인하고 실행, 재실행, 스케줄 제어, 수정, 삭제 같은 명령을 수행하는 상세 화면입니다.

이 화면은 `/jobs` 목록과 `/jobs/:jobId/runs` 실행 이력 사이의 중간 화면입니다. 상세 header와 tab은 두 route가 공유하므로 #441에서 만든 기준이 #442 실행 이력 폴리싱의 선행 기준이 됩니다.

## 2. 이번 구현 범위

이번 단계에서는 표시 정보와 Backend API, 데이터 계약, Job 상태 로직을 바꾸지 않았습니다. #440에서 확정한 SUIT 글꼴과 local shadcn-style component 기준으로 기존 UI를 교체했습니다.

| 영역 | 변경 전 | 변경 후 |
| --- | --- | --- |
| route 글꼴 | `Gothic A1` | `SUIT Variable` |
| 상세 header | 화면 전용 header markup/CSS | `PageHeader`, `ActionGroup`, `Button`, `TagList`, `StatusBadge`, `Chip` composition |
| 상세/실행 이력 tab | `SegmentedTabs` | Radix 기반 shadcn `Tabs` |
| 핵심 정보 section | 화면 전용 section/card CSS | `Panel`, `PanelHeader`, `Card` composition |
| read-only 설정 | legacy `Field`와 input 모양의 div | `KeyValueList` |
| 접기/펼치기 | native `details`/`summary` | Radix 기반 shadcn `Accordion` |
| 상세 table | raw `table`과 화면 전용 cell CSS | `DetailTableSection` + shadcn `Table` primitive |
| 건수 표시 | plain text | shadcn `Badge` |

## 3. 현재 화면 구조

현재 `JobDetailPage`는 아래 순서로 구성됩니다.

1. `PageHeader`: breadcrumb, Job 이름, 상태, owner, tag, action
2. shadcn `Tabs`: 작업 상세 정보 / 실행 이력
3. `Panel`: 작업 핵심 정보
4. 상태별 `Card`: 최근 Run, 마지막 실행, 다음 실행
5. 기본 메타 `Card`와 `KeyValueList`
6. `Accordion`: 소스 / 타겟 설정
7. `Accordion`: 스키마 / 변환
8. `Accordion`: Schedule / Permission

첫 진입에서는 소스/타겟과 스키마/변환을 펼쳐 현재 화면의 주요 정보를 바로 확인할 수 있게 했고 Schedule/Permission은 접힌 상태로 둡니다.

## 4. 유지한 AskLake composition

shadcn primitive로 무리하게 없애지 않고 유지한 composition은 아래와 같습니다.

### `JobDetailHeader`

- `/jobs/:jobId`와 `/jobs/:jobId/runs`가 공유하는 도메인 header입니다.
- 내부 부품은 `PageHeader`, `Tabs`, `Button`, `StatusBadge`로 교체했습니다.
- 아직 `JobsPages.tsx` 내부 함수입니다. #442에서 실행 이력 화면까지 정리한 뒤 `components/ingest` 분리 여부를 결정합니다.

### `DetailSummaryStat`

- shadcn에는 이 화면 밀도에 맞는 작은 운영 지표 component가 없습니다.
- local `Card`를 바탕으로 만든 AskLake composition으로 유지합니다.
- #442의 `RunSummaryMetric`, DAG summary와 비교한 뒤 공통 `CompactMetric` 후보로 판단합니다.

### `DetailTableSection`

- table title, meta, scroll 영역을 묶는 AskLake shell입니다.
- shell은 유지하고 내부 table만 shadcn `Table`로 교체했습니다.
- 정렬, 필터, pagination이 없는 작은 read-only table이라 `DataTable`까지 사용할 필요는 없습니다.

### 상태별 작업 요약

- 상태 tone, 현재 실행 요약, 주요 action이 결합된 도메인 composition입니다.
- shadcn `Card`와 `Button`을 사용하지만 상태 해석 자체는 AskLake 로직으로 유지합니다.

## 5. 교체하지 않은 영역

이번 단계에서 의도적으로 교체하지 않은 부분입니다.

1. `/jobs/:jobId/runs` 실행 이력 table, filter, pagination
2. 실행 로그 modal과 실행 단계 DAG modal
3. `JobDetailHeader`의 별도 파일 분리
4. `DetailSummaryStat`과 실행 이력 summary의 전역 공통 component 승격
5. 상세 페이지의 정보 추가/삭제 및 정보 우선순위 변경

1~2는 #442 범위입니다. 3~4는 #442까지 함께 본 뒤 공통 API가 명확해졌을 때 진행합니다. 5는 사용자와 정보 구조를 검증한 뒤 별도 폴리싱 단계에서 결정합니다.

## 6. CSS 정리 결과

컴포넌트 교체로 사용하지 않게 된 아래 상세 전용 selector를 `frontend/src/styles/ingest.css`와 `responsive.css`에서 제거했습니다.

- `.job-detail-header`
- `.job-detail-title-row`
- `.job-detail-tabs`
- `.job-detail-section*`
- `.job-detail-card*`
- `.detail-kv-grid`
- `.detail-plain-kv-grid`
- `.job-detail-disclosure*`
- `.job-ops-summary-card*`
- `.job-summary-stat-grid`
- `.detail-summary-stat*`
- `.detail-table*`
- `.detail-row-*`
- 관련 responsive override

아래 selector는 Catalog 상세가 아직 사용하므로 삭제하지 않았습니다.

- `.job-detail-breadcrumb`
- `.job-detail-meta`
- `.job-detail-actions`
- `.job-action-button`

Catalog 상세를 해당 route의 `PageHeader`/`ActionGroup` 기준으로 교체한 뒤 제거할 수 있습니다.

## 7. QA 결과

- `cd frontend && npm run build` 통과
- `/jobs/JOB-001`에서 SUIT computed font 확인
- 상세 page 안 native `details` 0개 확인
- 상세 page 안 legacy `.field` 0개 확인
- 상세 page 안 raw `.detail-table` 0개 확인
- Accordion 3개 렌더링 및 Schedule/Permission 펼치기 확인
- `작업 상세 정보`에서 `실행 이력` tab을 눌러 `/jobs/JOB-001/runs` 이동 확인
- 1440px viewport에서 document 가로 overflow 없음
- 760px viewport에서 action overflow 및 document 가로 overflow 없음
- 좁은 화면에서 상세 table의 내부 가로 scroll container 2개 확인

Vite build의 기존 large chunk warning은 남아 있으며 이번 상세 UI 변경 범위는 아닙니다.

## 8. 다음 정보 설계 검토 항목

컴포넌트 교체 이후에는 현재 표시 정보의 필요성을 아래 기준으로 검토합니다.

1. 상세 첫 화면에서 운영자가 즉시 판단해야 하는 정보
2. 실행 이력에서 확인해야 하므로 상세에서 중복되는 정보
3. 실제 Backend 데이터가 아니라 mock 문구로만 존재하는 정보
4. 수정 화면으로 이동해야 의미가 있고 read-only 상세에서는 불필요한 정보
5. 소스, 타겟, 스키마, 변환, 스케줄, 권한 중 기본 노출과 접힘 상태를 달리할 정보

이 검토가 끝나기 전에는 현재 정보 항목을 임의로 삭제하거나 API 필드를 변경하지 않습니다.
