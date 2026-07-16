# EKS 15.5 Backend 수정 배포와 live 재검증 기록

## 범위

Issue #798은 `f556e95e`의 Catalog Iceberg rows 오류 처리 수정이 현재 EKS Backend image보다 뒤에 있는 상태를 해소하고, 강화된 bounded S3 Parquet 실행기를 실제 dev EKS에서 다시 검증한다. 이 문서는 `fix-#798`에서 단계별 기준점과 실행 결과를 기록한다.

`feat-#794`, `feat-#797`, `pair1` 통합, Trino snapshot-aware HTTP 200, Kafka→Iceberg→Trino 전체 E2E와 production cutover는 이번 이슈 범위가 아니다. 실제 account ID, endpoint, repository, 전체 digest, Pod·EC2 식별자와 Secret value는 기록하지 않는다.

## Phase 0: 변경 전 runtime 기준점

2026-07-16 dev 환경을 읽기 전용으로 확인했다. Terraform apply, Helm upgrade, Kubernetes apply/delete, image build/push와 traffic 변경은 수행하지 않았다.

### Web runtime과 ALB

- Frontend와 FastAPI Deployment는 각각 desired/ready/available `2/2/2`다.
- 두 Backend Pod는 restart 0이고 Deployment와 같은 immutable digest를 사용한다.
- Frontend/FastAPI EndpointSlice는 각각 Ready endpoint 2개다.
- 공유 ALB는 `active`, internet-facing IPv4, 2개 AZ, target group 2개다.
- healthy target은 4개, draining target은 0개이며 EndpointSlice와 정확히 일치한다.
- 외부 `/`와 `/api/health`는 HTTP 200이고 `database.ok=true`다.

### Secret과 RDS

- `ExternalSecret/asklake-backend-runtime`은 `Ready=True`다.
- target Secret은 `DATABASE_URL`, `BOOTSTRAP_ADMIN_PASSWORD` 두 key만 가지며 ExternalSecret이 소유한다.
- AWS Secrets Manager source와 Kubernetes target의 canonical hash가 일치한다.
- `SecretStore/asklake-secrets-manager`는 AWS provider와 `Ready=True`를 유지한다.

### Backend image provenance

- 현재 formal receipt의 full revision과 Backend immutable digest가 ECR, Deployment와 두 Ready Pod imageID에 일치한다.
- ECR repository는 immutable이고 현재 digest가 정확히 하나 존재한다.
- 현재 receipt revision은 `f556e95e`를 포함하지 않는다. 현재 `fix-#798` source는 해당 수정을 포함한다.
- 따라서 기존 image는 15일차 runtime 기준점으로는 정상이나 Issue #798의 수정 반영 artifact로 재사용할 수 없다.

### Continuous와 rollback

- 두 FastAPI Pod의 `ASKLAKE_CONTINUOUS_CONTROL_PLANE`은 `external_ec2`다.
- EKS FastAPI의 worker·maintenance Continuous process 합계는 0이다.
- EKS 관리 노드를 제외한 보존 대상 EC2 후보는 정확히 하나였고 running, instance/system status check `ok`를 확인했다.
- 현재 `asklake-web` Helm revision은 deployed 상태다.
- 직전 superseded revision의 Backend image도 immutable digest이고 ECR에 남아 있으며 현재 image와 다르다.
- 따라서 새 Backend-only rollout 실패 시 직전 Helm revision과 digest로 되돌릴 수 있다.

### Foundation 상태

- `asklake-foundation` revision 3, `asklake-ingress` revision 2, `asklake-web` revision 3, `external-secrets` revision 2가 deployed 상태다.
- General NodePool의 현재 node 1개는 Ready AMD64다.

## Phase 0 결론

새 Backend image를 받기 전 기준점과 rollback 경로가 모두 정상이다. 현재 runtime은 안정적이지만 Catalog rows source fix는 포함하지 않으므로 다음 단계는 `f556e95e`를 포함하는 새 `linux/amd64` immutable Backend image와 formal receipt 인수다.

