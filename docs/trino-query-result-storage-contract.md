# Trino Query Result Storage Contract

이 문서는 Trino preview와 사용자 요청형 전체 결과의 저장 lifecycle을 정의한다. 기본 `preview` Query Run은 최대 100행만 실행해 PostgreSQL JSONB inline page에 저장한다. `전체 보기`, `CSV 다운로드`, 또는 SQL 결과 차트로 생성한 `run` Query Run만 private S3-compatible page object에 전체 결과를 저장한다. 로컬 root Compose는 MinIO를 사용하고 production은 사전 생성한 AWS S3 Query Result bucket과 EC2 instance profile default credential chain을 사용한다. SQL 검증, runtime identity, Query Run의 상위 동작은 `docs/trino-query-run-contract.md`를 따른다.

## 1. 핵심 결정

- 기본 실행은 원본 read-only SQL을 최대 100행 subquery로 감싼 `mode=preview`다. 결과 행은 PostgreSQL에 inline으로 저장하고 S3에는 쓰지 않는다.
- `전체 보기`, `CSV 다운로드`, 또는 SQL 결과 차트는 성공한 preview를 source로 `mode=run`을 시작하거나 보관 중인 같은 full run을 재사용한다. 이 run만 원본 SQL 전체를 실행한다.
- PostgreSQL은 두 mode의 Query Run metadata와 manifest를 저장한다. Preview에는 최대 100행 inline page도 저장하고, full run에는 페이지 순서, object reference, 접근 상태, checksum, retention 정보만 저장한다.
- backend는 full run 결과 페이지를 private Query Result bucket의 `query-results/<runId>/pages/<pageIndex>[.<attempt>].json.gz`에 저장한다. Collector page의 attempt는 lease generation에 묶이며 최초 request page는 suffix가 없을 수 있다.
- 압축 페이지에는 versioned JSON의 `columns`, `rows`를 넣는다. object upload가 끝난 뒤 현재 worker/generation을 DB row lock으로 다시 확인하고 metadata가 commit된 page만 조회 가능 상태로 만든다.
- 결과 object는 backend만 읽는다. API는 browser에 object URL, credential, bucket path를 반환하지 않는다.
- frontend polling이 아니라 backend collector가 Query Run과 Iceberg CTAS materialization의 Trino continuation URL을 terminal state까지 소비한다. 브라우저 탭을 닫아도 수집은 멈추지 않는다.
- 각 mode는 마지막 Trino page 수집과 result manifest 확정이 끝난 뒤에만 `succeeded`로 표시한다. Preview는 최대 100행 page가 준비되는 즉시 끝나며, full run은 전체 object page 저장이 끝날 때까지 background collector가 계속한다. Trino query는 끝났지만 결과 저장에 실패하면 `RESULT_PERSISTENCE_FAILED`로 `failed` 처리한다.
- Query Run 결과는 임시 데이터다. materialized Iceberg Dataset은 durable resource이며 Query Run 결과가 만료돼도 삭제하지 않는다.

## 2. 저장 모델

```text
default execute
  -> Trino preview (max 100 rows)
  -> PostgreSQL inline page / manifest
  -> preview table

full view, CSV, or chart
  -> linked Trino full run
  -> backend result collector
  -> private S3-compatible page objects
  -> PostgreSQL page metadata / manifest
  -> permission-checked cursor API, CSV stream, or bounded server chart aggregation
```

### 2.1 PostgreSQL metadata

`sql_run_result_pages`는 preview inline page와 full result metadata page를 같은 순서 계약으로 저장한다.

```ts
type QueryResultPageMetadata = {
  runId: string;
  pageIndex: number;
  storageBackend: "postgres" | "s3";
  objectKey?: string;
  rows?: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  compressedBytes: number;
  checksum?: string;
  sourceNextUri?: string;
  createdAt: string;
};

type QueryRunResultManifest = {
  storage: "postgres" | "s3";
  storageStatus: "collecting" | "available" | "expired" | "unavailable";
  columns: string[];
  pageCount: number;
  availablePageCount: number;
  rowCount?: number;
  collectedRowCount?: number;
  expectedRowCount?: number;
  collectionProgressPercentage?: number;
  byteSize: number;
  retentionExpiresAt: string;
};
```

Preview manifest는 `storage="postgres"`이고 최대 100행의 inline page 하나만 가진다. Full run이 수집 중이면 `availablePageCount`, `rowCount`, `collectedRowCount`는 계속 증가할 수 있다. `rowCount`는 terminal 전에는 누적 중인 값이다. QueryInfo가 작업 progress 100%와 `outputPositions`를 제공하거나 state가 `FINISHING`/`FINISHED`이면 이를 `expectedRowCount`로 저장하고 실제 누적 행과 비교해 `collectionProgressPercentage`를 계산한다. 총 출력 행을 얻지 못하면 별도 `COUNT(*)`를 실행하지 않고 수집 progress를 생략한다. Collector는 `collectionStartedAt`, `firstPageAvailableAt`, `collectionCompletedAt`과 대응 경과값을 durable manifest에 저장하며 최초 timestamp를 retry/restart/takeover에서 유지한다.

