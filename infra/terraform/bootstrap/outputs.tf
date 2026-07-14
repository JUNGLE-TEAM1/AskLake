output "state_bucket_name" {
  description = "S3 bucket used by the staging backend."
  value       = aws_s3_bucket.terraform_state.id
}

output "state_kms_key_arn" {
  description = "KMS key used by the staging backend."
  value       = aws_kms_key.terraform_state.arn
}

output "staging_state_key_template" {
  description = "Per-stack state key template."
  value       = "${var.state_key_prefix}/staging/$${stackId}/terraform.tfstate"
}
