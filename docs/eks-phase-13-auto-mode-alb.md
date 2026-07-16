# EKS Phase 13 Auto Mode ALB 진입 경로

## 목적과 현재 결과

Phase 13은 Phase 7의 일반 AWS Load Balancer Controller용 Ingress 초안을 EKS Auto Mode가 직접 관리하는 ALB 계약으로 전환한다. EKS Auto Mode cluster에는 load balancing controller가 관리 기능으로 포함되므로 별도 Helm controller를 설치하거나 application ServiceAccount에 ELB 권한을 주지 않는다.

이번 단계는 route를 켜기 전 기반과 실제 ALB 생성 단계를 분리한다.

```text
IngressClassParams (eks.amazonaws.com/v1)
  ├─ public/internal scheme
  ├─ 허용 namespace label
  ├─ 공유 ALB group
  ├─ IPv4/dualstack
  ├─ 선택된 subnet 2개 이상
  └─ HTTPS일 때만 ACM certificate ARN
          ↓
IngressClass (controller: eks.amazonaws.com/alb)
          ↓ routesEnabled=true일 때만
AskLake Ingress 두 개
  ├─ /api → fastapi:8080 → /api/health
  └─ /    → frontend:80  → /
          ↓
EKS Auto Mode가 ALB·target group을 reconcile
```

dev에는 `internet-facing`, `ip`, `ipv4`, AWS 생성 ALB DNS와 HTTP 80을 선택했다. IngressClassParams와 IngressClass는 실제 적용했지만 최종 Frontend/FastAPI Service가 없으므로 Ingress는 만들지 않았다. 따라서 ALB, Route 53 record와 ACM certificate도 생성하지 않았고 기존 EC2 진입 경로도 바꾸지 않았다.

## Phase 7에서 수정한 구조 오류

기존 chart는 `kubernetes.io/ingress.class: alb`, Ingress별 group name, scheme와 certificate annotation을 사용했다. 이 방식은 self-managed AWS Load Balancer Controller 계약이다. EKS Auto Mode에서는 다음처럼 바꾼다.

- `spec.ingressClassName`으로 환경별 class를 명시한다.
- class controller는 `eks.amazonaws.com/alb`다.
- scheme, group, subnet, 선택적 certificate와 namespace 제한은 `IngressClassParams`에 둔다.
- Ingress에는 target type, HTTP/HTTPS listener와 target별 health path를 둔다. HTTPS일 때만 redirect를 둔다.
- 별도 controller readiness/owner 입력은 제거하고 controller owner를 `eks-auto-mode-managed`로 기록한다.

IngressClass는 cluster-scoped이므로 `alb` 같은 공용 이름을 쓰지 않는다. dev 기본 이름은 `asklake-dev-alb`이고 staging은 해당 environment 이름을 별도 values로 전달한다. default IngressClass로 지정하지 않아 class를 명시하지 않은 다른 namespace의 Ingress를 가져오지 않는다.

## Namespace와 ALB group 경계

`IngressClassParams.namespaceSelector`는 `asklake.io/ingress-access=<namespace>` label이 있는 namespace만 class를 사용하도록 제한한다. Foundation dev namespace에는 다음 label이 추가됐다.

```yaml
asklake.io/ingress-access: asklake-dev
```

`ip` target ALB의 rolling update에서는 Kubernetes Pod Ready가 ELB target Healthy보다 먼저 바뀔 수 있다. 이 간격에 기존 Pod가 종료되면 외부 502가 발생하므로 Foundation namespace에는 다음 label도 둔다. Ingress, Service와 `TargetGroupBinding`이 먼저 존재한 상태에서 이후 생성되는 Pod에 `target-health.elbv2.k8s.aws/*` readiness gate가 주입되며, 새 target이 Healthy가 되기 전에는 기존 Pod를 종료하지 않는다.

```yaml
eks.amazonaws.com/pod-readiness-gate-inject: enabled
```

이 key는 일반 self-managed AWS Load Balancer Controller의 `elbv2.k8s.aws/pod-readiness-gate-inject`와 다르다. EKS Auto Mode cluster의 managed `eks-load-balancing-webhook` namespace selector를 읽어 exact key를 확인해야 하며 두 key를 혼용하지 않는다. condition 이름은 controller 구현별 suffix를 가정하지 않고 주입된 `target-health.*` gate와 같은 status condition이 `True`인지 검사한다. 이 label만으로 성공 처리하지 않고 실제 rolling update 후 새 Pod의 readiness gate 존재와 `True`, ALB steady, 외부 health 연속 성공을 함께 확인한다.

두 Ingress는 class의 `group.name=asklake-dev`를 통해 하나의 ALB를 공유한다. Backend와 Frontend를 나누는 이유는 각각 `/api/health`와 `/`라는 다른 target health check를 유지하기 위해서다. 기존 Ingress group annotation과 order annotation에는 의존하지 않는다. `/api`와 `/`의 Prefix route와 실제 ALB listener rule은 server-side dry-run과 runtime target health로 다시 검증한다.

## dev에서 선택한 값과 보류한 값

