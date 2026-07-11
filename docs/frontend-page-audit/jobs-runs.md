# /jobs/:jobId/runs UI 감사 및 구현 기록

상태: `구현 완료`
담당 이슈: #442
대상 route: `/jobs/:jobId/runs`
대표 확인 URL: `http://127.0.0.1:5174/jobs/JOB-001/runs`

## 1. 화면 목적

이 화면은 특정 수집/처리 Job의 실행 결과와 단계별 진단 정보를 확인하는 운영 화면입니다.

사용자는 여기에서 다음 질문에 답할 수 있어야 합니다.

1. 최근 실행이 성공했는가?
2. 실행에 얼마나 걸렸는가?
3. 입력 데이터가 몇 행이고 출력 데이터가 몇 행인가?
4. 실패했다면 어느 단계에서 어떤 원인으로 실패했는가?
5. 각 실행 단계는 어떤 순서와 상태로 처리되었는가?

## 2. 이번 구현 결과

### 실행 통계 요약

- `Panel`, `PanelHeader`, `MetricCard`로 공통화했습니다.
- 실행 성공률, 평균 실행 시간, 누적 실행 수, 최근 실행 결과를 표시합니다.
- 기존 3개 단순 텍스트 통계를 4개 요약 카드로 변경했습니다.
- `MetricCard`에 `icon`, `detail`, `size` API를 두고 page는 `default`, 실행 단계 Dialog는 `compact`를 사용합니다.
- 집계 기간 Backend 계약이 없으므로 특정 기간이나 실행 횟수를 임의로 붙이지 않고 `집계된 종료 Run 기준`이라고 표시합니다.

### 실행 이력 표

- raw `<table>`을 `DataTable`로 교체했습니다.
- 엔진은 TanStack Table, 표 UI는 로컬 shadcn-style `Table`을 사용합니다.
- 페이지당 5개 Run을 표시합니다.
- 표 밖의 독립 상태 필터는 제거했습니다.
- `/jobs` 목록과 같은 방식으로 상태 column header에 `DropdownMenu` filter를 결합했습니다.
- 상태 filter option은 현재 Run 목록에 실제로 존재하는 상태만 표시하고 각 상태의 건수를 함께 노출합니다.
- 상태 문구는 `실행 대기`, `실행 중`, `성공`, `실패`, `취소`를 `runStatusMeta` 한 곳에서 공유합니다.
- `실행 ID`와 `실행 시간`은 TanStack sorting을 제공하며 기본 정렬은 실행 시간 내림차순입니다.
- `/jobs` 목록과 같은 header/filter/action/pagination 시각 체계를 사용하되, 실행 이력은 정보 밀도에 맞춰 860px 최소 table, 48px header, 96px row의 compact density를 사용합니다.
- 공통 컴포넌트 사용은 동일한 물리 크기를 뜻하지 않으며, 일반 데스크톱에서는 모든 열과 action이 한 화면에 보이도록 폭을 제한합니다.
- 날짜 선택처럼 기능이 없는 가짜 버튼은 제거했습니다.
- 열 구성은 아래와 같습니다.

| 열 | 의미 |
| --- | --- |
| 실행 ID | Run 실행 식별자 |
| 상태 | 대기, 실행 중, 성공, 실패, 취소 |
| 실행 시간 | 시작, 종료, 전체 소요시간 |
| 처리 행 | 입력 행에서 출력 행으로 이어지는 처리량 |
| 결과 요약 | 정상 완료 또는 실패 단계와 원인 요약 |
| 액션 | `로그 보기`, `실행 단계 보기` text action |

### 상태 표현

- 성공: 초록색 `StatusBadge`
- 실패: 빨간색 `StatusBadge`
- 취소: 회색 `StatusBadge`
- 실행 중: 초록색 badge와 `Spinner`
- 대기 중: 회색 `StatusBadge`

### 로그 Dialog

- `DialogShell`을 유지했습니다.
- 표의 로그와 실행 단계 action은 파란색 text link를 세로로 배치해 `로그 보기`, `실행 단계 보기`를 직접 읽을 수 있게 했습니다.
- 성공 Run의 결과 요약은 `정상 완료`만 표시하고 반복 설명은 제거합니다. 실패·취소·진행 중에는 진단에 필요한 보조 문구를 유지합니다.
- 로그 본문은 진단 정보이므로 고정폭 글꼴을 유지합니다.

### 실행 단계 Dialog

`origin/codex/run-observability-ui`의 화면 구조를 현재 공통 컴포넌트 기준으로 이식했습니다.

- 기존의 작은 DAG 격자와 검색 시늉 UI를 제거했습니다.
- 왼쪽은 ReUI `c-timeline-10` deployment-log 패턴을 AskLake 데이터에 맞춘 `Timeline`, 오른쪽은 선택 단계 상세로 구성했습니다.
- 단계 선택 시 상세 정보와 진단 메시지가 갱신됩니다.
- `TimelineIndicator`와 `TimelineSeparator`를 같은 item 레일에 배치해 상태 아이콘과 연결선 중심을 일치시켰습니다.
- 단계 항목은 별도 card border 없이 제목 옆 상태 Badge, 메타·소요시간, 완료 시각을 순서대로 표시합니다.
- 선택 항목은 레일을 덮지 않고 제목 색과 indicator ring, 짧은 이동으로만 강조하며 inspector 전환에 짧은 motion을 적용했습니다.
- Run별 `dagStepsByRunId`를 우선 사용해 다른 Run의 단계가 섞이지 않게 했습니다.
- 요약 영역은 `MetricCard size="compact"`를 사용하고 `이 Run의 상태`, `이 Run의 소요 시간`, `완료 단계`, `이 Run의 입력 행`처럼 단일 Run 범위를 label에 명시합니다.
- 단계 상태는 `StatusBadge`, 진행 상태는 `Spinner`를 사용합니다.
- Dialog shell은 `DialogShell`, 섹션 제목은 `PanelHeader`를 사용합니다.

