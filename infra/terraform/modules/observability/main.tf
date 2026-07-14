terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

locals {
  log_groups = {
    batch      = "/asklake/staging/${var.name_prefix}/emr-batch"
    continuous = "/asklake/staging/${var.name_prefix}/emr-continuous"
    smoke      = "/asklake/staging/${var.name_prefix}/smoke-runner"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  for_each = local.log_groups

  name              = each.value
  retention_in_days = var.log_retention_days
  skip_destroy      = false

  tags = {
    Workload = each.key
  }
}
