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
