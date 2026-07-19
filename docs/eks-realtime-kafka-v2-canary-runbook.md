# EKS Realtime Kafka V2 격리 canary runbook

이 runbook은 Issue #1062의 승인 후 live 단계만 다룬다. 기본값은 apply 금지이며 production topic/group, V1 checkpoint, 기존 PVC를 변경하지 않는다. 최종 증거는 `deploy/eks-realtime-kafka-v2-receipt.schema.json`을 만족하는 비밀 없는 receipt 한 개다.

## 1. 시작 gate

다음 항목이 하나라도 없으면 중지한다.

- `origin/pair1` 기준 diff 감사와 모든 정적 검증 통과
- Connect/ClickHouse/Backend 이미지의 ECR digest receipt
- 암호화된 EBS StorageClass와 CSI VolumeSnapshotClass 확인
- Terraform plan에서 `asklake-realtime-v2-connect` association 1개, exact topic 5개, source consumer/worker group 2개, wildcard 0개 확인
- production과 다른 V2 generation, source topic, group, connector, ClickHouse target
- 이전 exact owner running task 0과 V1 concurrent claim 0

generation 하나에서 다음 이름을 파생한다.

```text
source  asklake.eks-realtime.v2.fixture.<generation>
dlq     asklake.eks-realtime.v2.dlq.<generation>
group   asklake-eks-realtime-v2-<generation>
worker  asklake-eks-realtime-v2-worker-<generation>
config  asklake-connect-v2-<generation>-config
offset  asklake-connect-v2-<generation>-offset
status  asklake-connect-v2-<generation>-status
```

## 2. 적용 순서

1. 검토된 Terraform plan으로 V2 generation과 전용 workload identity만 적용한다.
2. V2 전용 namespace에 runtime Secret reference를 준비하되 값은 log/receipt에 출력하지 않는다.
3. immutable digest와 `realtimeV2.enabled=true`, owner fence, generation, 암호화 StorageClass로 canonical Helm release를 적용한다.
4. StatefulSet PVC가 Bound이고 Connect/ClickHouse/Keeper/worker가 Ready인 것을 확인한다.
5. connector 1개와 선언된 task가 모두 RUNNING인지 확인하고 fixture를 발행한다. sink task group은 connector identity와 같은 source consumer group이고 Connect worker coordination group과 달라야 한다.
6. partition별 source offset, Connect offset, ClickHouse `(topic,partition,offset)`, row count/checksum을 receipt의 `beforeRestart`에 기록한다.

## 3. restart 검증

Connect, ClickHouse, Keeper Pod를 순서대로 교체한다. 각 단계에서 새 Pod UID와 기존 PVC UID를 기록하고 Ready를 기다린다. 마지막에 새 fixture를 발행한 뒤 `afterRestart` boundary를 기록한다. offset regression, missing row, 동일 boundary 중복은 모두 0이어야 한다.

## 4. snapshot과 격리 restore

일관된 canary snapshot을 위해 먼저 connector를 PAUSED로 만들고 task가 더 이상 offset을 전진하지 않음을 확인한다. ClickHouse와 Keeper StatefulSet을 0으로 내려 두 PVC를 quiesce한 다음, 같은 승인된 CSI VolumeSnapshotClass로 각각 VolumeSnapshot을 생성한다. 두 snapshot이 `readyToUse=true`가 아니면 원본을 재개하지 말고 실패 receipt를 남긴다.

restore는 별도 namespace와 별도 Helm release에서만 수행한다. `realtimeV2.recoveryMode=true`와 ClickHouse/Keeper snapshot 이름을 함께 전달하면 chart는 snapshot-backed PVC와 두 StatefulSet만 렌더하고 Kafka Connect/worker를 렌더하지 않는다. 원본 PVC를 dataSource나 restore target으로 재사용하지 않는다. 복원된 ClickHouse의 count/checksum/source boundary가 `beforeRestart`와 같을 때만 `afterRestore`를 pass로 기록한다.

## 5. rollback

1. V2 worker reconcile을 끄고 connector를 STOPPED로 만든다.
2. running task 0, V2 owner claim 0, 최종 source/ClickHouse boundary를 기록한다.
3. Connect internal topic, 원본 PVC, snapshot, receipt를 보존한다.
4. V1이 필요하면 새 승인 generation을 발급한다. V2 또는 이전 V1 generation을 재사용하지 않는다.
5. V1/V2가 같은 broker/topic/group/generation을 동시에 claim하지 않는 것을 확인한 뒤에만 새 owner를 시작한다.

자동 cross-engine fallback, Connect offset reset, V1 checkpoint 삭제, V2 PVC/snapshot 삭제는 rollback이 아니다. 이 runbook의 canary pass도 production HA 또는 production owner transfer 승인이 아니다.
