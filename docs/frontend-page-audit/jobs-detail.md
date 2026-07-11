# /jobs/:jobId Page UI Audit

상태: `1차 정보 구조 적용 완료 · 세부 폴리싱 대기`
담당 이슈: #441
대상 route: `/jobs/:jobId`
대표 확인 URL: `http://127.0.0.1:5206/jobs/JOB-001`

## 1. 화면 목적

`/jobs/:jobId`는 수집/처리 Job 하나의 상태와 설정을 확인하고 실행, 재실행, 스케줄 제어, 수정, 삭제 같은 명령을 수행하는 상세 화면입니다.

이 화면은 `/jobs` 목록과 `/jobs/:jobId/runs` 실행 이력 사이의 중간 화면입니다. 상세 header는 두 route가 공유하므로 #441에서 만든 기준이 #442 실행 이력 폴리싱의 선행 기준이 됩니다.

## 2. 이번 구현 범위

Backend API, 데이터 계약, Job 상태 로직은 바꾸지 않았습니다. #440에서 확정한 SUIT 글꼴과 local shadcn-style component 기준으로 기존 UI를 교체하고, `JobRowData`에 실제 존재하는 설정값만 우선 노출하도록 정보 구조를 재배치했습니다.

| 영역 | 변경 전 | 변경 후 |
| --- | --- | --- |
| route 글꼴 | `Gothic A1` | `SUIT Variable` |
| 상세 header | 화면 전용 header markup/CSS | dataset 이름 중심 `PageHeader`, compact `StatusBadge`, icon+text `Button` action composition, avatar 기반 owner identity |
| 상세/실행 이력 이동 | `SegmentedTabs` | 운영 요약의 `실행 이력 보기` Button과 실행 이력 화면의 뒤로가기 Button |
| 핵심 정보 section | 화면 전용 section/card CSS | Source → Process → Target 경로와 4개 핵심 상태를 묶은 `Panel` 운영 요약 |
| read-only 설정 | legacy `Field`와 input 모양의 div | `KeyValueList` |
| 접기/펼치기 | native `details`/`summary` | Radix 기반 shadcn `Accordion` |
| 상세 table | raw `table`과 화면 전용 cell CSS | `DetailTableSection` + TanStack/shadcn 조합의 공통 `DataTable` |
| 건수 표시 | plain text | shadcn `Badge` |

## 3. 현재 화면 구조

현재 `JobDetailPage`는 아래 순서로 구성됩니다.

1. 뒤로가기 `Button`: page body 좌측 상단에서 작업 목록으로 이동
2. `PageHeader`: dataset 이름, compact 상태, icon+text action, action 하단 owner identity와 최근 수정 일시
3. `Panel`: Source → Process → Target 경로와 실행 이력 진입점
4. `OperationSummaryItem`: 현재 상태, 최근 실행, 다음 실행, 최근 성공
5. `Accordion`: 실제 source config와 target storage 설정
6. `Accordion`: 출력 스키마, 변환 규칙, 품질 규칙 `DataTable`
7. `Accordion`: 스케줄, 실행 정책, 권한

첫 진입에서는 소스/타겟과 스키마/변환을 펼쳐 현재 화면의 주요 정보를 바로 확인할 수 있게 했고 Schedule/Permission은 접힌 상태로 둡니다.

## 4. 유지한 AskLake composition

shadcn primitive로 무리하게 없애지 않고 유지한 composition은 아래와 같습니다.

### `JobDetailHeader`

- `/jobs/:jobId`와 `/jobs/:jobId/runs`가 공유하는 도메인 header입니다.
- 내부 부품은 `PageHeader`, `Button`, `StatusBadge`로 교체했습니다.
- owner는 `/jobs` 목록의 `OwnerIdentity`를 재사용해 action 하단에 avatar와 이름을 두고 최근 수정 일시는 오른쪽에 분리합니다.
- 상세/실행 이력 tab은 제거했습니다. 상세에서는 운영 요약의 Button으로 실행 이력에 진입하고, 실행 이력에서는 `작업 상세로 돌아가기` Button을 사용합니다.
- 아직 `JobsPages.tsx` 내부 함수입니다. #442에서 실행 이력 화면까지 정리한 뒤 `components/ingest` 분리 여부를 결정합니다.

