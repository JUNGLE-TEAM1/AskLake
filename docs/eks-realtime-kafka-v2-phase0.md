# EKS Realtime Kafka V2 Phase 0

Issue #1062는 MSK Kafka를 source backbone으로 유지하고 실시간 serving sink만 Kafka Connect → ClickHouse로 전환할 수 있는지 격리 EKS canary에서 검증한다. Issue #1044의 V1 Spark → Iceberg checkpoint와 기존 EC2 production owner는 변경하지 않는다.

## 1. 증거와 현재 격차

EC2 Compose V2에는 Kafka Connect worker 1개, ClickHouse 1개, Keeper 1개, TLS·분리 계정·Kafka Connect FileConfigProvider, topic별 connector 등록과 ClickHouse `exactlyOnce=true`/KeeperMap 계약이 있다. 격리 container E2E는 Kafka 입력 2건, ClickHouse/JOIN/Catalog 2건과 revision event 1건을 검증했지만 clean host reboot, backup/restore와 multi-node failover 증거는 없다.

EKS에는 V1 SparkApplication, Pod Identity, generation-scoped topic/group, S3 checkpoint/runtime document 기반이 있지만 Kafka Connect·ClickHouse·Keeper workload와 V2 전용 MSK IAM은 없다. 따라서 Compose가 존재한다는 이유만으로 EKS V2가 ready라고 판정하지 않는다.

## 2. 단일 MVP topology 결정

격리 canary는 다음 topology로 고정한다.

```text
MSK Serverless
  ├─ generation-scoped source/DLQ/internal topics
  └─ Kafka Connect 1 (Pod Identity, AWS_MSK_IAM)
         │ exact topic/partition/offset
         ▼
ClickHouse 1 ── KeeperMap exactly-once state ── Keeper 1
     │ encrypted EBS PVC                         │ encrypted EBS PVC
     └─ isolated backup/restore receipt          └─ snapshot/log recovery
```

Kafka Connect의 config/offset/status authority는 generation별 MSK internal topic이다. ClickHouse sink의 `exactlyOnce=true`는 기존 gateway 계약대로 KeeperMap을 사용하므로 single-node canary에도 Keeper 1개가 필요하다. ClickHouse와 Keeper의 Pod local filesystem은 authoritative state가 아니며 각각 별도 encrypted EBS PVC를 사용한다.

이 topology는 HA가 아니다. production HA는 ClickHouse replica 2개 이상, Keeper 3개, Kafka Connect worker 2개 이상과 node loss failover 증거가 준비된 뒤 별도 결정한다. canary에 Operator topology를 먼저 도입하면 검증 대상이 consumer 전환보다 cluster lifecycle에 치우치므로 Phase 0 MVP에서는 선택하지 않는다.

## 3. exact-one identity

소유권 키는 다음 tuple이다.

```text
(brokerIdentity, sourceTopic, consumerGroup, generation, connectorIdentity, clickhouseTarget)
```

- source topic: `asklake.eks-realtime.v2.fixture.<generation>`
- group: `asklake-eks-realtime-v2-<generation>`
- Connect worker group: `asklake-eks-realtime-v2-worker-<generation>`
- connector: `asklake-eks-realtime-v2-<generation>`
- DLQ: `asklake.eks-realtime.v2.dlq.<generation>`
- Connect internal topics: `asklake-connect-v2-<generation>-{config,offset,status}`
- ClickHouse target: `asklake_realtime_v2.raw_events_v2_<generation_hash>`

V1과 V2는 같은 broker/topic/group/generation을 동시에 claim할 수 없다. 격리 canary는 production identity를 재사용하지 않는다. production 전환은 기존 owner task와 claim이 모두 0임을 증명하는 별도 receipt 전에는 차단한다.

## 4. IAM과 secret 경계

Kafka Connect는 전용 `asklake-realtime-v2-connect` ServiceAccount와 exact-one Pod Identity association을 사용한다. SASL_SSL + AWS_MSK_IAM plugin은 immutable Connect image 안에 있어야 하며 runtime download를 금지한다. cluster에는 Connect와 idempotent write, exact source/DLQ/internal topic에는 create/describe/read/write, exact group에는 describe/alter만 허용한다. wildcard topic/group과 credential 평문은 금지한다.

ClickHouse TLS certificate/key/CA와 여섯 role password, Connect FileConfigProvider properties는 Kubernetes Secret reference로만 전달한다. API, rendered manifest, receipt에는 secret 원문을 기록하지 않는다.

## 5. durable state와 성공 판정

성공은 produced count만으로 판정하지 않는다. partition별 source `[startOffset,endOffset)`, Connect offset, ClickHouse의 `(topic,partition,offset)` boundary와 row checksum을 함께 기록한다. restart 뒤 offset regression, row 유실과 동일 boundary 중복 publication이 모두 0이어야 한다.

