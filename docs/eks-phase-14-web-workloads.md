# EKS Phase 14 Frontend·FastAPI·AI Gateway·Trino Result Collector Workload와 Day 14 Scale 증거

## 결과

Phase 14는 Phase 13 ALB가 연결할 `frontend`와 `fastapi`, private `ai-gateway:8090`, Trino continuation을 회수하는 `trino-result-collector`, 그리고 opt-in FastAPI HPA 계약을 제공한다. 기본 chart는 아무 resource도 렌더하지 않으며, 네 이미지·runtime 설정·두 application Secret·General NodePool·FastAPI runtime 경계가 모두 검증됐다고 명시해야 네 workload가 생성된다. HPA는 별도 `backend.autoscaling.enabled=true` 입력 없이는 생성되지 않는다.

Airflow, Trino coordinator, Spark Operator와 SparkApplication은 이 chart에 포함하지 않는다. Collector는 Trino coordinator가 아니라 FastAPI와 같은 Backend application worker다. EKS 안에 Kafka broker를 배포하지 않으며 배포 broker는 계속 MSK Serverless + IAM이다. EC2 Continuous runtime도 이 단계에서 이동하거나 제어하지 않는다.

## 시작 상태와 의존성

Foundation namespace와 `asklake-frontend`, `asklake-backend`, `asklake-ai-gateway` ServiceAccount가 있어야 한다. General NodePool에는 `asklake.io/workload-class=general` 및 `kubernetes.io/arch=amd64` label이 있어야 한다. Phase 6의 Frontend/Backend/AI Gateway AMD64 image receipt, provider-key-free `asklake-backend-runtime`과 별도 `asklake-ai-gateway-runtime` Secret, `AI_QUERY_PROVIDER=gateway`와 `AI_GATEWAY_BASE_URL=http://ai-gateway:8090`을 포함한 `asklake-runtime` ConfigMap, Foundation의 `asklake-runtime-boundary` ConfigMap도 필요하다.

`asklake-runtime`의 실제 key/value와 FastAPI background singleton·Continuous 차단 구현은 Pair B의 runtime 계약이다. A는 그 값을 추측해 chart에 넣지 않는다. `backendRuntimeBoundaryReady=true`는 B가 해당 구현과 검증 증거를 넘겼다는 승인 기록이지 chart가 애플리케이션 동작을 대신 구현한다는 뜻이 아니다.

Frontend image는 `VITE_API_BASE_URL`을 지정하지 않은 동일-origin 빌드여야 한다. 그러면 browser의 `/api` 요청은 Phase 13 ALB에서 FastAPI로 분기된다.

## 구현 계약

`infra/eks/helm/asklake-web`은 `frontend`, `fastapi`, `ai-gateway`, `trino-result-collector` Deployment와 ClusterIP Service `frontend:80`, `fastapi:8080`, `ai-gateway:8090`을 소유한다. Gateway와 Collector의 public Ingress는 만들지 않는다. 네 Deployment는 General NodePool과 `kubernetes.io/arch=amd64` selector를 함께 사용한다. Frontend, Gateway와 Collector는 Kubernetes API token을 mount하지 않는다. FastAPI만 Foundation이 만든 backend ServiceAccount token과 최소 namespace RBAC를 유지한다. Gateway NetworkPolicy는 Backend의 8090 ingress, Backend MCP 8080, TCP/UDP 53 DNS와 provider HTTPS egress만 허용한다. EKS가 selectable CoreDNS Pod 없이 virtual Service IP로 DNS를 제공할 수 있으므로 DNS 목적지는 namespace selector로 제한하지 않고 포트·프로토콜로 제한한다. FastAPI의 DB-aware `/api/health`는 startup/readiness에만 사용하고, liveness는 TCP 8080 probe로 분리한다. Gateway는 provider와 MCP를 확인하는 `/health` startup/readiness와 TCP liveness를 분리한다. Rolling 종료 시 FastAPI는 `preStop` 310초와 종료 유예 360초로 dev ALB의 300초 deregistration delay를 포함한다.

