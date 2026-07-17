# EKS Phase 14 Frontend·FastAPI·Trino Result Collector Workload와 Day 14 Scale 증거

## 결과

Phase 14는 Phase 13 ALB가 연결할 `frontend`와 `fastapi` Deployment/Service, 그리고 Trino continuation을 회수하는 `trino-result-collector` Deployment 계약을 제공한다. 기본 chart는 아무 resource도 렌더하지 않으며, 이미지·runtime 설정·Secret·General NodePool·FastAPI runtime 경계가 모두 검증됐다고 명시해야 세 workload가 생성된다.

Airflow, Trino coordinator, Spark Operator와 SparkApplication은 이 chart에 포함하지 않는다. Collector는 Trino coordinator가 아니라 FastAPI와 같은 Backend application worker다. EKS 안에 Kafka broker를 배포하지 않으며 배포 broker는 계속 MSK Serverless + IAM이다. EC2 Continuous runtime도 이 단계에서 이동하거나 제어하지 않는다.

## 시작 상태와 의존성

Foundation namespace와 `asklake-frontend`, `asklake-backend` ServiceAccount가 있어야 한다. General NodePool에는 `asklake.io/workload-class=general` 및 `kubernetes.io/arch=amd64` label이 있어야 한다. Phase 6의 AMD64 image receipt, Phase 8 방식으로 전달된 `asklake-backend-runtime` Secret, 비밀이 아닌 backend 설정을 담은 `asklake-runtime` ConfigMap, Foundation의 `asklake-runtime-boundary` ConfigMap도 필요하다.

`asklake-runtime`의 실제 key/value와 FastAPI background singleton·Continuous 차단 구현은 Pair B의 runtime 계약이다. A는 그 값을 추측해 chart에 넣지 않는다. `backendRuntimeBoundaryReady=true`는 B가 해당 구현과 검증 증거를 넘겼다는 승인 기록이지 chart가 애플리케이션 동작을 대신 구현한다는 뜻이 아니다.

Frontend image는 `VITE_API_BASE_URL`을 지정하지 않은 동일-origin 빌드여야 한다. 그러면 browser의 `/api` 요청은 Phase 13 ALB에서 FastAPI로 분기된다.

## 구현 계약

`infra/eks/helm/asklake-web`은 `frontend`, `fastapi`, `trino-result-collector` Deployment와 ClusterIP Service `frontend:80`, `fastapi:8080`을 소유한다. Collector Service나 Ingress는 만들지 않는다. 서비스 이름·포트·health path는 Phase 13 ALB handoff와 동일하다. 세 Deployment는 General NodePool과 `kubernetes.io/arch=amd64` selector를 함께 사용한다. Frontend와 Collector는 Kubernetes API token을 mount하지 않는다. FastAPI만 Foundation이 만든 backend ServiceAccount token과 최소 namespace RBAC를 유지한다. FastAPI의 DB-aware `/api/health`는 startup/readiness에만 사용하고, liveness는 TCP 8080 probe로 분리한다. Rolling 종료 시 EndpointSlice와 ALB target deregistration이 먼저 전파되도록 FastAPI는 `preStop`에서 20초 동안 기존 process를 유지하고 전체 종료 유예를 60초로 둔다. Collector는 ALB target이 아니므로 이 HTTP drain hook을 사용하지 않는다.

이미지는 ECR의 `@sha256:` digest만 허용한다. Frontend/FastAPI는 두 replica 이상이고 Collector는 1 replica다. Collector는 별도 image를 만들지 않고 FastAPI와 exact Backend digest를 공유하며 `python scripts/collect-trino-results.py`만 실행한다. 세 workload 모두 CPU/memory request·limit를 명시해야 하며 저장소의 test values는 운영 권장치가 아니다. HPA, topology spread, PDB와 세부 autoscaling 수치는 실제 부하·가용성 요구를 학습하고 선택하는 후속 단계다.

