# EKS 15일차 ALB route 적용 기록

## 적용 범위

Issue #794 Phase 1에서 기존 `asklake-ingress` foundation에 실제 Frontend/FastAPI route를 연결했다. 저장소 밖 private values를 사용했고 저장소의 기본·example values에는 실제 subnet, hostname 또는 AWS 식별자를 추가하지 않았다.

공개 계약은 기존 결정대로 다음과 같다.

```text
internet-facing Application Load Balancer
IPv4, 2개 AZ, Pod IP target
AWS 기본 DNS + HTTP 80

/     → frontend:80
/api  → fastapi:8080
```

사용자 도메인, Route 53, ACM certificate와 HTTPS는 이번 Phase에 포함하지 않았다. 기존 EC2 공개 경로와 Continuous control-plane도 변경하지 않았다.

## 적용 중 발견한 ownership 문제

기존 배포 스크립트는 Helm이 이미 소유하는 `IngressClassParams`를 별도 `kubectl apply --server-side --dry-run=server` field manager로 검증해 `.spec.namespaceSelector` ownership conflict를 만들었다. dry-run 실패 시점에는 cluster resource가 변경되지 않았다.

실제 적용도 Helm upgrade이므로 preflight를 `helm upgrade --install --dry-run=server`로 바꿨다. 이 방식은 기존 Helm field ownership을 유지하면서 API server validation을 수행한다. 정적 verifier는 이전 kubectl server-side apply가 다시 들어오면 실패한다.

## 실제 적용 결과

- `asklake-ingress` Helm release는 revision 1 foundation-only에서 revision 2 route-enabled로 upgrade됐다.
- `asklake-backend`, `asklake-frontend` Ingress가 생성됐다.
- 두 Ingress는 하나의 ALB를 공유한다.
- ALB는 `active`, `internet-facing`, application, IPv4, 2개 AZ 상태다.
- target group은 Frontend/Backend 두 개이며 각각 Ready Pod target 2개가 healthy다.
- ALB provisioning 중 B가 scheduler 수정 Backend 후보 `git-059d8ea`를 rolling update해 FastAPI Deployment generation이 2가 됐다. 이전 Backend Pod target 두 개는 잠시 `Target.DeregistrationInProgress`였고 active target 4개는 모두 healthy였다. 최종 검증에서는 draining 0, healthy 4가 됐으며 FastAPI는 `2/2`다. 전체 digest는 Git 밖의 receipt에 둔다.
- verifier의 `--steady`는 draining 0개와 Frontend/FastAPI Ready EndpointSlice IP 집합이 각 ALB healthy target 집합과 정확히 같은지 확인한다. `--rollout`은 의도한 rolling update 중에만 healthy/draining을 허용하며 group별 healthy target 2개 바닥은 유지한다. 두 모드 모두 listener path, target port와 health path를 Service 계약과 대조한다.
- ALB 기본 DNS `/`는 HTTP 200이다.
- ALB 기본 DNS `/api/health`는 HTTP 200이고 `database.ok=true`다.

실제 ALB hostname, ARN, target ID/IP와 전체 image digest는 Git에 기록하지 않는다.

## 반복 검증

다음 명령은 Ingress가 같은 ALB를 공유하는지, ALB 계약, 2개 target group, group별 healthy Pod 2개 이상, 외부 HTTP와 RDS health를 확인한다. hostname과 ARN은 내부 조회에만 사용하고 출력하지 않는다.

```bash
bash scripts/verify-eks-day15-alb-runtime.sh --steady
# 실제 rolling update 관찰 중에만 사용
bash scripts/verify-eks-day15-alb-runtime.sh --rollout
```

Phase 0의 변경 전 gate는 Ingress 0개를 요구하므로 적용 후 다시 실행하지 않는다. 현재 상태는 다음 명령으로 비밀 없이 캡처한다.

```bash
bash scripts/capture-eks-day15-integration-baseline.sh --capture
```

## 비용과 rollback

ALB가 `active`가 된 시점부터 ALB 사용 비용이 발생한다. rollback은 저장소 밖 private values에서 `routesEnabled=false`로 되돌리고 foundation confirmation으로 같은 `asklake-ingress` release를 upgrade하는 방식이다. 이 순서는 두 Ingress와 ALB를 제거하지만 IngressClassParams/Class foundation은 유지한다.

cluster/VPC를 먼저 삭제하지 않는다. 전체 teardown에서는 Ingress 제거와 finalizer 완료, ALB 잔여 0 확인, class/foundation, cluster/VPC 순서를 유지한다.

## Phase 1 완료와 다음 gate

Phase 1은 B scheduler 수정 후보 image가 배포된 상태에서 ALB 외부 route와 RDS-aware health까지 완료했다. 후속 Phase 2에서 수동 `asklake-backend-runtime`을 Secrets Manager + External Secrets Operator 관리 방식으로 전환했고 FastAPI rolling restart 뒤 같은 route와 RDS health를 재검증했다. 상세 증거는 [Backend runtime Secret 전환 기록](eks-day15-backend-secret-runtime-evidence.md)을 따른다. B PR #774의 scheduler 경쟁 test와 `pair1` conflict 해결은 B 범위로 남으며, 최종 merge 후보가 다시 바뀌면 동일 ALB verifier와 FastAPI replica 경쟁 검증을 다시 실행한다.
