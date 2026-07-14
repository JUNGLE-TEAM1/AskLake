# AskLake EKS Foundation

이 디렉터리는 Issue #735 Phase 1의 credential-free 기반 계약이다. 실제 AWS 환경을 임의로 선택하지 않고 기존 cluster 재사용 또는 신규 cluster 생성에 필요한 입력, ECR repository, managed node group, Kubernetes namespace와 workload별 service account 이름을 고정된 interface로 제공한다.

이 foundation은 Kafka broker를 배포하지 않는다. 배포 Kafka runtime은 Amazon MSK Serverless + IAM이며, 기존 EC2 Continuous control plane과 worker는 MVP 동안 별도 runtime으로 유지한다. Trino는 기존 EC2 endpoint를 재사용하지 않고 EKS의 단일 coordinator workload로 배포한다.

## 디렉터리

- `terraform/`: 기존/new EKS cluster, optional managed node group, ECR repository, Trino handoff와 opt-in MSK/RDS/S3 data-plane 계약
- `helm/asklake-foundation/`: namespace, workload별 service account, backend/Spark namespace RBAC, non-secret runtime boundary ConfigMap
- `helm/asklake-ingress/`: 선택 완료 전에는 아무 resource도 만들지 않는 HTTPS ALB routing 계약
- `values/dev.example.yaml`: B가 manifest render와 fake client test에 사용할 예시 값
- `delivery/dev.handoff.example.json`: Terraform 출력과 B workload manifest 사이의 배포 전 handoff 형식
- `delivery/image-receipt.example.json`: 한 Git revision에서 만든 다섯 immutable ECR image의 전달 형식

## 안전 경계

- `terraform validate`와 `helm template`은 AWS resource를 만들지 않는다.
- `terraform apply`는 [Phase 0 환경·인수 계약](../../docs/eks-msk-mvp-phase-0-contract.md)의 Phase 1 gate가 채워진 뒤에만 실행한다.
- 실제 account ID, ARN, endpoint, credential, public IP, secret value는 저장소에 커밋하지 않는다.
- `shared` 또는 `external` resource는 이 Terraform state의 destroy 대상으로 가져오지 않는다.
- workload IAM policy는 B의 최소 권한 요구를 받은 뒤 별도 resource로 추가한다. 현재 chart는 확정된 IAM role annotation만 입력받는다.
- managed node group의 instance type과 ECR 미태그 이미지 retention은 기본값으로 승인하지 않는다. 검토된 값을 명시적으로 입력해야 생성 또는 자동 삭제가 활성화된다.
- MSK, RDS와 S3는 각각 `disabled`, `existing`, `create` 모드를 사용하며 기본값은 모두 `disabled`다. `create`를 선택해도 Phase 2 inventory와 비용·network·destroy 승인이 끝나기 전에는 apply하지 않는다.
- generated workload IAM policy는 IRSA 또는 Pod Identity 선택 전까지 role에 연결하지 않는다.
- `workload_identity_mode` 기본값은 `disabled`다. IRSA와 Pod Identity를 모두 지원하지만 실제 cluster의 OIDC provider 또는 Pod Identity Agent 소유권을 확인한 뒤 하나를 명시적으로 선택한다.
- 신규 EKS에서 IRSA를 선택하면 cluster 준비와 OIDC provider 확인을 먼저 끝내고 다음 승인된 plan에서 identity를 활성화한다. 생성 예정 ARN/issuer는 IAM resource의 `for_each` key로 사용하지 않는다.

## 로컬 검증

```bash
bash scripts/verify-eks-foundation.sh
bash scripts/verify-eks-rds-bootstrap.sh
bash scripts/verify-eks-delivery-handoff.sh
bash scripts/verify-eks-image-delivery.sh
bash scripts/verify-eks-network-ingress.sh
```

AWS 환경 inventory는 실제 식별자를 출력하지 않는 별도 read-only 스크립트로 확인한다.

```bash
bash scripts/inspect-eks-aws-inventory.sh
```

필요한 최소 metadata read 권한은 `iam/phase2-inventory-policy.json`, 판정과 resource 생성 gate는 [Phase 2 AWS Inventory](../../docs/eks-phase-2-inventory.md)에 기록한다.

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

실제 runtime manifest는 chart가 만든 service account 이름을 참조해야 한다. 임의 이름을 별도로 만들지 않는다. FastAPI는 `asklake-backend` token과 namespace Role로만 SparkApplication을 제어하고 Spark driver도 `asklake-spark` namespace Role만 사용한다. 세부 인수 항목은 [Phase 1 인수 계약](../../docs/eks-msk-mvp-phase-1-handoff.md)을 따른다.

