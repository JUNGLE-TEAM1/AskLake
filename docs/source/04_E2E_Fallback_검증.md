# 04 E2E Fallback 검증

## 검증 목표

이번 검증의 목표는 데이터 크기가 아니다. 작은 샘플 데이터라도 같은 ID와 상태가 화면 사이를 끝까지 지나가는지 확인한다.

목표 흐름:

```text
Review 생성
-> ETL Job 생성
-> Job 실행
-> Catalog Dataset 확인
-> Lineage 확인
-> SQL 실행
-> Dashboard Widget 생성
-> Dashboard 저장/Publish
```

## 성공 기준

| 기준 | 내용 |
|---|---|
| Job 생성 | Review 생성 후 ETL 목록에 새 Job이 보인다. |
| Dataset 생성 | 생성 응답의 Dataset이 Catalog 목록과 상세에 보인다. |
| Run 연결 | Job 실행 후 같은 `runId`가 상세/이력/DAG에 보인다. |
| Lineage 표시 | Dataset 상세에 upstream/current/downstream 관계가 보인다. |
| SQL 실행 | 선택 Dataset 기준 SELECT 결과가 Result Preview에 보인다. |
| Dashboard 연결 | SQL Result가 Dashboard Table Widget으로 표시된다. |
| 저장/Publish | 저장 후 목록에 남고 Published 화면에서 같은 Widget이 보인다. |
| 실패 복구 | API 실패나 mock fallback 후에도 다시 정상 흐름으로 복구된다. |

## 화면에 보여야 하는 증거

| 화면 | 보여야 하는 증거 |
|---|---|
| ETL 목록 | Job 이름, 상태 배지, 최근 실행 상태 |
| ETL 상세/이력/DAG | `runId`, 현재 단계, 실행 상태 |
| Catalog 목록/상세 | Dataset 이름, schema, rows, size, freshness |
| Lineage | upstream 노드, current Dataset 노드, downstream 노드 |
| SQL | Dataset 이름, read-only query, Result Preview, `runId` |
| Dashboard Builder | Table Widget, Widget 제목, columns/rows, 저장 상태 |
| Published Dashboard | 저장된 Dashboard 이름, 같은 Widget 구성 |

## 샘플 데이터 기준

| 항목 | 기준 |
|---|---|
| 데이터 크기 | 10MB~100MB 또는 mock `sampleRows` |
| 데이터 형태 | CSV, JSONL, 또는 기존 fixture |
| 필수 컬럼 | SQL Result와 Dashboard Table에 보여줄 수 있는 3~6개 컬럼 |
| 필수 row | 화면에서 preview 가능한 5~20개 row |
| Dataset 이름 | 데모에서 반복해도 헷갈리지 않는 고정 이름 |

샘플 데이터는 실제 처리 성능을 증명하기 위한 것이 아니다. 화면과 상태 전달을 검증하기 위한 최소 입력이다.

## Fallback 기준

| 실패 지점 | Fallback |
|---|---|
| Job 생성 API 실패 | `createPipelineDraft` mock 응답으로 Job/Dataset 생성 |
| Job 실행 API 실패 | `runJobCommand` mock 응답으로 Run/DAG 상태 생성 |
| Catalog API 실패 | mock Dataset 목록과 상세 사용 |
| Lineage API 없음 | Dataset의 `upstream/downstream` 배열로 단계형 lineage 표시 |
| SQL API 실패 | Dataset `sampleRows`로 `SqlResult` 생성 |
| Dashboard 저장 API 실패 | localStorage snapshot으로 Draft/Published 상태 유지 |
| Publish API 실패 | local published snapshot으로 Published 화면 표시 |

Fallback을 쓴 경우 known issues에 남긴다. 단, 발표에서는 "실패했다"가 아니라 "현재 이 구간은 mock fallback으로 데모 흐름을 유지한다"라고 정확히 말한다.

## Artifact index

| Artifact | 목적 | 필수 필드 |
|---|---|---|
| `create-job-response.json` | Job/Dataset 생성 증거 | `job.id`, `dataset.id`, `dataset.name` |
| `job-command-response.json` | 실행 상태 증거 | `job.id`, `run.id`, `run.status`, `dagSteps` |
| `catalog-dataset-{datasetId}.json` | Catalog 표시 근거 | `id`, `name`, `schema`, `rows`, `size`, `upstream`, `downstream` |
| `lineage-{datasetId}.json` | Lineage 표시 근거 | `nodes`, `edges`, `selectedNodeId` |
| `sql-result-{runId}.json` | SQL 결과 근거 | `runId`, `datasetId`, `query`, `columns`, `rows`, `rowCount` |
| `dashboard-snapshot-{dashboardId}.json` | Dashboard 저장/게시 근거 | `id`, `datasetId`, `sourceRunId`, `status`, `widgets` |
| `known-issues.md` | 실패/제한 사항 기록 | 날짜, 증상, 영향, 임시 대응, 발표 문구 |

## Known issues 기록 방식

Known issue는 짧고 구체적으로 쓴다.

| 항목 | 작성 기준 |
|---|---|
| 날짜 | 문제가 확인된 날짜 |
| 증상 | 사용자가 보는 현상 |
| 원인 | 확인된 범위까지만 작성 |
| 영향 | 어떤 데모 화면에 영향을 주는지 |
| 임시 대응 | mock fixture, localStorage, sampleRows 등 |
| 발표 문구 | 발표자가 그대로 말할 수 있는 한 문장 |

예시:

```md
| 날짜 | 증상 | 원인 | 영향 | 임시 대응 | 발표 문구 |
|---|---|---|---|---|---|
| Day 3 | Dashboard 저장 API가 실패함 | 저장 endpoint 미완성 | Dashboard 목록 | localStorage snapshot 사용 | "현재 Dashboard 저장은 local snapshot으로 유지하고, 같은 데이터 흐름은 Published 화면까지 확인할 수 있습니다." |
```

## 발표에서 말하는 방식

정상 흐름:

- "Review에서 생성한 Job과 Dataset이 ETL 목록과 Catalog에 같이 생깁니다."
- "이 Dataset의 schema와 lineage가 Catalog 상세에서 보입니다."
- "같은 Dataset을 SQL로 열고, SQL Result를 Dashboard Widget으로 넘깁니다."
- "저장 후 Published 화면에서 같은 Dashboard를 확인합니다."

Fallback 사용 시:

- "이 구간은 현재 mock fallback으로 연결했습니다."
- "중요한 것은 `datasetId`, `runId`, `sqlResult`, `dashboardId`가 화면 사이에서 끊기지 않는다는 점입니다."
- "실제 API가 붙으면 같은 response shape로 교체하면 됩니다."