FastAPI와 Collector는 `asklake-runtime` ConfigMap과 `asklake-backend-runtime` Secret을 `envFrom`으로 받으며 Trino CA를 `/var/run/asklake/secrets/trino-ca.pem`에 읽기 전용 mount한다. 둘 다 `asklake-backend` ServiceAccount의 RDS/S3/Trino runtime identity를 사용하지만 Collector Pod는 Kubernetes API token을 비활성화한다. 기본 `backend.trinoRuntimeSecretName`은 main runtime Secret과 같다. ESO mapping을 단계적으로 전환하는 동안에만 Trino 인증/CA 전용 Secret을 추가 `envFrom`/volume source로 지정할 수 있고, 정식 mapping 적용 뒤 다시 main Secret 하나로 수렴한다. Secret 값 자체는 values, Terraform state, manifest, log에 들어가면 안 된다. `asklake-runtime-boundary` 이름은 Pod annotation으로 추적하지만 애플리케이션이 이 annotation을 읽는다고 간주하지 않는다.

Collector의 상태 원본은 RDS `sql_runs`다. `nextUri`는 Collector만 소비하고 browser polling은 저장된 상태만 읽는다. steady-state replica는 하나지만 DB lease와 증가하는 generation이 Pod 재시작 또는 일시적 중복 실행에서 stale write와 duplicate result page 공개를 막는다. Collector가 없거나 죽어도 Run을 성공으로 바꾸지 않으며 새 Pod가 만료된 lease 뒤 같은 `runId`를 복구한다.

`asklake-runtime`은 `asklake-web`이나 foundation Helm release가 소유하지 않는 Pair B runtime object다. 실제 endpoint·bucket·digest가 든 전체 manifest는 저장소 밖에 두고 `asklake-pair-b-runtime` field manager의 server-side dry-run/apply로 관리한다. `envFrom` ConfigMap 변경은 실행 중 process에 자동 반영되지 않으므로 적용 뒤 `fastapi` Deployment를 명시적으로 rolling restart하고 두 새 Pod의 환경, Ready/RDS health와 ConfigMap의 non-Helm ownership을 다시 확인한다.

## 실행 순서

Phase 6 artifact의 image receipt와 저장소 밖의 private values를 준비한다. private values의 Frontend/Backend image는 receipt와 정확히 같아야 하고 Collector는 같은 Backend digest를 재사용해야 한다.

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

스크립트는 repository 안의 values 적용을 거부하고 AWS cluster endpoint와 현재 kubectl context, ServiceAccount·ConfigMap·Secret·Ready AMD64 General node label을 확인한다. 기존 release의 Helm field ownership을 유지하기 위해 API server preflight도 같은 release의 `helm upgrade --install --dry-run=server`로 수행한 뒤 Helm atomic rollout을 실행하고 세 Deployment rollout을 기다린다. 별도 `kubectl apply --server-side` manager로 Deployment image field를 인수하지 않는다.

## 완료 기준

코드 기준 완료는 disabled render가 비어 있고 enabled fixture가 정확히 세 Deployment와 두 Service를 만들며 mutable tag, Frontend/FastAPI 1 replica, Collector 0/2 replica, Collector 비활성화, ServiceAccount drift, 포트 drift와 ARM64 selector가 모두 실패하는 것이다. Collector image는 FastAPI image와 exact digest가 같고 HTTP port/Service/Ingress가 없어야 한다. Backend는 `/api/health`를 startup/readiness에만 두고 TCP liveness를 사용해야 하며, `preStop` 20초와 `terminationGracePeriodSeconds` 60초보다 짧은 ALB drain 계약을 허용하지 않는다.

실환경 완료는 별도다. Frontend/FastAPI 2/2와 Collector 1/1, `/`와 `/api/health`, EKS FastAPI의 EC2 Continuous 격리를 확인한다. Collector 부재 중 남은 `queued`/`running` Run은 삭제하지 않고 인증된 cancel API로 명시적으로 종료하거나 새 Collector가 terminal로 회수하는지 기록한다. 새 bounded `SELECT count(*)`가 `succeeded`와 기대값 100으로 끝나고 actor의 동시 실행 slot이 반환돼야 한다. Collector Pod 삭제 뒤 새 Pod가 생성되고, 이후 같은 지속 상태에서 새 Query Run이 terminal로 끝나는 것도 확인한다.

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

공식 기준은 [Amazon EKS Metrics Server](https://docs.aws.amazon.com/eks/latest/userguide/metrics-server.html)와 [Amazon EKS community add-ons](https://docs.aws.amazon.com/eks/latest/userguide/community-addons.html)를 따른다.