Phase 0 결과는 새 image 배포, Catalog rows HTTP 502 실제 검증 또는 강화된 Spark live 재실행의 성공 증거가 아니다.

## Phase 1: 수정 Backend image 인수

GitHub의 수동 `EKS image delivery` workflow를 `fix-#798`의 Phase 0 commit에서 dev 보호 환경으로 실행했다. workflow는 short-lived OIDC credential을 사용했고 기존 immutable ECR repository만 확인한 뒤 `linux/amd64` image를 게시했다. 실행은 성공했고 30일 보존 formal receipt artifact를 생성했다.

공식 receipt schema가 다섯 component image를 요구하므로 workflow는 Frontend, Backend, Airflow, Spark runtime과 Trino를 같은 revision으로 게시했다. Issue #798의 배포 승인 대상은 새 Backend digest 하나뿐이다. 나머지 새 digest는 Phase 2 private values에 넣거나 EKS workload를 변경하는 근거가 아니다.

### 인수 검증

- workflow source revision은 Phase 0 commit의 full SHA와 정확히 일치한다.
- receipt revision은 `f556e95e`를 포함한다.
- Backend focused test 8개가 통과했으며 service와 FastAPI TestClient HTTP 502 정보 비노출 scenario를 포함한다.
- receipt는 Phase 6 schema를 통과하고 Git 제외 private 경로에 보관했다.
- 새 Backend image는 `linux/amd64` OCI index이며 현재 배포 Backend digest와 다르다.
- 새 digest는 ECR에 정확히 하나 존재하고 `git-<short-sha>` tag가 같은 digest를 가리킨다.
- Backend ECR repository는 immutable 상태다.
- 현재 Deployment와 Pod image는 변경하지 않았다.

### Phase 1 결론

`f556e95e` 이후 source를 포함한 새 Backend immutable image와 formal receipt 인수가 완료됐다. 아직 Helm render/server dry-run, Backend-only rollout과 실제 Catalog rows HTTP 검증은 수행하지 않았다. 다음 단계는 현재 Phase 0 기준점을 다시 확인하고 private values의 Backend digest만 교체하는 rollout 사전 검증이다.

## Phase 2: Backend-only rollout 사전 검증

Git에서 제외된 Phase 1 receipt와 현재 `asklake-web` Helm release values를 사용해 실제 apply 없는 사전 검증을 수행했다. `scripts/preflight-eks-backend-image-rollout.sh`는 receipt revision이 `f556e95e`를 포함하고 현재 branch의 ancestor인지, Backend digest가 immutable ECR artifact인지, 실제 OCI index가 `linux/amd64`인지 다시 확인한다.

현재 Helm values에서 `backend.image`만 새 receipt의 digest로 바꾼 임시 candidate를 만들었다. 원본과 candidate를 구조적으로 비교해 다른 field가 바뀌지 않았음을 확인했고, render 결과에서 Frontend image가 현재 값 그대로이며 Backend image만 새 digest가 되는지 검사했다. 이어 기존 release의 field ownership을 유지하는 `helm upgrade --install --dry-run=server`를 통과했다.

server dry-run 전후의 Helm release revision, Backend Deployment generation과 현재 image, Backend Pod UID 집합은 모두 같았다. 따라서 이 단계에서 Helm revision 생성, Deployment 변경, Pod 교체 또는 새 image 배포는 발생하지 않았다.

### 동시 runtime 변경 처리

첫 사전 검증 사이에 별도 작업이 기존 Backend digest를 유지한 채 Pod를 재시작했다. 이 때문에 ALB에 draining target이 남아 첫 검증은 steady gate에서 fail-closed 했다. 해당 변경을 되돌리거나 덮어쓰지 않고 draining 종료를 기다린 뒤 다시 실행해 ALB healthy target과 Ready EndpointSlice의 일치를 확인했다.