### `OperationSummaryItem`

- shadcn에는 이 화면 밀도에 맞는 작은 운영 지표 component가 없습니다.
- 중첩 Card를 만들지 않고 label, value, detail을 세로로 묶는 AskLake composition으로 유지합니다.
- #442의 `RunSummaryMetric`, DAG summary와 비교한 뒤 공통 `CompactMetric` 후보로 판단합니다.

### `DetailTableSection`

- table title, meta, scroll 영역을 묶는 AskLake shell입니다.
- shell은 유지하고 내부 table은 `/jobs` 목록과 같은 공통 `DataTable`로 교체했습니다.
- 이 화면에서는 read-only 표시이므로 sorting과 pagination은 끄고, TanStack row model과 shadcn Table 스타일만 공유합니다.

### 운영 요약

- 실제 Job 데이터로 Source → Process → Target 경로를 표시합니다.
- 현재 상태와 최근 Run 결과를 분리하고, 다음 실행과 최근 성공을 함께 표시합니다.
- backend에 freshness 계약이 없으므로 임의 값을 만들지 않고 최근 성공 시각과 성공률을 사용합니다.
- 작업 상세는 Job의 현재 운영 판단, 실행 이력은 여러 Run의 집계와 비교, 실행 단계 Dialog는 단일 Run 진단을 담당합니다.
- 상세의 `OperationSummaryItem`은 unframed 상태 요약이고 실행 이력의 `MetricCard`는 집계 카드이므로 형태를 강제로 같게 만들지 않습니다.
- 실행 이력 page card와 실행 단계 modal card의 밀도 차이는 `MetricCard`의 `default`/`compact` size variant로 관리합니다.

## 5. 교체하지 않은 영역

이번 단계에서 의도적으로 교체하지 않은 부분입니다.

1. `/jobs/:jobId/runs` 실행 이력 table, filter, pagination
2. 실행 로그 modal과 실행 단계 DAG modal
3. `JobDetailHeader`의 별도 파일 분리
4. `OperationSummaryItem`과 실행 이력 summary의 전역 공통 component 승격
5. 세부 typography, table density, 영문 label 한글화

1~2는 #442 범위입니다. 3~4는 #442까지 함께 본 뒤 공통 API가 명확해졌을 때 진행합니다. 5는 현재 정보 구조를 실제 화면에서 검토한 뒤 이어지는 폴리싱 단계에서 결정합니다.

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
- header title을 dataset 이름으로 표시하고 상태 badge를 제목 오른쪽에 compact 크기로 배치
- header action을 `/jobs`와 같은 icon/tone 체계의 icon+text `Button`으로 정리
- header action 하단에 목록과 같은 avatar 기반 소유자 표시를 배치하고 최근 수정 일시를 오른쪽에 분리
- breadcrumb를 page body 좌측 상단의 `ArrowLeft` 뒤로가기 action으로 분리
- 상세 최대 폭을 1240px에서 1360px로 확대하되 초광폭 readability를 위해 상한 유지
- 상세 page 안 native `details` 0개 확인
- 상세 page 안 legacy `.field` 0개 확인
- 상세 page 안 raw `.detail-table` 0개 확인
- Accordion 3개 렌더링 및 Schedule/Permission 펼치기 확인
- 운영 요약의 `실행 이력 보기` Button으로 `/jobs/JOB-001/runs` 이동
- 실행 이력 화면의 `작업 상세로 돌아가기` Button으로 상세 화면 복귀
- Source/Target은 `sourceConfig`, storage, format, compression, partition 값을 직접 표시
- 출력 스키마, 변환 규칙, 품질 규칙은 공통 `DataTable`로 렌더링
- 스키마/변환/품질 헤더의 개수와 중복되던 3개 요약 블록 제거
- 변환 규칙에 적용 순서와 저장된 `params`를 추가하고 오류 처리 문구를 한글화
- 품질 규칙의 검증 종류, 심각도, 실패 처리 문구를 한글화
- 최근 Run의 품질 통과/점수 Badge는 설정 섹션에서 제거
- 스케줄/권한은 `scheduleSummary`, `retryPolicySummary`, `permissionRoles` 값을 직접 표시
- 고정된 인증 방식, 쓰기 모드, 승인 상태, downstream 문구 제거
- 실행 통계를 schema mapping row로 표시하던 fallback 제거
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

