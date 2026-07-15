# EKS 15일차 통합 마무리 Phase 0 기준점

## 목적

이 문서는 Issue #794의 ALB route, Backend ExternalSecret 전환, S3 positive/negative smoke와 B 수정 이미지 통합 전에 현재 dev EKS 상태를 고정한다. 이후 상태와 비교할 수 있는 비밀 제외 판정만 저장하며 AWS account ID, ARN, endpoint, ALB hostname, 실제 Secret value와 전체 image digest는 기록하지 않는다.

기준 시점은 2026-07-16 KST다. Git 기준은 A의 PR #788과 B 계약 PR #792가 반영된 `pair1` merge commit `00e091de`이며, 작업 브랜치는 최신 `pair1`에서 생성한 `feat-#794`다. 기존 `feat-#735-day15`는 종료된 브랜치이므로 재사용하지 않는다.

## 변경 전 workload 기준점

`asklake-dev` namespace에서 Frontend와 FastAPI는 각각 desired/ready/available `2/2/2`다. 두 Deployment 모두 immutable `repository@sha256:digest` image를 사용하지만 실제 digest는 Git 밖의 배포 증거에 둔다. ServiceAccount는 Frontend `asklake-frontend`, FastAPI `asklake-backend`다.

Service와 Ready endpoint 기준은 다음과 같다.

```text
frontend:80   ClusterIP → Ready endpoint 2개
fastapi:8080  ClusterIP → Ready endpoint 2개
```

Frontend Pod에서 내부 `http://fastapi:8080/api/health`를 호출해 `database.ok=true`를 확인했다. 이 판정은 RDS application 연결 기준점이며 ALB 외부 접근 성공을 뜻하지 않는다.

General NodePool에는 Ready AMD64 node가 존재하고 두 web workload는 digest-pinned image로 정상 실행된다. 실제 node 이름, instance ID, Pod UID/IP는 저장하지 않는다.

## 변경 전 ALB 기준점

`asklake-ingress` Helm release revision 1, `IngressClassParams/asklake-dev-alb`와 `IngressClass/asklake-dev-alb`는 존재한다. namespace에는 정확한 `asklake.io/ingress-access=asklake-dev` label이 있다.

아직 Ingress는 0개이고 load balancer address도 없다. AWS region의 load balancer 수도 0개로 확인했다. 따라서 이 시점에는 ALB route 비용과 외부 hostname이 없으며 기존 EC2 공개 경로와 사용자 traffic을 변경하지 않았다.

다음 단계는 저장소 밖 private values에서 `routesEnabled=true`를 사용해 정확히 두 Ingress를 적용하는 것이다.

```text
/     → frontend:80
/api  → fastapi:8080
```

## 변경 전 Secret 전달 기준점

ESO controller는 desired/ready/available `1/1/1`이고 `external-secrets` Helm release revision 2가 배포돼 있다. namespaced `SecretStore/asklake-secrets-manager`는 AWS provider와 `Ready=True` 상태다.

하지만 application `ExternalSecret`은 0개다. 현재 `asklake-backend-runtime`은 owner reference가 없는 수동 `Opaque` Secret이며 다음 두 key만 가진다.

```text
DATABASE_URL
BOOTSTRAP_ADMIN_PASSWORD
```

값은 읽거나 기록하지 않았다. 이 Secret은 실행 중인 FastAPI가 사용하므로 ExternalSecret source 동기화와 target ownership을 확인하기 전에 먼저 삭제하지 않는다. 전체 B workload chart가 요구하는 AI/Airflow/Trino key는 이 두 key 기준점과 별개이며 consumer와 실제 source가 확정되기 전 placeholder로 추가하지 않는다.

## Helm과 rollback 기준점

다음 release는 모두 `deployed` 상태다.

```text
asklake-foundation  revision 2
asklake-ingress     revision 1
asklake-web         revision 1
external-secrets    revision 2
```

Phase 0에서는 Kubernetes나 AWS resource를 생성·수정·삭제하지 않았다. 기존 EC2는 Continuous control-plane과 rollback 원본을 계속 소유한다. B가 배포한 현재 web image의 전체 digest와 private values는 Git 밖의 receipt로 유지하고, 이후 rolling update 실패 시 `asklake-web` 이전 revision과 이전 digest로 되돌린다.

## 재현 가능한 비밀 제외 확인

다음 명령은 resource를 변경하지 않고 현재 상태를 JSON으로 출력한다. 출력에는 endpoint, ARN, Secret value와 전체 image digest가 들어가지 않는다.

```bash
bash scripts/capture-eks-day15-integration-baseline.sh --capture
```

Phase 0의 정확한 변경 전 조건까지 확인하려면 다음 gate를 사용한다.

```bash
bash scripts/capture-eks-day15-integration-baseline.sh --expect-pre-change
```

이 gate는 Frontend/FastAPI `2/2`, Ready endpoint 2개씩, RDS health, Ingress 0, ExternalSecret 0, 수동 Backend Secret 두 key, Ready AWS SecretStore와 Ready AMD64 General node를 확인한다.

## Phase 0 완료와 다음 gate

Phase 0 완료 기준은 다음과 같다.

- 변경 전 workload, Service, health, ALB, Secret ownership과 Helm revision을 비밀 없이 고정했다.
- 기존 EC2와 현재 web workload를 변경하지 않았다.
- ALB 적용 전 rollback과 Secret 전환 순서를 명시했다.
- 반복 가능한 read-only capture와 pre-change assertion이 통과한다.

다음 Phase 1은 ALB route 적용이다. B PR #774의 `pair1` 충돌과 scheduler singleton 수정은 B 브랜치 범위이며 A의 ALB manifest를 막지 않는다. 다만 B 수정 image rollout 뒤 ALB health와 replica 안전성은 최종 통합 gate에서 다시 확인한다.
