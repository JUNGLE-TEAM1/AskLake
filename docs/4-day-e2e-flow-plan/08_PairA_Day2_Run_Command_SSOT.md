# 08 Pair A Day2 Run/Command SSOT

이 문서는 2026-07-05 Day2 Pair A의 Run/Command 작업 기준이다.
오늘은 이 문서를 Pair A Run/Command 작업의 SSOT로 사용한다.

## 1. 현재 기준

이미 구현된 것은 새로 만들지 않는다.

현재 pair1 merge 이후 이미 있는 것:

- `POST /api/etl/jobs/{jobId}/commands` backend endpoint
- `runJobCommand()` frontend adapter
- `JobRunsPage` 화면
- `JobDagPage` 화면
- 기존 `jobExecutionEvidence` 임시 adapter
- command 응답 `{ job, run, dagSteps }` 처리 흐름

오늘 작업의 목적은 아래 구조를 새로 정리하는 것이다.

```text
임시 jobExecutionEvidence 중심 구조
↓
runId 기준 정식 Run 상태 구조
↓
Command / History / DAG가 같은 runId를 보는 구조
```

## 2. 잠긴 계약

PR0에서 잠그는 계약은 아래 3개 map이다.

```ts
type RunsByJobId = Record<string, JobRunSummary[]>;
type SelectedRunIdByJobId = Record<string, string>;
type DagStepsByRunId = Record<string, JobDagStep[]>;
```

상태 이름은 아래 이름을 사용한다.

```text
runsByJobId
selectedRunIdByJobId
dagStepsByRunId
```

연결 규칙:

- `job.id`는 `runsByJobId`의 key다.
- `run.runId`는 `selectedRunIdByJobId[job.id]`의 value다.
- `run.runId`는 `dagStepsByRunId`의 key다.
- History는 `selectRunForJob(jobId, runId)`로 선택 Run만 바꾼다.
- DAG는 `selectedRunIdByJobId[job.id]`가 가리키는 runId만 사용한다.
- `jobExecutionEvidence`는 기존 화면 호환 adapter이며 정식 source of truth가 아니다.

PR1 optimistic 실행 규칙:

- API request에 `clientRunId`를 추가하지 않는다.
- 프론트가 `client:<jobId>:<timestamp>` 형식의 temp run id를 만든다.
- 서버 응답의 `run.runId`가 오면 temp run을 실제 Run으로 교체한다.

## 3. 오늘 PR 순서

오늘 작업은 아래 PR 순서로 나눈다.

| PR | 제목 | 담당 성격 | 완료 기준 |
|---|---|---|---|
| PR0 | Run 상태 계약 정리 | 공통 계약 | `runsByJobId`, `selectedRunIdByJobId`, `dagStepsByRunId` 계약이 코드/문서에 반영된다 |
| PR1 | Command UX + 즉시 상태 반영 | 실행 버튼과 optimistic 상태 | 실행 버튼 클릭 직후 Job/Run이 running으로 보이고, 응답 후 실제 Run으로 교체된다 |
| PR2 | Run History Page 보강 | History 화면 | `runsByJobId[selectedJob.id]`가 렌더되고 row 클릭으로 선택 Run이 바뀐다 |
| PR3 | DAG Page 보강 | DAG 화면 | `selectedRunIdByJobId[selectedJob.id]` 기준 DAG step이 보인다 |
| PR4 | Retry / Cancel / Pause 보강 | 추가 command | 상태에 맞는 command 버튼과 즉시 상태 반영이 동작한다 |

권장 merge 순서:

```text
PR0
↓
PR1
↓
PR2, PR3
↓
PR4
```

PR2와 PR3은 PR0 계약만 있으면 병렬 작업 가능하다.
다만 실제 실행 버튼으로 end-to-end 확인하려면 PR1 이후 검증하는 것이 좋다.

## 4. 오늘 2인 시작 분배

### 작업자 1

먼저 잡을 작업:

```text
PR1: Command UX + 즉시 상태 반영
```

해야 할 일:

- `commandPendingByJobId` 또는 동등한 per-job pending 상태 추가
- 실행 버튼 클릭 직후 해당 Job 버튼 disabled/loading 처리
- `run`/`retry` 클릭 직후 temp Run 생성
- 클릭 직후 Job을 `running`처럼 표시
- temp Run을 `runsByJobId[job.id]` 맨 앞에 추가
- `selectedRunIdByJobId[job.id]`를 temp run id로 설정
- 서버 응답 성공 시 temp Run을 실제 `response.run`으로 교체
- `response.dagSteps`를 `dagStepsByRunId[response.run.runId]`에 저장
- `response.job`으로 `jobs`와 `selectedJob` 갱신
- 실패 시 temp Run 제거, 선택 Run과 Job 상태 복구
- 성공/실패 toast 표시