### 제안하는 정보 우선순위

아래 구조는 확정안이 아니라 사용자 검토를 위한 기준안입니다.

#### 1) 첫 화면에서 바로 보여줄 운영 요약

- dataset 이름과 Job 상태
- 소스에서 타겟으로 이어지는 한 줄 경로
- 실행 유형과 주기
- 다음 예정 실행
- 최근 실행 결과, 실행 시각, 실행 시간
- 최근 성공 시각 또는 freshness
- 실패 상태라면 실패 단계와 실행 이력 진입 action
- owner avatar/name과 최근 수정 일시

Job의 현재 상태와 최근 Run 결과는 별도 개념으로 표시합니다. 예를 들어 반복 Job이 `실행 대기`여도 최근 Run은 `실패`일 수 있습니다.

#### 2) 설정 확인용 상세 정보

- Source: connector 유형, 경로/topic/table, 읽기 방식, watermark 기준
- Target: dataset, 물리 경로, format, partition, compression, write mode
- Transform: 실제 schema mapping, transform rule, quality rule
- Schedule: timezone, 반복 주기, overlap 처리, retry/backoff
- Permission: owner, 실행 가능 role, 조회 가능 role, 데이터 민감도

인증 정보는 credential 값이 아니라 연결 이름 또는 secret reference만 표시해야 합니다.

#### 3) 실행 이력 route로 보내야 할 정보

- Run별 DAG 단계
- 단계별 로그와 오류 stack
- Run별 input/output row, bytes, files, partitions
- Spark application/executor 같은 실행 엔진 상세
- 재시도 시도별 결과와 긴 실행 진단

상세 첫 화면에는 최신 결과의 요약과 실행 이력 진입점만 두고, Run마다 달라지는 진단 정보는 `/jobs/:jobId/runs`에서 다룹니다.

### 현재 항목 중 검증이 필요한 내용

- `Host`, `Database`, `Table`처럼 connector별 source config label의 한글화 여부
- `Fail Run`, `Warning`, `Partition key` 같은 backend enum을 사용자용 문구로 변환할지 여부
- 실제 source-to-target column mapping 계약이 추가되기 전까지 출력 스키마만 보여주는 현재 범위
- timezone, overlap, watermark를 `scheduleSummary` 문자열이 아니라 개별 필드로 항상 받을 수 있는지 여부
- 데이터 민감도와 수정 권한을 backend permission 계약에 추가할지 여부
- `JobStats`의 `successRate`, `totalRuns`, `averageDuration`을 포맷된 문자열이 아니라 숫자 원본으로 받을지 여부
- 현재 backend의 `averageDuration`이 실제 평균이 아니라 최신 Run의 duration을 사용하는 문제
- 배치 Job은 Run 성공률/평균 소요시간으로 안정성을 표시하고, 실시간 Job은 가동률, 처리 지연 또는 consumer lag, 최근 heartbeat/checkpoint, 재시작 횟수, 오류율로 별도 정의할 것

현재 `실행 대기` 상태의 보조 문구는 실제 scheduler health 검증을 의미하지 않으므로 `스케줄 정상`이 아니라 `자동 실행 활성`으로 표시합니다.

운영 요약의 두 번째 항목은 Run 상태에 따라 역할을 바꿉니다.

- 실행 중: `현재 Run`으로 표시하고 시작 시각과 Run ID를 제공
- 종료 후: `최근 실행`으로 표시하고 성공/실패 결과, 종료 시각, 소요 시간을 제공

이렇게 하면 첫 번째 `현재 상태`의 진행 단계와 두 번째 항목의 정보가 중복되지 않습니다.

