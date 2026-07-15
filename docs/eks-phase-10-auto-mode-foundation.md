# EKS Phase 10 Auto Mode Foundation

## 목적

Phase 10은 Pair A의 EKS 기반을 표준 Managed Node Group에서 EKS Auto Mode로 전환한다. 배포 목표 문서의 “EKS Auto Mode를 사용한다”는 선택과 실제 Terraform이 서로 다른 상태였던 구조 충돌을 제거하는 단계다. 이 단계는 AWS에 리소스를 생성하지 않고 코드, 정적 계약과 mock provider 검증까지만 완료한다.

Auto Mode는 단순한 autoscaling 옵션이 아니다. EKS가 compute, load balancing, block storage 운영 기능을 묶어서 제공하는 cluster capability다. 따라서 신규 cluster 생성 시 세 기능을 모두 활성화하고, Auto Mode 전용 cluster/node IAM 역할을 사용한다. 기존 `aws_eks_node_group`과 instance type·min/desired/max 입력은 제거한다.

신규 Auto Mode cluster는 AWS API 요구에 따라 `bootstrap_self_managed_addons=false`로 생성한다. CoreDNS, kube-proxy, VPC CNI를 기존 self-managed bootstrap 경로와 중복 생성하지 않으며 필요한 EKS/Community add-on은 명시적인 별도 resource로 관리한다.

## 신규 cluster 생성 계약

`cluster_mode = "create"`는 다음을 한 계약으로 만든다.

- EKS API 인증 모드는 `API`로 고정한다.
- cluster creator에게 암묵적인 관리자 권한을 주지 않는다.
- 검토한 IAM role 또는 user를 `cluster_admin_principal_arn`으로 받아 EKS Access Entry와 `AmazonEKSClusterAdminPolicy` association을 만든다.
- Auto Mode compute와 built-in `system`, `general-purpose` NodePool을 활성화한다.
- Auto Mode load balancing과 block storage capability를 함께 활성화한다.
- cluster role에는 AWS가 요구하는 cluster, compute, block storage, load balancing, networking 정책을 연결하고 trust에 `sts:TagSession`을 포함한다.
- node role에는 minimal worker와 ECR pull 정책만 연결한다.

관리자 principal은 STS assumed-role session ARN이 아니라 장기 식별 가능한 IAM role/user ARN이어야 한다. 실제 ARN은 저장소에 넣지 않는다. 값이 없으면 plan이 실패한다.

## 기존 cluster 재사용 계약

`cluster_mode = "existing"`은 기존 EKS resource를 Terraform state로 가져오거나 변경하지 않는다. `existing_auto_mode_enabled = true`와 실제 Auto Mode node role ARN이 모두 있어야 plan이 열린다. 이는 A가 AWS CLI/Console과 platform owner를 통해 확인한 결과를 기록하는 fail-closed gate다.

Terraform data source만으로 기존 cluster의 모든 Auto Mode 세부 상태와 built-in/custom NodePool 운영 상태를 증명했다고 주장하지 않는다. 실제 배포 전에는 다음 evidence가 별도로 필요하다.

- cluster compute, load balancing, block storage capability 활성 상태
- node role과 cluster role 정책/trust
- API access entry와 운영 관리자 접근
- built-in NodePool Ready 상태와 test Pod scheduling
- workload subnet, security group과 private endpoint 연결

확인 전에는 manifest render와 mock test만 완료할 수 있고 실제 환경 준비 완료로 표시하지 않는다.

## 이번 단계에서 하지 않는 일

Phase 10은 모든 Auto Mode 운영 설정을 한꺼번에 확정하지 않는다.

- General workload와 Spark batch를 분리하는 custom NodePool/NodeClass 구조는 Phase 12에서 구현했다. instance category, Spot/On-Demand, pool limits와 disruption의 실제 환경값은 여전히 학습·선택 gate다.
- Phase 11은 external/create VPC, public/private subnet, NAT/VPC endpoint와 MSK/RDS security group 구조를 구현했다. 실제 CIDR/AZ/egress 비용 선택, apply와 smoke는 여전히 환경 작업이다.
- Auto Mode load balancing capability 위의 공개/내부 ALB exposure, DNS, ACM, target/address type과 route 계약은 Phase 13의 IngressClassParams 구조로 구현했다. 실제 환경값과 apply/smoke는 여전히 별도 gate다.
- Metrics Server, Spark Operator, CloudWatch/Prometheus 운영 구성은 Phase 14 이후 범위다.
- 기존 cluster의 Auto Mode 활성화 작업과 신규 cluster `terraform apply`는 실제 account, 비용, destroy, rollback 승인 뒤 수행한다.

Auto Mode는 노드 운영 부담을 낮추지만 무제한 자원이나 무비용을 의미하지 않는다. 실행된 EC2 compute와 storage/load balancer 등 AWS 리소스 비용은 발생한다. 또한 AWS가 관리하는 노드를 기존 self-managed/managed node처럼 직접 운영하거나 임의 수정하는 방식에 제약이 있으므로 custom NodePool 설계와 장애 대응 절차를 실제 부하 시험 전에 검증해야 한다.

## 전달 계약

`auto_mode_handoff` output은 secret 없이 다음을 전달한다.

- `ownership`: 신규 cluster는 `terraform`, 기존 cluster는 `external-confirmed`
- `authentication`: `API`
- `node_role_arn`: 신규 생성 role 또는 기존 cluster에서 확인한 role
- `builtin_node_pools`: 신규 cluster에 활성화하는 built-in pool
- `custom_node_pools`: 아직 완료되지 않은 `phase-12`
- `capabilities`: compute/load balancing/block storage 활성 계약

Phase 10은 `phase1_handoff.contract_version = "2.0"`과 `cluster_compute = "eks-auto-mode"`를 도입했다. Phase 11 network output은 `2.1`, Phase 12 node placement는 `2.2`, Phase 13 ALB handoff 추가 뒤 현재 계약은 `2.3`이다. B는 custom chart 적용 전에는 selector 대상 node가 존재한다고 가정하지 않고, 적용 뒤 일반 workload와 Spark driver/executor에 각각 전달된 placement를 사용한다.

## 검증과 완료 기준

정적 검증은 AWS credential과 실제 mutation 없이 수행한다.

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

docker run --rm \
  -v "$PWD/infra/eks:/workspace" \
  -w /workspace/terraform \
  hashicorp/terraform:1.15.8 test

bash scripts/verify-eks-foundation.sh
```

완료 기준은 신규 cluster의 Auto Mode/IAM/access 계약이 mock test로 검증되고, 확인되지 않은 기존 cluster와 관리자 없는 신규 cluster가 실패하며, 표준 Managed Node Group resource와 입력이 코드에서 제거된 상태다. 실제 AWS 준비 완료 기준은 이후 environment apply와 smoke evidence가 추가되어야 충족한다.

## 공식 참고

- [Amazon EKS Auto Mode](https://docs.aws.amazon.com/eks/latest/userguide/automode.html)
- [Auto Mode cluster 생성](https://docs.aws.amazon.com/eks/latest/userguide/create-cluster-auto.html)
- [기존 cluster에 Auto Mode 활성화](https://docs.aws.amazon.com/eks/latest/userguide/auto-enable-existing.html)
