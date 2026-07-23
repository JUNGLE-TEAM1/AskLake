provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(
      {
        Project     = "AskLake"
        Environment = var.environment
        ManagedBy   = "Terraform"
        Owner       = var.owner
        Lifecycle   = var.resource_lifecycle
      },
      var.additional_tags,
    )
  }
}