dev foundation에는 다음 값을 적용했다.

- `internet-facing`
- Pod IP를 직접 target으로 쓰는 `ip`
- `ipv4`
- Phase 11에서 만든 서로 다른 AZ의 public subnet 두 개
- HTTP 80과 AWS 생성 ALB DNS

사용자 도메인, Route 53 record owner, ACM certificate와 HTTPS 전환은 보류한다. HTTPS를 선택할 때만 exact lowercase host, 같은 region의 ACM certificate ARN과 DNS owner를 모두 비공개 environment values에 넣는다.

다른 환경에서는 다음 선택을 그대로 복사하지 않고 접근 방식, VPC와 비용·보안 요구를 검토한다.

- `internet-facing` 또는 `internal`
- Pod IP를 직접 target으로 쓰는 `ip` 또는 NodePort를 쓰는 `instance`
- `ipv4` 또는 `dualstack`
- 서로 다른 AZ에 위치한 ALB subnet 2개 이상
- HTTP 또는 HTTPS listener
- HTTPS일 때 실제 lowercase DNS host, 같은 region의 ACM certificate ARN과 DNS 담당자

Terraform은 `internet-facing`이면 Phase 11 public ALB subnet, `internal`이면 private cluster subnet을 handoff한다. ID가 두 개라고 서로 다른 AZ임이 자동 증명되는 것은 아니므로 inventory evidence가 필요하다. `instance`를 선택하면 Frontend/FastAPI Service도 NodePort여야 하며 chart schema가 ClusterIP 조합을 거절한다.

저장소의 `infra/eks/values/ingress/alb.example.yaml`은 HTTP/default-DNS 렌더 검증용 fixture다. placeholder subnet은 실제 배포값이 아니며 apply script는 실제 값 유출을 막기 위해 저장소 내부의 모든 values 파일 사용을 거절한다.

## 기반 적용과 유료 ALB 생성 분리

먼저 실제 값을 저장소 밖 values 파일에 작성하고 로컬 render를 확인한다.

```bash
bash scripts/deploy-eks-auto-mode-ingress.sh --render /private/path/ingress-values.yaml
```

`routesEnabled=false`이면 target cluster의 Auto Mode load balancing, kubectl context, namespace label, `IngressClassParams` API와 server-side dry-run을 확인한 뒤 class/params만 적용한다. Ingress가 없으므로 Frontend/FastAPI Service를 요구하지 않고 ALB도 요청하지 않는다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<reviewed-cluster>'
export ASKLAKE_EKS_NAMESPACE='<reviewed-namespace>'
export ASKLAKE_INGRESS_FOUNDATION_APPLY_CONFIRM='apply-auto-mode-ingress-foundation'
bash scripts/deploy-eks-auto-mode-ingress.sh --apply /private/path/ingress-values.yaml
```

최종 Frontend/FastAPI Deployment와 Service가 준비된 뒤 `routesEnabled=true`로 바꾼다. 이때 스크립트가 두 Service와 server-side dry-run을 검사하며, 실제 ALB를 만들기 위한 비용 confirmation도 정확히 입력해야 한다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<reviewed-cluster>'
export ASKLAKE_EKS_NAMESPACE='<reviewed-namespace>'
export ASKLAKE_INGRESS_APPLY_CONFIRM='create-cost-bearing-auto-mode-alb'
bash scripts/deploy-eks-auto-mode-ingress.sh --apply /private/path/ingress-values.yaml
```

ALB는 Ingress가 생성된 뒤 비동기로 만들어진다. Helm 성공만으로 공개 성공을 선언하지 않는다. Ingress status의 ALB hostname, target health, `/`, `/api/health`, 허용/차단 source와 비용 evidence를 남긴다. dev 첫 검증은 AWS 생성 hostname의 HTTP 호출을 사용한다. 추후 HTTPS를 선택하면 DNS·ACM·HTTP→HTTPS evidence를 별도로 추가하며 이 단계의 Terraform은 Route 53 shared zone을 소유하지 않는다.

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

정적 완료 기준은 disabled render 0개, 미선택 enabled render 실패, foundation render의 Auto Mode IngressClassParams/Class 각 1개와 Ingress 0개, route render의 Ingress 2개, namespace selector, exact subnet, route/health 분리와 self-managed annotation 부재다. HTTP는 host/certificate를 거절하고 HTTPS는 둘을 필수로 요구한다. Terraform mock test는 public subnet 누락, 부분 입력과 disabled 상태의 잔여 runtime 값을 거절해야 한다. dev 실제 foundation 결과는 [적용 기록](eks-day15-alb-foundation-evidence.md)에 남긴다.

## 공식 참고

- [EKS Auto Mode에서 ALB IngressClass 구성](https://docs.aws.amazon.com/eks/latest/userguide/auto-configure-alb.html)
- [EKS Auto Mode networking과 load balancing](https://docs.aws.amazon.com/eks/latest/userguide/auto-networking.html)
- [Amazon EKS load balancing 모범 사례](https://docs.aws.amazon.com/eks/latest/best-practices/load-balancing.html)
