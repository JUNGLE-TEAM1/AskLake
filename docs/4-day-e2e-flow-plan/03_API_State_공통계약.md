# 03 API State 공통계약

> **문서 상태 — 역사적 초기 계약 (2026-07)**
>
> 현재 공개 API의 기준은 [API Reference](../03-api-reference.md)와 [API Contract](../api-contract.md)다. 아래 내용은 초기 Pair 간 상태 전달 규칙을 보존한다.

## 원칙

- 성공 응답은 프론트 타입과 같은 shape를 쓴다.
- 실패 응답은 항상 `ErrorResponse`를 쓴다.
- Pair 간 전달 객체에는 ID를 반드시 포함한다.
- mock/live 응답은 같은 필드 이름과 같은 상태값을 써야 한다.
- Dashboard Publish는 제품 기능이다. 게시 상태는 `Dashboard.status`로 관리한다.

## 공통 ID 규칙

| ID | 의미 | 사용 위치 |
|---|---|---|
| `pipeline_id` | Review 단계의 임시 파이프라인 ID. 생성 성공 후 `job_id`와 `dataset_id`로 이어진다. | Review, create request 추적 |
| `job_id` | ETL Job의 고유 ID. `Job.id`와 같다. | ETL 목록, 상세, 실행 명령 |
| `run_id` | Job 실행 또는 SQL 실행 1회의 고유 ID. | 실행 이력, DAG, SQL Result, Dashboard source |
| `dataset_id` | Dataset의 고유 ID. `Dataset.id`와 같다. | Catalog, Lineage, SQL, Dashboard |
| `query_id` | SQL 실행 추적 ID. 별도 필드가 없으면 `SqlResult.runId`를 쓴다. | SQL 실행 로그, Result Preview |
| `dashboard_id` | Dashboard의 고유 ID. `Dashboard.id`와 같다. | Dashboard 목록, Builder, Published 화면 |
| `widget_id` | Widget의 고유 ID. `Widget.id`와 같다. | Dashboard Widget |
| `lineage_node_id` | Lineage 노드의 고유 ID. 보통 `dataset_id`를 그대로 쓴다. | Catalog 상세, Lineage |
| `dag_step_id` | DAG step의 고유 ID. | DAG 화면, 실행 단계 |

## 공통 상태값

| 영역 | 상태값 | 의미 |
|---|---|---|
| Pipeline/Dashboard | `draft` / `Draft` | 저장 전 또는 편집 중 상태 |
| Job | `scheduled` 또는 `스케줄됨` | 실행 예약 상태 |
| Job/Run/DAG | `running` 또는 `실행 중` | 실행 중 상태 |
| Run/DAG/SQL/Dashboard | `success` | 성공 |
| Run/DAG/SQL/Dashboard | `failed` | 실패 |
| Run | `canceled` | 취소. UI에서는 `취소됨`으로 보여도 된다. |
| Job | `paused` 또는 `일시정지` | 일시정지 |
| Dataset freshness | `latest` | 최신 |
| Dataset freshness | `stale` | 오래된 데이터 |
| Dataset freshness | `approval` | 승인 필요 |
| Dashboard | `Published` | 게시된 Dashboard |

UI 표시가 한국어여도 API와 mock fixture는 같은 내부 값을 써야 한다. 한국어 배지는 mapper에서 변환한다.

## Error Response

```ts
type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_JOB_STATE"
  | "SQL_SYNTAX_ERROR"
  | "BACKEND_TIMEOUT"
  | "INTERNAL_ERROR";

type ErrorResponse = {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
};
```

사용 규칙:

- 422 입력 오류는 `VALIDATION_ERROR`를 쓴다.
- 없는 Job/Dataset/Dashboard는 `NOT_FOUND`를 쓴다.
- 중복 생성이나 중복 실행은 `CONFLICT`를 쓴다.
- 실행할 수 없는 Job 상태는 `INVALID_JOB_STATE`를 쓴다.
- read-only SQL 위반이나 문법 오류는 `SQL_SYNTAX_ERROR`를 쓴다.
- 시간 초과는 `BACKEND_TIMEOUT`을 쓴다.

## Live API 규칙

- 성공 응답은 별도 envelope 없이 타입 그대로 반환한다.
- 실패 응답은 항상 `ErrorResponse`로 반환한다.
- API가 없거나 실패하면 사용자가 다시 시도할 수 있게 error/toast/rollback 경로를 제공한다.
- fallback을 쓴 경우 audit log나 known issues에 이유를 남기고, ETL Source/Create/Run의 authoritative 경로로 쓰지 않는다.
- Dashboard 저장/Publish API가 없으면 localStorage snapshot을 사용한다.

## 주요 타입 요약

### Job

| 필드 | 의미 |
|---|---|
| `id`, `name`, `owner` | Job 식별과 표시 이름 |
| `status` | `스케줄됨`, `실행 중`, `일시정지`, `실패` |
| `source`, `target`, `schedule` | 입력/출력/스케줄 요약 |
| `lastRun`, `lastState`, `nextRun` | 목록과 상세 표시 |
| `progress` | 실행 중 단계 label과 진행률 |

