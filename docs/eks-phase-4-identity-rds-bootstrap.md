# EKS MVP Phase 4 Workload Identity와 RDS Bootstrap

이 단계는 workload identity 연결 방식과 PostgreSQL 논리 분리를 다룬다. 2026-07-15 dev EKS에는 Pod Identity 역할과 association, private RDS와 세 논리 database/user를 실제 적용했다.

## 완료된 구현

Terraform의 `workload_identity_mode`는 `disabled`, `irsa`, `pod_identity`를 지원하며 기본값은 `disabled`다. 코드가 IRSA와 Pod Identity 중 하나를 임의로 최종 선택하지 않는다.

identity를 활성화하면 다음 네 ServiceAccount에 서로 분리된 IAM role과 최소 권한 policy를 만든다.

- `asklake-backend`: 승인된 Raw/Output 읽기와 Warehouse·Query Result·evidence 경계
- `asklake-trino`: 지정된 S3 Warehouse·Query Result 경계
- `asklake-msk-smoke`: 격리된 MSK test topic metadata 경계
- `asklake-spark`: 격리된 MSK topic/group과 지정된 S3 경계

Frontend와 Airflow에는 현재 계약상 AWS IAM role을 만들지 않는다. 외부 fixture producer policy document도 EKS role에 연결하지 않는다. producer의 실제 AWS principal은 별도 선택 사항이다.

IRSA를 선택하면 배포 환경이 제공한 IAM OIDC provider ARN과 EKS issuer로 namespace·ServiceAccount가 정확히 일치하는 trust policy를 만든다. Terraform output의 annotation을 Helm ServiceAccount value에 전달한다.

신규 EKS와 IRSA는 한 번에 임의 적용하지 않는다. 먼저 identity가 `disabled`인 상태로 cluster를 준비하고, 해당 cluster의 issuer와 IAM OIDC provider lifecycle owner를 확인하거나 platform 범위에서 provider를 만든 다음, 두 번째 승인된 plan에서 IRSA를 활성화한다. Terraform resource의 `for_each` key는 이 issuer나 생성 예정 MSK ARN에 의존하지 않고 `backend`, `trino`, `mskSmoke`, `spark`로 정적으로 고정된다.

Pod Identity를 선택하면 annotation 대신 `aws_eks_pod_identity_association`을 만든다. dev cluster는 EKS Auto Mode에 통합된 Pod Identity 기능을 사용하므로 별도 Agent add-on을 설치하거나 소유하지 않고, 실제 Pod STS smoke가 성공한 경우에만 `pod_identity_agent_ready=true` 증거를 유지한다.

두 방식 모두 MSK와 S3 contract가 `disabled`가 아닐 때만 활성화된다. 실제 ARN과 bucket 경계가 없는 broad policy로 우회하지 않는다.

workload policy는 AWS provider mock에 의해 대체되지 않는 순수 Terraform module에서 만든다. Spark는 전용 MSK topic/group과 Raw/Output/Warehouse/checkpoint/quarantine만 읽고 쓰며, Backend는 승인된 Raw/Output 읽기와 Warehouse·Query Result·evidence 경계만 사용한다. Backend의 bucket 목록 권한은 logical bucket별 statement로 나눠 Raw/Output의 bucket-wide `*` 조건이 Warehouse/Query Result resource로 전파되지 않게 한다. `s3:*`, `kafka-cluster:*`와 `Resource: "*"`는 허용하지 않는다.

Helm handoff는 identity mode를 runtime boundary에 기록한다. IRSA fixture는 네 AWS workload ServiceAccount에만 role annotation을 렌더링하고, Pod Identity fixture는 IRSA annotation을 전혀 렌더링하지 않는다. 실제 Terraform output을 environment별 Helm values로 전달하는 deploy workflow는 후속 단계다.

## 2026-07-15 dev Pod Identity 적용 결과

dev EKS Auto Mode에는 Pod Identity를 선택해 다음 실제 검증을 완료했다.

- Backend, MSK smoke, Spark, Trino IAM role·managed policy·attachment·association 각 4개, 총 16개 생성
- 적용 결과 `16 added, 0 changed, 0 destroyed`, 후속 plan `No changes`
- 네 ServiceAccount Pod의 `sts:GetCallerIdentity`가 각각 분리된 role session을 반환
- Backend와 Spark는 기존 Raw object 조회 성공
- Trino는 Warehouse object 조회 성공, Raw 접근 거절
- MSK smoke는 S3 접근 거절
- Backend에는 불필요한 AWS Kafka control-plane 조회 권한이 없음을 확인
- smoke Pod가 General node scale-out을 유발한 뒤 모든 임시 Pod를 삭제

15일차 통합 Phase 3에서는 현재 FastAPI와 같은 immutable image·ServiceAccount로 Backend S3 경계를 다시 검증했다. 최초 정책의 결합된 `ListBackendBuckets` condition에서 Raw/Output의 `*`가 Query Result 목록까지 넓히는 문제가 발견돼 bucket별 statement로 분리했다. 수정 후 허용 result object의 Put/Get/Delete, 읽기 전용 prefix 쓰기 거절, 계약 밖 실제 sentinel 읽기와 목록 거절, 불필요한 bucket metadata 거절을 모두 확인했다. 상세 원인, 적용과 rollback은 [Backend S3 최소 권한 검증 기록](eks-day15-backend-s3-runtime-evidence.md)을 따른다. Spark/Trino policy는 이 Backend 증거로 완료 처리하지 않고 각 workload 배포 전에 별도 검증한다.

