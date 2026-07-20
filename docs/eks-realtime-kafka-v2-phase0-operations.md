# EKS 실시간 Kafka V2 운영 배포 Phase 0 증적

이 문서는 Issue #1084의 운영 배포 사전 점검 결과다. Phase 0에서는 AWS, EKS, Kubernetes resource를 생성·수정·삭제하지 않는다. `realtimeV2.enabled`와 API admission은 계속 fail-closed 상태로 둔다.

## 판정

현재 판정은 **STATIC-PASS / LIVE-PREFLIGHT-BLOCKED / NO-GO**다.

- V2 machine contract, Helm workload, encrypted storage, image receipt, Kafka IAM contract와 negative test는 통과했다.
- Helm 기본 values는 V2 disabled 상태이며, 실제 image digest와 운영 Secret 값은 저장소에 넣지 않는다.
- EKS read-only preflight는 `ASKLAKE_EKS_CLUSTER_NAME`이 설정되지 않아 첫 검증 단계에서 차단됐다. 이는 클러스터를 추측하거나 잘못된 context를 조회하지 않기 위한 의도적인 fail-closed 결과다.
- 따라서 이번 Phase 0에서는 AWS/EKS read, apply, image push, Secret 생성, API admission 활성화를 수행하지 않았다.

## 실행한 정적 검증

| 검증 | 결과 |
| --- | --- |
| `python3 scripts/verify_eks_realtime_kafka_v2_mvp.py` | pass |
| `python3 -m unittest scripts.test_verify_eks_realtime_kafka_v2_mvp` | 11 pass |
| `python3 scripts/verify-eks-realtime-v2-storage.py` | pass |
| `bash scripts/verify-eks-realtime-v2-workload.sh` | pass |
| `helm lint infra/eks/helm/asklake-workloads -f infra/eks/values/workloads/dev.example.yaml` | pass |
| `node scripts/verify-eks-realtime-v2-image-receipt.mjs infra/eks/delivery/realtime-v2-image-receipt.example.json` | pass |
| `node scripts/test-eks-realtime-v2-image-receipt.mjs` | 4 pass |
| `node scripts/test-eks-realtime-v2-kafka-contract.mjs` | 5 pass |
| `node scripts/test-eks-realtime-v2-live-evidence.mjs` | 5 pass |
| `bash -n` Phase 0 deploy/audit/secrets scripts | pass |
| `git diff --check` | pass |

기계 판독 결과는 [`deploy/eks-realtime-kafka-v2-phase0-receipt.json`](../deploy/eks-realtime-kafka-v2-phase0-receipt.json)에 기록했다.

## Phase 1 진입 전 필수 입력

1. `ASKLAKE_EKS_CLUSTER_NAME`과 해당 cluster endpoint에 일치하는 `kubectl` context
2. 실제 cluster/namespace, ECR registry, MSK bootstrap endpoint, ClickHouse endpoint를 가진 저장소 밖 private values
3. ClickHouse·Kafka Connect·backend의 immutable `linux/amd64` image digest receipt
4. `asklake-realtime-v2-connect` Pod Identity와 generation-scoped exact topic/group IAM plan
5. ExternalSecret reference, TLS/CA reference, credential rotation owner
6. 승인된 deployment window, canary operator와 rollback owner

실제 Secret 값, account/ARN, broker endpoint와 private image receipt는 Git에 커밋하지 않는다.

## 다음 단계 진입 명령

운영 담당자가 대상 cluster를 명시적으로 정한 뒤 다음 read-only preflight만 먼저 실행한다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<approved-cluster-name>'
export ASKLAKE_EKS_NAMESPACE='asklake-dev'
export AWS_REGION='ap-northeast-2'
bash scripts/audit-eks-realtime-v2-kafka-live.sh --preflight
```

이 명령이 통과하기 전에는 `--e2e`, Helm apply, image push, API V2 admission 활성화로 진행하지 않는다.

## 불변식

- exact-one owner: 같은 broker/topic/group/generation을 V1과 V2가 동시에 claim하지 않는다.
- durable state: Connect internal topic, ClickHouse/Keeper PVC와 paired snapshot이 authority이며 Pod local filesystem은 authority가 아니다.
- rollback: 새 V2 reconcile 차단 → task 0 증명 → offset/boundary 기록 → owner claim 0 증명 → state 보존 순서를 따른다.
- generation 재사용, Connect offset reset, 자동 cross-engine fallback, production identity 재사용은 금지한다.
