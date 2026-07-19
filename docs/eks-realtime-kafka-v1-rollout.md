# EKS Realtime Kafka V1 rollout·rollback runbook

이 문서는 Issue #1044에서 선택한 V1 Spark Structured Streaming을 EC2 Continuous owner에서 EKS owner로 전환할 때의 실행 계약이다. 2026-07-19에 격리 generation의 live EKS canary와 checkpoint restart를 완료했다. 기존 EC2 production identity의 owner transfer는 수행하지 않았으므로, 아래 production cutover 순서는 계속 별도 승인 계약이다.

## 1. 고정 identity와 owner 계약

소비 소유권 키는 다음 튜플이며 active claim은 항상 정확히 하나다.

```text
(brokerIdentity, topic, consumerGroup, generation, checkpointIdentity)
```

- 현재 owner: `ec2-continuous-worker`
- 제안 owner: `eks-continuous-worker-v1`
- canary topic: `asklake.eks-realtime.fixture.<generation>`
- canary group: `asklake-eks-realtime-v1-<generation>`
- checkpoint: `checkpoints/<jobId>/<targetId>/<generation>`
- runtime receipt authority: private S3 `continuous-runtime` prefix
- production topic/group/checkpoint 재사용, generation 재사용, Pod local receipt는 금지한다.

실제 broker endpoint, ARN, account ID, credential과 Secret 값은 receipt에 기록하지 않는다. 식별이 필요하면 배포 Secret reference와 SHA-256 hash만 남긴다.

## 2. 사전 차단 조건과 해소 결과

2026-07-19 읽기 전용 policy 감사에서 Spark role의 generation-scoped `asklake.eks-realtime.fixture.*` topic과 `asklake-eks-realtime-v1-*` group resource, Backend role의 `continuous-runtime/*` object resource가 각각 0개였고 두 role 모두 bucket-root S3 object wildcard가 남아 있었다. Terraform 정적 계약은 narrow prefix, 동일 generation의 exact topic/group pair와 runtime resource를 포함하지만 공유 account에는 apply하지 않았다.

따라서 다음 두 조건을 실제 policy hash와 함께 재관찰하기 전에는 canary도 시작하지 않는다.

1. Spark Pod Identity policy가 exact five consumer actions와 동일 generation의 exact topic/group ARN pair만 허용한다.
2. Backend Pod Identity policy가 해당 deployment의 private `continuous-runtime/*` prefix만 읽고 쓸 수 있다.

wildcard action/resource, broad topic/group prefix, 다른 deployment의 runtime prefix가 발견되면 중단한다.

2026-07-19 live 실행에서는 전용 `asklake-realtime-v1-worker`와 `asklake-realtime-v1-spark` ServiceAccount/Pod Identity를 만들고, 동일 generation의 exact topic/group과 Backend·Spark 양쪽의 `continuous-runtime/*`만 허용했다. 최종 read-only probe는 association 각 1개, broad action/resource 없음, blocker 0, `activationReady=true`를 확인했다. Spark가 runtime report를 직접 쓰므로 Backend뿐 아니라 Spark policy에도 이 prefix가 필요하다는 사실을 Terraform과 probe 계약에 반영했다.

## 3. 승인된 live canary 순서

각 단계는 이전 단계의 durable receipt가 존재할 때만 진행한다.

1. 현재 EC2 process/replica, EKS Continuous workload 0개, active owner claim 1개를 읽기 전용으로 기록한다.
2. 검토된 Terraform plan으로 동일 generation의 exact topic/group pair와 runtime IAM만 반영하고 policy hash와 resource count를 다시 기록한다.
3. 새 generation을 발급해 격리 topic/group/checkpoint로 canary를 시작한다. production identity는 사용하지 않는다.
4. source offset, input/stored/quarantine count, SparkApplication/driver/executor 상태, Iceberg snapshot/manifest와 Catalog ACK를 receipt에 연결한다.
5. driver Pod를 교체하고 같은 generation/checkpoint에서 복구한다. offset regression, 동일 source boundary의 중복 publication, count 불일치가 없어야 한다.
6. canary를 stop/fence하고 active EKS claim 0개와 durable receipt 재조회 성공을 확인한다.

canary 성공은 production owner transfer 승인이 아니다. 실패 시 checkpoint를 삭제하거나 rewind하지 않고 state를 보존한 채 조사 상태로 끝낸다.

## 4. exact-one owner cutover

승인자는 immutable image digest, IAM policy hash, canary restart receipt와 rollback 담당자를 확인한 뒤 transfer generation을 발급한다. 순서는 바꿀 수 없다.

