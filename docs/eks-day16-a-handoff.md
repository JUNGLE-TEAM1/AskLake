# EKS 16일차 Pair A Phase 5 handoff 검증 기록

## 현재 판정

Issue #812 Phase 5의 private handoff 생성, planning 계약 검증, 전체 workload Helm lint/render와 신규 Trino 리소스 server-side dry-run을 수행했다. 현재 판정은 `integration_blocked`이며 Phase 5를 완료 처리하지 않는다.

실제 cluster, ARN, endpoint, bucket, repository와 digest는 다음 Git 제외 파일에만 있다.

```text
infra/eks/delivery/dev.day16-a.handoff.json
infra/eks/secrets/dev.day16-a.runtime-secret-contract.json
infra/eks/values/workloads/dev.day16-a.private-values.json
```

세 파일은 Git 미추적 상태이고 handoff/runtime/values는 `0600`이다. Secret value, TLS material과 credential은 포함하지 않는다.

## 최신 기준

`origin/pair1`은 현재 `feat-#812`의 조상이며 추가 commit이 없어 별도 merge가 필요하지 않았다. private handoff의 image 다섯 개는 최신 사용 가능한 formal receipt와 정확히 일치하고, namespace·ServiceAccount·MSK·RDS·S3·Trino Service·Pod Identity reference는 실제 Terraform output과 일치한다.

현재 확정된 선택은 다음과 같다.

- 신규 EKS Auto Mode cluster
- EKS Pod Identity
- Secrets Manager + External Secrets Operator
- internet-facing HTTP ALB
- single NAT와 현재 VPC endpoint 조합
- Continuous control plane은 외부 EC2 유지
- domain/ACM은 현재 HTTP MVP를 막지 않는 deferred 항목

## 검증 결과

`scripts/prepare-eks-day16-a-handoff.sh`는 실제 reference를 private handoff에 채우고 runtime delivery mode를 `external_secrets`로 맞춘다. `scripts/verify-eks-day16-a-handoff.sh`는 다음을 확인했다.

- delivery handoff planning verifier 통과
- runtime Secret delivery `--ready` 기반 계약 통과
- Phase 5/8 combined planning verifier 통과
- Phase 2 Spark·Trino source/target/owner/hash/RBAC gate 유지
- Phase 3 private values와 Trino data plane gate 유지
- 전체 workload chart Helm lint/render 통과
- Trino ConfigMap/Service/Deployment server-side dry-run 통과
- dry-run 전후 Deployment/Service/ConfigMap/Job UID와 resourceVersion 동일
- 실제 Trino Deployment/Service 생성 없음

## 남은 blocker

### 1. Phase 4 fixture receipt 없음

외부 producer의 produce-only IAM role은 준비됐고 장기 access key는 만들지 않았다. 로컬 Mac과 보존 EC2는 MSK private DNS/VPC 경로가 없어 producer host가 될 수 없었다. EKS VPC의 임시 EC2+SSM 경로는 Kafka 연결 단계까지 도달했지만 SASL authorization을 통과하지 못해 100건 batch receipt가 생성되지 않았다.

실패한 임시 EC2, instance profile, host role과 임시 producer trust는 모두 정리됐다. 전용 producer role/policy만 남아 있으며 IAM 자체에는 별도 사용 요금이 없다. Phase 4는 계속 미완료다.

### 2. Helm release ownership 충돌

현재 Web은 `asklake-web`, Airflow는 `asklake-airflow` release가 소유한다. 전체 `asklake-workloads` chart를 다른 release/selector로 server dry-run하면 기존 Airflow Deployment의 immutable selector와 ownership이 충돌한다.

Trino 신규 리소스만 분리하면 server dry-run은 통과한다. 하지만 전체 통합에서는 다음 중 하나를 B와 확정해야 한다.

- 기존 Web/Airflow release는 유지하고 workload chart에서 해당 component를 비활성화한 채 Trino/Spark만 별도 release로 배포
- chart/release migration 절차를 만들고 기존 resource ownership을 안전하게 이전

기존 Deployment를 삭제 후 재생성하거나 Helm annotation을 임의 덮어써서 해결하지 않는다.

### 3. Backend full runtime Secret과 Trino CA mount 미완료

현재 FastAPI는 승인된 5-key Web Secret을 사용한다. Phase 1의 Backend Trino client patch, AI/Airflow 전체 key와 `trino-ca.pem` file mount는 아직 실제 Deployment에 연결되지 않았다. 따라서 Trino가 기동해도 현재 Backend가 HTTPS/password client로 연결할 준비는 끝나지 않았다.

### 4. full-service runtime 결정 미완료

runtime delivery 기반은 준비됐지만 static contract의 Airflow 인증·AI runtime 결정은 아직 `learning-required`다. Phase 5 planning 검증은 통과하지만 `--full-service-ready`는 의도적으로 닫혀 있다. B가 실제 Backend consumer와 image startup 요구사항을 확정하기 전 임의 값을 만들지 않는다.

## checkpoint 계약 정정

기존 example은 fixture checkpoint를 `eks-mvp/checkpoints/`로 적었지만 실제 Spark IAM과 Terraform storage root는 `checkpoints/`다. handoff를 다음처럼 정정했다.

```text
output:     eks-mvp/output/<run-id>
checkpoint: checkpoints/eks-mvp/<batch-id>
```

이렇게 해야 fixture 경계가 실제 IAM 허용 범위 안에 있으면서 기존 Continuous와 분리된다. 현재 batch SparkApplication은 checkpoint를 직접 소비하지 않으므로 checkpoint는 향후 streaming/retry 경계 reference이며 사용 중이라고 주장하지 않는다.

## 다음 작업

Phase 5 완료를 위해서는 먼저 Phase 4 SASL authorization을 해결해 private fixture receipt를 만들고, B와 Helm release ownership 및 Backend runtime/file mount 계약을 합쳐야 한다. 그 뒤 같은 private handoff로 전체 server dry-run을 통과시키고 `readiness`를 `ready-for-deploy`로 올린다.
