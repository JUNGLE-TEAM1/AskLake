# EKS Phase 14 Frontend·FastAPI Workload

## 결과

Phase 14는 Phase 13 ALB가 연결할 `frontend`와 `fastapi` Deployment/Service 계약을 추가한다. 아직 AWS에 Pod를 배포한 것은 아니다. 기본 chart는 아무 resource도 렌더하지 않으며, 이미지·runtime 설정·Secret·General NodePool·FastAPI runtime 경계가 모두 검증됐다고 명시해야 두 workload가 생성된다.

Airflow, Trino, Spark Operator와 SparkApplication은 이 chart에 포함하지 않는다. 각각의 lifecycle과 상태 계약이 다르므로 후속 workload phase에서 다룬다. EKS 안에 Kafka broker를 배포하지 않으며 배포 broker는 계속 MSK Serverless + IAM이다. EC2 Continuous runtime도 이 단계에서 이동하거나 제어하지 않는다.

## 시작 상태와 의존성

Foundation namespace와 `asklake-frontend`, `asklake-backend` ServiceAccount가 있어야 한다. General NodePool에는 `asklake.io/workload-class=general` label이 있어야 한다. Phase 6의 AMD64 image receipt, Phase 8 방식으로 전달된 `asklake-backend-runtime` Secret, 비밀이 아닌 backend 설정을 담은 `asklake-runtime` ConfigMap, Foundation의 `asklake-runtime-boundary` ConfigMap도 필요하다.

`asklake-runtime`의 실제 key/value와 FastAPI background singleton·Continuous 차단 구현은 Pair B의 runtime 계약이다. A는 그 값을 추측해 chart에 넣지 않는다. `backendRuntimeBoundaryReady=true`는 B가 해당 구현과 검증 증거를 넘겼다는 승인 기록이지 chart가 애플리케이션 동작을 대신 구현한다는 뜻이 아니다.

Frontend image는 `VITE_API_BASE_URL`을 지정하지 않은 동일-origin 빌드여야 한다. 그러면 browser의 `/api` 요청은 Phase 13 ALB에서 FastAPI로 분기된다.

## 구현 계약

`infra/eks/helm/asklake-web`은 `frontend` Deployment/ClusterIP Service `frontend:80`과 `fastapi` Deployment/ClusterIP Service `fastapi:8080`만 소유한다. 서비스 이름·포트·health path는 Phase 13 ALB handoff와 동일하다. 두 Deployment는 General NodePool selector를 사용하고 Frontend는 ServiceAccount token을 mount하지 않는다. FastAPI는 Foundation이 만든 backend ServiceAccount token과 최소 namespace RBAC를 유지한다.

이미지는 ECR의 `@sha256:` digest만 허용한다. 두 replica 이상과 CPU/memory request·limit를 명시해야 하며 chart가 임의의 production 용량을 고르지 않는다. 저장소의 test values는 schema 검증용 fixture일 뿐 운영 권장치가 아니다. HPA, topology spread, PDB와 세부 autoscaling 수치는 실제 부하·가용성 요구를 학습하고 선택하는 후속 단계다.

FastAPI는 `asklake-runtime` ConfigMap과 `asklake-backend-runtime` Secret을 `envFrom`으로 받는다. Secret 값 자체는 values, Terraform state, manifest, log에 들어가면 안 된다. `asklake-runtime-boundary` 이름은 Pod annotation으로 추적하지만 애플리케이션이 이 annotation을 읽는다고 간주하지 않는다.

## 실행 순서

Phase 6 artifact의 image receipt와 저장소 밖의 private values를 준비한다. private values의 image 두 개는 receipt의 frontend/backend digest와 정확히 같아야 한다.

```bash
bash scripts/verify-eks-web-workloads.sh
bash scripts/deploy-eks-web-workloads.sh --render /private/web-values.yaml /private/image-receipt.json
```

실제 적용 전에는 B의 runtime boundary 증거, Secret sync, runtime ConfigMap, General NodePool scheduling, target cluster/context를 검토한다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME=<reviewed-cluster>
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_WEB_APPLY_CONFIRM=deploy-reviewed-web-workloads
bash scripts/deploy-eks-web-workloads.sh --apply /private/web-values.yaml /private/image-receipt.json
```

스크립트는 repository 안의 values 적용을 거부하고 AWS cluster endpoint와 현재 kubectl context, ServiceAccount·ConfigMap·Secret·General node label, server-side dry-run을 확인한 뒤 Helm atomic rollout을 수행한다.

## 완료 기준

코드 기준 완료는 disabled render가 비어 있고 enabled fixture가 정확히 두 Deployment와 두 Service를 만들며 mutable tag·1 replica·부분 readiness·포트 drift가 모두 실패하는 것이다. Terraform handoff가 Phase 13과 같은 Service 이름/포트를 제공하고 전체 Foundation 검증이 통과해야 한다.

실환경 완료는 별도다. 두 replica의 Ready 상태, 한 Pod 재시작 뒤 FastAPI 상태 복구, `/`와 `/api/health`, EKS FastAPI의 EC2 Continuous 격리를 확인해야 한다. 이 증거가 없으면 readiness를 true로 두거나 Phase 13 Ingress를 적용하면 안 된다.

## 삭제와 rollback

ALB Ingress가 남아 있는 동안 Service를 먼저 삭제하지 않는다. Phase 13 Ingress와 ALB finalizer를 먼저 정리한 뒤 workload만 제거한다.

```bash
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_EKS_CLUSTER_NAME=<reviewed-cluster>
export ASKLAKE_WEB_DESTROY_CONFIRM=destroy-web-after-ingress
bash scripts/destroy-eks-web-workloads.sh
```

Foundation ServiceAccount·ConfigMap·Secret, database migration, EC2 데이터 rollback은 Phase 14가 삭제하거나 수행하지 않는다.
