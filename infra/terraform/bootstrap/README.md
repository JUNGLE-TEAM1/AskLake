# Terraform state bootstrap

이 stack은 staging resource stack과 분리된 S3 state bucket/KMS key만 소유한다. 최초 한 번은 backend 없이 실행하고, 생성 직후 bootstrap state를 같은 bucket의 별도 key로 이전한다. bucket과 KMS key에는 `prevent_destroy`가 있어 staging destroy 대상이 아니다.

```bash
terraform init -backend=false
terraform apply -var='state_bucket_name=<globally-unique-name>'

terraform init -migrate-state \
  -backend-config='bucket=<globally-unique-name>' \
  -backend-config='key=asklake/bootstrap/terraform.tfstate' \
  -backend-config='region=ap-northeast-2' \
  -backend-config='encrypt=true' \
  -backend-config='kms_key_id=<state-kms-key-arn>' \
  -backend-config='use_lockfile=true'
```

실제 bucket, KMS ARN, credential을 파일에 저장하거나 커밋하지 않는다. 최초 local state는 migration 완료와 원격 state 확인 후 안전하게 폐기한다.
