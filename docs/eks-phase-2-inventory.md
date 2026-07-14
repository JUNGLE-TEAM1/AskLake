# EKS MVP Phase 2 AWS Inventory

이 문서는 Pair A가 실제 AWS resource를 생성하기 전에 수행한 비식별 read-only inventory와 다음 결정 gate를 기록한다. 실제 account ID, resource name, ARN, endpoint, public IP와 secret value는 기록하지 않는다.

## 2026-07-15 확인 결과

AWS CLI 인증과 `ap-northeast-2` region 설정은 정상이다.

현재 허용된 범위에서는 기본 VPC 1개, 4개 Availability Zone의 subnet 4개, Internet Gateway 1개, route table 1개, security group 2개와 실행 중 EC2 instance 1개가 확인됐다. subnet 4개는 모두 public IP 자동 할당이 켜져 있고 private subnet, NAT Gateway와 VPC endpoint는 없다. 기존 load balancer와 Route 53 hosted zone은 확인된 범위에서 0개다.

다음 inventory는 `AccessDenied`라서 존재 여부를 판단할 수 없다.

- EKS cluster
- ECR repository
- MSK cluster
- RDS instance
- S3 bucket
- Secrets Manager metadata
- ACM certificate

`AccessDenied`는 resource가 없다는 뜻이 아니다. 이 상태에서는 기존 EKS 재사용 또는 신규 생성, 기존 ECR/RDS/MSK 재사용, ingress certificate와 secret 저장 위치를 확정하지 않는다.

## 네트워크 판정

현재 확인된 default VPC와 public subnet만으로 EKS MVP 네트워크를 확정하지 않는다. MSK Serverless와 RDS는 private access를 사용하고, EKS node와 Pod는 ECR, S3, STS와 Kubernetes control plane에 접근해야 한다.

다음 선택은 read-only inventory와 비용 확인 뒤 별도 결정한다.

- 기존 VPC 재사용 또는 MVP 전용 VPC
- private subnet 신규 구성
- NAT Gateway 또는 ECR/S3/STS 등 VPC endpoint 조합
- public ALB subnet과 private workload subnet 분리
- EKS control plane public endpoint 사용 여부와 CIDR allowlist

private subnet이나 승인된 egress 경로 없이 default public subnet을 그대로 채택하지 않는다.

## 관리자 요청

[Phase 2 inventory policy](../infra/eks/iam/phase2-inventory-policy.json)는 resource를 생성·변경·삭제하거나 secret value를 읽지 않는다. 기존 resource의 존재, ownership, network와 lifecycle을 판단하는 metadata read-only action만 포함한다.

권한이 반영되면 다음 명령으로 inventory를 다시 실행한다.

```bash
bash scripts/inspect-eks-aws-inventory.sh
```

스크립트는 account ID, resource name, ARN, endpoint와 IP를 출력하지 않고 서비스별 접근 상태와 개수만 출력한다.

## Phase 2 종료 Gate

다음 항목이 모두 확인돼야 Phase 2를 완료하고 유료 resource apply로 넘어갈 수 있다.

- EKS/ECR/MSK/RDS/S3/ACM/Secrets inventory를 읽을 수 있다.
- 기존 EKS 재사용 또는 신규 EKS 생성이 결정됐다.
- VPC, public/private subnet과 NAT/VPC endpoint 경로가 결정됐다.
- IRSA 또는 EKS Pod Identity 방식이 결정됐다.
- secret 저장·Pod 전달 방식이 결정됐다.
- domain/certificate와 public/internal ingress 방식이 결정됐다.
- 각 resource가 `shared`, `mvp-owned`, `external`로 분류됐다.
- 생성 비용, TTL, rollback과 destroy owner가 기록됐다.

현재는 첫 번째 gate가 충족되지 않았으므로 실제 EKS, MSK, RDS, NAT Gateway와 신규 VPC를 생성하지 않는다. Terraform/Helm의 정적 개발은 계속할 수 있다.
