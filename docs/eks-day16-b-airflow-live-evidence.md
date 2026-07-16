# EKS MVP 목요일 Pair B Airflow 실환경 검증 기록

## 범위와 결론

2026-07-16 dev 환경에서 기존 `asklake-web` Frontend/FastAPI release의 소유권을 유지한 채 Airflow만 별도 `asklake-airflow` Helm release로 배포했다. 최종 release는 revision 2, status `deployed`다. API server, scheduler, DAG processor는 각각 1 replica이며 모두 Ready, restart 0이다.

이 기록은 목요일 전체 MSK → Spark → Iceberg → Trino → Catalog bounded E2E 완료를 뜻하지 않는다. `/Users/sisu/Downloads/eks-roadmap.md`에서 Pair B가 맡은 Airflow 3-Pod 분리, RDS/Secret 연결, DAG/API 준비 상태만 증명한다.

## Runtime Secret과 RDS TLS

- AWS Secrets Manager source는 `asklake/dev/backend/runtime`, `asklake/dev/airflow/runtime`으로 분리했다.
- `infra/eks/secrets/runtime-externalsecrets.dev.yaml`의 두 namespaced `ExternalSecret`이 `Ready=True`, `SecretSynced`다.
- target은 `asklake-backend-runtime`, `asklake-airflow-runtime`이며 둘 다 해당 `ExternalSecret`이 소유한다.
- Backend와 Airflow의 `AIRFLOW_PASSWORD`, `AIRFLOW_EXECUTION_API_TOKEN`, `AIRFLOW_INTERNAL_TOKEN`은 값을 출력하지 않고 base64 payload 동일성만 비교해 모두 일치함을 확인했다.
- Airflow DB URL은 `sslmode=verify-full`과 mount된 Seoul RDS CA bundle을 사용한다. 일회성 EKS Pod가 `airflow_metadata`에 `airflow_app`으로 연결해 TLS 활성화, PostgreSQL 16.14, Airflow Alembic version row 존재를 확인했다.
- CA는 `asklake-rds-ca` ConfigMap의 `ap-northeast-2-bundle.pem`으로 전달한다. Secret value, DB URL과 private endpoint는 이 문서에 기록하지 않는다.

## Migration과 API 사용자 bootstrap

첫 install에서 `airflow db migrate`는 성공했지만 migration hook에 FAB AuthManager 설정이 없어 `airflow users create/reset-password`가 기본 `AirflowSecurityManagerV2`의 누락 메서드로 실패했다. `--atomic` install은 release resource를 제거했고 RDS schema를 drop하거나 restore하지 않았다.

실제 image 진단에서 `AIRFLOW__CORE__AUTH_MANAGER=airflow.providers.fab.auth_manager.fab_auth_manager.FabAuthManager`를 설정하면 `FabAirflowSecurityManagerOverride`가 선택되고 `find_role`, `find_user`, `add_user`, `reset_password`가 모두 존재함을 확인했다. migration hook에 같은 설정을 추가했고, 기존 사용자와 password rotation에도 멱등하도록 사용자 생성 뒤 password reset을 항상 실행한다. 재설치 migration과 FAB API 사용자 bootstrap은 성공했다.

## Airflow image와 DAG 발견

초기 ECR digest는 `apache/airflow:3.3.0` base image를 그대로 mirror한 것이어서 `/opt/airflow/dags`가 비어 있었다. 과거 RDS metadata 때문에 CLI 목록에는 `asklake_etl_job`이 보였지만 DAG Processor는 파일 0개를 보고했고 DAG Run 생성 API는 404를 반환했다.

`.github/workflows/eks-image-delivery.yml`을 수정해 `airflow/Dockerfile`을 실제 `linux/amd64` image로 build/push하고 네 build 모두 `--provenance=false`를 사용하게 했다. 최종 dev image는 tag `git-e53f031-amd64`, digest `sha256:<redacted>`다. 먼저 push한 `git-e53f031` provenance index tag는 ECR tag immutability 때문에 덮어쓰지 않았고 어떤 workload도 사용하지 않는다. 삭제/retention은 별도 ECR lifecycle 판단으로 남긴다. revision 2의 세 Pod가 모두 최종 digest를 실행하며 DAG Processor에서 다음을 확인했다.

- `/opt/airflow/dags/asklake_etl_job.py` 존재
- DAG bundle에서 파일 1개 발견
- serialized DAG 1개 RDS 기록
- import error 0

## Live workload와 양방향 API 검증

- `asklake-airflow-apiserver`, `asklake-airflow-scheduler`, `asklake-airflow-dag-processor`: 각 1/1 Ready, restart 0
- Service `airflow-apiserver:8080`: Ready endpoint 1개
- executor: `LocalExecutor`
- Kubernetes API token: 세 Pod 모두 `automountServiceAccountToken=false`
- `/api/v2/monitor/health`: metadata DB, scheduler, DAG processor 모두 healthy
- 기존 `frontend`, `fastapi`: `asklake-web` 소유와 각 2/2 Ready 유지, FastAPI RDS health 200

FastAPI Pod에서 실제 Airflow username/password 인증을 사용해 `backend/scripts/verify-airflow-smoke.mjs`를 실행했다. `executionMode=smoke`라 실제 Spark/S3/Catalog를 변경하지 않는다.

- 성공 DAG Run `asklake_smoke_success_mrmzrhll_d1676c2b`: terminal `success`, 네 task 성공
- 의도적 실패 DAG Run `asklake_smoke_failure_mrmzrp9b_16bd6ee0`: terminal `failed`, 예상 실패 task 확인

반대 방향은 Airflow Pod에서 `ASKLAKE_EXECUTION_API_TOKEN`으로 FastAPI internal execution endpoint를 호출했다. 존재하지 않는 test job을 사용해 데이터 변경 없이 인증을 통과한 뒤 HTTP 404와 `NOT_FOUND`를 받았다. 401/403/503이 아니므로 Airflow → FastAPI 공유 token 전달이 실제로 동작한다.

## Storage 경계와 rollback

Airflow MVP는 image-baked DAG + RDS metadata + `LocalExecutor`다. EFS/PVC/shared DAG volume/shared log volume은 없다. 따라서 Pod-local task log는 Pod 교체 뒤 보존되거나 다른 Pod에서 공유된다고 보장하지 않는다.

Helm rollback 또는 uninstall은 세 Deployment, Service와 ConfigMap을 되돌리거나 제거할 수 있지만 이미 수행한 RDS schema migration을 역방향으로 되돌리지 않는다. schema/data rollback은 기존 RDS snapshot과 EC2 source receipt를 기준으로 별도 판단해야 한다. 이번 작업은 RDS database를 drop하지 않았고 기존 EC2 및 S3 object를 변경하지 않았다.