이 값들은 backend 계약에 실제 필드가 있으면 연결하고, 없으면 UI에서 사실처럼 노출하지 않는 방향으로 정리합니다.

### 스키마 / 변환 / 품질 정보 검증

이 섹션은 Job의 고정 설정을 확인하는 영역으로 유지합니다. 특정 Run에서 나온 성공/실패, 품질 점수, invalid row 수는 실행 이력에서 다루고 이 섹션과 섞지 않습니다.

#### 유지할 정보

- 출력 스키마: 출력 필드명, 데이터 타입, nullable, key/partition 역할
- 변환 규칙: 적용 순서, 사용자용 규칙명, 입력 → 출력 매핑, 변환 파라미터 또는 식, 오류 처리, 활성 여부
- 품질 규칙: 대상 컬럼, 검증 종류, threshold/config, 심각도, 실패 처리, 활성 여부
- 섹션 헤더 요약: 출력 컬럼 수, 변환 규칙 수, 품질 규칙 수

#### 현재 화면에서 줄일 정보

- 헤더의 개수 요약과 바로 아래 3개 요약 블록이 같은 개수를 반복하므로 하나만 유지
- 출력 스키마 요약의 파티션은 타겟 카드와 스키마 테이블에 이미 있어 중복
- 각 테이블이 활성 규칙만 반환한다면 모든 행의 `활성` 상태 컬럼은 정보 가치가 낮음
- 내부 operation code(`RENAME_COLUMNS`, `CAST_DECIMAL`)는 기본값으로 크게 노출하지 않고 규칙명 아래 보조 정보로만 유지

#### 이 섹션에서 제거하거나 이동할 정보

- `품질 통과`, `점수 98.2`는 규칙 설정이 아니라 최근 Run의 결과이므로 `/jobs/:jobId/runs` 또는 운영 요약으로 이동
- Run별 invalid row, input/output row, 실행 단계 상태, 오류 stack은 실행 이력에서만 표시
- `Fail Run`, `Warning`, `Partition key` 같은 backend enum은 사용자용 한글 문구로 변환

#### Backend 계약 보강이 필요한 정보

- 출력 컬럼의 `nullable`, source-to-target mapping, 컬럼별 대표 샘플 값, schema version/fingerprint, schema evolution 정책
- 변환 규칙의 순서와 `params` 또는 expression
- 품질 규칙의 range/regex/accepted values 같은 실제 threshold/config
- 품질 결과의 집계 시각과 대상 Run ID

컬럼 수가 많아지는 실제 데이터 레이크 환경에서는 출력 스키마 전체를 한 번에 렌더링하지 않습니다. 검색과 내부 pagination 또는 virtualization을 제공하고, 기본 화면에는 일부 행만 보여주는 방향으로 확장합니다.

현재 상세 화면의 `샘플` 컬럼은 선택 필드인 `schemaSampleValues`를 사용합니다. QA용 `JOB-001`에는 화면 검증을 위한 mock 값을 넣었으며, Backend 응답에 값이 없으면 `-`로 표시합니다. 실제 계약에서는 샘플의 기준 Run, 마스킹 여부, 수집 시각을 함께 정의해야 합니다.

상세 표의 한글과 영문이 서로 다른 굵기로 보이지 않도록 언어가 아닌 정보 역할로 typography를 구분합니다. 필드명·규칙명은 `16px/700`, 경로·매핑은 `16px/600`, 설정·설명·오류 처리는 `16px/500`, 내부 operation code는 `13px/600` muted, 상태·타입 Badge는 `14px/600`을 사용합니다.

출력 스키마는 결과 데이터셋의 필드명, 타입, 대표 샘플을 확인하는 계약 정보이므로 유지합니다. 파티션 설정은 타겟 카드에서 이미 제공하고 스키마 이해에 필수적인 열이 아니므로 출력 스키마 표의 `파티션` 컬럼은 제거합니다.

`스케줄 / 실행 정책 / 권한`은 사용자가 찾는 정보 단위에 맞춰 `스케줄 / 권한`으로 단순화했습니다.