이미지는 ECR의 `@sha256:` digest만 허용한다. Frontend/FastAPI는 두 replica 이상이고 Gateway/Collector는 1 replica다. Gateway의 replay guard가 공유 저장소로 이동하기 전에는 `Recreate`와 exact 1 replica를 유지한다. Collector는 FastAPI와 exact Backend digest를 공유한다. 네 workload 모두 CPU/memory request·limit를 명시해야 하며 저장소의 test values는 운영 권장치가 아니다.

FastAPI HPA는 `autoscaling/v2`와 CPU request 대비 utilization을 사용하고 roadmap evidence 경계인 `minReplicas=2`, `maxReplicas=6`만 허용한다. HPA가 활성화되면 Helm은 FastAPI Deployment의 `spec.replicas`를 렌더하지 않아 autoscaling controller와 field ownership을 경쟁하지 않는다. Frontend와 Collector는 계속 고정 replica다. tracked test profile의 CPU 60%, scale-up 2 Pods/30초, scale-down 1 Pod/60초와 300초 안정화는 render/실행 계약 fixture이며 production 권장값이 아니다. 실제 적용 전 baseline과 부하를 측정하고 private values에서 검토한다. topology spread와 PDB는 여전히 후속 단계다.

FastAPI와 Collector는 `asklake-runtime` ConfigMap과 `asklake-backend-runtime` Secret을 `envFrom`으로 받으며 Trino CA를 `/var/run/asklake/secrets/trino-ca.pem`에 읽기 전용 mount한다. 둘 다 `asklake-backend` ServiceAccount의 RDS/S3/Trino runtime identity를 사용하지만 Collector Pod는 Kubernetes API token을 비활성화한다. 기본 `backend.trinoRuntimeSecretName`은 main runtime Secret과 같다. ESO mapping을 단계적으로 전환하는 동안에만 Trino 인증/CA 전용 Secret을 추가 `envFrom`/volume source로 지정할 수 있고, 정식 mapping 적용 뒤 다시 main Secret 하나로 수렴한다. Secret 값 자체는 values, Terraform state, manifest, log에 들어가면 안 된다. `asklake-runtime-boundary` 이름은 Pod annotation으로 추적하지만 애플리케이션이 이 annotation을 읽는다고 간주하지 않는다.

Collector의 상태 원본은 RDS `sql_runs`다. `nextUri`는 Collector만 소비하고 browser polling은 저장된 상태만 읽는다. steady-state replica는 하나지만 DB lease와 증가하는 generation이 Pod 재시작 또는 일시적 중복 실행에서 stale write와 duplicate result page 공개를 막는다. Collector가 없거나 죽어도 Run을 성공으로 바꾸지 않으며 새 Pod가 만료된 lease 뒤 같은 `runId`를 복구한다.

`asklake-runtime`은 `asklake-web`이나 foundation Helm release가 소유하지 않는 Pair B runtime object다. 실제 endpoint·bucket·digest가 든 전체 manifest는 저장소 밖에 두고 `asklake-pair-b-runtime` field manager의 server-side dry-run/apply로 관리한다. `envFrom` ConfigMap 변경은 실행 중 process에 자동 반영되지 않으므로 검증한 비밀 제외 revision을 `backend.runtimeConfigRevision`에 넣어 FastAPI와 Collector Pod template annotation을 함께 바꾸고 두 workload를 같은 revision으로 rolling restart한다. 두 새 Pod의 환경, Ready/RDS health와 ConfigMap의 non-Helm ownership을 다시 확인한다. 값이 비어 있으면 annotation을 렌더하지 않지만, 기존 live release에 revision이 있으면 HPA-only upgrade에서도 같은 값을 보존해 불필요한 rollout을 만들지 않는다.

## 실행 순서

Phase 6 artifact의 image receipt와 저장소 밖의 private values를 준비한다. private values의 Frontend/Backend image는 receipt와 정확히 같아야 하고 Collector는 같은 Backend digest를 재사용해야 한다.

