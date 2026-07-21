# EKS Phase 11 VPC와 Private Network Foundation

## 목적

Phase 11은 EKS Auto Mode workload가 실행될 VPC 배치를 코드로 만든다. Phase 7에서 정의한 network/ingress 선택 계약을 실제 VPC, public/private subnet, route, NAT Gateway 또는 VPC endpoint 리소스로 연결하되 실제 AWS 환경에서 아직 선택하지 않은 비용·주소·가용성 값을 임의로 정하지 않는다.

초기 Phase 11은 Terraform 구조와 mock provider test까지 완료했다. 2026-07-15 dev 환경에는 전용 VPC, 두 AZ public/private subnet, 단일 NAT, EKS/MSK/RDS 배치와 exact-port security group을 실제 적용하고 runtime smoke까지 완료했다. 2026-07-20에는 NAT 구성을 유지한 채 S3 Gateway Endpoint를 독립 활성화했다. 실제 증거는 [7월 15일 Private Network 검증 기록](eks-day15-private-network-evidence.md)과 [100GB Resource Planner 검증](eks-100gb-resource-planner-shadow-evidence-2026-07-20.md)을 따른다.

## 2026-07-15 dev 적용 결과

dev는 `network_mode=create`, `private_egress_mode=nat_gateway`, `nat_gateway_mode=single`, `enable_s3_gateway_endpoint=true`를 사용한다. S3 Gateway Endpoint는 `available`이고 두 EKS private route table에 연결돼 있다. 단일 NAT와 두 `0.0.0.0/0` 기본 route는 유지하며 Interface Endpoint는 추가하지 않았다. 10GB smoke와 후속 100GB 실행에서 Raw/Output S3 read/write, NAT 우회, RDS/MSK/ALB/외부 통신 health를 검증했다.

Pod traffic enforcement는 `auto_mode_network_policy`를 선택했다. AWS 공식 ConfigMap으로 Auto Mode Network Policy Controller를 활성화하고 General/Spark NodeClass를 `DefaultAllow`로 명시했다. 임시 namespace에서 ingress deny와 정책 제거 후 복구를 검증했다. 실제 workload default-deny/allow 정책은 B의 Service·port 계약 전에는 만들지 않는다.

## 두 가지 소유권 경로

`network_mode = "external"`은 기본값이다. 기존/shared VPC와 subnet을 Terraform state에 import하거나 변경하지 않는다. 신규 EKS가 외부 private subnet을 사용하면 기존 `control_plane_subnet_ids`를 전달하고, 이후 public ALB가 승인되면 `external_public_subnet_ids`에 subnet을 최소 두 개 전달한다. Terraform은 ID 중복만 막으므로 실제 서로 다른 AZ인지도 inventory evidence로 확인한다. 기존 EKS cluster의 VPC/private subnet은 data source에서 읽되 실제 route, tag, 남은 IP와 egress 상태는 AWS inventory evidence로 따로 확인한다.

`network_mode = "create"`는 `cluster_mode = "create"`, `resource_lifecycle = "mvp-owned"`일 때만 열린다. 이 경로는 다음을 만든다.

- DNS resolution/hostname이 활성화된 전용 VPC
- 최소 두 개 AZ에 public/private subnet 한 쌍씩
- public subnet의 Internet Gateway route와 `kubernetes.io/role/elb=1` tag
- private subnet의 독립 route table과 `kubernetes.io/role/internal-elb=1` tag
- 선택한 private egress에 따른 NAT Gateway 또는 VPC endpoint
- 같은 private subnet을 사용하는 EKS Auto Mode, MSK Serverless와 RDS placement
- 생성형 MSK `9098`, RDS `5432`를 신규 EKS cluster security group에서만 받는 destination security group

public subnet은 Phase 13의 외부 ALB를 배치할 자리일 뿐, Phase 11에서 ALB·DNS·ACM을 만들거나 공개 endpoint를 확정하지 않는다. subnet의 `map_public_ip_on_launch`도 끈 상태다.

현재 신규 cluster 기본값은 Kubernetes API private endpoint만 활성화한다. 이 경우 개발자 PC나 GitHub runner가 바로 `kubectl`/Helm을 실행할 수 있다는 뜻이 아니다. VPN, SSM 기반 VPC runner, self-hosted runner 또는 제한된 public endpoint 가운데 운영 접근 경로를 학습·선택해야 하며, `phase11_network_handoff.kubernetes_api.private_operator_path`가 이 후속 gate를 표시한다.

## CIDR와 AZ 입력

실제 VPC CIDR과 AZ는 account inventory, 연결 대상 CIDR과 IP 수요를 확인한 뒤 입력한다. subnet CIDR 문자열을 각각 받지 않고 다음 값으로 VPC CIDR 안에서 결정적으로 계산한다.

- `vpc_cidr`: 충돌하지 않는 검토된 RFC1918 범위
- `subnet_newbits`: subnet prefix에 추가할 bit 수
- `public_subnet_netnums`: AZ 순서와 대응하는 public subnet 번호
- `private_subnet_netnums`: AZ 순서와 대응하는 private subnet 번호

예를 들어 `/16` VPC에서 `subnet_newbits = 8`이면 각 subnet은 `/24`다. public/private netnum은 전체에서 중복될 수 없다. AZ는 최소 두 개이며 CIDR/AZ 실제 값은 example이나 PR에 기록하지 않는다.

## Private egress 선택

MVP 전용 VPC를 생성하려면 `private_egress_mode`를 반드시 선택해야 한다.

### NAT Gateway

