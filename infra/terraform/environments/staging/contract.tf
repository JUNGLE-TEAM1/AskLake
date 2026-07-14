resource "terraform_data" "contract_guard" {
  input = {
    aws_account_id                           = var.aws_account_id
    github_oidc_role_arn                     = var.github_oidc_role_arn
    available_emr_serverless_concurrent_vcpu = var.available_emr_serverless_concurrent_vcpu
    longest_bucket_name                      = "${local.bucket_prefix}-checkpoint"
  }

  lifecycle {
    precondition {
      condition     = startswith(var.github_oidc_role_arn, "arn:aws:iam::${var.aws_account_id}:role/")
      error_message = "github_oidc_role_arn must belong to aws_account_id."
    }

    precondition {
      condition     = length("${local.bucket_prefix}-checkpoint") <= 63
      error_message = "The longest staging bucket name exceeds the S3 63-character limit."
    }

    precondition {
      condition     = var.available_emr_serverless_concurrent_vcpu >= 16
      error_message = "The observed EMR Serverless quota is below the Phase 1 application cap."
    }

    precondition {
      condition     = length(toset(var.availability_zones)) == 3
      error_message = "The staging private subnets must use three distinct availability zones."
    }
  }
}