MSK IAM data-plane의 실제 bootstrap/topic metadata 조회는 Kafka IAM client가 필요하므로 B의 smoke client를 받은 뒤 수행한다. 현재 완료 증거는 association, STS와 S3 positive/negative boundary까지다.

Secret 저장 방식은 AWS Secrets Manager와 namespace 범위 External Secrets Operator로 적용했다. RDS master password는 RDS 관리형 secret, 세 application password는 `asklake/dev/rds/application-databases` source에 저장한다. bootstrap용 Kubernetes Secret은 ESO로 임시 생성하고 실행 후 삭제한다. 실제 DB password, token, TLS key와 장기 AWS access key는 Git, Terraform variable, Terraform output 또는 PR 본문에 넣지 않는다.

Ingress, domain/certificate, public/internal ALB, VPC endpoint/NAT와 workload security group은 이 단계에서 선택하지 않았다. 이 값이 필요한 실제 EKS deploy와 network smoke는 계속 보류한다.

## RDS 논리 database bootstrap

`scripts/bootstrap-eks-rds-databases.sh`는 승인된 PostgreSQL admin 연결을 사용해 다음 세 database와 전용 login role을 멱등 생성한다.

- `asklake_app` / `asklake_app`
- `airflow_metadata` / `airflow_app`
- `iceberg_catalog` / `iceberg_catalog`

각 role은 superuser, database/role 생성, replication과 bypass-RLS 권한을 갖지 않는다. 각 application database의 PUBLIC connect/temp 권한을 회수하고 해당 전용 role에만 부여한다. 반복 실행은 database를 중복 생성하지 않고 전달된 password를 회전한다.

실제 실행 전에는 대상 endpoint, backup/snapshot, migration owner와 rollback 기준을 확인한다. 다음 값은 shell environment 또는 승인된 secret delivery에서만 제공한다.

```bash
export PGHOST='<approved-rds-endpoint>'
export ASKLAKE_RDS_BOOTSTRAP_EXPECTED_HOST='<approved-rds-endpoint>'
export PGPORT='5432'
export PGDATABASE='postgres'
export PGSSLMODE='verify-full'
export PGSSLROOTCERT='<downloaded-rds-ca-bundle-path>'
export PGUSER='<bootstrap-admin-user>'
export PGPASSWORD='<bootstrap-admin-password>'
export ASKLAKE_APP_DB_PASSWORD='<secret>'
export AIRFLOW_APP_DB_PASSWORD='<secret>'
export ICEBERG_CATALOG_DB_PASSWORD='<secret>'
export ASKLAKE_RDS_BOOTSTRAP_CONFIRM='create-three-isolated-databases'

bash scripts/bootstrap-eks-rds-databases.sh
```

이 script는 application schema migration이나 기존 EC2 데이터 이전을 수행하지 않는다. FastAPI migration, Airflow DB migration과 Iceberg JDBC catalog 검증은 각 workload 배포 순서에 맞춘 후속 작업이다. dual-write는 사용하지 않으며 기존 EC2 PostgreSQL과 backup은 rollback 기간이 끝나기 전 삭제하지 않는다.

script는 `PGHOST`가 별도로 확인한 `ASKLAKE_RDS_BOOTSTRAP_EXPECTED_HOST`와 정확히 일치해야 실행된다. 운영 기본 TLS는 `verify-full`이고 실제 CA bundle 파일이 필요하다. `PGSSLMODE=disable`은 격리된 Docker 검증에서 `ASKLAKE_RDS_BOOTSTRAP_ALLOW_INSECURE_LOCAL=true`를 함께 지정한 경우에만 허용한다.

실제 EKS 실행은 `infra/eks/bootstrap/rds/bootstrap-job.yaml`을 사용한다. Job은 RDS CA bundle, script/SQL ConfigMap과 ESO가 만든 임시 bootstrap Secret을 mount하며 service account token과 static AWS credential을 사용하지 않는다. 성공 후 Job, ConfigMap, ExternalSecret과 target Secret을 제거한다. application password의 Secrets Manager source는 후속 workload mapping을 위해 유지한다.

RDS master는 PostgreSQL 진짜 SUPERUSER가 아니라 `rds_superuser`다. 따라서 role 최초 생성 시 모든 `NO*` 속성을 명시하고 재실행에서는 password만 회전한다. bootstrap은 세 role의 관리 권한 부재, 각 database에 대한 실제 TLS 로그인과 다른 database 접근 거부를 매번 확인한다.

## 검증과 실제 완료 기준

정적 검증은 다음 명령으로 수행한다.

```bash
bash scripts/verify-eks-foundation.sh
bash scripts/verify-eks-rds-bootstrap.sh

docker run --rm --entrypoint sh \
  -v "$PWD/infra/eks/terraform:/workspace" \
  -w /workspace \
  hashicorp/terraform:1.15.8 \
  -c 'export TF_DATA_DIR=/tmp/tfdata; terraform fmt -check -recursive && terraform init -backend=false -input=false >/dev/null && terraform validate && terraform test'
```

mock test는 identity 기본 비활성화, create-mode의 정적 IAM resource key, 실제 policy/trust 내용, IRSA role/annotation 4개, Pod Identity readiness 차단과 기존 data-plane 안전장치를 확인한다. RDS Docker 검증은 bootstrap을 두 번 실행하고 role의 관리 권한 부재와 세 database의 상호 CONNECT 격리를 확인한다. dev RDS bootstrap은 반복 실행을 통과했고 세 role의 TLS 로그인과 cross-database 거부가 확인됐다. Phase 4 전체 완료는 남은 MSK IAM client smoke와 각 실제 workload의 schema migration·DB 연결이 성공해야 선언할 수 있다.
