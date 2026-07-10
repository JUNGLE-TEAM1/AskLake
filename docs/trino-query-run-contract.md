# Trino Query Run Contract

이 문서는 Issue #488 Phase 0에서 확정한 SQL 분석의 목표 실행 계약입니다. 현재 구현된 DuckDB Preview runtime의 동작 설명이 아니라, 후속 Phase에서 구현할 Trino 기반 실제 SQL 실행의 기준입니다.

## 1. 핵심 결정

- SQL 분석 화면에는 Preview 실행을 두지 않는다. 사용자의 `실행`은 선택한 Dataset 전체를 대상으로 하는 Trino Query Run 제출이다.
- 실행 전에는 read-only SQL, 선택 Dataset context, 권한, 차단/잠금, 추정 정보를 검증할 수 있지만, 별도 샘플 SQL 실행은 하지 않는다.
- 전체 결과는 Trino에서 완성한다. 브라우저는 결과를 한 번에 받거나 렌더링하지 않고 cursor 기반 페이지 API로 필요한 행만 조회한다.
- Query AI는 SQL 초안만 만든다. AI 제안은 자동 실행하지 않고, 사용자가 editor에 적용한 뒤 동일한 Query Run 검증을 거쳐 실행한다.
- 대시보드의 지속 가능한 source는 materialized Dataset이다. 완료된 run 결과는 retention 기간 안에서 임시 분석/대시보드 draft source로 쓸 수 있으나, publish 또는 반복 사용은 Iceberg/Parquet Dataset materialization을 거쳐야 한다.

## 2. Runtime Boundary

```text
SQL editor
  -> local syntax/context preflight (UX)
  -> POST /api/query/runs
  -> backend read-only/context/permission/governance validation
  -> Trino submit
  -> query_runs persistence
  -> queued/running/succeeded/failed/cancelled polling
  -> GET /api/query/runs/{runId}/results?cursor=...
```

Frontend preflight와 버튼 비활성화는 사용성 보조입니다. 실제 보안은 backend가 Trino 제출 전에 수행하는 validation과 permission/governance enforcement입니다.

## 3. Dataset To Trino Mapping

Trino 실행 대상 Dataset은 Catalog metadata에 다음 physical mapping을 가져야 합니다.

```ts
type QueryEngineTableRef = {
  catalog: string;
  schema: string;
  table: string;
  format: "iceberg" | "parquet";
  partitionColumns?: string[];
};
```

- 분석 SQL의 표시명과 실제 table reference는 mapping으로 분리한다.
- 한국어, 공백, 특수문자가 있는 표시명은 double-quoted identifier 정책을 유지한다.
- `sampleRows`는 schema/context UI 보조 데이터이며 Trino 실행 source가 아니다.
- Query Run은 base Dataset과 reference Dataset 전체의 mapping을 해석한 뒤, 선택되지 않은 physical table 참조를 차단한다.

## 4. Query Run Lifecycle

```ts
type QueryRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

type QueryRun = {
  runId: string;
  engine: "trino";
  status: QueryRunStatus;
  query: string;
  baseDatasetId: string;
  referenceDatasetIds: string[];
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  trinoQueryId?: string;
  error?: { code: string; message: string };
  stats?: {
    elapsedMs?: number;
    queuedMs?: number;
    cpuMs?: number;
    processedRows?: number;
    processedBytes?: number;
    peakMemoryBytes?: number;
  };
  result?: {
    columns: string[];
    rowCount?: number;
    retentionExpiresAt?: string;
    nextCursor?: string | null;
  };
};
```

- `POST /api/query/runs`는 `202 Accepted`와 `runId`, 초기 `queued` 상태를 반환한다.
- `GET /api/query/runs/{runId}`는 lifecycle, Trino query ID, 실행 통계, 오류, 결과 metadata를 반환한다.
- `POST /api/query/runs/{runId}/cancel`은 `queued` 또는 `running` run만 취소할 수 있다.
- terminal state는 `succeeded`, `failed`, `cancelled`다.
- run 상태는 poll 또는 후속 event transport로 갱신한다. Phase 0에서는 polling을 canonical client 흐름으로 둔다.

