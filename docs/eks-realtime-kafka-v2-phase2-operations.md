# EKS 실시간 Kafka V2 운영 배포 Phase 2 증적

이 문서는 Issue #1084 Phase 2의 data-plane render와 read-only preflight 결과다. Phase 2에서 실제 AWS/EKS resource를 변경하지 않았으며, test values와 placeholder receipt를 운영 배포에 사용하지 않았다.

## 판정

현재 판정은 **RENDER-PASS / READ-ONLY-PREFLIGHT-BLOCKED / APPLY-NOT-RUN**이다.

- canonical `asklake-realtime-data-plane` Helm chart가 정상 lint/render됐다.
- render 결과는 ClickHouse Keeper StatefulSet 1개, ClickHouse StatefulSet 1개, Kafka Connect Deployment 1개, Service 3개다.
- image는 모두 digest 형식이며 Secret resource 원문은 render되지 않는다.
- data-plane wrapper, Terraform validate, Kafka IAM, storage, Secret/TLS negative gate가 통과했다.
- `scripts/deploy-eks-realtime-v2.sh --preflight`는 `ASKLAKE_EKS_CLUSTER_NAME` 미지정으로 fail-closed 중단됐다.
- 실제 EKS context, ServiceAccount/Pod Identity, PVC/StorageClass, foundation ConfigMap/Secret과 V1 owner를 확인하지 못했으므로 Helm apply는 실행하지 않았다.

기계 판독 결과는 [`deploy/eks-realtime-kafka-v2-phase2-receipt.json`](../deploy/eks-realtime-kafka-v2-phase2-receipt.json)에 기록했다.

## 실행한 검증

```bash
bash scripts/deploy-eks-realtime-v2.sh --render \
  infra/eks/values/workloads/realtime-data-plane.test.example.yaml \
  infra/eks/delivery/realtime-v2-image-receipt.example.json

bash scripts/verify-eks-realtime-data-plane.sh
bash scripts/deploy-eks-realtime-v2.sh --preflight \
  infra/eks/values/workloads/realtime-data-plane.test.example.yaml \
  infra/eks/delivery/realtime-v2-image-receipt.example.json
```

첫 번째 render는 성공했다. 두 번째 preflight는 다음 단계 전에 의도적으로 중단됐다.

```text
ASKLAKE_EKS_CLUSTER_NAME is required
```

## Phase 2 apply 전 필수 조건

1. 승인된 `ASKLAKE_EKS_CLUSTER_NAME`과 endpoint가 일치하는 `kubectl` context
2. 실제 ECR immutable digest receipt(placeholder `000000000000` 금지)
3. private values: 실제 namespace, MSK bootstrap, ClickHouse endpoint, CIDR, PVC size/class, Secret references
4. foundation-owned `asklake-runtime` ConfigMap과 `asklake-backend-runtime` Secret
5. `asklake-realtime-v2-connect` ServiceAccount와 정확히 하나의 Pod Identity association
6. 기존 V1 Kafka owner와 EC2 owner 상태를 읽기 전용으로 확인한 승인된 canary window

## 적용 순서

필수 조건이 채워진 뒤에도 순서는 고정한다.

1. `--preflight`로 context, owner, ServiceAccount, Pod Identity, IAM, Secret/TLS, connector와 PVC selector를 확인한다.
2. shadow data-plane만 Helm apply하고 Pod/PVC/NetworkPolicy Ready를 확인한다.
3. MSK IAM smoke와 Kafka Connect connector registration을 별도 canary generation에서 검증한다.
4. source owner와 generation을 확인한 뒤에만 cutover/Continuous worker를 승인한다.
5. 실패하면 새 reconcile을 차단하고 task 0·owner claim 0·PVC 보존을 증명한다.

`phase2Ready=false`인 동안에는 `--apply`, production identity 재사용, Connect offset reset, V1/V2 동시 claim을 실행하지 않는다.