`nat_gateway`는 private workload가 일반 internet destination에도 접근할 수 있어 운영이 단순하지만 시간당·처리량 비용이 발생한다. `nat_gateway_mode = "single"`은 비용이 낮지만 선택된 NAT AZ 장애와 cross-AZ traffic 위험이 있다. `per_az`는 AZ별 독립 route를 제공하지만 NAT 고정비가 AZ 수만큼 발생한다. 이 선택은 실제 가용성·비용 기준을 학습한 뒤 한다.

`enable_s3_gateway_endpoint = true`는 NAT mode와 독립적인 선택이다. Terraform이 소유한 모든 private route table을 같은 리전의 S3 Gateway Endpoint에 연결한다. NAT 기본 route, 외부 API·STS·MSK·RDS·ALB 경로는 그대로 두고 S3 prefix-list route만 추가하며 Interface Endpoint를 만들지 않는다.

### VPC endpoints

`vpc_endpoints`는 NAT 기본 route를 만들지 않는다. baseline은 EC2, ECR API/DKR, CloudWatch Logs, STS interface endpoint와 S3 gateway endpoint를 요구한다. interface endpoint마다 시간당·처리량 비용이 있고, 이 목록만으로 모든 AskLake workload 목적지가 자동 해결되지는 않는다.

Pod Identity를 선택하면 `eks-auth`, external Secret delivery를 선택하면 `secretsmanager`/`kms`, ALB controller의 private AWS API 경로가 필요하면 `elasticloadbalancing` 같은 endpoint를 실제 선택에 맞춰 추가해야 한다. 외부 package repository와 OpenAI 같은 non-AWS endpoint는 VPC endpoint로 갈 수 없으므로 별도 egress가 필요하다.

### Hybrid

`hybrid`는 NAT와 선택 endpoint를 함께 사용한다. AWS service traffic을 endpoint로 보내면서 일반 outbound는 NAT로 처리할 수 있지만 route·DNS·고정비가 모두 늘어난다. 단순히 가장 안전한 기본값으로 취급하지 않는다.

S3 traffic만 NAT에서 우회하려는 경우에는 `hybrid`로 바꾸지 않고 NAT mode와 `enable_s3_gateway_endpoint=true` 조합을 사용한다.

## Security group 경계

신규 VPC와 MSK/RDS를 같은 state에서 생성할 때 MSK listener는 `9098`, PostgreSQL은 `5432`만 신규 EKS cluster security group에서 허용한다. `0.0.0.0/0` service ingress나 모든 port 규칙은 만들지 않는다.

이 규칙은 built-in Auto Mode node의 baseline 연결이다. Phase 12에서 custom NodeClass와 Security Groups for Pods를 선택하면 실제 node/Pod security group이 달라질 수 있으므로 source security group을 다시 검토하고 positive/negative smoke를 수행해야 한다. security group 코드만으로 network 성공을 선언하지 않는다.

## 전달 계약

Phase 11에서 도입한 contract `2.1`의 `phase11_network_handoff`는 Phase 13의 현재 contract `2.3`에서도 같은 이름으로 다음 non-secret 값을 배포 계층에 전달한다.

- external/terraform network 소유권
- VPC와 cluster private/public ALB subnet reference
- private egress mode, NAT 배치, interface/S3 endpoint 구성
- 생성형 MSK/RDS destination security group reference
- Pod network enforcement의 현재 선택 상태
- Phase 12 custom node placement와 Phase 13 ALB handoff output 이름
- 실제 runtime smoke 필요 여부

실제 resource ID와 endpoint가 들어간 output은 승인된 deployment environment에서만 소비하고 저장소 문서나 PR 본문에 복사하지 않는다.

## 이번 단계에서 하지 않는 일

- 새 CIDR/AZ/NAT/Interface Endpoint 선택 또는 추가 AWS apply
- Route 53, ACM, ALB/Ingress 생성과 외부 URL 개통
- General/Spark custom NodePool·NodeClass·taint/label은 Phase 12 코드로 이동했으며 실제 selector/용량 승인과 AWS apply는 미완료
- Security Groups for Pods 적용과 실제 workload별 NetworkPolicy
- MSK topic bootstrap, RDS migration, Secret 동기화
- 연결 비용과 대용량 처리량 검증

## 검증과 완료 기준

```bash
docker run --rm --entrypoint sh \
  -v "$PWD/infra/eks:/workspace" \
  -w /workspace/terraform \
  hashicorp/terraform:1.15.8 \
  -c 'export TF_DATA_DIR=/tmp/tfdata; terraform fmt -check -recursive && terraform init -backend=false -input=false >/dev/null && terraform validate && terraform test'

bash scripts/verify-eks-foundation.sh
```

정적 완료 기준은 external/create 소유권 분리, 2개 이상 AZ의 결정적 subnet 계산, NAT single/per-AZ와 endpoint-only 경로, NAT+optional S3 Gateway 경로, endpoint 최소 집합, EKS/MSK/RDS private placement, exact service port security group과 실패 조건이 mock test로 통과하는 것이다. dev는 endpoint `available`, private route table 연결 2개, NAT 기본 route 유지, Interface Endpoint 증분 0, 10GB/100GB S3 read/write와 NAT 우회를 통과했다. Kafka IAM 인증과 실제 workload별 NetworkPolicy/Service 연결은 후속 완료 기준이다.

## 공식 참고

- [Amazon EKS VPC와 subnet 고려사항](https://docs.aws.amazon.com/eks/latest/best-practices/subnets.html)
- [Amazon EKS VPC와 subnet 요구사항](https://docs.aws.amazon.com/eks/latest/userguide/network-reqs.html)
- [Interface VPC endpoint 생성](https://docs.aws.amazon.com/vpc/latest/privatelink/create-interface-endpoint.html)
- [Amazon S3 Gateway Endpoint](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html)
- [EKS Auto Mode Network Policy 사용](https://docs.aws.amazon.com/eks/latest/userguide/auto-net-pol.html)