ClickHouse와 Keeper Pod 교체 뒤 PVC에서 복구하고, quiesce한 두 PVC의 승인된 CSI VolumeSnapshot을 격리 restore target에 함께 복원해 count/checksum/source boundary를 대조한다. 원본 PVC를 삭제하거나 restore로 덮어쓰지 않는다. 이 증거 전에는 live durable-state gate가 닫혀 있다.

## 6. rollback 불변식

rollback은 자동 cross-engine fallback이 아니다.

1. 새 V2 reconcile을 막는다.
2. connector와 모든 task를 중지하고 running task 0을 증명한다.
3. 최종 source offset, ClickHouse boundary와 backup reference를 기록한다.
4. V2 owner claim 0을 증명한다.
5. internal topic, ClickHouse/Keeper PVC와 backup을 보존한다.
6. 새 승인 generation에서만 V1 owner를 시작한다.
7. 전환 전후 offset과 publication boundary를 비교한다.

V1 checkpoint 삭제, Connect offset reset, generation 재사용, 같은 identity의 V1/V2 동시 실행은 금지한다.

## 7. 현재 완료 범위와 검증

Phase 0 topology 결정 뒤 Phase 1 canonical Helm package와 Phase 2 static runtime contract까지 완료했다. `realtimeV2.enabled=false`가 기본이며 activation에는 승인, previous exact owner fence, generation, storage class와 Backend/Connect/ClickHouse immutable digest가 모두 필요하다. package는 worker와 Kafka Connect Deployment 각 1개, ClickHouse와 Keeper StatefulSet 각 1개, 삭제·축소 Retain PVC 2개를 렌더한다. V1/V2 동시 enable과 Secret·mutable image·local authoritative state는 거부한다.

Terraform은 generation 하나에서 source/DLQ/internal topic 5개와 source consumer/Connect worker group 2개를 파생하고 전용 Connect identity만 추가한다. worker coordination group과 sink task group은 protocol 충돌을 막기 위해 분리한다. MSK IAM auth 2.3.6 uber JAR은 검증된 checksum으로 Connect image classpath에 포함하며 Kafka Connect plugin path에서는 제외한다. Helm `recoveryMode`는 paired CSI snapshot을 새 PVC로 복원하면서 Connect/worker를 0개 렌더한다. receipt schema와 실제 순서는 [V2 canary runbook](eks-realtime-kafka-v2-canary-runbook.md)에 고정했다.

MSK IAM/Pod Identity 실제 apply, ECR image receipt, PVC restart, snapshot/restore와 live canary는 아직 완료되지 않았다. machine contract는 `deploy/eks-realtime-kafka-v2-mvp.json`이며 다음 명령으로 검증한다.

```bash
python3 -m unittest scripts.test_verify_eks_realtime_kafka_v2_mvp
python3 scripts/verify_eks_realtime_kafka_v2_mvp.py
bash scripts/verify-eks-realtime-v2-workload.sh
```

validator 통과는 EKS V2 runtime 완료나 공유 AWS apply 승인이 아니다. IAM·restart·backup/restore의 정적 계약만 ready이며 실제 apply, live canary와 production transfer gate는 계속 false다.

## 8. commit 전 전체 diff 감사

2026-07-19에 원격을 다시 fetch하고 `origin/feat-#1062@6943a9764e1b0152575802ba03ac8a7d85c6915a`와 working tree 전체를 대조했다. 변경은 tracked 24개와 신규 9개, 합계 33개다. 범위는 V2 image/provenance/machine contract/receipt schema 5개, worker/source group을 분리하는 Backend 3개, canonical Helm 3개, exact IAM Terraform 10개, validator 4개, Phase/SSOT 문서 8개로만 구성된다.

- Issue #1062 범위 밖 변경: 0
- 동일 checksum의 중복 산출물: 0
- canonical Helm 외 독립 Kubernetes workload manifest: 0
- credential/access key/실제 account ARN: 0
- `pair1` 직접 수정, PR/merge, 공유 AWS/EKS apply: 0

기존 `docs/realtime-2026/clickhouse-v2-recovery-runbook.md`는 application-level hot/archive cutover 계약이고, 이번 `docs/eks-realtime-kafka-v2-canary-runbook.md`는 EKS workload identity/PVC/snapshot canary 계약이라 소유 범위가 겹치지 않는다. 기존 EC2 Compose 파일은 수정하지 않았고 EKS workload 정의는 `infra/eks/helm/asklake-workloads/templates/realtime-v2.yaml` 한 곳만 canonical source로 유지한다.

최종 정적 검증은 Terraform `52 passed, 0 failed`, ClickHouse V2 release `60 tests`, V2 machine contract `9 tests`, 전체 EKS workload Helm lint/render와 receipt JSON Schema를 통과했다. Connect와 ClickHouse V2 image는 로컬에서 각각 build됐고 Connect image 안의 IAM JAR checksum/classpath를 다시 확인했다. account ARN scan 결과는 기존 Terraform test의 `111122223333` mock fixture뿐이며 실제 account/resource 식별자는 없다. 이 결과에는 ECR push, AWS plan/apply, EKS Pod/PVC/snapshot 또는 live offset/row 증거가 포함되지 않는다.
