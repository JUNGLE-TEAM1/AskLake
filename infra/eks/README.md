# AskLake EKS Foundation

이 디렉터리는 Issue #735의 credential-free EKS 기반 계약이다. Phase 10부터 신규 cluster는 EKS Auto Mode로 생성하고 표준 Managed Node Group은 만들지 않는다. 기존 cluster는 Terraform이 변경하거나 import하지 않으며, 실제 환경에서 Auto Mode 활성화와 node role을 확인한 뒤 그 결과만 명시적으로 전달한다. ECR repository, Kubernetes namespace와 workload별 service account 이름은 안정적인 interface로 제공한다.

이 foundation은 Kafka broker를 배포하지 않는다. 배포 Kafka runtime은 Amazon MSK Serverless + IAM이며, 기존 EC2 Continuous control plane과 worker는 MVP 동안 별도 runtime으로 유지한다. Trino는 기존 EC2 endpoint를 재사용하지 않고 EKS의 단일 coordinator workload로 배포한다.

## 디렉터리

- `terraform/`: 기존/new EKS Auto Mode cluster, external/MVP-owned VPC network, ECR repository, Trino handoff와 opt-in MSK/RDS/S3 data-plane 계약
- `helm/asklake-foundation/`: namespace, workload별 service account, backend/Spark namespace RBAC, non-secret runtime boundary ConfigMap
- `helm/asklake-ingress/`: EKS Auto Mode IngressClassParams/Class와 HTTPS ALB routing 계약
- `helm/asklake-web/`: immutable image와 runtime 준비 gate 뒤 Frontend/FastAPI를 배포하는 workload 계약
- `helm/asklake-scale-smoke/`: Metrics API와 General NodePool scale-out을 확인한 뒤 제거하는 임시 test Deployment
- `helm/asklake-auto-mode/`: 명시적인 운영값이 없으면 아무 resource도 만들지 않는 General/Spark NodeClass·NodePool 계약
- `values/dev.example.yaml`: B가 manifest render와 fake client test에 사용할 예시 값
- `delivery/dev.handoff.example.json`: Terraform 출력과 B workload manifest 사이의 배포 전 handoff 형식
- `delivery/image-receipt.example.json`: 한 Git revision에서 만든 다섯 immutable ECR image의 전달 형식
- `secrets/runtime-secret-contract.example.json`: 값 없이 workload별 Secret 이름·key·공유 binding을 고정하는 planning 계약

## 안전 경계

- `terraform validate`와 `helm template`은 AWS resource를 만들지 않는다.
- `terraform apply`는 [Phase 0 환경·인수 계약](../../docs/eks-msk-mvp-phase-0-contract.md)의 Phase 1 gate가 채워진 뒤에만 실행한다.
- 실제 account ID, ARN, endpoint, credential, public IP, secret value는 저장소에 커밋하지 않는다.
- `shared` 또는 `external` resource는 이 Terraform state의 destroy 대상으로 가져오지 않는다.
- workload IAM policy는 B의 최소 권한 요구를 받은 뒤 별도 resource로 추가한다. 현재 chart는 확정된 IAM role annotation만 입력받는다.
- EKS Auto Mode의 built-in `system`/`general-purpose` NodePool은 cluster bootstrap 계약에 유지한다. General/Spark custom NodePool과 NodeClass는 Phase 12 chart가 제공하지만 기본값은 disabled이며 용량·Spot·disruption·selector를 학습하고 선택하기 전에는 렌더되지 않는다.
- network는 기본 `external`이고 기존/shared VPC를 state에 넣지 않는다. `create`는 신규 MVP-owned cluster에서만 허용하며 실제 CIDR/AZ와 NAT single/per-AZ 또는 VPC endpoint 비용 선택이 끝나기 전에는 plan이 실패한다.
- ECR 미태그 이미지 retention은 기본값으로 승인하지 않는다. 검토된 값을 명시적으로 입력해야 자동 삭제가 활성화된다.
- MSK와 RDS는 `disabled`, `existing`, `create`, S3는 추가로 기존 bucket을 안전하게 import하는 `managed-existing` 모드를 사용하며 기본값은 모두 `disabled`다. `create`를 선택해도 Phase 2 inventory와 비용·network·destroy 승인이 끝나기 전에는 apply하지 않는다.
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
bash scripts/verify-eks-runtime-secrets.sh
bash scripts/verify-eks-auto-mode-node-pools.sh
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
  -v "$PWD/infra/eks:/workspace" \
  -w /workspace/terraform \
  hashicorp/terraform:1.15.8 fmt -check -recursive

