# EKS MVP Phase 3 Data Plane 계약

이 문서는 Pair A가 MSK Serverless와 PostgreSQL RDS를 `disabled`, `existing`, `create`, S3를 `disabled`, `existing`, `managed-existing`, `create` 모드로 표현하고 실제 환경 결정 전에도 정적으로 검증할 수 있게 만든 Terraform 계약이다.

## 현재 결과

`infra/eks/terraform`은 다음 경계를 제공한다.

- MSK는 Serverless와 IAM 인증만 허용한다. EKS 안에 Kafka 또는 Redpanda broker를 만들지 않는다.
- MSK test topic과 consumer group 이름을 EKS MVP 전용 값으로 고정해 기존 EC2 Continuous consumer와 격리한다.
- RDS create 모드는 private PostgreSQL 단일 인스턴스를 만들 수 있는 입력을 제공한다. 암호화, RDS 관리 master secret, backup, deletion protection과 final snapshot을 기본 안전 경계로 둔다.
- S3는 Raw, Output, Warehouse, Query Result bucket을 분리하고 public access 차단, versioning과 server-side encryption을 적용한다. `managed-existing`은 기존 bucket을 import해 관리하면서 bucket 삭제를 Terraform lifecycle로 차단한다.
- workload별 MSK/S3 최소 권한은 IAM policy document로 생성한다. `kafka-cluster:*`, `s3:*`와 전체 resource wildcard는 사용하지 않는다.
- 실제 endpoint, ARN, bucket name과 secret reference를 포함할 수 있는 output은 sensitive로 표시한다.

모든 data-plane 모드의 기본값은 `disabled`다. `create`는 `resource_lifecycle=mvp-owned`일 때만 허용된다. 이 코드를 merge하거나 `terraform test`를 실행해도 AWS resource는 생성되지 않는다.

## 아직 선택해야 하는 사항

다음 항목은 코드가 대신 결정하지 않는다. 학습과 실제 환경 확인 뒤 팀이 선택하고 배포 입력으로 제공해야 한다.

- 기존 VPC를 쓸지 MVP VPC를 만들지, 어떤 private subnet과 security group을 사용할지
- EKS IRSA와 Pod Identity 중 어느 방식으로 generated IAM policy를 service account에 연결할지
- RDS instance class, PostgreSQL engine version, Multi-AZ 여부와 비용 한도
- S3 SSE-S3(`AES256`)와 SSE-KMS 중 어느 방식을 쓸지. SSE-KMS라면 key owner, rotation, 비용과 workload별 KMS action을 추가로 확정해야 한다.
- 기존 bucket/RDS/MSK를 참조할지 MVP-owned resource를 만들지와 각 resource의 destroy owner
- 실제 ingress, DNS, certificate와 NAT/VPC endpoint 구성

Phase 2 inventory가 `AccessDenied`인 현재 상태에서는 위 선택을 완료한 것으로 보지 않는다. 따라서 실제 `terraform plan`의 검토 입력도 아직 확정되지 않았고 `terraform apply`는 금지한다.

## Terraform 밖의 bootstrap 책임

MSK Serverless cluster 생성은 Kafka topic을 만들지 않는다. `asklake.eks-mvp.fixture.v1` topic의 partition 수, retention과 topic 생성 주체는 실제 부하 목표를 학습하고 정한 뒤 별도 운영 bootstrap 또는 승인된 admin client가 적용한다. 외부 fixture producer는 해당 test topic의 produce 권한만 받고 EKS workload로 배포하지 않는다.

RDS resource는 최초 database `asklake_app`만 만든다. `airflow_metadata`, `iceberg_catalog`, 각 database user와 grant는 credential을 Terraform state에 넣지 않는 별도 멱등 DB bootstrap/migration으로 생성한다. 그 bootstrap owner와 실행 위치가 정해지기 전에는 FastAPI, Airflow 또는 Trino의 실제 RDS 연결 smoke를 완료로 판정하지 않는다.

IAM policy document는 권한 요구의 결과물이지 아직 role attachment가 아니다. IRSA 또는 Pod Identity가 선택되고 service account trust가 검토된 뒤에만 role과 연결한다. KMS를 선택하면 현재 S3 action 외에 필요한 최소 KMS action도 별도 검토한다.

## 모드 사용 기준

