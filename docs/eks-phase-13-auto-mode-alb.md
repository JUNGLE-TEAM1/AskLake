# EKS Phase 13 Auto Mode ALB 진입 경로

## 목적과 현재 결과

Phase 13은 Phase 7의 일반 AWS Load Balancer Controller용 Ingress 초안을 EKS Auto Mode가 직접 관리하는 ALB 계약으로 전환한다. EKS Auto Mode cluster에는 load balancing controller가 관리 기능으로 포함되므로 별도 Helm controller를 설치하거나 application ServiceAccount에 ELB 권한을 주지 않는다.

이번 단계는 다음 구조를 코드와 검증으로 완성했다.

```text
IngressClassParams (eks.amazonaws.com/v1)
  ├─ public/internal scheme
  ├─ 허용 namespace label
  ├─ 공유 ALB group
  ├─ IPv4/dualstack
  ├─ 선택된 subnet 2개 이상
  └─ ACM certificate ARN
          ↓
IngressClass (controller: eks.amazonaws.com/alb)
          ↓
AskLake Ingress 두 개
  ├─ /api → fastapi:8080 → /api/health
  └─ /    → frontend:80  → /
          ↓
EKS Auto Mode가 ALB·target group을 reconcile
```

실제 AWS apply, ALB 생성, Route 53 record 생성과 HTTPS 호출은 실행하지 않았다. 현재 완료 상태는 manifest, Terraform handoff, 적용·삭제 gate와 mock/static test까지다.

## Phase 7에서 수정한 구조 오류

기존 chart는 `kubernetes.io/ingress.class: alb`, Ingress별 group name, scheme와 certificate annotation을 사용했다. 이 방식은 self-managed AWS Load Balancer Controller 계약이다. EKS Auto Mode에서는 다음처럼 바꾼다.

- `spec.ingressClassName`으로 환경별 class를 명시한다.
- class controller는 `eks.amazonaws.com/alb`다.
- scheme, group, subnet, certificate와 namespace 제한은 `IngressClassParams`에 둔다.
- Ingress에는 target type, HTTPS listener, redirect와 target별 health path만 둔다.
- 별도 controller readiness/owner 입력은 제거하고 controller owner를 `eks-auto-mode-managed`로 기록한다.

IngressClass는 cluster-scoped이므로 `alb` 같은 공용 이름을 쓰지 않는다. dev 기본 이름은 `asklake-dev-alb`이고 staging은 해당 environment 이름을 별도 values로 전달한다. default IngressClass로 지정하지 않아 class를 명시하지 않은 다른 namespace의 Ingress를 가져오지 않는다.

## Namespace와 ALB group 경계

`IngressClassParams.namespaceSelector`는 `asklake.io/ingress-access=<namespace>` label이 있는 namespace만 class를 사용하도록 제한한다. Foundation dev namespace에는 다음 label이 추가됐다.

```yaml
asklake.io/ingress-access: asklake-dev
```

두 Ingress는 class의 `group.name=asklake-dev`를 통해 하나의 ALB를 공유한다. Backend와 Frontend를 나누는 이유는 각각 `/api/health`와 `/`라는 다른 target health check를 유지하기 위해서다. 기존 Ingress group annotation과 order annotation에는 의존하지 않는다. `/api`와 `/`의 Prefix route와 실제 ALB listener rule은 server-side dry-run과 runtime target health로 다시 검증한다.

## 임의로 선택하지 않은 값

다음 값은 실제 사용자 접근 방식, VPC와 비용·보안 요구를 학습하고 승인한 뒤 비공개 environment values에 넣는다.

- `internet-facing` 또는 `internal`
- Pod IP를 직접 target으로 쓰는 `ip` 또는 NodePort를 쓰는 `instance`
- `ipv4` 또는 `dualstack`
- 서로 다른 AZ에 위치한 ALB subnet 2개 이상
- 실제 lowercase DNS host
- 같은 region에서 host를 포함하는 ACM certificate ARN
- DNS record 생성·삭제 담당자