docker run --rm \
  -v "$PWD/infra/eks:/workspace" \
  -w /workspace/terraform \
  hashicorp/terraform:1.15.8 init -backend=false

docker run --rm \
  -v "$PWD/infra/eks:/workspace" \
  -w /workspace/terraform \
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

`cluster_mode = "existing"`은 기존 cluster를 읽기만 하고 EKS cluster 자체를 state에 넣지 않는다. 이 경로는 `existing_auto_mode_enabled=true`와 실제 Auto Mode node role ARN 없이는 plan이 실패한다. 이는 외부 확인 결과를 기록하는 gate이지 실제 활성 상태를 Terraform이 증명하는 기능은 아니다. `cluster_mode = "create"`는 external private subnet 또는 `network_mode=create`가 만든 private subnet에 compute, load balancing, block storage가 모두 활성화된 Auto Mode cluster를 만든다. 암묵적인 creator admin은 끄고 검토한 IAM role/user를 EKS Access Entry로 등록한다.

## Pair B handoff

B는 AWS resource가 없어도 다음 명령으로 namespace와 service account 계약을 사용할 수 있다.

```bash
helm template asklake-foundation \
  infra/eks/helm/asklake-foundation \
  -f infra/eks/values/dev.example.yaml
```

실제 runtime manifest는 chart가 만든 service account 이름을 참조해야 한다. 임의 이름을 별도로 만들지 않는다. FastAPI는 `asklake-backend` token과 namespace Role로만 SparkApplication을 제어하고 Spark driver는 `asklake-spark` token과 namespace Role로 executor lifecycle만 관리한다. 이 두 ServiceAccount 외 application workload의 Kubernetes API token mount는 금지한다. 세부 인수 항목은 [Phase 1 인수 계약](../../docs/eks-msk-mvp-phase-1-handoff.md)을 따른다.

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

현재 foundation contract `2.5`는 EKS Auto Mode compute, Phase 11 network, Phase 12 custom node placement, Phase 13 Auto Mode ALB, Phase 14 Frontend/FastAPI workload와 Metrics Server handoff, frontend, backend, Airflow, Trino, MSK IAM smoke, Spark service account를 제공한다. Replay Producer compatibility input은 `create=false`로 유지하며 ECR repository, service account 또는 workload를 만들지 않는다. `trino_handoff`는 실제 secret 값 없이 image digest, IRSA role ARN, in-cluster Service URL, RDS/S3 network와 Secret reference를 전달한다. AWS inventory가 확정되기 전 nullable 값은 resource 생성 gate로 남고 manifest render·fake client test만 완료할 수 있다.

Phase 3 data-plane Terraform은 MSK Serverless + IAM, private PostgreSQL RDS, 분리된 S3 bucket과 workload별 최소 권한 policy document를 추가한다. MSK topic 생성, RDS의 `airflow_metadata`/`iceberg_catalog` database와 user/grant bootstrap, IAM role attachment는 Terraform resource 생성과 분리된 후속 책임이다. 상세 모드와 미결정 사항은 [Phase 3 Data Plane 계약](../../docs/eks-phase-3-data-plane.md)을 따른다.

Phase 4는 IRSA/Pod Identity를 선택형으로 연결하고 RDS의 세 논리 database/user를 만드는 멱등 bootstrap을 제공한다. identity와 bootstrap은 기본적으로 실행되지 않으며 실제 선택·secret 전달·migration 경계는 [Phase 4 Workload Identity와 RDS Bootstrap](../../docs/eks-phase-4-identity-rds-bootstrap.md)을 따른다.

Phase 5는 실제 workload를 생성하지 않고 A의 infrastructure output과 B의 manifest 사이에 `delivery/dev.handoff.example.json` 계약을 둔다. planning 검증은 AWS 값 없이 통과하지만 실제 배포용 `--ready` 검증은 immutable ECR digest, data-plane reference와 중요한 platform 선택이 모두 채워지기 전까지 실패한다. 실제 값이 들어간 handoff는 Git에 커밋하지 않는다. 상세 기준은 [Phase 5 배포 Handoff](../../docs/eks-phase-5-delivery-handoff.md)를 따른다.

Phase 6는 수동 GitHub workflow로 Frontend, Backend, Airflow mirror, Spark runtime, Trino mirror를 `linux/amd64`로 ECR에 전달하고 digest receipt를 만든다. Workflow는 ECR repository를 생성하지 않으며 보호된 environment의 OIDC role 없이는 실행되지 않는다. 실제 push 전 설정과 비용 경계는 [Phase 6 ECR Image Delivery](../../docs/eks-phase-6-image-delivery.md)를 따른다.