1. EC2 worker에 동일 배포 코드가 준비됐음을 확인하고 `CONTINUOUS_WORKER_SCOPE=continuous_sql`로 바꿔 Kafka reconcile을 fence한다.
2. EC2 Kafka process/lease/claim이 모두 0이고 기존 Continuous SQL owner는 유지됨을 기록한다.
3. owner manifest와 PostgreSQL `kafka_continuous_runtimes.metrics.ownerClaim`에 새 generation, proposed owner, broker/topic/group/checkpoint identity fingerprint, fencing token과 state revision을 원자적인 release receipt로 기록한다. EKS env와 claim이 모두 일치하기 전에는 worker가 해당 Job을 reconcile하지 않는다.
4. Helm `realtimeV1.ownerTransfer.approved=true`, `previousOwnerFenced=true`, 새 generation과 digest image를 사용해 replica 1의 Kafka-only worker를 활성화한다.
5. EKS claim이 정확히 1개이고 V2 Kafka Connect/ClickHouse/Keeper workload가 0개임을 확인한다.
6. offset, count, checkpoint, publication evidence를 전환 전 boundary와 대조하고 receipt를 닫는다.

EC2 fence와 EKS activation 사이에 관찰 가능한 zero-owner 구간이 있어야 한다. 동시에 두 claim이 보이면 EKS를 즉시 stop/fence하고 rollback 절차로 이동한다.

## 5. rollback 순서

rollback은 자동 cross-engine fallback이 아니며 새 generation을 사용한다.

1. EKS owner의 새 reconcile/start를 막고 Deployment를 0으로 내려 SparkApplication/driver/executor를 stop/fence한다.
2. EKS active claim과 관련 Kafka consumer가 0임을 증명한다.
3. 마지막 source offsets, S3 checkpoint/runtime receipt, Iceberg snapshot/manifest와 Catalog ACK를 기록한다.
4. EC2 worker를 `CONTINUOUS_WORKER_SCOPE=all` 또는 승인된 Kafka 전용 cell로 복원하고 **새 rollback generation**을 발급한다.
5. 검증된 S3 Structured Streaming checkpoint authority에서만 resume한다.
6. offset regression, 중복 publication, `input = stored + quarantine`, durable receipt 재조회를 확인한 뒤 rollback receipt를 닫는다.

다음 동작은 항상 금지한다.

- checkpoint 삭제·rewind로 복구를 강제
- owner transfer 사이 generation 재사용
- EC2와 EKS Kafka owner 동시 실행
- 같은 run의 V1/V2 자동 fallback
- production identity를 canary로 사용

## 6. 최소 receipt schema

receipt는 private S3 runtime prefix에 저장하고 PostgreSQL run/session과 연결한다.

```text
jobId, runOrSessionId, owner, generation, brokerIdentityHash,
topicHash, consumerGroupHash, checkpointIdentityHash, fencingToken,
stateRevision, heartbeatAt, sourceOffsetsBefore, sourceOffsetsAfter,
inputCount, storedCount, quarantineCount, imageDigests,
serviceAccountPolicyHashes, sparkTerminalState,
icebergSnapshotManifestReference, catalogAckReference, observedAt, observer
```

성공 판정은 active owner 1개, restart 후 offset regression 0, 동일 source boundary의 publication 중복 0, `input = stored + quarantine`, Pod 교체 뒤 receipt 재조회 성공을 모두 요구한다. 하나라도 누락되면 transfer는 완료가 아니라 `blocked` 또는 `rollback-required`다.

## 7. 로컬 검증과 권한 경계

```bash
python3 -m unittest scripts.test_verify_eks_realtime_kafka_mvp
python3 scripts/verify_eks_realtime_kafka_mvp.py
python3 -m unittest scripts.test_observe_eks_realtime_kafka_readiness
python3 scripts/observe_eks_realtime_kafka_readiness.py
bash scripts/verify-eks-workloads.sh
```

2026-07-19 승인된 운영 실행에서 generation `1044-20260719-058ff8ac`의 격리 canary를 적용했다. 최종 immutable revision은 `2f941035e2e8cd0264cd7d4b96e67a951ca9b6f3`이며 Backend와 Spark runtime은 private image receipt의 linux/amd64 digest를 사용한다. 100건 produce 후 source range `partition 0: 0-100`, consumed/stored/quarantine `100/100/0`, lag 0, Iceberg snapshot·단일 publication manifest를 확인했다. 같은 checkpoint에서 SparkApplication UID를 교체한 뒤에도 consumed/stored는 `100/100`, publication은 batch 0 한 건, checkpoint는 `offsets/0`·`commits/0` 한 쌍으로 유지되어 offset regression과 중복 publication이 없었다.

Helm worker upgrade 중 `Recreate` 전략의 zero-overlap과 이전 digest rollback 후 재적용을 실제로 수행했고, 기존 EC2 production stream은 계속 별도 identity의 owner로 보존했다. canary runtime document의 Catalog ACK는 아직 `null`이므로 이 증거는 EKS Kafka consume/checkpoint/Iceberg 경로의 완료이며 기존 production identity cutover 완료를 뜻하지 않는다.
