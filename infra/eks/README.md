# AskLake EKS Foundation

이 디렉터리는 Issue #735 Phase 1의 credential-free 기반 계약이다. 실제 AWS 환경을 임의로 선택하지 않고 기존 cluster 재사용 또는 신규 cluster 생성에 필요한 입력, ECR repository, managed node group, Kubernetes namespace와 workload별 service account 이름을 고정된 interface로 제공한다.

이 foundation은 Kafka broker를 배포하지 않는다. 배포 Kafka runtime은 Amazon MSK Serverless + IAM이며, 기존 EC2 Continuous control plane과 worker는 MVP 동안 별도 runtime으로 유지한다.

## 디렉터리

- `terraform/`: 기존/new EKS cluster, optional managed node group, ECR repository와 handoff output
- `helm/asklake-foundation/`: namespace, workload별 service account, non-secret runtime boundary ConfigMap
- `values/dev.example.yaml`: B가 manifest render와 fake client test에 사용할 예시 값

## 안전 경계

- `terraform validate`와 `helm template`은 AWS resource를 만들지 않는다.
- `terraform apply`는 [Phase 0 환경·인수 계약](../../docs/eks-msk-mvp-phase-0-contract.md)의 Phase 1 gate가 채워진 뒤에만 실행한다.
- 실제 account ID, ARN, endpoint, credential, public IP, secret value는 저장소에 커밋하지 않는다.
- `shared` 또는 `external` resource는 이 Terraform state의 destroy 대상으로 가져오지 않는다.
- workload IAM policy는 B의 최소 권한 요구를 받은 뒤 별도 resource로 추가한다. 현재 chart는 확정된 IAM role annotation만 입력받는다.
- managed node group의 instance type과 ECR 미태그 이미지 retention은 기본값으로 승인하지 않는다. 검토된 값을 명시적으로 입력해야 생성 또는 자동 삭제가 활성화된다.

## 로컬 검증

```bash
bash scripts/verify-eks-foundation.sh
```

Terraform CLI가 설치돼 있으면 script가 `fmt -check`, `init -backend=false`, `validate`와 mock AWS provider 기반 `terraform test`까지 수행한다. 설치되지 않은 환경에서는 Helm과 계약 검증만 수행하고 Terraform 검증은 명시적으로 `SKIP`이라고 출력한다.

Docker로 같은 Terraform 검증을 실행할 수도 있다.

```bash
docker run --rm \
  -v "$PWD/infra/eks/terraform:/workspace" \
  -w /workspace \
  hashicorp/terraform:1.15.8 fmt -check -recursive

docker run --rm \
  -v "$PWD/infra/eks/terraform:/workspace" \
  -w /workspace \
  hashicorp/terraform:1.15.8 init -backend=false

docker run --rm \
  -v "$PWD/infra/eks/terraform:/workspace" \
  -w /workspace \
  hashicorp/terraform:1.15.8 validate
```

## 실제 환경 입력

`terraform.tfvars`는 커밋하지 않는다. `terraform/dev.tfvars.example`을 복사한 뒤 environment의 실제 값으로 채운다.

```bash
cd infra/eks/terraform
cp dev.tfvars.example terraform.tfvars
terraform init
terraform plan
```

`cluster_mode = "existing"`은 기존 cluster를 읽기만 하고 EKS cluster 자체를 state에 넣지 않는다. `cluster_mode = "create"`는 입력한 control-plane subnet에 cluster를 만든다. managed node group은 두 mode 모두 `create_managed_node_group=true`일 때만 생성한다.

## Pair B handoff

B는 AWS resource가 없어도 다음 명령으로 namespace와 service account 계약을 사용할 수 있다.

```bash
helm template asklake-foundation \
  infra/eks/helm/asklake-foundation \
  -f infra/eks/values/dev.example.yaml
```

실제 runtime manifest는 chart가 만든 service account 이름을 참조해야 한다. 임의 이름을 별도로 만들지 않는다. 세부 인수 항목은 [Phase 1 인수 계약](../../docs/eks-msk-mvp-phase-1-handoff.md)을 따른다.

## 설계 참고 자료

- [Amazon EKS VPC와 subnet 고려사항](https://docs.aws.amazon.com/eks/latest/best-practices/subnets.html)
- [Amazon EKS identity와 access management 모범 사례](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html)
- [Amazon EKS managed node group](https://docs.aws.amazon.com/eks/latest/userguide/managed-node-groups.html)
- [Amazon MSK IAM access control](https://docs.aws.amazon.com/msk/latest/developerguide/how-to-use-iam-access-control.html)
- [HashiCorp EKS provisioning guide](https://developer.hashicorp.com/terraform/tutorials/kubernetes/eks)