Phase 7은 최초의 fail-closed ALB와 private network 선택 계약을 추가했다. Phase 13에서 controller 경계를 EKS Auto Mode managed ALB로 교체했으므로 현재 ingress 적용은 Phase 13 문서를 우선하고, Phase 7 문서는 선택 배경과 호환 output 설명으로 사용한다.

Phase 8은 한 JSON을 기준으로 FastAPI, Airflow, Spark, Trino의 runtime Secret 이름·key·공유 binding·env injection·파일 mount를 값 없이 고정하고 Terraform이 같은 계약을 output한다. delivery는 `disabled`가 기본이며 Phase 5 선택과 결합 검증한다. `ready_for_sync`와 Airflow/AI 선택까지 포함한 full-service Secret contract readiness는 구분한다. 상세 gate는 [Phase 8 런타임 Secret 전달 계약](../../docs/eks-phase-8-runtime-secrets.md)을 따른다.

Phase 10은 신규 EKS를 Auto Mode로 전환하고 기존 Managed Node Group 코드를 제거한다. 기존 cluster 경로는 외부 확인 없이는 닫혀 있고, General/Spark custom NodePool과 실제 AWS smoke는 완료로 간주하지 않는다. 상세 기준은 [Phase 10 EKS Auto Mode Foundation](../../docs/eks-phase-10-auto-mode-foundation.md)을 따른다.

Phase 11은 외부 network 참조와 MVP-owned VPC 생성을 분리하고 public/private subnet, NAT 또는 VPC endpoint egress, EKS/MSK/RDS private placement와 exact port security group을 추가한다. 실제 CIDR/AZ/egress 비용 선택은 example에 기본값으로 넣지 않으며 ALB는 후속이다. custom NodePool 구조는 Phase 12로 이어진다. 상세 기준은 [Phase 11 VPC와 Private Network Foundation](../../docs/eks-phase-11-network-foundation.md)을 따른다.

Phase 12는 custom NodeClass용 전용 node role/access entry와 General/Spark NodePool chart를 추가한다. 기본 렌더는 비어 있고 테스트 fixture의 숫자는 운영 권장값이 아니다. 실제 workload selector, 비용·용량·disruption 선택과 apply/scheduling/scale smoke는 [Phase 12 Auto Mode NodeClass와 NodePool](../../docs/eks-phase-12-auto-mode-node-pools.md)을 따른다.

Phase 13은 별도 AWS Load Balancer Controller를 설치하지 않고 EKS Auto Mode `IngressClassParams`/`IngressClass`로 하나의 HTTPS ALB를 관리한다. 기본 렌더는 비어 있고 실제 subnet/DNS/ACM 값은 저장소 밖에 둔다. apply/destroy confirmation, namespace selector와 Ingress-first cleanup은 [Phase 13 Auto Mode ALB 진입 경로](../../docs/eks-phase-13-auto-mode-alb.md)을 따른다.

Phase 14는 ALB가 참조하는 `frontend:80`과 `fastapi:8080` Service 및 두 Deployment를 추가한다. immutable receipt, runtime ConfigMap/Secret, General NodePool과 B의 FastAPI runtime 경계가 모두 준비되기 전에는 chart가 아무것도 렌더하지 않는다. 상세 기준은 [Phase 14 Frontend·FastAPI Workload](../../docs/eks-phase-14-web-workloads.md)을 따른다.

14일 A 마감의 Metrics Server는 EKS community add-on으로 관리한다. target cluster 호환 버전과 owner를 입력하기 전에는 disabled이고, 실제 완료는 Metrics API·`kubectl top`과 임시 General workload의 node scale-out/cleanup/scale-in evidence가 필요하다. 실행 절차도 Phase 14 문서를 따른다.

## 설계 참고 자료

- [Amazon EKS VPC와 subnet 고려사항](https://docs.aws.amazon.com/eks/latest/best-practices/subnets.html)
- [Amazon EKS identity와 access management 모범 사례](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html)
- [Amazon EKS Auto Mode](https://docs.aws.amazon.com/eks/latest/userguide/automode.html)
- [Amazon MSK IAM access control](https://docs.aws.amazon.com/msk/latest/developerguide/how-to-use-iam-access-control.html)
- [HashiCorp EKS provisioning guide](https://developer.hashicorp.com/terraform/tutorials/kubernetes/eks)