현재 Gateway 배포에는 `contractVersion=1.1`이며 `images.aiGateway`가 있는 receipt가 필수다. v1.0 receipt는 과거 Day 16–18 rollback 도구에서만 읽을 수 있고 이 배포 스크립트는 `--require-ai-gateway`로 거부한다. AI Gateway container는 numeric `10001:10001`, `runAsNonRoot`, `RuntimeDefault` seccomp로 실행한다.

```bash
bash scripts/verify-eks-web-workloads.sh
bash scripts/deploy-eks-web-workloads.sh --render /private/web-values.yaml /private/image-receipt.json
```

실제 적용 전에는 B의 runtime boundary 증거, Secret sync, runtime ConfigMap, General NodePool scheduling, target cluster/context를 검토한다. HPA를 활성화하면 Metrics API 가용성과 FastAPI CPU request를 추가로 확인한다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME=<reviewed-cluster>
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_WEB_APPLY_CONFIRM=deploy-reviewed-web-workloads
bash scripts/deploy-eks-web-workloads.sh --apply /private/web-values.yaml /private/image-receipt.json
```

스크립트는 repository 안의 values 적용을 거부하고 AWS cluster endpoint와 현재 kubectl context, 세 ServiceAccount·runtime ConfigMap·두 exact Secret·Ready AMD64 General node label을 확인한다. 두 ExternalSecret은 `Ready=True`이고 canonical target을 `creationPolicy=Owner`로 소유해야 하며 target Secret의 controller ownerReference도 일치해야 한다. Backend Secret은 provider key 없는 exact 15-key Gateway profile, Gateway Secret은 exact 3-key이고 두 공유 token의 encoded binding이 같아야 한다. `asklake-runtime`은 선택한 Helm release 소유이며 Gateway endpoint가 정확해야 한다. 이 검증은 값을 출력하지 않는다. API server preflight를 같은 release의 `helm upgrade --install --dry-run=server`로 수행한 뒤 Helm atomic rollout을 실행하고 네 Deployment rollout을 기다린다. 별도 `kubectl apply --server-side` manager로 Deployment image field를 인수하지 않는다. candidate의 Frontend/FastAPI/Gateway/Collector image와 runtime revision이 승인된 live 상태와 다르면 먼저 reconcile한다.

Secret과 runtime ConfigMap 전환은 workload rollout과 분리한다. `promote-eks-ai-gateway-runtime.sh --preflight`는 두 Secrets Manager source의 exact 15/3 key, provider key 격리, 공유 token 일치, 두 server dry-run과 별도 13-key direct rollback source를 검사한다. `--apply`는 임시 ExternalSecret 두 개의 전체 canonical hash가 source와 같을 때만 canonical target과 Gateway runtime values를 적용한다. 중간 실패 시 Backend Secrets Manager source를 검증된 direct 13-key JSON으로 되돌리고 저장한 두 ExternalSecret spec과 direct runtime values를 복원한 뒤 FastAPI를 재검증한다. 기존 `promote-eks-backend-full-service-secret.sh`는 `runtimeDecisions.aiRuntime.selected=direct`인 rollback 계약에서만 사용할 수 있다.

```bash
bash scripts/promote-eks-ai-gateway-runtime.sh --preflight \
  /private/runtime-gateway.yaml /private/runtime-direct-rollback.yaml \
  /private/backend-direct-rollback-source.json

export ASKLAKE_AI_GATEWAY_PROMOTION_CONFIRM=promote-staged-ai-gateway-runtime
bash scripts/promote-eks-ai-gateway-runtime.sh --apply \
  /private/runtime-gateway.yaml /private/runtime-direct-rollback.yaml \
  /private/backend-direct-rollback-source.json