Terraform은 `internet-facing`이면 Phase 11 public ALB subnet, `internal`이면 private cluster subnet을 handoff한다. ID가 두 개라고 서로 다른 AZ임이 자동 증명되는 것은 아니므로 inventory evidence가 필요하다. `instance`를 선택하면 Frontend/FastAPI Service도 NodePort여야 하며 chart schema가 ClusterIP 조합을 거절한다.

저장소의 `infra/eks/values/ingress/alb.example.yaml`은 렌더 검증용 fixture다. placeholder subnet, domain과 ACM ARN은 실제 배포값이 아니며 apply script는 실제 값 유출을 막기 위해 저장소 내부의 모든 values 파일 사용을 거절한다.

## 적용 순서와 과금 gate

먼저 Foundation namespace와 Frontend/FastAPI Deployment·Service가 준비돼야 한다. 그다음 실제 값을 저장소 밖 values 파일에 작성하고 로컬 render를 확인한다.

```bash
bash scripts/deploy-eks-auto-mode-ingress.sh --render /private/path/ingress-values.yaml
```

실제 apply는 target cluster의 Auto Mode load balancing, kubectl context, namespace label, `IngressClassParams` API, Frontend/FastAPI Service와 server-side dry-run을 확인한다. 비용 confirmation도 정확히 입력해야 한다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<reviewed-cluster>'
export ASKLAKE_EKS_NAMESPACE='<reviewed-namespace>'
export ASKLAKE_INGRESS_APPLY_CONFIRM='create-cost-bearing-auto-mode-alb'
bash scripts/deploy-eks-auto-mode-ingress.sh --apply /private/path/ingress-values.yaml
```

ALB는 Ingress가 생성된 뒤 비동기로 만들어진다. Helm 성공만으로 DNS와 HTTPS 성공을 선언하지 않는다. Ingress status의 ALB hostname, target health, `/`, `/api/health`, HTTP→HTTPS, 허용/차단 source, CloudWatch/Cost Explorer evidence를 남긴다. DNS owner는 그 hostname을 확인한 뒤 승인된 방식으로 record를 생성하며 이 단계의 Terraform은 Route 53 shared zone을 소유하지 않는다.

## 삭제와 rollback

cluster/VPC를 먼저 삭제하면 ALB finalizer가 정리 작업을 끝내지 못해 load balancer, target group 또는 security group이 남을 수 있다. 반드시 Ingress를 먼저 지우고 Kubernetes resource 삭제가 끝난 다음 class release를 제거한다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<reviewed-cluster>'
export ASKLAKE_EKS_NAMESPACE='<reviewed-namespace>'
export ASKLAKE_INGRESS_DNS_REMOVED_CONFIRM='dns-record-removed-or-not-created'
export ASKLAKE_INGRESS_DESTROY_CONFIRM='delete-auto-mode-alb-before-cluster'
bash scripts/destroy-eks-auto-mode-ingress.sh
```

DNS record는 지정된 owner가 먼저 제거하고 confirmation을 전달한다. 스크립트가 끝나도 AWS Console/API에서 ALB, target group과 관련 security group 삭제를 확인한 뒤 EKS/VPC destroy로 넘어간다.

## 검증

```bash
bash scripts/verify-eks-network-ingress.sh
bash scripts/verify-eks-foundation.sh
```

정적 완료 기준은 disabled render 0개, 미선택 enabled render 실패, Auto Mode IngressClassParams/Class 각각 1개, Ingress 2개, namespace selector, exact subnet·certificate, route/health 분리와 self-managed annotation 부재다. Terraform mock test는 public subnet 누락, 부분 입력과 disabled 상태의 잔여 runtime 값을 거절해야 한다.

## 공식 참고

- [EKS Auto Mode에서 ALB IngressClass 구성](https://docs.aws.amazon.com/eks/latest/userguide/auto-configure-alb.html)
- [EKS Auto Mode networking과 load balancing](https://docs.aws.amazon.com/eks/latest/userguide/auto-networking.html)
- [Amazon EKS load balancing 모범 사례](https://docs.aws.amazon.com/eks/latest/best-practices/load-balancing.html)