`disabled`는 resource와 연결 정보를 모두 만들지 않는다. 현재 기본값이며 정적 개발 단계에 사용한다.

`existing`은 AWS resource를 Terraform state의 생성·삭제 대상으로 가져오지 않고 배포 환경이 제공한 reference만 검증하고 출력한다. MSK는 cluster ARN과 IAM bootstrap broker, RDS는 endpoint와 managed secret ARN, S3는 네 bucket 이름이 필요하다.

`managed-existing`은 S3 전용이다. 배포 환경의 기존 네 bucket을 `aws_s3_bucket.data`와 public-access-block, encryption, versioning resource에 각각 import한 뒤 이 state가 설정을 관리한다. bucket 자체는 `prevent_destroy=true`, `force_destroy=false`, `Lifecycle=shared-preserved`로 보호한다. import 직후 plan에서 bucket create, replace 또는 delete가 있으면 apply하지 않는다.

`create`는 이 state가 MVP 전용 resource를 소유할 때만 사용한다. MSK와 RDS에는 승인된 private subnet과 security group이 필요하고, RDS instance class는 반드시 명시해야 한다. S3 bucket 이름은 전역 중복이 없도록 배포 환경에서 제공한다.

## 2026-07-15 기존 S3 관리 전환 결과

서울 리전 dev 계정의 기존 Raw, Output, Warehouse, Query Result bucket 네 개를 삭제나 재생성 없이 현재 EKS Terraform state로 가져왔다. 실제 이름은 저장소에 기록하지 않고 로컬 배포 입력으로만 전달했다.

- import 전 plan: S3 import 대상 16개 create, 기존 EKS/MSK/VPC 39개 no-op
- import 대상: bucket, Public Access Block, server-side encryption, versioning을 bucket별 네 주소로 관리
- import 후 plan: create/replace/delete 0개, lifecycle tag와 versioning update 8개
- apply 결과: 0 added, 8 changed, 0 destroyed
- 최종 plan: `No changes`
- 실제 검증: 네 bucket 모두 versioning `Enabled`, Public Access Block 네 항목 `true`, `Lifecycle=shared-preserved`
- 객체 검증: 네 bucket에서 기존 객체 목록과 표본 key가 유지됨을 확인했으며 Terraform은 객체를 이동하거나 삭제하지 않았다.

bucket resource에는 `prevent_destroy=true`와 `force_destroy=false`가 함께 적용된다. 따라서 이 configuration에서 bucket 삭제 plan은 실패해야 한다. 단, 현재 Terraform state는 로컬 ignored file이므로 다른 작업자나 CI가 같은 인프라를 관리하려면 remote state/backend 전환을 별도 수행해야 한다. 이 제한을 해소하기 전에는 다른 state에서 동일 bucket을 다시 import하거나 apply하지 않는다.

기존 Dataset inventory에서 Raw와 Output bucket은 여러 최상위 prefix를 사용하고 있음을 확인했다. 따라서 이 두 전용 bucket은 bucket ARN 자체를 IAM 경계로 삼고 object ARN은 해당 bucket 아래 전체 key로 허용한다. 이는 계정 전체 S3 wildcard가 아니며 다른 bucket에는 접근하지 못한다. Backend는 기존 Source browse/preview 계약에 맞춰 Raw 읽기 권한을 포함하고, Warehouse와 Query Result는 고정 prefix만 허용한다.

## 검증과 완료 기준

다음 검증은 AWS credential 없이 mock provider로 실행하며 실제 AWS API를 변경하지 않는다.

```bash
bash scripts/verify-eks-foundation.sh

docker run --rm --entrypoint sh \
  -v "$PWD/infra/eks/terraform:/workspace" \
  -w /workspace \
  hashicorp/terraform:1.15.8 \
  -c 'export TF_DATA_DIR=/tmp/tfdata; terraform fmt -check -recursive && terraform init -backend=false -input=false >/dev/null && terraform validate && terraform test'
```

Phase 3 정적 완료 기준은 Serverless IAM 인증, private RDS, 네 개의 보호된 S3 bucket, shared resource 생성 차단과 broad IAM action 부재가 mock test로 확인되는 것이다. 실제 완료는 Phase 2 gate를 닫고 승인된 plan을 리뷰한 뒤, 별도 승인된 apply와 MSK/RDS/S3 smoke evidence가 있어야 한다.