IRSA와 Pod Identity render 계약은 실제 ARN이 없는 fixture로 각각 확인할 수 있다. IRSA는 Backend/Trino/MSK smoke/Spark 네 ServiceAccount annotation을 만들고 Pod Identity는 annotation 없이 association output을 사용한다.

```bash
helm template asklake-foundation \
  infra/eks/helm/asklake-foundation \
  -f infra/eks/values/dev.example.yaml \
  -f infra/eks/values/identity/irsa.example.yaml

helm template asklake-foundation \
  infra/eks/helm/asklake-foundation \
  -f infra/eks/values/dev.example.yaml \
  -f infra/eks/values/identity/pod-identity.example.yaml
```

현재 foundation contract `1.2`는 frontend, backend, Airflow, Trino, MSK IAM smoke와 Spark service account를 제공한다. Replay Producer compatibility input은 `create=false`로 유지하며 ECR repository, service account 또는 workload를 만들지 않는다. `trino_handoff`는 실제 secret 값 없이 image digest, IRSA role ARN, in-cluster Service URL, RDS/S3 network와 Secret reference를 전달한다. AWS inventory가 확정되기 전 nullable 값은 resource 생성 gate로 남고 manifest render·fake client test만 완료할 수 있다.

Phase 3 data-plane Terraform은 MSK Serverless + IAM, private PostgreSQL RDS, 분리된 S3 bucket과 workload별 최소 권한 policy document를 추가한다. MSK topic 생성, RDS의 `airflow_metadata`/`iceberg_catalog` database와 user/grant bootstrap, IAM role attachment는 Terraform resource 생성과 분리된 후속 책임이다. 상세 모드와 미결정 사항은 [Phase 3 Data Plane 계약](../../docs/eks-phase-3-data-plane.md)을 따른다.

Phase 4는 IRSA/Pod Identity를 선택형으로 연결하고 RDS의 세 논리 database/user를 만드는 멱등 bootstrap을 제공한다. identity와 bootstrap은 기본적으로 실행되지 않으며 실제 선택·secret 전달·migration 경계는 [Phase 4 Workload Identity와 RDS Bootstrap](../../docs/eks-phase-4-identity-rds-bootstrap.md)을 따른다.

Phase 5는 실제 workload를 생성하지 않고 A의 infrastructure output과 B의 manifest 사이에 `delivery/dev.handoff.example.json` 계약을 둔다. planning 검증은 AWS 값 없이 통과하지만 실제 배포용 `--ready` 검증은 immutable ECR digest, data-plane reference와 중요한 platform 선택이 모두 채워지기 전까지 실패한다. 실제 값이 들어간 handoff는 Git에 커밋하지 않는다. 상세 기준은 [Phase 5 배포 Handoff](../../docs/eks-phase-5-delivery-handoff.md)를 따른다.

Phase 6는 수동 GitHub workflow로 Frontend, Backend, Airflow mirror, Spark runtime, Trino mirror를 `linux/amd64`로 ECR에 전달하고 digest receipt를 만든다. Workflow는 ECR repository를 생성하지 않으며 보호된 environment의 OIDC role 없이는 실행되지 않는다. 실제 push 전 설정과 비용 경계는 [Phase 6 ECR Image Delivery](../../docs/eks-phase-6-image-delivery.md)를 따른다.

Phase 7은 Terraform의 resource-free network handoff와 fail-closed ALB Ingress chart를 추가한다. controller owner, exposure, target type, DNS와 ACM을 모두 선택하기 전에는 Ingress가 렌더링되지 않고 NAT/VPC endpoint 및 Pod network enforcement도 `undecided`로 남는다. 실제 선택과 smoke 기준은 [Phase 7 Network와 ALB Ingress 계약](../../docs/eks-phase-7-network-ingress.md)을 따른다.

## 설계 참고 자료

- [Amazon EKS VPC와 subnet 고려사항](https://docs.aws.amazon.com/eks/latest/best-practices/subnets.html)
- [Amazon EKS identity와 access management 모범 사례](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html)
- [Amazon EKS managed node group](https://docs.aws.amazon.com/eks/latest/userguide/managed-node-groups.html)
- [Amazon MSK IAM access control](https://docs.aws.amazon.com/msk/latest/developerguide/how-to-use-iam-access-control.html)
- [HashiCorp EKS provisioning guide](https://developer.hashicorp.com/terraform/tutorials/kubernetes/eks)