같은 시점에 `asklake-backend-runtime`은 기존 2-key web baseline에서 repository의 승인된 5-key runtime 계약으로 확장됐다. 사전 검증은 두 승인 집합 중 하나와 정확히 일치하는 경우만 허용하고, ExternalSecret mapping, target owner, Secrets Manager source와 Kubernetes target의 전체 key/value canonical hash 일치를 확인한다. 임의 key 추가나 부분 일치는 허용하지 않는다. Secret value는 출력하거나 Git에 기록하지 않았다.

### Phase 2 결론

- 새 Backend receipt의 수정 ancestry, immutable digest와 AMD64 platform 검증이 통과했다.
- candidate values는 `backend.image`만 변경했다.
- Helm lint, render와 API server dry-run이 통과했다.
- dry-run 전후 cluster mutation은 0이다.
- FastAPI `2/2`, ALB steady, Backend Secret, RDS-aware health, `external_ec2` Continuous 경계와 정확한 보존 EC2 상태가 통과했다.

실제 EKS는 여전히 기존 Backend image를 실행한다. 다음 단계는 같은 private receipt와 candidate를 사용한 Backend-only atomic rollout이며, 그 뒤에 새 Pod digest와 Catalog rows HTTP 오류 계약을 실제로 검증한다.

## Phase 3: Backend-only atomic rollout과 가용성 결함 발견

Phase 2 candidate의 새 Backend digest만 Helm release에 적용했다. 첫 두 번의 실행은 새 Backend Pod가 `2/2`로 수렴했지만 외부 `/api/health` 연속 표본에서 각각 비-200 응답을 감지해 성공 처리하지 않았고 직전 revision으로 자동 복구했다. 재시도에서 확인한 실패 유형에는 실제 ALB HTTP 502가 포함됐다.

원인은 Kubernetes Pod Ready가 ALB target Healthy보다 먼저 성립하는데 새 Pod에 target-health readiness gate가 없었던 것이다. 일반 controller용 namespace label을 처음 적용했지만 EKS Auto Mode managed webhook의 실제 selector와 달라 주입되지 않았다. cluster의 `eks-load-balancing-webhook`을 확인해 exact key를 `eks.amazonaws.com/pod-readiness-gate-inject=enabled`로 정정하고 잘못된 `elbv2.k8s.aws/...` label은 제거했다. Foundation Helm values와 repository example도 같은 key로 맞췄다.

세 번째 upgrade는 새 Backend digest, FastAPI `2/2`, ALB healthy 4·draining 0으로 수렴했다. 다만 실행 감시 process가 Helm upgrade 직후 중단돼 그 rollout 자체의 외부 health zero-failure와 readiness gate 주입 증거는 남지 않았다. 현재 새 image 배포 상태는 정상이나 무중단 rollout gate는 다음 새 Pod 교체에서 다시 입증해야 한다.

## Phase 4: Catalog rows runtime 오류 계약 점검

새 Backend image에 관리자 session으로 접근해 queryable Iceberg Dataset 하나의 bounded rows endpoint를 호출했다. HTTP status는 502, error code는 `SQL_STORAGE_ERROR`, message와 details key는 허용된 최소 envelope였고 `NameError`, traceback, endpoint, query, credential marker는 노출되지 않았다.

하지만 실제 Trino 연결 실패 reason이 wire value `BACKEND_TIMEOUT`이 아니라 Python enum 표현 `ErrorCode.BACKEND_TIMEOUT`으로 직렬화되는 drift를 발견했다. `iceberg_read_reason`이 `ApiError.code`의 enum value를 사용하도록 수정했고 Catalog rows focused test 8개가 통과했다. 이 추가 수정은 아직 현재 EKS image에 포함되지 않았으므로 Phase 4 runtime 완료가 아니다. 새 formal receipt, Backend-only rollout과 같은 live endpoint 재검증이 남아 있다.