완료 문장:

```text
즉시 실행을 누르면 2분 동안 먹통처럼 보이지 않고,
Job과 Run이 바로 running으로 보인 뒤,
서버 응답이 오면 실제 runId로 교체된다.
```

### 작업자 2

먼저 잡을 작업:

```text
PR2: Run History Page 보강
```

해야 할 일:

- 기존 `JobRunsPage` 재사용
- `runsByJobId[selectedJob.id]`를 렌더하도록 준비
- Run ID, 상태, 시작/종료 시간, 입력/출력 행 표시 유지
- row 클릭 시 `selectRunForJob(selectedJob.id, runId)` 호출
- `selectedRunIdByJobId[selectedJob.id]` 기준 selected row 표시
- Run 없음 empty state 유지
- running 상태 Run 표시 확인

완료 문장:

```text
실행 직후 History에 running Run이 보이고,
row를 클릭하면 selectedRunIdByJobId가 바뀐다.
```

## 5. 지원 인력이 오면 줄 작업

지원 인력이 오면 아래 순서로 넘긴다.

| 우선순위 | 작업 | 맡기기 좋은 이유 | 주의할 점 |
|---|---|---|---|
| 1 | PR3 DAG Page 보강 | PR0 계약만 있으면 독립 렌더 가능 | command action을 직접 바꾸지 않는다 |
| 2 | PR4 Retry / Cancel / Pause 보강 | PR1 command 흐름 위에 얹을 수 있음 | PR1의 optimistic helper를 재사용한다 |
| 3 | 상태/empty/error 문구 정리 | UI polish가 아니라 상태 케이스 보강 | store 구조는 바꾸지 않는다 |
| 4 | 브라우저 smoke | 충돌 없이 검증 가능 | 검증 결과를 PR 댓글/체크리스트에 남긴다 |

## 6. 오늘 건드리면 안 되는 것

아래는 오늘 각 PR에서 임의로 바꾸지 않는다.

| 금지 항목 | 이유 |
|---|---|
| `runsByJobId`, `selectedRunIdByJobId`, `dagStepsByRunId` 이름 변경 | PR0 계약이 깨진다 |
| API request에 `clientRunId` 추가 | backend contract 변경으로 범위가 커진다 |
| `dagSteps`에 `runId` 필드 강제 추가 | PR0 계약은 같은 응답의 `run.runId`로 묶는 방식이다 |
| History에서 DAG state 직접 변경 | History는 selected run만 바꿔야 한다 |
| DAG가 `runs[0]`을 직접 사용 | 선택 Run 기준이 깨진다 |
| polling 주기나 GET runs API 설계 | 오늘 PR1 범위가 아니다 |
| DAG 그래프 레이아웃 대개편 | PR3의 기능 검증보다 범위가 커진다 |

## 7. PR별 하지 않을 일

### PR1에서 하지 않을 일

- History row 클릭 구현
- DAG 화면 selected run 마이그레이션
- retry/cancel/pause 세부 조건 정리
- polling API 설계
- GET runs API 추가

### PR2에서 하지 않을 일

- command API 호출 방식 변경
- optimistic temp Run 생성 방식 변경
- DAG step 저장 방식 변경

### PR3에서 하지 않을 일

- command 버튼 조건 변경
- History row 클릭 정책 변경
- Run store 이름 변경

## 8. 오늘 종료 기준

오늘 Pair A Run/Command 작업은 아래 상태까지 가는 것을 목표로 한다.

최소 목표:

```text
PR0와 PR1이 리뷰 가능한 상태다.
실행 버튼 클릭 직후 화면이 running으로 반응한다.
서버 응답 후 실제 runId로 Run/DAG 상태가 확정된다.
```

확장 목표:

```text
PR2까지 리뷰 가능한 상태다.
History에 running/success/failed Run row가 보이고,
row 클릭으로 selected run이 바뀐다.
```

데모 문장:

```text
사용자가 즉시 실행을 누르면 화면이 바로 실행 중으로 바뀌고,
같은 runId가 History와 DAG로 이어질 준비가 되어 있다.
```

## 9. 검증 기준

각 PR은 최소 아래를 확인한다.

```bash
cd frontend
npm run build
```

수동 smoke:

- ETL 목록이 열린다.
- 즉시 실행 버튼을 누를 수 있다.
- 클릭 직후 버튼이 중복 클릭되지 않는다.
- 클릭 직후 해당 Job이 running처럼 보인다.
- 실패 시 이전 Job/Run 상태가 깨지지 않는다.