```

## 완료 기준

코드 기준 완료는 disabled render가 비어 있고 enabled fixture가 정확히 네 Deployment, 세 Service, Gateway NetworkPolicy와 FastAPI HPA 하나를 만들며 mutable tag, Frontend/FastAPI 1 replica, HPA `2..6` drift, Gateway/Collector replica·활성화·ServiceAccount·port drift와 ARM64 selector가 모두 실패하는 것이다. HPA 활성 render에서는 FastAPI `spec.replicas`가 없어야 하고 HPA 비활성 render에서는 네 Deployment가 모두 명시적인 replica를 가져야 한다. Gateway는 provider key의 Backend 노출, public Service, 다중 replica, Kubernetes API token과 과도한 network 경로를 허용하지 않는다. Collector는 Backend와 exact digest가 같고 HTTP/Service/Ingress가 없어야 한다. Gateway 실환경 완료는 별도 배포 검증으로 판정한다.

실환경 완료는 별도다. Frontend/FastAPI 2/2, Gateway/Collector 1/1, `/`, `/api/health`, `/api/health/ai`의 `status=ready`, Dashboard Assistant 실제 응답과 EKS FastAPI의 EC2 Continuous 격리를 확인한다. HPA 완료를 주장할 때는 기존 exact-one 실행 증거가 추가로 필요하다. Collector 부재 중 Run은 삭제하지 않고 인증된 cancel API 또는 Collector 재배포로 복구한다.

배포 성공과 제품 AI smoke 성공은 별도 상태로 기록한다. Git 제외·`0600` JSON에 base URL, bearer token, 실제 Dataset을 사용하는 Query AI/Dashboard Assistant request body를 넣고 먼저 `--verify-input`으로 검사한다. `--run`은 비용이 발생하는 provider 호출이므로 별도 confirmation이 필요하며 응답 본문이나 token은 출력하지 않는다.

```bash
bash scripts/run-eks-ai-gateway-live-smoke.sh --verify-input /private/ai-gateway-smoke.json
ASKLAKE_AI_GATEWAY_SMOKE_CONFIRM=run-reviewed-ai-gateway-smoke \
  bash scripts/run-eks-ai-gateway-live-smoke.sh --run /private/ai-gateway-smoke.json
```

2026-07-17 dev 환경에서 위 조건을 모두 통과했다. FastAPI/Collector 동일 digest rollout, 외부 health 318표본 non-200 0개, 연속 count query scalar 100, active slot 0, Collector `0 -> 1` 교체 뒤 같은 `runId` terminal 복구와 result page 1개를 [Day 17 Collector live evidence](eks-day17-trino-result-collector-evidence.md)에 기록한다.

## 삭제와 rollback

ALB Ingress가 남아 있는 동안 Service를 먼저 삭제하지 않는다. Phase 13 Ingress와 ALB finalizer를 먼저 정리한 뒤 workload만 제거한다.

```bash
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_EKS_CLUSTER_NAME=<reviewed-cluster>
export ASKLAKE_WEB_DESTROY_CONFIRM=destroy-web-after-ingress
bash scripts/destroy-eks-web-workloads.sh
```

Foundation ServiceAccount·ConfigMap·Secret, RDS Query Run/result page, database migration, EC2 데이터 rollback은 Phase 14가 삭제하거나 수행하지 않는다. Collector rollback 시 진행 중 Run은 RDS에 남으므로 row를 직접 삭제하지 말고 인증된 `POST /api/query/runs/{runId}/cancel` 또는 Collector 재배포로 복구한다.

## Metrics Server와 Node scale-out

14일 A 완료 항목에는 Metrics Server와 test Pod 기반 Node scale-out 검증이 포함된다. Metrics Server는 Amazon EKS가 기본 설치하지 않으므로 `metrics-server` EKS community add-on으로 관리한다. 수동 latest manifest를 직접 적용하지 않고 AWS가 target Kubernetes version과 호환성을 확인하는 add-on 경로를 사용한다. 이 add-on은 IAM policy를 요구하지 않지만 Metrics Server Pod에서 각 node kubelet의 TCP `10250` 접근이 가능해야 한다.

저장소는 add-on 버전을 임의로 고정하지 않는다. target cluster가 생긴 뒤 다음 조회 결과에서 검토한 exact version을 `metrics_server_addon_version`에 기록한다.

```bash
aws eks describe-addon-versions \
  --addon-name metrics-server \
  --kubernetes-version <target-version>
