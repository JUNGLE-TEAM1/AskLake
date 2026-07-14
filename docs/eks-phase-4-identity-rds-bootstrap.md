# EKS MVP Phase 4 Workload Identity와 RDS Bootstrap

이 단계는 실제 AWS에 IAM role을 만들거나 RDS를 변경했다는 뜻이 아니다. Pair A가 Phase 2의 AWS inventory gate를 기다리는 동안 독립적으로 만들 수 있는 두 계약, 즉 workload identity 연결 방식과 PostgreSQL 논리 분리를 정적으로 완성한다.

## 완료된 구현

Terraform의 `workload_identity_mode`는 `disabled`, `irsa`, `pod_identity`를 지원하며 기본값은 `disabled`다. 코드가 IRSA와 Pod Identity 중 하나를 임의로 최종 선택하지 않는다.

identity를 활성화하면 다음 네 ServiceAccount에 서로 분리된 IAM role과 최소 권한 policy를 만든다.

- `asklake-backend`: 지정된 S3 결과·evidence 경계
- `asklake-trino`: 지정된 S3 Warehouse·Query Result 경계
- `asklake-msk-smoke`: 격리된 MSK test topic metadata 경계
- `asklake-spark`: 격리된 MSK topic/group과 지정된 S3 경계

Frontend와 Airflow에는 현재 계약상 AWS IAM role을 만들지 않는다. 외부 fixture producer policy document도 EKS role에 연결하지 않는다. producer의 실제 AWS principal은 별도 선택 사항이다.

IRSA를 선택하면 배포 환경이 제공한 IAM OIDC provider ARN과 EKS issuer로 namespace·ServiceAccount가 정확히 일치하는 trust policy를 만든다. Terraform output의 annotation을 Helm ServiceAccount value에 전달한다.

신규 EKS와 IRSA는 한 번에 임의 적용하지 않는다. 먼저 identity가 `disabled`인 상태로 cluster를 준비하고, 해당 cluster의 issuer와 IAM OIDC provider lifecycle owner를 확인하거나 platform 범위에서 provider를 만든 다음, 두 번째 승인된 plan에서 IRSA를 활성화한다. Terraform resource의 `for_each` key는 이 issuer나 생성 예정 MSK ARN에 의존하지 않고 `backend`, `trino`, `mskSmoke`, `spark`로 정적으로 고정된다.

Pod Identity를 선택하면 annotation 대신 `aws_eks_pod_identity_association`을 만든다. 단, platform owner가 EKS Pod Identity Agent 설치와 소유권을 확인해 `pod_identity_agent_ready=true`를 제공해야 한다. 이 application state가 shared add-on을 임의로 설치하거나 삭제하지 않는다.

두 방식 모두 MSK와 S3 contract가 `disabled`가 아닐 때만 활성화된다. 실제 ARN과 bucket 경계가 없는 broad policy로 우회하지 않는다.

workload policy는 AWS provider mock에 의해 대체되지 않는 순수 Terraform module에서 만든다. Spark는 전용 MSK topic/group과 Raw/Output/Warehouse/checkpoint/quarantine만 읽고 쓰며, Backend는 Output/Warehouse/Query Result/evidence만 사용한다. `s3:*`, `kafka-cluster:*`와 `Resource: "*"`는 허용하지 않는다.

Helm handoff는 identity mode를 runtime boundary에 기록한다. IRSA fixture는 네 AWS workload ServiceAccount에만 role annotation을 렌더링하고, Pod Identity fixture는 IRSA annotation을 전혀 렌더링하지 않는다. 실제 Terraform output을 environment별 Helm values로 전달하는 deploy workflow는 후속 단계다.

## 아직 학습하고 선택해야 하는 사항

IRSA와 Pod Identity 중 무엇을 사용할지는 실제 cluster 기준으로 결정해야 한다. 다음 내용을 비교한 뒤 기록한다.

- 기존 cluster에 IAM OIDC provider가 이미 있고 누가 lifecycle을 소유하는지
- EKS Pod Identity Agent가 설치돼 있는지, shared add-on을 누가 upgrade·복구하는지
- 현재 배포 도구가 ServiceAccount annotation과 Pod Identity association 중 무엇을 안정적으로 전달하는지
- 팀의 감사·운영 방식에서 role trust와 association을 어디서 확인하기 쉬운지

Secret 저장 방식도 아직 선택하지 않았다. Kubernetes Secret을 배포 workflow가 직접 생성할지, Secrets Manager와 External Secrets 계열을 사용할지 학습해야 한다. 어느 방식을 선택해도 실제 DB password, token, TLS key와 장기 AWS access key는 Git, Terraform variable, Terraform output 또는 PR 본문에 넣지 않는다.

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

mock test는 identity 기본 비활성화, create-mode의 정적 IAM resource key, 실제 policy/trust 내용, IRSA role/annotation 4개, Pod Identity Agent 미확인 차단과 기존 data-plane 안전장치를 확인한다. RDS Docker 검증은 bootstrap을 두 번 실행하고 role의 관리 권한 부재와 세 database의 상호 CONNECT 격리를 확인한다. 실제 Phase 4 완료는 선택된 identity 방식으로 EKS Pod의 AWS caller identity와 MSK/S3 최소 권한 smoke가 성공하고, 승인된 RDS에서 bootstrap과 세 workload별 DB 연결이 확인돼야 선언할 수 있다.
