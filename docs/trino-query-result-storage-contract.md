# Trino Query Result Storage Contract

이 문서는 Query Result Phase 0에서 확정한 대용량 결과 lifecycle을 정의한다. Query Result Phase 1은 일반 Trino 결과 행을 private MinIO page object로 전환했으며, PostgreSQL JSONB row는 migration read compatibility로만 남아 있다. SQL 검증, runtime identity, Query Run의 상위 동작은 `docs/trino-query-run-contract.md`를 따른다.

## 1. 핵심 결정

- 성공한 Query Run은 read-only query 전체를 실행한다. 브라우저는 전체 결과를 한 번에 받거나 렌더링하지 않는다.
- PostgreSQL은 Query Run metadata, 페이지 순서, object reference, 접근 상태, checksum, retention 정보만 저장한다. 결과 행은 저장하지 않는다.
- backend는 결과 페이지를 private MinIO의 `query-results/<runId>/pages/<pageIndex>[.<attempt>].json.gz`에 저장한다. Collector page의 attempt는 lease generation에 묶이며 최초 request page는 suffix가 없을 수 있다.
- 압축 페이지에는 versioned JSON의 `columns`, `rows`를 넣는다. object upload가 끝난 뒤 현재 worker/generation을 DB row lock으로 다시 확인하고 metadata가 commit된 page만 조회 가능 상태로 만든다.
- 결과 object는 backend만 읽는다. API는 browser에 MinIO URL, access key, bucket path를 반환하지 않는다.
- frontend polling이 아니라 backend collector가 Query Run과 Iceberg CTAS materialization의 Trino continuation URL을 terminal state까지 소비한다. 브라우저 탭을 닫아도 수집은 멈추지 않는다.
- 마지막 Trino page 수집과 result manifest 확정이 끝난 뒤에만 Query Run을 `succeeded`로 표시한다. Trino query는 끝났지만 결과 저장에 실패하면 `RESULT_PERSISTENCE_FAILED`로 `failed` 처리한다.
- Query Run 결과는 임시 데이터다. materialized Iceberg Dataset은 durable resource이며 Query Run 결과가 만료돼도 삭제하지 않는다.

## 2. 저장 모델

```text
Trino pages
  -> backend result collector
  -> private MinIO page objects
  -> PostgreSQL page metadata / manifest
  -> permission-checked result API
  -> frontend page renderer
```

### 2.1 PostgreSQL metadata

Phase 1은 `sql_run_result_pages`의 새 row를 아래 metadata-only shape로 저장한다.

```ts
type QueryResultPageMetadata = {
  runId: string;
  pageIndex: number;
  objectKey: string;
  rowCount: number;
  compressedBytes: number;
  checksum: string;
  sourceNextUri?: string;
  createdAt: string;
};

type QueryRunResultManifest = {
  storage: "minio";
  storageStatus: "collecting" | "available" | "expired" | "unavailable";
  columns: string[];
  pageCount: number;
  availablePageCount: number;
  rowCount?: number;
  byteSize: number;
  retentionExpiresAt: string;
};
```

Run이 수집 중이면 `availablePageCount`와 현재까지 저장된 `rowCount`는 계속 증가할 수 있다. `rowCount`는 terminal 전에는 누적 중인 값이며, 이를 확정하기 위해 별도 `COUNT(*)`를 실행하지 않는다.

### 2.2 Object lifecycle

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
- Trino/MinIO 오류는 5초, 15초, 60초, 최대 5분 backoff로 재시도한다. retry 시각 전에는 worker가 같은 run을 다시 claim하지 않는다.
- Cancel은 먼저 collector generation을 무효화한 뒤 Trino cancel을 요청하고 partial result object를 정리한다.
- 같은 actor의 동일 `clientRequestId`와 base/reference/query/resultPageSize fingerprint는 idempotent하다. 다른 요청에 재사용하면 `409 CONFLICT`를 반환한다. actor별 active slot reservation은 PostgreSQL advisory lock 안에서 이루어져 동시 요청도 제한을 우회하지 못한다.

## 4. 결과 API 계약

`GET /api/query/runs/{runId}`는 result manifest를 포함한다. Frontend는 `storageStatus`, `availablePageCount`, `pageCount`, `retentionExpiresAt`로 수집 중인 결과와 만료된 결과를 구분한다.