```

`metrics_server_mode=eks_addon`, exact version, lifecycle owner와 `resource_lifecycle=mvp-owned`가 모두 있어야 Terraform이 `aws_eks_addon.metrics_server`를 만든다. 다른 platform owner가 이미 운영한다면 `external`과 실제 확인 증거를 사용하며 중복 설치하지 않는다. 기본 `disabled`는 add-on resource를 만들지 않는다.

설치 후에는 `ACTIVE` 상태만으로 완료하지 않는다. `v1beta1.metrics.k8s.io` APIService가 Available이고 `kubectl top nodes`, `kubectl top pods`가 성공해야 한다. Metrics Server는 현재값과 HPA 입력용이며 장기 이력·알림 시스템으로 간주하지 않는다.

Node scale smoke는 `infra/eks/helm/asklake-scale-smoke`의 임시 Deployment를 사용한다. 운영 resource 수치를 재사용하지 않고 실제 General NodePool 한도 안에서 replica와 CPU/memory request를 학습·선택한다. backend image receipt의 immutable digest만 사용하며 Service·Ingress·Secret을 만들지 않는다.

```bash
bash scripts/verify-eks-metrics-scale.sh

export ASKLAKE_EKS_CLUSTER_NAME=<reviewed-cluster>
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_SCALE_SMOKE_CONFIRM=run-cost-bearing-node-scale-smoke
bash scripts/run-eks-node-scale-smoke.sh \
  /private/scale-values.yaml \
  /private/image-receipt.json \
  /private/day14-scale-evidence.json
```

실행 스크립트는 cluster/context, add-on `ACTIVE`, Metrics API, image receipt를 확인하고 baseline보다 node 수가 증가할 때까지 최대 20분 기다린다. scale-out과 Pod metrics 확인 후 test Deployment를 삭제한다. Auto Mode consolidation에 따른 scale-in은 시간이 더 걸릴 수 있으므로 삭제 직후 성공으로 추정하지 않고 별도 관찰 결과를 evidence에 추가한다. test values의 replica/resource는 schema fixture일 뿐 실제 실행값이 아니다.

```bash
bash scripts/verify-eks-node-scale-in.sh /private/day14-scale-evidence.json
```

scale-in verifier는 임시 release와 Deployment가 삭제됐는지 확인하고 최대 30분 동안 node 수가 사전 baseline으로 돌아오는지 관찰한 뒤 같은 evidence 파일을 갱신한다.

14일 A 실환경 완료 증거는 Metrics add-on/version/owner, Metrics API와 `kubectl top` 성공, scale 전후 node 수, test Pod rollout, cleanup, 이후 scale-in 관찰 결과다. 코드 검증만 통과하고 이 evidence가 없으면 14일 A는 배포 준비 완료이지 실환경 완료가 아니다.

## 17일 scale 실험 관찰 화면

`scripts/watch-eks-day17-scale.mjs`는 HPA와 FastAPI, Spark Pod, 관리형 NodePool node, 최근 autoscaling/scheduling event를 한 터미널에서 연결해 보는 read-only observer다. 실험 변경을 수행하지 않으므로 HPA apply나 부하 시작보다 먼저 켜고, 부하 종료 뒤 FastAPI `2/2`와 Spark node scale-in을 확인할 때까지 유지한다.

```bash
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_EKS_CLUSTER_NAME='<reviewed-cluster>'
node scripts/watch-eks-day17-scale.mjs \
  --interval 5 \
  --record /private/tmp/asklake-day17-scale-observer.jsonl
```

직접 Pod Metrics 조회가 RBAC로 막혀도 HPA가 게시하는 CPU utilization과 replica 변화는 계속 표시한다. JSONL에는 aggregate 숫자와 허용된 event reason/kind만 mode `0600`으로 기록하며 cluster, resource 이름, run ID, ARN, endpoint를 포함하지 않는다. 이 기록은 timeline 보조 자료이고, Run별 데이터 정합성이나 HPA 적용 승인 자체를 대신하지 않는다. 자세한 load status 연결 형식과 검증 명령은 [개발 가이드](04-development-guide.md)를 따른다.

공식 기준은 [Amazon EKS Metrics Server](https://docs.aws.amazon.com/eks/latest/userguide/metrics-server.html)와 [Amazon EKS community add-ons](https://docs.aws.amazon.com/eks/latest/userguide/community-addons.html)를 따른다.
