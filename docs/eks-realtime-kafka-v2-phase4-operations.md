# EKS 실시간 Kafka V2 운영 배포 Phase 4 증적

이 문서는 Issue #1084 Phase 4의 단일 canary 진입 결과다. Phase 4는 실제 MSK fixture를 발행하고 Kafka Connect → ClickHouse row boundary를 검증하는 단계지만, 현재 EKS target이 지정되지 않아 canary를 시작하지 않았다.

## 판정

현재 판정은 **CANARY-CONTRACT-PASS / LIVE-PREFLIGHT-BLOCKED / CANARY-NOT-RUN**이다.

- live evidence verifier의 positive example shape와 5개 negative test가 통과했다.
- Kafka exact topic/DLQ/group/IAM contract test 5개가 통과했다.
- canary 성공에는 connector/task RUNNING, source `[startOffset,endOffset)`, Connect offset, ClickHouse `(topic,partition,offset)`, row checksum, duplicate 0이 모두 필요하다.
- canary는 generation-scoped source/topic/group/connector만 사용하며 production identity 재사용을 금지한다.
- `audit-eks-realtime-v2-kafka-live.sh --preflight`와 `--e2e` 모두 `ASKLAKE_EKS_CLUSTER_NAME is required`에서 차단됐다.
- 따라서 fixture 발행, connector 활성화, ClickHouse row 증가, Pod restart, snapshot/restore, rollback은 실행하지 않았다.

기계 판독 결과는 [`deploy/eks-realtime-kafka-v2-phase4-receipt.json`](../deploy/eks-realtime-kafka-v2-phase4-receipt.json)에 기록했다.

## canary 실행 전 필수 gate

1. 승인된 cluster name과 일치하는 `kubectl` context
2. V2 Pod Identity association 정확히 1개와 exact topic/group IAM policy
3. ClickHouse/Keeper encrypted PVC와 snapshot-controller/VolumeSnapshotClass
4. ECR immutable image receipt와 private Secret/TLS references
5. 기존 exact owner running task 0, V1 concurrent claim 0
6. production과 다른 generation/topic/group/connector/ClickHouse target

위 gate 중 하나라도 없으면 `--e2e`로 진행하지 않는다.

## 실행 순서

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<approved-cluster-name>'
export ASKLAKE_EKS_NAMESPACE='asklake-dev'
export AWS_REGION='ap-northeast-2'
bash scripts/audit-eks-realtime-v2-kafka-live.sh --preflight
bash scripts/audit-eks-realtime-v2-kafka-live.sh --e2e
```

preflight 통과 후에만 connector/task Ready 확인 → generation fixture 발행 → ClickHouse raw/output count와 source boundary 기록 → approved restart/snapshot sequence로 진행한다.

## rollback 불변식

- 신규 V2 reconcile을 먼저 차단한다.
- connector STOPPED와 running task 0을 증명한다.
- 최종 source offset·ClickHouse boundary·receipt를 기록한다.
- V2 owner claim 0을 증명하고 Connect internal topic/PVC/snapshot을 보존한다.
- 자동 cross-engine fallback, Connect offset reset, generation 재사용, V1 checkpoint/PVC 삭제는 금지한다.

기존 `deploy/eks-realtime-kafka-v2-receipt.json`은 과거 Issue #1062 격리 canary의 역사적 증거이며, 이번 Phase 4의 현재 live 실행 결과로 재사용하지 않는다. 현재 Phase 4 receipt의 `canary.status`는 `not-run`이다.