후속 검토에서 실제 구현이 확인되지 않은 overlap 문구(`이전 Run 실행 중이면 건너뜀`)와 이력 보관 문구는 상세 화면에서 제거했습니다. 스케줄 카드에는 실행 유형, 주기, 다음 실행, 재시도 정책만 표시합니다.

권한은 최신 `origin/dev`의 ETL 권한 설정 초안을 기준으로 `조회`, `쿼리 실행`, `메타데이터`, `관리`를 역할별로 표시합니다. Admin의 `PermissionAction`에는 별도로 `run`, `delete`, `share`가 정의되어 있으므로, Backend 계약 확정 시 ETL 생성 권한과 Admin 리소스 권한을 하나의 액션 집합으로 통합해야 합니다. 통합 전까지 상세 화면에서 파이프라인 실행 권한을 임의로 만들어 표시하지 않습니다.

### 후속 Backend 운영 지표 계약 제안

이 절은 현재 구현된 API 계약이 아니라 후속 Backend/API PR에서 확정해야 할 제안입니다. 운영 지표의 계산 책임은 Backend가 가지며 Frontend는 숫자 포맷과 상태 표현만 담당합니다.

```ts
type BatchOperationalMetrics = {
  metricType: "batch";
  windowFrom: string;
  windowTo: string;
  totalRuns: number;
  successfulRuns: number;
  successRate: number | null;
  averageDurationMs: number | null;
};

type RealtimeOperationalMetrics = {
  metricType: "realtime";
  windowFrom: string;
  windowTo: string;
  healthStatus: "healthy" | "degraded" | "unhealthy" | "unknown";
  availabilityRate: number | null;
  consumerLag: number | null;
  processingDelayMs: number | null;
  lastHeartbeatAt: string | null;
  lastCheckpointAt: string | null;
  restartCount: number;
  errorRate: number | null;
};

type JobOperationalMetrics = BatchOperationalMetrics | RealtimeOperationalMetrics;
```

- 권장 응답 위치: `GET /api/etl/jobs/:jobId`의 `operationalMetrics`
- 퍼센트, 횟수, 시간은 `"96%"`, `"32회"`, `"12분"` 같은 문자열이 아니라 숫자로 전달
- 지표를 아직 수집하지 못한 경우 `0`으로 가장하지 않고 `null`로 전달
- 배치 성공률은 명시된 집계 기간 안의 종료 Run을 기준으로 계산
- 실시간 가동률은 heartbeat/checkpoint 관측 구간을 기준으로 계산하고, 재시작과 lag는 같은 집계 기간을 사용
- 목록 API는 필터와 현황 카드에 필요한 최소 상태만 반환하고, 비용이 큰 운영 지표는 상세 API에서 조회

현재 Frontend 임시 정책은 다음과 같습니다.

- 배치 Job: `runHistory` 또는 기존 `job.stats` 기반 실행 안정성 표시
- 실시간 Job: `operationalMetrics`가 있으면 수집 안정성, 가동률, 처리 지연을 표시하고 없으면 `측정 대기`로 표시
- QA fixture의 JOB-003에는 화면 검증용 `operationalMetrics` mock을 사용하며, 컴포넌트 내부에 수치를 하드코딩하지 않음
- `operationalMetrics` 계약이 구현되면 Frontend의 `fallbackJobStats` 기반 안정성 계산은 제거하거나 개발용 fallback으로 제한

## Text Structuring Model Placement - 2026-07-11

- 모델 선택과 fallback 정책은 Job의 변환 설정에 속하며, ETL 변환 편집 모달이 해당 설정을 소유한다.
- Job 상세는 변환 규칙의 구성 정보를 보여주되 전체 model artifact inventory를 별도 section으로 만들지 않는다.
- 실제로 어떤 모델이 사용됐는지, fallback이 발생했는지, 검증 결과가 어땠는지는 설정값이 아니라 Run 결과이므로 `/jobs/:jobId/runs`의 실행 단계 상세에서 표시한다.