### 2.2 Full result object lifecycle

- Page object는 generation별 immutable attempt key에 먼저 쓴다. 페이지 metadata는 DB lease owner/generation이 일치할 때만 commit하며, fenced/duplicate worker는 자신이 방금 쓴 attempt object만 삭제한다.
- Cleanup은 idempotent하다. cleanup 중 없는 object는 이미 삭제된 것으로 처리한다. terminal(`succeeded`, `failed`, `cancelled`) run만 retention cleanup 대상이며 collector가 동작 중인 run은 건드리지 않는다. `trino-result-cleanup` worker는 keyset batch로 terminal run 전체를 순회한다.
- Expiry는 page object를 지우고 manifest를 `expired`로 표시한다. Query Run metadata와 감사 증거는 유지한다.
- Cancel은 generation을 먼저 fence한 뒤 현재 partial object/metadata를 정리한다. Failed run의 저장 page는 원인 확인이 가능하도록 retention까지 유지한 뒤 일반 expiry cleanup으로 제거한다.

## 3. Lifecycle And Recovery

```text
Query Run: queued -> running -> succeeded | failed | cancelled
Result storage: collecting -> available | unavailable | expired
```

- `queued`, `running`은 Query Run state다. `collecting`은 새 public Query Run status가 아니라 `result.storageStatus`로 표현한다.
- Collector lease는 Query Run과 함께 durable하게 저장한다. 한 run은 한 worker만 소유할 수 있다.
- Collector lease에는 generation을 둔다. cancel 또는 lease takeover는 generation을 증가시켜 이미 fetch 중인 이전 collector가 결과 metadata나 run payload를 다시 저장하지 못하게 한다.
- Collector는 blocking fetch 전후로 lease를 갱신한다. object upload와 metadata commit 사이에도 generation을 다시 확인하므로 오래된 worker가 replacement worker의 정상 page를 삭제할 수 없다.
- Backend 재시작 뒤 lease가 만료되면 한 worker가 lease를 다시 얻고, 마지막 durable continuation URL과 저장된 page index부터 수집을 재개한다.
- Collector는 page metadata의 `sourceNextUri`를 확인한다. worker가 page object commit 뒤 manifest를 쓰기 전에 중단돼도 같은 continuation을 다시 읽어 duplicate page를 만들지 않는다.
- Trino/object-storage 오류는 5초, 15초, 60초, 최대 5분 backoff로 재시도한다. retry 시각 전에는 worker가 같은 run을 다시 claim하지 않는다.
- Cancel은 먼저 collector generation을 무효화한 뒤 Trino cancel을 요청하고 partial result object를 정리한다.
- 같은 actor의 동일 `clientRequestId`와 base/reference/query/mode/previewLimit/sourceRunId/resultPageSize fingerprint는 idempotent하다. 다른 요청에 재사용하면 `409 CONFLICT`를 반환한다. actor별 active slot reservation은 PostgreSQL advisory lock 안에서 이루어져 동시 요청도 제한을 우회하지 못한다.

## 4. 결과 API 계약

`GET /api/query/runs/{runId}`는 result manifest를 포함한다. Frontend는 `storageStatus`, `availablePageCount`, `pageCount`, `retentionExpiresAt`로 수집 중인 결과와 만료된 결과를 구분한다.

`POST /api/query/runs/{previewRunId}/full-results`는 성공하고 아직 접근 가능한 preview에서만 full run을 시작한다. 같은 preview에 연결된 active run 또는 보관 중인 성공 run이 있으면 재사용하며, 응답의 `mode="run"`, `sourceRunId=previewRunId`로 두 실행을 구분한다.

`GET /api/query/runs/{runId}/results?cursor=<opaque>`는 submit 시 고정한 `resultPageSize`의 논리 API page를 반환한다. Trino/object-storage 물리 chunk 경계를 넘어서 행을 합쳐 반환하므로 첫 physical chunk가 1행이어도 완료된 결과의 100행 API page는 100행을 반환한다.

```ts
type QueryRunResultPage = {
  runId: string;
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  pageSize: number;
  pageNumber: number;
  rowStart: number;
  rowEnd: number;
  totalRows?: number;
  totalPages?: number;
  nextCursor: string | null;
  rowCount?: number;
};
```