## 5. Result Pagination

```ts
type QueryRunResultPage = {
  runId: string;
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  pageSize: number;
  nextCursor: string | null;
  rowCount?: number;
};
```

- `GET /api/query/runs/{runId}/results?cursor=<opaque>&pageSize=<n>`만 결과 행을 반환한다.
- cursor는 opaque value이며 frontend가 offset 또는 SQL을 조합하지 않는다.
- 실행 결과 전체를 API response 또는 frontend memory에 적재하지 않는다.
- row count는 Trino가 확정할 수 있을 때만 반환하며, pagination을 위해 별도 `COUNT(*)`를 강제하지 않는다.
- 결과 retention 만료 또는 cursor 만료는 명시적 오류로 응답한다. 재실행 여부는 사용자에게 선택하게 한다.

## 6. Validation, Governance, Audit

Trino 제출 전에 backend는 다음 순서로 검증합니다.

1. `SELECT` 또는 `WITH ... SELECT` 단일 statement인지 확인한다.
2. SQL이 참조한 Dataset을 selected context와 physical mapping으로 해석한다.
3. 모든 참조 Dataset에 대해 `query` 권한을 확인한다.
4. 사용자/그룹 차단과 resource lock을 확인한다.
5. Trino에 제출하고 `trinoQueryId`를 Query Run에 기록한다.

권한이 없거나 차단/잠금된 요청은 Trino에 제출하지 않고 `403 FORBIDDEN`으로 종료합니다. 감사 로그에는 submit, cancel, terminal result, forbidden attempt를 남기며 다음을 포함합니다.

- actor와 참조 Dataset
- AskLake `runId`, Trino query ID
- 실행 상태와 오류 요약
- elapsed/CPU time, processed rows/bytes, peak memory

## 7. Estimate And Guardrail

- `POST /api/query/estimates`는 SQL을 실행하지 않고 Trino plan/metadata 기반의 예상 처리량, 위험도, 경고를 반환하는 선택 API다.
- 예상값은 보장 비용이 아니며, 실제 처리량과 실행 시간은 완료된 Query Run stats를 source of truth로 한다.
- UI는 editor 아래에 estimate를 표시한다. 확인 모달은 조직의 bytes/time/concurrency 정책 임계치를 넘는 경우에만 사용한다.
- backend는 사용자/조직별 동시 실행 수, timeout, 최대 처리량 등의 guardrail을 적용할 수 있다.

## 8. Dashboard And Materialization

- SQL result draft는 retention 내의 completed run 결과를 임시 source로만 사용할 수 있다.
- publish, 공유, 반복 refresh가 필요한 dashboard는 `POST /api/catalog/derived-datasets` 또는 후속 materialization API로 생성한 Iceberg/Parquet Dataset을 source로 사용한다.
- materialized Dataset은 Catalog, lineage, permission grant, audit 흐름에 등록된다.
- dashboard가 결과의 한 frontend page를 source로 저장하는 것은 금지한다.

## 9. Phase Boundary

Phase 1은 Trino single-node coordinator와 Iceberg JDBC catalog, MinIO S3 warehouse 구성, Catalog `queryEngineTable` mapping schema와 backend configuration을 추가합니다. `scripts/verify-deploy-dependencies.sh`는 Trino image availability도 확인합니다.

Phase 2는 `TrinoClient`의 statement/nextUri/cancel protocol adapter, canonical Trino Query Run payload persistence, Dataset display name -> physical table compiler, Trino submit/refresh/cancel service를 추가합니다. 기존 `/api/query/runs`와 frontend는 아직 DuckDB compatibility runtime을 사용한다. API routing 전환, cursor result retention, UI polling과 current DuckDB 제거는 후속 Phase다.
