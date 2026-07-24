# 08 PairA 2번 Day2 Run History 작업 가이드

> **문서 상태 — 역사적 작업 기록 (2026-07)**
>
> 당시 담당자 작업 가이드를 보존한다. 현재 Run 계약은 [API Contract](../api-contract.md)를 따른다.

## 목적

Day2 작업자 2의 범위를 Run History 기준으로 고정한다.

현재 전제는 PR0 Run 상태 계약이 `pair1`에 들어간 상태다. 작업자 2는 새 화면을 다시 만들지 않고 기존 `JobRunsPage`를 정식 Run store에 붙인다.

## 기준 계약

```ts
runsByJobId[jobId] = Run[]
selectedRunIdByJobId[jobId] = runId
dagStepsByRunId[runId] = DagStep[]
```

History에서 선택을 바꿀 때는 반드시 `selectRunForJob(jobId, runId)` action을 사용한다.

## PR2 범위

작업자 2가 맡는 범위는 아래로 제한한다.

| 항목 | 해야 하는 것 |
|---|---|
| History data source | `runsByJobId[selectedJob.id]`를 렌더한다. |
| 선택 Run | row 클릭, Enter, Space로 `selectRunForJob(job.id, run.runId)`를 호출한다. |
| DAG handoff | `DAG 보기`를 누르면 해당 Run을 선택한 뒤 DAG 화면으로 이동한다. |
| 상태 표시 | `queued`, `running`, `success`, `failed`, `canceled`를 표시한다. |
| Empty state | Run이 없을 때 빈 화면을 명확히 보여준다. |
| 화면 높이 | 실행 이력이 많아져도 페이지가 끝없이 늘지 않도록 표 카드 안에서 스크롤한다. |

## PR2에서 하지 않는 것

아래는 작업자 2가 임의로 고치지 않는다.

| 항목 | 이유 |
|---|---|
| `runsByJobId` shape 변경 | PR0 계약을 깨면 PR1, PR3, PR4가 동시에 흔들린다. |
| command optimistic insert | PR1 담당 범위다. 실행 버튼 직후 temp Run을 넣는 책임은 PR1에 둔다. |
| `dagStepsByRunId` 구조 변경 | PR3 담당 범위다. |
| retry/cancel/pause 조건 정리 | PR4 담당 범위다. |
| create mapper, jobs/datasets prepend | Pair A 1번 범위와 충돌한다. |

## running Run 기준

PR2는 store에 `running` 또는 `queued` Run이 들어오면 History에 바로 보이도록 만든다.

다만 현재 backend command는 Spark 실행이 끝난 뒤 응답하는 구조라, 사용자가 실행 버튼을 누른 즉시 running Run을 store에 넣는 작업은 PR1에서 처리한다.

따라서 PR2 완료 기준은 아래처럼 판단한다.

```text
Run store에 running/queued Run이 있으면 History에 보인다.
DAG 보기 전에 같은 runId가 selectedRunIdByJobId에 저장된다.
실제 command 클릭 직후 optimistic Run 삽입은 PR1에서 한다.
```

## 완료 기준

PR2가 끝났다고 말하려면 아래가 맞아야 한다.

- `JobRunsPage`가 `job.runHistory`나 `jobExecutionEvidence`를 직접 fallback으로 쓰지 않는다.
- `App`에서 `runsByJobId[selectedJob.id]`와 `selectedRunIdByJobId[selectedJob.id]`를 넘긴다.
- History row 클릭이 `selectRunForJob(jobId, runId)`만으로 선택 Run을 바꾼다.
- `DAG 보기` 버튼이 row의 `runId`를 선택하고 DAG 화면으로 넘긴다.
- Run이 없으면 empty state가 보인다.
- 행이 많아져도 History 표 내부에서 스크롤된다.
- `npm run build`가 통과한다.
- 브라우저에서 작업 상세 -> 실행 이력 -> row 선택 -> DAG 보기 흐름이 깨지지 않는다.

## 검증 방법

```powershell
cd frontend
npm run build
```

브라우저 검증은 아래 순서로 한다.

```text
수집/처리 목록
-> 작업 상세
-> 실행 이력
-> Run row 클릭
-> DAG 보기
```

확인할 것:

- 실행 이력 표에 Run ID, 상태, 시작/종료 시간, 입력/출력 행이 보인다.
- 선택된 row가 시각적으로 구분된다.
- `DAG 보기` 후 같은 Run ID의 DAG로 이동한다.
- 실행 이력이 많아질 경우 표 카드 안에서 스크롤된다.

## 서브 에이전트 리뷰 체크리스트

서브 에이전트에게 검토를 맡길 때는 아래만 확인시킨다.

| 구분 | 확인 내용 |
|---|---|
| 계약 | `runsByJobId`, `selectedRunIdByJobId`, `selectRunForJob` 경로가 맞는지 |
| UI | empty/running/success/failed/canceled row가 깨지지 않는지 |
| handoff | `DAG 보기`가 선택 Run을 먼저 저장하는지 |
| 범위 | PR1/PR3/PR4 책임을 PR2에서 침범하지 않았는지 |
| 검증 | `npm run build`와 브라우저 클릭 흐름이 통과하는지 |
