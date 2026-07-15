# EKS MVP Phase 7 Network와 ALB Ingress 계약

> 현재 ALB 구현 기준은 [Phase 13 Auto Mode ALB 진입 경로](eks-phase-13-auto-mode-alb.md)다. 아래 내용은 최초 선택 계약과 self-managed controller 초안의 변경 이력으로 유지한다.

이 단계는 AskLake의 외부 진입 경로와 private workload 통신에 필요한 선택을 처음 코드로 표현한 단계다. 이후 Phase 11이 VPC/NAT/endpoint foundation을 추가했고 Phase 13이 ALB manifest를 EKS Auto Mode 방식으로 교체했다. 실제 ALB, DNS, certificate와 network smoke가 정적 검증만으로 완료되는 것은 아니다.

## 구현된 경계

Terraform의 `phase7_network_handoff`는 다음 값을 A에서 배포 계층으로 전달한다.

- ALB ingress 활성화 여부와 EKS Auto Mode load balancing 상태
- `internal` 또는 `internet-facing` exposure
- `ip` 또는 `instance` target type
- exact DNS host와 ACM certificate ARN reference
- Frontend `/` → `frontend:80`, FastAPI `/api` → `fastapi:8080` routing
- Frontend `/`, FastAPI `/api/health`의 서로 다른 health check
- private egress와 Pod traffic enforcement의 선택 상태
- Kubernetes API, ECR/S3/STS, RDS, MSK IAM, Trino, Airflow의 필수 port

기본값은 `ingress_mode=disabled`, `private_egress_mode=undecided`, `pod_network_enforcement=undecided`다. Phase 13 활성값은 `auto-mode-alb`이며 exposure, target/address type, subnet, DNS owner와 ACM 일부만 채우는 것도 허용하지 않는다. 단, `network_mode=create`를 선택하면 Phase 11 gate가 private egress 결정을 필수로 요구한다.

`infra/eks/helm/asklake-ingress` chart는 기본값으로 아무 resource도 만들지 않는다. 활성화하면 EKS Auto Mode IngressClassParams/Class와 HTTPS Ingress 두 개를 만들고 class-level group으로 하나의 ALB를 공유한다. 두 Ingress로 나누는 이유는 Frontend와 FastAPI target group에 실제 health endpoint를 각각 적용하기 위해서다.

```text
Internet 또는 사내 network
            ↓ HTTPS 443
       AWS ALB Ingress
       ├─ /api → fastapi:8080 → /api/health
       └─ /    → frontend:80  → /
```

## 아직 학습하고 선택해야 하는 사항

### ALB exposure

`internet-facing`은 외부 사용자가 직접 접속해야 하고 public subnet, WAF·접근제어, DNS·certificate 운영 주체가 준비된 경우에 선택한다. `internal`은 VPN, bastion, 사내 network 또는 별도 edge proxy를 통해서만 접근할 경우에 선택한다. 현재 코드는 어느 쪽도 기본값으로 고르지 않는다.

### ALB target type

`ip`는 Pod IP를 target으로 사용하므로 VPC CNI, subnet IP 여유와 Pod readiness를 확인해야 한다. `instance`는 NodePort와 node security group 경계를 사용한다. Chart는 `instance`를 선택하면서 B의 Service 계약이 `ClusterIP`이면 render를 거절한다. B workload Service 형태, CNI 구성과 운영 진단 방식을 확인한 뒤 target type과 Service type을 함께 선택한다.

### Private egress

`nat_gateway`는 일반적인 외부 HTTPS 접근이 단순하지만 시간당·처리량 비용이 지속된다. `vpc_endpoints`는 AWS 서비스 traffic을 private하게 유지할 수 있지만 ECR API/DKR, S3, STS 등 필요한 endpoint 목록과 endpoint별 비용을 관리해야 하며 외부 package/API 접근은 별도 경로가 필요하다. `hybrid`는 두 방식을 함께 쓰지만 route와 비용 추적이 복잡해진다. 실제 workload destination과 비용 견적을 확인해 선택한다.

### Pod traffic enforcement

`vpc_cni_network_policy`, `security_groups_for_pods`, `both` 중 실제 cluster add-on과 Node/Pod network 구조에 맞는 방식을 선택한다. 이번 Terraform state는 shared VPC CNI add-on을 설치·업그레이드하거나 소유하지 않는다. controller/add-on owner와 장애 복구 책임을 먼저 확정한다.

## 보안 주의사항

Phase 13 IngressClassParams는 exact `asklake.io/ingress-access` namespace label로 class 사용 범위를 제한한다. Ingress와 cluster-scoped class를 생성·변경할 주체는 배포 role로 제한하고 application ServiceAccount에는 Ingress 변경 권한을 주지 않는다.

Certificate ARN, host와 실제 network identifier가 들어간 environment values는 repository example을 덮어쓰지 않고 승인된 GitHub Environment 또는 배포 설정에서 전달한다. certificate private key, AWS credential과 application secret은 values나 Terraform output에 넣지 않는다.

## 검증

AWS를 변경하지 않는 정적 검증은 다음과 같다.

```bash
bash scripts/verify-eks-network-ingress.sh

docker run --rm --entrypoint sh \
  -v "$PWD/infra/eks/terraform:/workspace" \
  -w /workspace \
  hashicorp/terraform:1.15.8 \
  -c 'export TF_DATA_DIR=/tmp/tfdata; terraform fmt -check -recursive && terraform init -backend=false -input=false >/dev/null && terraform validate && terraform test'
```

현재 코드 완료 기준은 disabled render 0개, 미완성 enabled values 거절, Auto Mode IngressClassParams/Class와 HTTPS Ingress 2개 render, route/health check 분리와 전체 Terraform mock test 통과다.

실제 운영 완료는 EKS Auto Mode load balancing 상태, DNS/ACM 검증, ALB provisioning, `/`와 `/api/health` HTTPS 확인, 허용·차단 network smoke, RDS `5432`와 MSK IAM `9098` private 접근, ECR/S3/STS egress, ALB 삭제 후 잔여 resource 확인까지 성공해야 선언할 수 있다.
