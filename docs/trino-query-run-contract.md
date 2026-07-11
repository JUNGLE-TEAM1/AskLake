# Trino Query Run Contract

이 문서는 Issue #488에서 구현한 Trino 기반 실제 SQL 실행 계약입니다. `TRINO_ENABLED=false`의 DuckDB bounded runtime은 전환 호환 경로이며 이 계약의 대용량 실행으로 해석하지 않습니다. 대용량 결과의 durable storage, collector, retention 상세는 `docs/trino-query-result-storage-contract.md`를 따른다.

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
  -> atomic actor slot + idempotency reservation
  -> Trino submit
  -> query_runs persistence
  -> trino-result-collector continuation drain
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

- `POST /api/query/runs`는 `202 Accepted`와 `runId`, 최초로 저장된 실행 상태를 반환한다.
- 최초 Trino response가 이미 진행 또는 완료 상태이면 initial response는 `running`, `succeeded`, `failed`일 수 있다.
- Frontend는 실행 시도마다 `clientRequestId`를 보내고 confirmation/network retry에는 같은 값을 재사용한다. Backend는 `(actorKey, clientRequestId)` unique reservation과 request fingerprint로 중복 Trino submit을 막는다.
- actor별 active run limit은 PostgreSQL advisory lock 안에서 reservation row를 먼저 저장해 원자적으로 적용한다. 초과는 `429`, 같은 key의 다른 request는 `409`다.
- `GET /api/query/runs/{runId}`는 lifecycle, Trino query ID, 실행 통계, 오류, 결과 metadata를 반환한다.
- `GET /api/query/runs`는 현재 submitter의 최근 실행 요약만 반환한다. actor user ID가 있으면 ID를 기준으로 분리하고, ID 없는 legacy run에만 display name fallback을 적용한다. 동일 display name의 다른 user ID는 run을 열거나 materialize할 수 없다.
- SQL 분석 UI는 polling 응답의 queued/elapsed time, processed bytes/rows, peak memory를 실행 중과 완료 뒤에 함께 표시한다. 실행 전 estimate는 참고값이고 실제 stats가 우선한다.
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

- `GET /api/query/runs/{runId}/results?cursor=<opaque>`만 결과 행을 반환한다. page size는 submit 시 고정하고 마지막 page만 작을 수 있다.
- cursor는 storage page index와 row offset을 감춘 opaque value이며 frontend가 offset 또는 SQL을 조합하지 않는다.
- 실행 결과 전체를 API response 또는 frontend memory에 적재하지 않는다.
- Frontend는 현재 page row와 cursor history만 보관하고 이전 page 이동 시 서버에서 다시 읽는다.
- row count는 Trino가 확정할 수 있을 때만 반환하며, pagination을 위해 별도 `COUNT(*)`를 강제하지 않는다.
- 결과 retention 만료 또는 cursor 만료는 결과 page endpoint에서 명시적 오류로 응답한다. run metadata 조회는 만료 후에도 유지해 사용자가 SQL, 상태, 통계를 확인할 수 있게 한다. 재실행 여부는 사용자에게 선택하게 한다.
- 새 Trino Query Run 결과는 private MinIO gzip page object에 저장하고 PostgreSQL에는 page metadata만 남긴다. 기존 PostgreSQL JSONB page storage는 migration read compatibility로만 유지한다. browser-independent collector lifecycle은 `docs/trino-query-result-storage-contract.md`를 canonical source로 둔다.

## 6. Validation, Governance, Audit

Trino 제출 전에 backend는 다음 순서로 검증합니다.

1. `SELECT` 또는 `WITH ... SELECT` 단일 statement인지 확인한다.
2. SQL이 참조한 Dataset을 selected context와 physical mapping으로 해석한다.
3. 모든 참조 Dataset에 대해 `query` 권한을 확인한다.
4. 사용자/그룹 차단과 resource lock을 확인한다.
5. actor slot과 idempotency key를 원자적으로 reserve한다.
6. Trino에 제출하고 `trinoQueryId`를 Query Run에 기록한다.

권한이 없거나 차단/잠금된 요청은 Trino에 제출하지 않고 `403 FORBIDDEN`으로 종료합니다. 감사 로그에는 submit, cancel, terminal result, forbidden attempt를 남기며 다음을 포함합니다.

Run metadata/result/cancel과 materialization submit/status를 열 때도 현재 base/reference Dataset의 `query` grant, principal block, resource lock을 다시 확인합니다. Frontend에서 목록이 늦게 사라지거나 직접 URL/API를 호출해도 backend 403이 최종 보안 경계입니다. User grant principal은 ID와 email을 우선 지원하고 legacy display name grant를 읽기 호환합니다.

- actor와 참조 Dataset
- AskLake `runId`, Trino query ID
- 실행 상태와 오류 요약
- elapsed/CPU time, processed rows/bytes, peak memory

## 7. Estimate And Guardrail

