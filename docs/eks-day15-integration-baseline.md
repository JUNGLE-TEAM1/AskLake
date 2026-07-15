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

다음 Phase 1은 ALB route 적용이다. 이 기준점 작성 당시 B PR #774의 `pair1` 충돌과 scheduler singleton 수정은 B 브랜치 범위였고 A의 ALB manifest를 막지 않았다. 이후 Phase 3.5 결과는 아래 동기화 기록을 따른다.

## Phase 3.5 B 머지 후 동기화

PR #774는 2026-07-16 KST 기준 `pair1` merge commit `4715513b`로 반영됐다. `feat-#794`는 최신 `origin/pair1`을 merge했고 `docs/system-guardrails.md` 한 곳의 충돌을 해결했다. 충돌 해결은 A의 강화된 ALB steady/rollout·ESO·S3 gate와 B의 실제 scheduler/Continuous 검증 결과를 모두 유지한다.

최종 Backend source 기준은 scheduler 경쟁 수정 commit `059d8eaa`다. dev FastAPI Deployment는 이 commit tag가 붙은 ECR의 immutable digest를 사용하고 두 Pod의 실제 imageID도 같은 digest와 일치했다. 전체 digest, repository URI와 AWS 식별자는 Git에 기록하지 않는다.

동기화 직후 read-only 사전 점검에서 다음 상태가 유지됐다.

- FastAPI desired/updated/ready `2/2/2`, unavailable 0
- ALB steady target 4개, draining 0, `/`와 `/api/health` HTTP 200
- Backend `database.ok=true`
- `ExternalSecret/asklake-backend-runtime` Ready와 target ownership/hash 검증 통과
- ECR repository immutable 설정과 배포 digest 존재 확인

이 단계는 새 image build/push나 workload rollout을 수행하지 않았다. 최신 Git 기준과 이미 배포돼 있던 B image의 일치를 확인한 동기화·사전 점검이다.

## Phase 4 최종 Backend rollout gate

Phase 4는 Phase 3.5에서 확인한 동일 immutable digest로 FastAPI Deployment만 rolling restart한다. rollout 동안 ALB 기본 DNS의 `/api/health`를 1초 간격으로 연속 호출하고 모든 표본이 HTTP 200이어야 한다. 종료 후 Deployment generation/revision 증가, 같은 digest의 Ready Pod `2/2`, restart 0, ALB steady target, RDS health와 Backend ExternalSecret을 다시 검증한다.

Continuous 경계는 두 새 Pod 모두 `ASKLAKE_CONTINUOUS_CONTROL_PLANE=external_ec2`인지, Kafka Continuous stream/manager process가 0개인지 확인한다. 기존 실행 중 EC2는 조회만 하고 중지·재시작·삭제하지 않는다. 실행 절차와 실제 결과는 `scripts/run-eks-day15-backend-rollout-smoke.sh`와 이 문서의 Phase 4 완료 기록을 기준으로 한다.

2026-07-16 KST 실제 실행에서는 Backend source commit `059d8eaa`의 기존 immutable ECR digest를 변경하지 않고 FastAPI Deployment를 rolling restart했다. Deployment generation과 revision이 증가했고 새 Pod 두 개는 같은 digest, Ready `2/2`, restart 0으로 복구됐다. rollout 중 1초 간격으로 수집한 외부 `/api/health` 표본은 모두 HTTP 200이었다.

Kubernetes rollout 완료 직후에는 이전 Backend target 두 개가 ALB의 정상 `draining` 상태로 남았다. target group의 설정된 deregistration delay 300초 동안 healthy target 4개와 RDS health는 계속 정상이고 비정상 target은 0개였다. runner는 고정 대기 대신 외부 health 측정을 유지하면서 최대 420초 동안 exact steady를 기다리도록 보완했다. delay 종료 뒤 ALB는 healthy 4, draining 0이며 Frontend/FastAPI EndpointSlice와 target 집합이 정확히 일치했다.

최종 post-check 결과는 다음과 같다.

- Backend ExternalSecret source/target hash, owner와 Ready 상태 유지
- ALB `/`, `/api/health` HTTP 200과 `database.ok=true`
- 두 FastAPI Pod 모두 `external_ec2`, Kafka Continuous stream/manager process 합계 0
- 기존 EC2 running 상태 유지, 중지·재시작·삭제 없음
- 새 Backend Pod Identity로 S3 positive/negative boundary smoke 재통과 및 임시 자원 정리

따라서 Phase 4는 새 image build/push, EC2 traffic cutover 또는 기존 환경 삭제 없이 최종 Backend rollout 가용성과 Continuous 소유권 경계를 완료했다.