- Cursor는 signed, run-bound, retention-bound opaque token이다. Storage page index와 row offset을 노출하거나 다른 run에 재사용할 수 없어야 한다.
- 아직 수집되지 않은 page 요청은 retry hint와 함께 `409 RESULT_PAGE_NOT_READY`를 반환한다.
- 만료된 결과는 `410 RESULT_EXPIRED`를 반환한다.
- Full result object가 없거나 손상되면 `503 RESULT_STORAGE_UNAVAILABLE`을 반환한다. Run은 감사 가능 상태로 남기며 운영자가 recovery를 다시 시도할 수 있다.
- 모든 result page read는 PostgreSQL inline page 또는 object storage를 읽기 전에 Dataset `query` 권한, user/group block, resource lock, submitter/admin ownership, retention state를 다시 검사한다.
- `POST /api/query/runs/{runId}/chart`는 완료된 full run page를 순차적으로 읽어 서버에서 집계한다. 최대 10,000개 집계 상태만 유지하고 최대 500개 chart group을 반환하며, 부분 page 또는 원본 전체 행을 browser에 전달하지 않는다. 현재 cursor page 이동은 차트 결과에 영향을 주지 않는다.

## 5. 용량, 보존, guardrail

- 현재 `TRINO_MAX_RESULT_BYTES=50MB`, `TRINO_MAX_RESULT_PAGES=1000`은 PostgreSQL 보호를 위한 전환기 제한이다. Phase 1은 일반 result path에서 이 제한을 제거한다.
- Result retention은 deployment별로 설정한다. Phase 1의 기본 목표는 24시간(`TRINO_RESULT_RETENTION_SECONDS=86400`)이며, 배포 환경은 더 짧게 설정할 수 있다.
- Storage quota, concurrent run quota, timeout, estimate 기반 확인은 organization policy다. 실행 전에 경고하거나 거절할 수 있지만, 완료된 결과를 조용히 truncate해서는 안 된다.
- `GET /api/query/runs/{runId}/exports/csv`는 완료된 `mode=run`의 object page를 다시 읽어 CSV를 server-side stream으로 반환한다. Preview에 직접 요청하면 `409 RESULT_PAGE_NOT_READY`다. SQL을 다시 실행하거나 browser memory에서 전체 파일을 만들지 않으며, 같은 permission과 retention check를 사용하고 raw object storage credential을 노출하지 않는다.
- `POST /api/query/runs/{runId}/chart`도 완료된 `mode=run`만 허용한다. 집계가 15초를 넘거나 group limit을 초과하면 부분 결과를 성공으로 표시하지 않고 명시적 오류를 반환한다.

## 6. 보안과 감사

- Query execution은 `asklake-api` Trino service identity를 유지한다. 로컬 Result collection은 warehouse/root와 분리된 MinIO query-result credential을 사용하고, production은 static key 없이 EC2 instance profile에 Query Result bucket 최소 권한을 부여한다.
- CTAS materialization은 `asklake-materializer`를 유지하며 temporary result page retention과 독립적이다.
- AskLake audit event는 submit, collector start/recovery, result persistence failure, cancel, terminal state, result page access, 전체 결과 chart aggregation, expiry, cleanup을 기록한다.
- 실제 사용자 identity는 AskLake audit actor로 남는다. Trino service account identity로 대체하지 않는다.

## 7. Phase 경계

### Phase 1: Storage migration

완료: 최대 100행 PostgreSQL inline preview, 요청형 S3-compatible full-result page storage, manifest persistence, integrity check, expiry cleanup primitive을 제공한다. 기존 PostgreSQL row page도 preview와 같은 read path로 호환한다.

### Phase 2: Collector worker

완료: Trino continuation 소비를 frontend polling에서 분리했다. `trino-result-collector`는 `sql_runs`의 durable lease를 claim하고 Query Run과 materialization을 terminal state까지 수집한다. lease 만료 run은 다음 worker가 recover하며, generation-fenced attempt object와 source continuation metadata로 page write retry를 idempotent하게 처리한다. collector start/recovery/retry/terminal audit event를 남긴다.

### Phase 3: Cursor API and UI

완료: `page:<index>`를 run-bound, retention-bound signed opaque cursor로 교체했다. API는 storage page 내부 row offset도 숨긴 채 고정 크기로 나누고, SQL 분석 UI는 preview page와 full run의 현재 page만 유지하면서 collecting/available/expired/unavailable 상태를 구분해 표시한다.

## 8. Phase 0 완료 기준

- Architecture, API, 운영 문서가 PostgreSQL preview와 S3-compatible full-result page-store의 경계, local MinIO/production AWS 경계를 같은 방식으로 설명한다.
- Result storage와 Query Run execution state가 모호하지 않다.
- Schema 또는 worker code를 추가하기 전에 retention, cleanup, access check, recovery, failure semantics가 확정된다.
- Phase 0 code 변경이 대용량 result persistence가 이미 구현됐다고 주장하지 않는다.