`GET /api/query/runs/{runId}/results?cursor=<opaque>`는 submit 시 고정한 `resultPageSize` 이하의 API page를 반환한다. 하나의 Trino storage page가 더 커도 backend가 row offset cursor로 나누며 results endpoint에서 크기를 변경하지 않는다.

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

- Cursor는 signed, run-bound, retention-bound opaque token이다. Storage page index와 row offset을 노출하거나 다른 run에 재사용할 수 없어야 한다.
- 아직 수집되지 않은 page 요청은 retry hint와 함께 `409 RESULT_PAGE_NOT_READY`를 반환한다.
- 만료된 결과는 `410 RESULT_EXPIRED`를 반환한다.
- Object가 없거나 손상되면 `503 RESULT_STORAGE_UNAVAILABLE`을 반환한다. Run은 감사 가능 상태로 남기며 운영자가 recovery를 다시 시도할 수 있다.
- 모든 result page read는 MinIO를 읽기 전에 Dataset `query` 권한, user/group block, resource lock, submitter/admin ownership, retention state를 다시 검사한다.

## 5. 용량, 보존, guardrail

- 현재 `TRINO_MAX_RESULT_BYTES=50MB`, `TRINO_MAX_RESULT_PAGES=1000`은 PostgreSQL 보호를 위한 전환기 제한이다. Phase 1은 일반 result path에서 이 제한을 제거한다.
- Result retention은 deployment별로 설정한다. Phase 1의 기본 목표는 24시간(`TRINO_RESULT_RETENTION_SECONDS=86400`)이며, 배포 환경은 더 짧게 설정할 수 있다.
- Storage quota, concurrent run quota, timeout, estimate 기반 확인은 organization policy다. 실행 전에 경고하거나 거절할 수 있지만, 완료된 결과를 조용히 truncate해서는 안 된다.
- Download/export는 별도 후속 API다. 같은 permission과 retention check를 사용하며 raw object storage credential을 노출하지 않는다.

## 6. 보안과 감사

- Query execution은 `asklake-api` Trino service identity를 유지한다. Result collection은 MinIO root/warehouse identity와 분리된 query-result 전용 credential만 사용한다.
- CTAS materialization은 `asklake-materializer`를 유지하며 temporary result page retention과 독립적이다.
- AskLake audit event는 submit, collector start/recovery, result persistence failure, cancel, terminal state, result page access, expiry, cleanup을 기록한다.
- 실제 사용자 identity는 AskLake audit actor로 남는다. Trino service account identity로 대체하지 않는다.

## 7. Phase 경계

### Phase 1: Storage migration

완료: MinIO page storage, metadata-only page row, manifest persistence, integrity check, expiry cleanup primitive을 추가했다. Migration 중 기존 PostgreSQL row page는 backward compatibility를 위해 read만 허용한다.

### Phase 2: Collector worker

완료: Trino continuation 소비를 frontend polling에서 분리했다. `trino-result-collector`는 `sql_runs`의 durable lease를 claim하고 Query Run과 materialization을 terminal state까지 수집한다. lease 만료 run은 다음 worker가 recover하며, generation-fenced attempt object와 source continuation metadata로 page write retry를 idempotent하게 처리한다. collector start/recovery/retry/terminal audit event를 남긴다.

### Phase 3: Cursor API and UI

완료: `page:<index>`를 run-bound, retention-bound signed opaque cursor로 교체했다. API는 storage page 내부 row offset도 숨긴 채 고정 크기로 나누고, SQL 분석 UI는 현재 page만 유지하면서 collecting/available/expired/unavailable 상태를 구분해 표시한다. 기존 PostgreSQL row-page read는 migration compatibility로만 남는다.

## 8. Phase 0 완료 기준

- Architecture, API, 운영 문서가 같은 MinIO page-store 모델을 설명한다.
- Result storage와 Query Run execution state가 모호하지 않다.
- Schema 또는 worker code를 추가하기 전에 retention, cleanup, access check, recovery, failure semantics가 확정된다.
- Phase 0 code 변경이 대용량 result persistence가 이미 구현됐다고 주장하지 않는다.
