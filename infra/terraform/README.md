# AskLake AWS staging Terraform

Issue #727의 임시 AWS staging을 소유한다. 일반 애플리케이션 배포와 분리하며 `ap-northeast-2`의 실행별 stack만 생성한다.

## 구성

- `bootstrap/`: versioning/KMS/S3 lockfile을 사용하는 별도 Terraform state stack
- `modules/network`: 3개 private subnet, no-NAT, no-public-ingress, S3/SSM/Logs/EMR Serverless endpoint
- `modules/storage`: artifact/output/checkpoint/report S3와 staging data KMS key
- `modules/msk`: IAM/TLS 전용 MSK Serverless
- `modules/emr`: 16 vCPU 상한의 Batch/Continuous EMR Serverless application
- `modules/iam`: EMR runtime과 private SSM smoke runner 최소 권한
- `modules/observability`: 7일 보존 CloudWatch log group
- `modules/cost-control`: `StackId` 기준 30 USD Budget 알림
- `modules/smoke-runner`: 승인된 AMI를 사용할 때만 생성하는 private EC2/SSM runner
- `environments/staging`: Phase 0 계약을 조합하는 root module

## AWS credential 없는 검증

Terraform mock provider는 실제 API를 호출하거나 resource를 만들지 않는다.

```bash
cd backend
npm run verify:aws-staging-terraform
```

## 실제 plan 준비

실제 값은 커밋하지 않고 별도 파일 또는 workflow input으로 전달한다.

```bash
terraform -chdir=infra/terraform/environments/staging init \
  -backend-config=/secure/path/backend.hcl

terraform -chdir=infra/terraform/environments/staging plan \
  -var-file=/secure/path/staging.tfvars \
  -out=/secure/path/staging.tfplan
```

Phase 1은 실제 `apply`를 실행하지 않는다. apply/destroy 승인과 output 전달은 Phase 2~3에서 연결한다.

`StackId` 기반 Budget filter가 비용을 분리하려면 platform 운영자가 AWS Billing의 user-defined cost allocation tag에서 `StackId`를 미리 활성화해야 한다. AWS Budget 알림은 실시간 종료 장치가 아니며 destroy/TTL guard를 대체하지 않는다.