## 3. 공통 컴포넌트 기준

| 역할 | 컴포넌트 |
| --- | --- |
| 섹션 외곽 | `Panel` |
| 섹션 제목 | `PanelHeader` |
| 통계 카드 | `MetricCard size="default"` |
| 실행 이력 | `DataTable` |
| 상태 | `StatusBadge` |
| 상태 필터 | 상태 column header의 `DropdownMenu` |
| 액션 | `Button variant="link"` |
| Modal | `DialogShell` |
| 진행 표시 | `Spinner` |
| Modal 통계 카드 | `MetricCard size="compact"` |
| 실행 단계 레일 | ReUI `Timeline`, `TimelineItem`, `TimelineIndicator`, `TimelineSeparator` |
| 실행 단계 스크롤 | shadcn `ScrollArea` |

표면별 조합 컴포넌트는 유지하지만, 단일 primitive를 다시 만드는 CSS는 추가하지 않습니다.

## 4. 제거한 legacy UI/CSS

아래 구현과 selector는 공통 컴포넌트로 대체되어 제거했습니다.

- raw 실행 이력 table과 `nth-child` 열 너비 CSS
- `.runs-filter-*`
- `.runs-table-*`
- `.run-status-pill*`
- `.runs-detail-button`, `.runs-log-button`
- `.runs-pagination`
- `.runs-stats-summary`, `.run-summary-metric`
- 기존 DAG grid, arrow, node, search panel, selected strip CSS
- `.dag-timeline-*` 수제 연결선, marker, 선택 item CSS
- 실행 이력과 DAG의 중복 반응형 selector

현재 남은 `ingest-dag.css`는 Dialog workbench와 단계 inspector처럼 화면 배치 및 진단 정보 표현에 필요한 복합 UI 전용입니다.

단계별 `duration`, `completedAt`은 Backend가 제공하면 그대로 사용합니다. 값이 없을 때 frontend는 가짜 시간을 계산하지 않고 `소요시간 미수집`, `현재 실행 중`, `실행 대기`처럼 수집 상태를 표시합니다.

## 5. 백엔드 계약 후속 항목

이번 작업에서는 Backend API와 데이터 계약을 변경하지 않았습니다. 아래 값은 현재 mock 또는 프론트에 전달된 값으로 표현합니다.

### 실행 이력 API

운영 데이터가 커지면 아래 요청 조건이 필요합니다.

- `status`
- `startedFrom`, `startedTo`
- `page`, `pageSize`
- 서버가 계산한 `totalCount`

성공률과 평균 소요시간에는 반드시 집계 기간이 함께 정의되어야 합니다. 예: 최근 30일 또는 최근 100회.

### 로그 API

현재 `errorSummary`만으로는 전체 로그를 대체할 수 없습니다. 후속 계약에서는 아래 항목이 필요합니다.

- 전체 또는 chunk 단위 로그 조회
- 로그 timestamp와 level
- 단계 ID
- 다음 page/cursor
- 로그 보관 만료 여부

### 실행 단계 API

Run별 단계 목록에는 아래 정보가 필요합니다.

- 단계 ID, 순서, 상태
- 시작/종료 시각과 소요시간
- 단계별 입력/출력 행
- 오류 코드와 사용자용 오류 요약
- 진단 로그 또는 로그 조회 식별자

Airflow DAG ID, DAG Run ID, Airflow URL, 동기화 시각은 현재 계약에 없습니다. 실제 계약이 추가되기 전에는 화면에 가짜 값으로 표시하지 않습니다.

## 6. QA 체크리스트

- `/jobs/JOB-001/runs`: 성공 Run과 통계 카드
- `/jobs/JOB-002/runs`: 실패 Run, 빨간 badge, 실패 요약
- 상태 column header filter 선택 및 해제
- 현재 Run 목록에 없는 상태 option이 filter에서 제외되는지 확인
- 실행 ID 오름차순/내림차순 및 실행 시간 최신순/과거순 정렬 확인
- `/jobs` 목록과 실행 이력의 header, action, pagination 시각 체계 비교
- 일반 데스크톱에서 실행 이력 전체 열과 action이 가로 scroll 없이 보이는지 확인
- 페이지당 5개 pagination
- 로그 Dialog 열기, 스크롤, 닫기
- 실행 단계 Dialog 열기, 단계 선택, inspector 변경
- 짧은 화면에서 Dialog 내부 스크롤
- 920px 이하에서 타임라인과 inspector의 세로 배치
- SUIT 글꼴, focus, hover, 텍스트 잘림

## 7. 보류 범위

- 서버 기반 날짜 필터와 pagination
- 실시간 로그 streaming
- Airflow 연결 정보
- 실행 단계 재시도/건너뛰기 같은 제어 액션
- React Flow 등 별도 DAG 엔진 도입

## 8. Text Structuring Runtime Integration - 2026-07-11

- `runHistory[].textStructuringExecution`과 호환 `textStructuring` 데이터를 보존한다.
- 모델 실행 정보를 실행 단계 목록 위의 별도 전역 table로 중복 노출하지 않는다.
- 사용자가 `변환`, `텍스트 구조화`, `모델` 관련 Timeline 단계를 선택했을 때 오른쪽 `DagStepInspector` 안에 대상 컬럼, 실제 사용 모델, 실행 방식, validation rows, invalid rows, fallback 여부를 표시한다.
- Catalog materialization provenance는 요약만 담당하고, 모델 실행의 상세 진단 source of truth는 이 Run 단계 inspector다.
