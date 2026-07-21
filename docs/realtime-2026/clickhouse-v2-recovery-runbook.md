# ClickHouse Realtime V2 복구·전환 runbook

## 상태와 적용 범위

이 문서는 ClickHouse hot serving, Gold Iceberg archive, rebuild, Dataset routing cutover/rollback의 운영 순서를 고정한다. 누적 PR01~09 branch의 코드 경계를 설명하지만 merge, production 배포 또는 traffic promotion을 승인하지 않는다.

현재 외부 cutover HTTP endpoint는 없다. Backend-owned worker/운영 command만 `ArchiveRecoveryService`와 `RealtimeRecoveryRepository`를 호출할 수 있으며 raw SQL로 Catalog, freshness, routing assignment나 event log를 수정하는 방식은 지원하지 않는다.

## 절대 금지

- production에서 Alembic downgrade, consumer group offset reset, checkpoint 삭제를 rollback으로 사용하지 않는다.
- parity mismatch 상태에서 count만 보고 matched로 바꾸지 않는다.
- Bronze raw archive를 Gold JOIN 결과처럼 Dashboard fallback에 연결하지 않는다.
- switch transaction 동안 ClickHouse, Trino, Kafka 또는 S3 I/O를 수행하지 않는다.
- 이전 ClickHouse table/volume을 cutover나 rollback 직후 삭제하지 않는다.
- 10만 건, 72시간, P95, chaos, security, rollback drill evidence 없이 gate boolean을 수동으로 true로 만들지 않는다.

## 1. 사전 조건

1. 모든 선행 V2 PR이 순서대로 merge됐고 해당 branch CI가 green인지 확인한다.
2. `alembic current`가 `0018_realtime_archive_recovery`인지 확인한다.
3. V1/V2 consumer owner가 한 Job generation을 동시에 claim하지 않는지 확인한다.
4. hot receipt와 archive receipt가 partition별 contiguous한 boundary B까지 도달했는지 확인한다.
5. pipeline version과 모든 dimension version을 고정한다.
6. Catalog의 현재 active binding, `dataset_freshness.binding_epoch`, latest revision을 evidence에 기록한다.
7. production 작업이면 변경 ticket, actor, 10자 이상의 reason, correlation ID와 rollback target을 미리 준비한다.

## 2. 같은 boundary parity

Hot은 ClickHouse canonical `serving_current_v2`, archive는 동일 pipeline/dimension version의 Gold projection에서 evidence를 만든다. 두 파일은 다음 필드를 포함한다.

- `datasetId`, `pipelineVersionId`, `bindingVersionId`
- `sourceBoundary.partitions[]`의 topic/partition/fromOffsetExclusive/toOffsetInclusive
- `dimensionVersionIds`
- `rowCount`, `checksum`, `distinctSourcePositionCount`
- `schemaFingerprint`, `nullCount`, `errorCount`
- `numericSums`, `sampleHash`

Secret, row payload와 credential은 evidence 파일에 넣지 않는다. Repository 밖의 제한된 경로에 저장하고 preflight를 실행한다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/verify-hot-archive-parity.py \
  --hot /secure/evidence/hot.json \
  --archive /secure/evidence/archive.json
