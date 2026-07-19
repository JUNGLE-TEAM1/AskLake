# EKS Realtime Kafka V2 live preflight

이 문서는 Issue #1062 Phase 4A의 읽기 전용 사전검증 결과다. 조회 과정에서 AWS, EKS, Kubernetes resource를 생성·수정·삭제하지 않았으며 계정 ID, ARN, bucket, generation과 runtime object 이름은 기록하지 않는다.

## 판정

현재 V2 live canary apply는 **NO-GO**다. V1 Spark Structured Streaming owner가 정상 실행 중인 사실은 V2 준비 증거가 아니며, V2가 production identity를 인수했다는 뜻도 아니다. 다음 기반이 live cluster에 없으므로 `sharedAwsApplyAllowed`, `liveCanaryReady`, `productionTransferAllowed`는 모두 false를 유지한다.

| 확인 항목 | 읽기 전용 관찰 | 판정 |
| --- | --- | --- |
| current realtime owner | V1 worker와 SparkApplication driver/executor가 V1 identity를 claim 중 | V1 보존, V2와 identity 공유 금지 |
| EBS storage | legacy in-tree `gp2` StorageClass만 존재 | V2 encrypted Auto Mode gp3 요구 불충족 |
| snapshot API | VolumeSnapshot CRD와 snapshot-controller add-on 없음 | paired snapshot/restore 실행 불가 |
| workload identity | V2 worker/Connect ServiceAccount와 V2 Pod Identity association 없음 | V2 IAM apply 전 activation 금지 |
| image registry | V2 Connect/ClickHouse ECR repository 없음 | immutable digest receipt 생성 불가 |

## 정적 보완

사전검증에서 발견한 결손은 공유 환경을 변경하지 않고 다음 repository 계약으로 보완했다.

- `infra/eks/terraform/realtime-v2-storage.tf`: snapshot-controller 소유자를 `disabled`, exact-version EKS add-on, 외부 관리 중 하나로 명시하고 부분 입력을 거부하며 controller를 canonical `asklake-general` pool에 배치한다.
- `infra/eks/storage/realtime-v2-auto-mode.yaml`: Auto Mode EBS CSI 기반 encrypted gp3 `StorageClass`와 `Retain` `VolumeSnapshotClass`를 고정한다.
- foundation Helm/Terraform: V2 worker와 Connect ServiceAccount를 명시하고 Connect Pod의 default API token mount를 끈다.
- Terraform ECR 계약: `kafka-connect-v2`, `clickhouse-v2` repository를 foundation 범위에 추가한다.
- 정적 verifier: storage/snapshot driver, encryption, topology, reclaim policy와 delivery handoff drift를 fail-closed로 검사한다.

이 보완은 live resource가 존재한다는 증거가 아니다. Terraform/manifest/Helm을 실제 적용하거나 image를 push하지 않았다.

## Phase 4B 진입 조건

승인된 변경 창에서 다음 순서를 지키고 각 단계의 plan 또는 read-only observation이 통과해야 한다.

1. cluster-compatible exact snapshot-controller add-on version과 lifecycle owner를 승인한다.
2. snapshot-controller와 세 VolumeSnapshot CRD가 Available인지 확인한다.
3. V2 Auto Mode StorageClass와 VolumeSnapshotClass를 적용하고 semantic verifier 결과와 live object를 대조한다.
4. V2 ECR repository에 검증된 Connect/ClickHouse image를 push하고 immutable digest receipt를 만든다.
5. V2 ServiceAccount, exact generation IAM과 Pod Identity association plan을 검토·적용한다.
6. production과 격리된 generation/topic/groups/connector/ClickHouse target으로만 Helm canary를 활성화한다.
7. ingest, restart, paired snapshot, isolated restore, rollback receipt까지 통과한 뒤에만 `liveCanaryReady` 변경을 검토한다.

중간 실패 시 이미 생성된 durable state와 evidence는 보존하고 consumer activation을 진행하지 않는다. V1 중지, production identity 재사용, Connect offset reset, V1 checkpoint 또는 V2 PVC/snapshot 삭제는 이 preflight의 승인 범위가 아니다.

## 승인 후 Phase 4B~5 결과

위 NO-GO는 2026-07-19 Phase 4A 시점의 역사적 판정이다. 이후 사용자가 격리 canary 변경을 승인했고, 결손 항목을 generation `v2-canary-20260719-01` 범위에서 적용했다. snapshot-controller/CRD, encrypted Auto Mode gp3 StorageClass, Retain VolumeSnapshotClass, immutable ECR image, 전용 ServiceAccount와 Pod Identity association 1개를 확인했다. IAM은 source/DLQ/internal topic 5개와 sink/worker group 2개만 허용하고 wildcard resource는 0개다.

live 실행은 Connect/ClickHouse/Keeper/worker Ready, ClickHouse Sink v1.4.0, MSK IAM source ingest, restart 후 offset `59`·60행·checksum 보존, paired snapshot 2개, 별도 namespace restore의 consumer 0개와 동일 checksum을 검증했다. rollback은 connector를 STOPPED/tasks 0으로 만든 뒤 원본 V2 resource를 0개로 내리고 PVC 2개·snapshot 2개·internal topic을 보존했다. 기존 V1 worker UID와 Ready 상태는 유지됐다. 비밀 없는 최종 증거는 `deploy/eks-realtime-kafka-v2-receipt.json`이다.

따라서 `liveCanaryReady`는 true지만 `productionTransferAllowed`와 HA claim은 false다. 이 canary는 production topic/group 인수, 다중 노드 장애조치 또는 자동 cross-engine fallback 승인이 아니다.
