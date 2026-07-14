locals {
  environment         = "staging"
  name_prefix         = "asklake-staging-${var.stack_id}"
  bucket_region_alias = "apne2"
  bucket_prefix       = "asklake-stg-${var.aws_account_id}-${local.bucket_region_alias}-${var.stack_id}"
  topic_namespace     = "asklake.staging.${var.stack_id}"

  vpc_cidr = "10.77.0.0/16"
  private_subnet_cidrs = [
    "10.77.0.0/20",
    "10.77.16.0/20",
    "10.77.32.0/20",
  ]

  required_tags = {
    Project     = "AskLake"
    Environment = local.environment
    ManagedBy   = "terraform"
    Issue       = "727"
    StackId     = var.stack_id
    ExpiresAt   = var.expires_at
  }
}