### Run

| 필드 | 의미 |
|---|---|
| `id`, `jobId`, `datasetId` | 실행 ID와 연결 대상 |
| `status` | `queued`, `running`, `success`, `failed`, `canceled` |
| `stepLabel` | 현재 단계 |
| `startedAt`, `endedAt`, `durationMs` | 실행 시간 요약 |
| `inputRows`, `outputRows` | 작은 샘플 처리 결과 요약 |
| `outputPath` | 결과 위치가 있으면 표시 |

### RunResultSummary

| 필드 | 의미 |
|---|---|
| `runId`, `jobId`, `datasetId` | ETL 실행과 Dataset 연결 키 |
| `status` | 실행 결과 |
| `inputRows`, `outputRows` | 처리 row 요약 |
| `durationMs` | 실행 시간 |
| `message` | 화면에 보여줄 요약 문구 |

### Dataset

| 필드 | 의미 |
|---|---|
| `id`, `name`, `layer`, `owner` | Dataset 식별과 소유 |
| `status`, `freshness` | 사용 가능 여부와 최신성 |
| `rows`, `size`, `quality`, `lastUpdated` | Catalog 표시 지표 |
| `schema` | `[컬럼명, 타입]` 목록 |
| `sampleRows` | SQL fallback 결과 |
| `upstream`, `downstream` | lineage 표시용 Dataset ID 또는 이름 목록 |

### Lineage

| 필드 | 의미 |
|---|---|
| `nodes` | upstream/current/downstream 노드 목록 |
| `edges` | 노드 간 연결 |
| `selectedNodeId` | 현재 선택된 Dataset 또는 lineage 노드 |

```ts
type LineageNode = {
  id: string;
  datasetId: string;
  name: string;
  layer: "RAW" | "BRONZE" | "SILVER" | "GOLD" | "DASHBOARD";
  role: "upstream" | "current" | "downstream";
  rows?: string;
  freshness?: "latest" | "stale" | "approval";
};

type LineageEdge = {
  id: string;
  sourceId: string;
  targetId: string;
};
```

### SqlResult

| 필드 | 의미 |
|---|---|
| `runId` | SQL 실행 ID |
| `datasetId`, `datasetName` | 대상 Dataset |
| `query` | 실행 query |
| `columns`, `rows`, `rowCount` | Result Preview 데이터 |
| `executedAt` | 실행 시각 |

### Dashboard

| 필드 | 의미 |
|---|---|
| `id`, `name` | Dashboard 식별과 표시 이름 |
| `datasetId` | 기준 Dataset |
| `sourceRunId` | SQL Result 또는 ETL Run과 연결 |
| `status` | `Draft` 또는 `Published` |
| `widgets` | Widget 목록 |
| `updatedAt` | 마지막 수정 시각 |

### Widget

| 필드 | 의미 |
|---|---|
| `id`, `dashboardId` | Widget 식별과 소속 Dashboard |
| `type` | `kpi`, `bar`, `line`, `donut`, `table` |
| `title` | 화면 표시 이름 |
| `sourceRunId`, `datasetId` | 데이터 출처 |
| `columns`, `rows` | Table Widget 데이터 |

## Pair 간 전달 객체

### Pair A -> Pair B

```ts
type CreateJobResponse = {
  job: Job;
  catalogTarget: {
    id: string;
    name: string;
    layer: string;
    status: "pending_run";
  };
};
```

필수 확인:

- create 직후 Catalog Dataset을 만들지 않는다.
- `catalogTarget.id`, `catalogTarget.name`, `catalogTarget.layer`, `catalogTarget.status`가 있어야 실행 전 대상 정보를 표시할 수 있다.
- Spark run 성공 후 command 응답의 `dataset.name`, `schema`, `sampleRows`, `rows`, `size`가 SQL context를 만들 수 있다.

### Pair A -> Pair B/C

```ts
type JobCommandResponse = {
  action: "run" | "retry" | "pause" | "cancel";
  job: Job;
  run?: Run;
  dagSteps?: Array<{
    id: string;
    title: string;
    status: "pending" | "running" | "success" | "failed";
  }>;
  resultSummary?: RunResultSummary;
};
```

필수 확인:

- `run.id`가 있으면 SQL/Dashboard의 출처 추적에 쓸 수 있다.
- `run.datasetId`는 Catalog의 `dataset.id`와 같아야 한다.

### Pair B -> Pair C

```ts
type QueryRunResponse = SqlResult;
```

필수 확인:

- `columns`와 `rows`가 Table Widget의 데이터가 된다.
- `runId`는 Dashboard `sourceRunId`가 된다.
- `datasetId`는 Dashboard `datasetId`와 같아야 한다.

### Pair C -> 전체 Pair

- Dashboard draft/published snapshot
- Dashboard 저장/Publish 확인 방법
- Widget이 필요로 하는 `SqlResult` 필드 목록
- Dashboard 관련 known issues