```

Exit 0과 `status=matched`가 모두 필요하다. 다른 partition boundary는 count/checksum이 같아도 mismatch다. Backend worker는 같은 `ArchiveParityReport`를 `realtime_parity_checks`에 기록한다. mismatch면 hot result를 삭제하지 않고 Dataset을 degraded로 유지하며 rebuild/rollback 판단으로 이동한다.

## 3. rebuild

1. 검증된 archive snapshot과 matched parity report를 선택한다.
2. 새 immutable pipeline/serving version과 shadow ClickHouse table을 만든다.
3. `RebuildPlan`을 예약한다. 같은 report/target retry는 같은 operation ID를 반환해야 한다.
4. operation을 `running`으로 바꾼 뒤 Bronze의 deduplicated source `offset <= B[p]`만 동일 rule/dimension version으로 backfill한다.
5. shadow checkpoint를 B로 CAS한다.
6. hot tail은 각 partition의 `B[p] + 1`부터 연결한다. scalar max offset을 사용하지 않는다.
7. catch-up boundary에서 gap/overlap 0과 새 shadow/Gold parity를 다시 기록한다.
8. `RebuildCompletionEvidence`가 gap 0, overlap 0이고 shadow binding/version/boundary가 operation과 같을 때만 `ready`로 바꾼다.

Worker가 죽으면 operation과 target table을 삭제하지 않는다. 같은 operation을 재시도해 `attempt_count`를 늘리고 fixed boundary/version을 재사용한다.

## 4. cutover gate

Production `action=cutover`는 다음 evidence가 모두 있어야 request 생성이 가능하다.

- deterministic fixture 100,000건 이상, source position 유실 0, logical duplicate 0
- 최소 72시간 shadow count/checksum parity
- 승인된 P95 SLO
- restart/chaos 시나리오
- 권한 철회·secret/ACL security test
- 실제 rollback drill
- 운영 dashboard와 이 runbook 준비

Local 100-row ClickHouse smoke, 단위 test 또는 boolean field 자체는 위 evidence가 아니다. 하나라도 없으면 `BindingSwitchRequest` 생성이 실패해야 한다.

## 5. boundary-safe switch

외부 backfill/catch-up과 parity를 transaction 전에 끝낸다. Backend coordinator는 한 PostgreSQL transaction에서 다음을 수행한다.

1. `dataset_freshness`를 `FOR UPDATE`로 잠그고 expected epoch/current binding을 확인한다.
2. Catalog Dataset을 잠그고 active physical binding이 같은지 확인한다.
3. persisted matched parity가 target dataset/pipeline/dimensions/boundary/count/checksum을 포함하는지 확인한다.
4. 기존 active binding을 `stale`, target을 `active`로 바꾼다.
5. sticky `realtime_routing_assignments`를 target engine/epoch으로 갱신한다.
6. global Dataset revision과 binding epoch를 각각 1 증가시킨다.
7. `mutationType=replace` revision commit과 `dataset.revision.committed` schema v2 event를 기록한다.
8. recovery operation에 result epoch/revision/event cursor를 기록하고 commit한다.

동일 idempotency key 재시도는 새 revision/event를 만들지 않고 기존 result를 반환해야 한다. expected pointer가 달라졌거나 같은 key의 evidence가 다르면 전체 transaction을 rollback한다.

## 6. cutover 뒤 확인

- Catalog active binding과 freshness active engine/version/epoch가 target과 같은지 확인한다.
- revision commit과 SSE event의 epoch/revision/mutation/version이 같은지 확인한다.
- published Dashboard가 reload 없이 새 epoch를 수용하고 DOM 결과가 expected 값인지 확인한다.
- 권한 철회 actor가 event replay와 widget query를 받을 수 없는지 확인한다.
- previous binding은 stale/retention evidence로 남아 있고 source offsets가 변하지 않았는지 확인한다.

Browser DOM, EventSource 재연결과 permission evidence가 없으면 production cutover 완료로 표시하지 않는다.

## 7. rollback

1. 마지막으로 검증된 previous serving 또는 Gold archive target과 matched parity를 선택한다.
2. 현재 freshness epoch/version을 expected pointer로 사용해 `action=rollback`을 요청한다.
3. coordinator는 cutover와 같은 transaction을 사용해 더 큰 epoch/global revision과 `replace` event를 만든다.
4. Trino archive target이면 active archive binding과 Dataset sticky engine을 `trino`로 바꾸고 ClickHouse binding은 `stale`로 보존한다.
5. Dashboard가 새 epoch를 적용했는지 확인한다. target 내부 revision이 낮아도 public epoch가 크므로 폐기하면 안 된다.
6. ClickHouse ingest/table은 forensic과 재-cutover를 위해 보존한다. offset을 reset하지 않는다.

장애 rollback은 matched target/expected pointer를 요구하지만 72시간 shadow를 다시 기다리지 않는다. 복구 뒤 재-cutover는 다시 full production gate를 요구하고 또 더 큰 epoch/revision을 만든다.

## 8. 검증 명령

```bash
cd backend
npm run verify:clickhouse-realtime-v2-release
npm run verify:realtime-recovery-postgres
npm run verify:clickhouse-realtime-v2-recovery-live

cd ../frontend
npm run verify:ui-regressions
npm run test:dashboard-runtime
npm run build
```

`verify:realtime-recovery-postgres`와 live ClickHouse smoke는 각각 명시된 opt-in 환경 변수와 disposable target이 필요하다. Production credential/URL을 검증 편의를 위해 사용하지 않는다.

## 9. 현재 No-Go evidence

2026-07-18 local evidence는 PostgreSQL concurrent cutover, ClickHouse 100-position parity, migration lifecycle, backend/frontend/deploy regression까지다. 다음은 아직 production No-Go다.

- 실제 100,000건 end-to-end loss/duplicate artifact
- 72시간 shadow와 P95 artifact
- real connector restart/rebalance/poison/partition gap chaos
- 실제 browser cutover→rollback DOM과 permission-revoke evidence
- EC2 clean reboot, production certificate/hostname
- HA failover와 backup/restore drill

이 항목은 별도 운영 승인과 artifact가 생길 때만 갱신한다.
