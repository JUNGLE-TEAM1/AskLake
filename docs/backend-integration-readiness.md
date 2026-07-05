# AskLake Backend Integration Readiness

이 문서는 AskLake 프론트엔드와 백엔드 연결 상태, 남은 API 범위, 검증 기준을 정리한다. Pair A Source/Schema/Create/Run 흐름은 live backend를 기준으로 검증한다.

상세 request/response shape는 `docs/api-contract.md`를 기준으로 한다.

## 1. 현재 연결 상태

| 영역 | 현재 상태 | 남은 범위 |
| --- | --- | --- |
| 수집/처리 목록 | `GET /api/etl/jobs` hydrate. 서버 상태가 비어 있으면 빈 목록으로 시작 | 삭제, 수정 저장 persistence |
| 새 수집/처리 생성 | Source -> Schema -> Rule -> Schedule -> Permission -> Target -> Review -> Create가 `POST /api/etl/jobs`로 연결 | 중간 단계별 서버 저장 API는 후속 범위 |
| Source/Schema | `POST /api/etl/sources/test`로 실제 connector 확인 및 schema/sampleRows 반영 | Kafka message payload sampling, Parquet physical schema inference |
| Rule | 현재 schema/sampleRows 기반 preview, create payload에 transform/quality detail 포함 | 별도 backend rule preview API |
| Job command | `POST /api/etl/jobs/{jobId}/commands`로 Spark run 실행 | pause/cancel의 실제 Spark job interrupt |
| Run/DAG | Spark 결과로 runHistory, dagSteps, catalog dataset 갱신 | 장기 persistence와 run detail 조회 API |
| Catalog | `GET /api/catalog/datasets` hydrate, create/run 결과 반영 | 상세/lineage/search persistence |
| SQL 분석 | `POST /api/query/runs` 호출 지점 유지 | read-only SQL engine 고도화 |
| Dashboard | frontend flow 유지 | dashboard 저장/게시 persistence |
| Audit | local 기록 중심 | `POST /api/audit-logs` 서버 저장 |

## 2. Pair A Live Contract

Pair A 생성 요청은 nested `draftPipeline`을 submit 직전에 flat `CreatePipelineRequest`로 변환한다.

필수 create payload:

- Source: `sourceType`, `sourceLabel`, `sourceConfig`
- Schema: `schemaColumns`, `schemaSampleRows`, `schemaSummary`, `schemaFingerprint`
- Transform: `transformSteps`, `transformOutputColumns`
- Quality: `qualityRules`, `qualityScore`, `qualityStatus`, `qualityInvalidRows`
- Schedule/Permission/Target: `scheduleLabel`, `retryPolicy`, `owner`, `targetDataset`, `targetLayer`, `targetFormat`

Backend create response:

```ts
type CreateJobResponse = {
  job: JobRowData;
  dataset: CatalogDataset;
};
```

Backend command response:

```ts
type JobCommandResponse = {
  action: string;
  apiPath: string;
  job: JobRowData;
  run: JobRunSummary;
  dagSteps: JobDagStep[];
};
```

## 3. Source Credential Handling

Backend connector 응답은 secret field를 redacted value로 내려준다. 프론트는 응답 metadata, schema, sampleRows는 반영하되 브라우저 세션에 사용자가 입력한 credential 값은 다음 connector 호출을 위해 유지해야 한다.

적용 기준:

- 첫 연결 테스트 성공 후 Schema 단계의 다시 확인이 credential 없이 실패하면 안 된다.
- 샘플 범위 변경 재호출도 같은 credential을 유지해야 한다.
- PR 본문, 로그, 문서에는 실제 credential 값을 쓰지 않는다.

## 4. Spark Run Path

`POST /api/etl/jobs/{jobId}/commands`는 Spark runner를 호출한다.

Spark runner 입력:

- File / S3, Data Lake: object path를 Spark source로 직접 사용
- REST/PostgreSQL/MongoDB 등 connector source: bounded schema sample rows를 JSONL로 기록한 뒤 Spark source로 사용
- connector sample JSONL은 `ASKLAKE_SPARK_REPORT_DIR`에 쓰고 Spark submit/master/worker 모두 `ASKLAKE_SPARK_REPORT_CONTAINER_DIR` 기본값 `/work/reports`로 같은 host directory를 mount해야 한다. worktree가 바뀌면 Spark container는 mount source가 달라지므로 자동 재생성되어야 한다.
- `ASKLAKE_SPARK_TRANSFORM_STEPS`: create payload의 transform steps
- `ASKLAKE_SPARK_QUALITY_RULES`: create payload의 quality rules

Spark runner 결과:

- transformed Parquet output
- output schema
- input/output row count
- quality summary
- run status
- DAG step status

## 5. 검증 명령

Backend:

```powershell
cd backend
npm run verify
npm run verify:sources
npm run verify:spark-run
```

Frontend:

```powershell
cd frontend
npm run build
```

Browser smoke:

- backend server를 켠다.
- frontend dev server를 켠다.
- 수집/처리 목록이 처음에는 비어 있는지 확인한다.
- 새 수집/처리 생성에서 Source 연결, Schema 확인, Rule 적용, Review, Create를 진행한다.
- 생성된 Job을 실행하고 Run history와 DAG가 Spark 결과를 반영하는지 확인한다.

## 6. 완료 기준

- ETL/Catalog 초기 목록은 서버가 비어 있으면 빈 상태로 표시된다.
- Source/Schema/Create/Run 흐름에서 seed나 fixture job을 사용자 화면에 표시하지 않는다.
- Source credential은 connector 응답의 redacted config로 덮어쓰이지 않는다.
- Transform/Quality는 summary 문자열만이 아니라 실행 가능한 payload로 create request에 들어간다.
- Spark run 후 DAG는 Source, Schema, Spark Source read, Transform, Quality, Parquet write, Catalog update 단계를 표시한다.
- 실패 상태는 실제 실패 단계와 원인을 표시하고, 고정된 fake failed DAG를 보여주지 않는다.

## 7. 남은 작업

- Kafka message payload schema sampling
- Parquet physical schema inference endpoint
- ETL job/dataset/run persistence
- 삭제/수정 API persistence
- SQL engine read-only guard 고도화
- Dashboard save/publish persistence
- Audit log server persistence
