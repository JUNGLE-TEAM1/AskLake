mock_provider "aws" {}

run "bootstrap_plan" {
  command = plan

  variables {
    region            = "ap-northeast-2"
    state_bucket_name = "asklake-tfstate-123456789012-apne2"
  }

  assert {
    condition     = aws_s3_bucket.terraform_state.bucket == "asklake-tfstate-123456789012-apne2"
    error_message = "The bootstrap bucket name was not preserved."
  }

  assert {
    condition     = aws_s3_bucket_versioning.terraform_state.versioning_configuration[0].status == "Enabled"
    error_message = "Terraform state versioning must remain enabled."
  }

  assert {
    condition     = aws_kms_key.terraform_state.enable_key_rotation
    error_message = "Terraform state KMS rotation must remain enabled."
  }
}

run "rejects_non_seoul_state" {
  command = plan

  variables {
    region            = "us-east-1"
    state_bucket_name = "asklake-tfstate-123456789012-apne2"
  }

  expect_failures = [var.region]
}