- `POST /api/query/estimates`는 SQL을 실행하지 않고 우선 `EXPLAIN (TYPE DISTRIBUTED)` plan의 byte estimate를 사용한다. plan을 읽지 못하면 Catalog size/JOIN complexity heuristic으로 fallback하며, UI는 source를 표시한다. 이 값은 actual Trino run stats나 청구 금액이 아니다.
- 예상값은 보장 비용이 아니며, 실제 처리량과 실행 시간은 완료된 Query Run stats를 source of truth로 한다.
- UI는 editor 아래에 estimate를 표시한다. 확인 모달은 조직의 bytes/time/concurrency 정책 임계치를 넘는 경우에만 사용한다.
- backend는 사용자/조직별 동시 실행 수, timeout, 최대 처리량 등의 guardrail을 적용한다. warning threshold 이상은 actor/query/dataset/TTL-bound confirmation token을 요구하며, hard byte limit은 backend가 차단한다.
- Dataset 크기가 없거나 `Trino managed`처럼 Catalog 크기를 추정할 수 없어도 Trino plan byte estimate가 있으면 그 값을 사용해 저위험 실행은 바로 진행한다. plan과 Catalog 크기를 모두 얻지 못한 경우에만 보수적으로 confirmation을 요구하고 불확실성을 UI에 표시한다.

## 8. Dashboard And Materialization

- SQL result draft는 retention 내의 completed run 결과를 임시 source로만 사용할 수 있다.
- publish, 공유, 반복 refresh가 필요한 dashboard는 `POST /api/catalog/derived-datasets` 또는 후속 materialization API로 생성한 Iceberg/Parquet Dataset을 source로 사용한다.
- materialized Dataset은 Catalog, lineage, permission grant, audit 흐름에 등록된다.
- dashboard가 결과의 한 frontend page를 source로 저장하는 것은 금지한다.
- Materialization 요청은 source run submitter ID 또는 admin 여부와 현재 Dataset query/governance 상태를 다시 확인한 뒤 `asklake-materializer`로 CTAS를 제출한다.
- CTAS continuation은 `trino-result-collector`가 durable lease로 처리한다. `GET /api/catalog/trino-materializations/{materializationId}`는 persisted 상태를 읽을 뿐 실행을 진전시키지 않으며, terminal success 뒤 등록 검증만 안전하게 재시도할 수 있다.

## 9. Phase Boundary

Phase 1은 Trino single-node coordinator와 Iceberg JDBC catalog, MinIO S3 warehouse 구성, Catalog `queryEngineTable` mapping schema와 backend configuration을 추가합니다. `scripts/verify-deploy-dependencies.sh`는 Trino image availability도 확인합니다.

Phase 2는 `TrinoClient`의 statement/nextUri/cancel protocol adapter, canonical Trino Query Run payload persistence, Dataset display name -> physical table compiler, Trino submit/refresh/cancel service를 추가합니다. 보안 보완으로 AST 기반 single SELECT validation, physical table 직접 입력/table function 차단, server-side bounded result page 저장, opaque cursor, run submitter ownership, nextUri coordinator origin 검증, audit lifecycle를 포함합니다.

production Trino는 backend-only internal network, client/internal HTTPS, password authentication, file-based least-privilege access control, separate Iceberg JDBC/warehouse/result-storage credentials를 전제로 한다. `asklake-api`는 SELECT와 자기 query 실행/관리만, `asklake-materializer`는 `asklake` schema의 CTAS/검증에 필요한 권한만 가진다. TLS CA, keystore, bcrypt cost 8 이상 또는 PBKDF2 password hash file은 서버 secret 경로에서 mount하며 repository에 저장하지 않는다. Bootstrap job은 기존 volume에도 JDBC role과 Iceberg metadata table 소유권, 전용 bucket/service account를 멱등 반영한다. `TRINO_ENABLED=true`이면 `/api/query/runs` routing은 Trino runtime을 사용하고 frontend는 run polling, cancel, cursor 결과 page를 사용하며 preview-only `LIMIT`을 기본 SQL에 넣지 않는다.

Phase 5는 legacy JSONL derived dataset 경로와 Trino run을 명확히 분리한다. Trino run은 전체 결과 page를 재조합하지 않고, succeeded run의 SQL을 Iceberg CTAS statement로 materialize한다.

Phase 6은 `POST /api/catalog/trino-runs/{runId}/materializations`로 CTAS를 Trino materializer service account에 제출하고 materialization run을 별도 저장한다. 일반 Query Run은 `asklake-api`, CTAS는 `asklake-materializer`를 Basic auth와 `X-Trino-User`에 동일하게 사용한다. 로그인 사용자의 actor identity는 Trino service account로 대체하지 않고 AskLake audit log에 별도로 기록한다. 생성 요청은 Catalog `pending` row를 먼저 만들고, collector가 CTAS terminal state를 저장한 뒤 별도 `DESCRIBE`가 성공해야 `queryEngineStatus=available`과 physical mapping을 공개한다. 확인 실패는 `registration_failed`로 남고 terminal materialization GET이 같은 table 검증을 재시도할 수 있다. 표시명은 한글을 허용하되 Dataset ID와 Iceberg table은 hash suffix가 있는 안전한 ASCII identity로 자동 생성한다.
