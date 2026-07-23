# Continuous Materialization·Catalog·Dashboard 발행 계약

## 목적과 범위

Kafka Continuous micro-batch가 durable output을 만든 뒤 Catalog와 Dashboard에 보이는 과정을 하나의 긴 transaction이나 `etl_service.py`의 암묵적 순서로 처리하지 않는다. `app.application.continuous_publication`이 단계와 재시도 경계를 소유하고, `etl_service.py`는 production hook을 조립하는 compatibility facade로 남는다.

공개 API, DB schema, 기존 Job/runtime/session/checkpoint/report/manifest 형식은 변경하지 않는다. 최신 단계 진단은 bounded `runtime.metrics.publicationWorkflow`에 저장하며 기존 client는 이를 무시할 수 있다.

## 단계와 canonical evidence

| 단계 | 성공 증거 | canonical owner | 실패 후 재시도 |
|---|---|---|---|
| output | exact Iceberg snapshot, `_asklake_run_id`, row count와 `sourceBoundary`의 Trino 검증 | Iceberg/Trino | 기존 output을 재검증하며 Spark를 다시 실행하지 않음 |
| manifest | batch manifest path, `_SUCCESS`, 정규화된 Kafka source range | object storage | 같은 manifest를 다시 읽고 검증 |
| Catalog | 같은 `runId`의 `materializationRuns` 항목과 query-engine mapping | PostgreSQL Catalog dataset | 기존 Run을 재사용하며 중복 materialization을 만들지 않음 |
| Dashboard | 같은 `runId`의 dataset revision commit 또는 zero-row partition progress | PostgreSQL Dashboard live tables | 기존 Catalog Run에서 revision만 재개 |

runtime status나 worker report는 위 사실을 대신하지 않는다. runtime은 가장 최근 publication 하나의 단계별 attempts/status/error만 투영한다.

## 발행 identity와 멱등성

발행 identity는 다음 값으로 결정한다.

- `jobId`
- durable publication `batchId`
- deterministic `runId`
- `manifestPath`, `sourceBoundary`, `sourceRanges`의 manifest fingerprint
- `dataPath`, `icebergCommit`, `storedCount`의 output fingerprint

이 값의 SHA-256이 `idempotencyKey`다. 같은 batch/run/manifest 재시도는 같은 identity를 사용한다. Catalog와 Dashboard의 실제 중복 방지는 기존 dataset publication advisory lock, dataset row lock, `runId` unique commit 계약이 담당한다. Spark raw batch number만으로 identity를 만들지 않는다.

## transaction 경계

```text
output/manifest 외부 검증 (DB publication lock 없음)
  -> Catalog identity lock + dataset row lock + Catalog commit
  -> Dashboard identity lock + revision/progress commit
  -> runtime cursor/diagnostic projection
```

- object storage와 Trino 검증 중에는 Catalog/Dashboard DB lock을 잡지 않는다.
- Catalog commit과 Dashboard commit은 서로 독립적이다.
- Catalog 성공 뒤 Dashboard가 실패해도 Catalog를 rollback하거나 적재를 data loss로 표시하지 않는다.
- Dashboard 재시도는 Catalog의 같은 `runId`를 재사용한다.
- Catalog commit 전에 실패하면 partial Catalog row를 남기지 않는다.
- zero-row batch는 Catalog materialization을 만들지 않고 manifest 검증 뒤 partition progress만 멱등 기록한다.

## 부분 실패와 복구

| 장애 지점 | 보존되는 것 | 다음 reconciliation 동작 |
|---|---|---|
| output 검증 실패 | checkpoint/output/manifest 원본, 단계 오류 | output evidence부터 재검증 |
| output 성공, manifest 실패 | Iceberg output, output 성공 진단 | manifest 재확인 후 후속 단계 수행 |
| manifest 성공, Catalog timeout | output/manifest, Catalog pending 오류 | 같은 manifest로 Catalog만 재개 |
| Catalog 성공, Dashboard 실패 | Catalog Run, Dashboard pending 오류 | 기존 Catalog Run에서 Dashboard만 재개 |
| backend process 종료 | durable manifest, Catalog/Dashboard unique identity | report 또는 manifest recovery가 미반영 batch를 다시 선택 |
| 동시 reconciler | advisory/row lock과 `runId` identity | 한 발행만 생성하고 다른 호출은 기존 결과 재사용 |

발행 실패 시 `publicationRecoveryPending=true`를 남긴다. 다음 reconciliation은 report window만 신뢰하지 않고 완료 manifest 목록에서 Catalog cursor 이후 batch를 복구한다. 발행이 모두 끝나면 pending flag와 publication 단계 오류를 지운다.

## Legacy 호환

- fingerprint optional field가 없는 기존 manifest도 필수 batch/run/path/source range가 유효하면 읽는다.
- Catalog에는 존재하지만 Dashboard revision이 없는 legacy Run은 첫 재시도에서 snapshot baseline revision으로 backfill한다.
- 기존 `lastError` 문자열 prefix는 유지하고 구조화 오류의 stage/code/retryable/context를 함께 기록한다.
- 저장된 `publicationWorkflow`가 없는 runtime은 빈 단계 상태에서 정상적으로 시작한다.

## 검증

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_continuous_publication_workflow \
  tests.test_kafka_continuous_dashboard_sync \
  tests.test_dashboard_live_repository -v
npm run verify:continuous-runtime-contract
npm run verify:kafka-continuous-contract
```

집중 회귀는 output 성공 후 manifest 실패, Catalog timeout, Dashboard 실패, 같은 batch 재시도, backend restart, 동시 reconciler identity, legacy manifest를 포함한다.

## Rollback

`app.application.continuous_publication`과 `etl_service.py`의 hook wiring을 함께 이전 facade 내부 구현으로 되돌린다. DB migration과 public field 제거가 없으므로 data rewrite는 하지 않는다. 이미 저장된 `publicationWorkflow` JSON은 이전 코드가 무시한다.
