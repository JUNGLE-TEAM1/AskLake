# AskLake AWS staging Terraform

Issue #727의 임시 AWS staging을 소유한다. 일반 애플리케이션 배포와 분리하며 `ap-northeast-2`의 실행별 stack만 생성한다.

## 구성

- `bootstrap/`: versioning/KMS/S3 lockfile을 사용하는 별도 Terraform state stack
- `modules/network`: 3개 private subnet, no-NAT, no-public-ingress, S3/SSM/Logs/CloudWatch Metrics/EMR Serverless endpoint
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
npm run verify:aws-staging-runtime
npm run verify:aws-staging-workflows
npm run verify:aws-staging-smoke
npm run verify:aws-staging-lifecycle
npm run verify:aws-staging-handoff
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

Phase 1은 실제 `apply`를 실행하지 않는다. Phase 2 output 변환기는 apply 결과를 다음처럼 stack별 private env와 redacted manifest로 연결한다.

```bash
terraform -chdir=infra/terraform/environments/staging output -json \
  | npm --prefix backend run aws-staging:render-runtime -- \
      --output-dir deploy/generated/aws-staging
```

Terraform sensitive JSON을 `tee`하거나 console에 출력하지 않는다. 생성 파일은 mode `0600`이며 `deploy/generated/` 전체가 Git ignore 대상이다. manifest에는 broker 원문이 없다. Continuous flag는 Phase 3 artifact workflow가 checksum 고정 JAR bundle을 conditional write로 올리고 S3 SHA-256/size/metadata와 manifest를 검증한 뒤에만 true가 된다.

실제 실행은 `.github/workflows/aws-staging-plan-apply.yml`, `aws-staging-artifacts.yml`, `aws-staging-smoke.yml`, `aws-staging-destroy.yml`의 수동 dispatch와 매시 audit인 `aws-staging-ttl-sweep.yml`을 사용한다. apply/artifact/smoke/destroy는 별도 보호 Environment와 `apply|artifacts|smoke|destroy:<stackId>` 확인을 요구하며 OIDC 단기 credential을 사용한다. smoke는 checksum runner bundle을 private SSM instance에서 실행하고 success/failure evidence export 뒤 teardown receipt를 남긴다. TTL sweep은 자동 삭제하지 않고 만료/비정상 state를 실패 신호와 artifact로 남겨 기존 destroy 승인으로 연결한다. `.github/workflows/aws-staging-contract-checks.yml`은 PR에서 credential/id-token 없이 로컬 계약과 mock plan만 검증한다. 현재 단계에서는 AWS plan/apply/smoke를 실행하지 않았고 resource나 비용이 발생하지 않았다.

`StackId` 기반 Budget filter가 비용을 분리하려면 platform 운영자가 AWS Billing의 user-defined cost allocation tag에서 `StackId`를 미리 활성화해야 한다. AWS Budget 알림은 실시간 종료 장치가 아니며 destroy/TTL guard를 대체하지 않는다.
