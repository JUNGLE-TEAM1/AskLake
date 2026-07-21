variable "benchmark_observability_reader_enabled" {
  description = "Create the dedicated read-only IAM/EKS identity and S3 request metrics used by the bounded 100 GB benchmark."
  type        = bool
  default     = false
}

variable "benchmark_observability_owner" {
  description = "Lifecycle and cost owner for the bounded benchmark observer resources."
  type        = string
  default     = null
  nullable    = true
}

variable "benchmark_observability_reader_trusted_principal_arns" {
  description = "Existing IAM principals allowed to assume the dedicated benchmark observer role."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.benchmark_observability_reader_trusted_principal_arns :
      can(regex("^arn:aws:iam::[0-9]{12}:(role|user)/.+$", arn))
    ])
    error_message = "benchmark_observability_reader_trusted_principal_arns accepts IAM role/user ARNs only."
  }
}

variable "benchmark_observability_reader_assumer_iam_user_names" {
  description = "Existing IAM users that receive assume-only access to the dedicated benchmark observer role."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for name in var.benchmark_observability_reader_assumer_iam_user_names :
      can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", name))
    ])
    error_message = "benchmark_observability_reader_assumer_iam_user_names must contain valid existing IAM user names."
  }
}

variable "benchmark_s3_request_metrics_prefixes" {
  description = "Exact 100 GB benchmark input and output prefixes used by S3 one-minute request metrics."
  type = object({
    raw    = string
    output = string
  })
  default = {
    raw    = ""
    output = ""
  }
}

locals {
  benchmark_observability_reader_group = "asklake:observability-readers"
  benchmark_observability_prefixes = var.benchmark_observability_reader_enabled ? {
    raw    = trim(var.benchmark_s3_request_metrics_prefixes.raw, "/")
    output = trim(var.benchmark_s3_request_metrics_prefixes.output, "/")
  } : {}
  benchmark_observability_inputs_complete = (
    trimspace(coalesce(var.benchmark_observability_owner, "")) != "" &&
    length(var.benchmark_observability_reader_trusted_principal_arns) > 0 &&
    length(var.benchmark_observability_reader_assumer_iam_user_names) > 0 &&
    trim(var.benchmark_s3_request_metrics_prefixes.raw, "/ ") != "" &&
    trim(var.benchmark_s3_request_metrics_prefixes.output, "/ ") != ""
  )
  benchmark_observability_prefixes_in_boundary = !var.benchmark_observability_reader_enabled || (
    (
      var.storage_prefixes.raw == "*" ||
      local.benchmark_observability_prefixes.raw == trim(var.storage_prefixes.raw, "/") ||
      startswith(local.benchmark_observability_prefixes.raw, "${trim(var.storage_prefixes.raw, "/")}/")
    ) &&
    (
      var.storage_prefixes.output == "*" ||
      local.benchmark_observability_prefixes.output == trim(var.storage_prefixes.output, "/") ||
      startswith(local.benchmark_observability_prefixes.output, "${trim(var.storage_prefixes.output, "/")}/")
    )
  )
}

check "benchmark_observability_contract" {
  assert {
    condition = var.benchmark_observability_reader_enabled ? (
      local.observability_enabled &&
      local.use_storage &&
      var.resource_lifecycle == "mvp-owned" &&
      local.benchmark_observability_inputs_complete
      ) : (
      var.benchmark_observability_owner == null &&
      length(var.benchmark_observability_reader_trusted_principal_arns) == 0 &&
      length(var.benchmark_observability_reader_assumer_iam_user_names) == 0 &&
      var.benchmark_s3_request_metrics_prefixes.raw == "" &&
      var.benchmark_s3_request_metrics_prefixes.output == ""
    )
    error_message = "Benchmark observability requires the existing managed observability stack, storage, MVP ownership, an owner, reviewed reader identities, and exact S3 prefixes; disabled mode must leave all inputs empty."
  }
}

check "benchmark_observability_s3_prefix_boundary" {
  assert {
    condition     = local.benchmark_observability_prefixes_in_boundary
    error_message = "Benchmark S3 request metric prefixes must stay at or below the configured Raw and Output workload prefixes."
  }
}

resource "aws_s3_bucket_metric" "benchmark_100gb" {
  for_each = local.benchmark_observability_prefixes

  bucket = var.storage_bucket_names[each.key]
  name   = "${var.name_prefix}-${var.environment}-${each.key}-100gb"

  filter {
    prefix = each.value
  }
}

resource "aws_iam_role" "benchmark_observability_reader" {
  count = var.benchmark_observability_reader_enabled ? 1 : 0

  name = "${var.name_prefix}-${var.environment}-benchmark-observer"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TrustReviewedBenchmarkObservers"
      Effect    = "Allow"
      Action    = ["sts:AssumeRole"]
      Principal = { AWS = sort(tolist(var.benchmark_observability_reader_trusted_principal_arns)) }
    }]
  })

  tags = {
    Name        = "${var.name_prefix}-${var.environment}-benchmark-observer"
    Owner       = var.benchmark_observability_owner
    Environment = var.environment
    Lifecycle   = "mvp-owned"
  }
}

resource "aws_iam_policy" "benchmark_observability_reader" {
  count = var.benchmark_observability_reader_enabled ? 1 : 0

  name = "${var.name_prefix}-${var.environment}-benchmark-observer"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadCloudWatchMetrics"
        Effect = "Allow"
        Action = [
          "cloudwatch:GetMetricData",
          "cloudwatch:GetMetricStatistics",
          "cloudwatch:ListMetrics",
        ]
        Resource = ["*"]
      },
      {
        Sid    = "ReadEksAndNodeInventory"
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "eks:DescribeAddon",
          "eks:DescribeCluster",
          "eks:ListAddons",
          "eks:ListClusters",
        ]
        Resource = ["*"]
      },
      {
        Sid    = "ReadBenchmarkMetricConfigurations"
        Effect = "Allow"
        Action = [
          "s3:GetMetricsConfiguration",
          "s3:ListBucketMetricsConfigurations",
        ]
        Resource = [
          local.storage_bucket_arns.raw,
          local.storage_bucket_arns.output,
        ]
      },
    ]
  })

  tags = {
    Name        = "${var.name_prefix}-${var.environment}-benchmark-observer"
    Owner       = var.benchmark_observability_owner
    Environment = var.environment
    Lifecycle   = "mvp-owned"
  }
}

resource "aws_iam_role_policy_attachment" "benchmark_observability_reader" {
  count = var.benchmark_observability_reader_enabled ? 1 : 0

  role       = aws_iam_role.benchmark_observability_reader[0].name
  policy_arn = aws_iam_policy.benchmark_observability_reader[0].arn
}

resource "aws_iam_policy" "benchmark_observability_reader_assume" {
  count = var.benchmark_observability_reader_enabled ? 1 : 0

  name = "${var.name_prefix}-${var.environment}-benchmark-observer-assume"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AssumeDedicatedBenchmarkObserver"
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = [aws_iam_role.benchmark_observability_reader[0].arn]
    }]
  })

  tags = {
    Name        = "${var.name_prefix}-${var.environment}-benchmark-observer-assume"
    Owner       = var.benchmark_observability_owner
    Environment = var.environment
    Lifecycle   = "mvp-owned"
  }
}

resource "aws_iam_user_policy_attachment" "benchmark_observability_reader_assume" {
  for_each = var.benchmark_observability_reader_enabled ? var.benchmark_observability_reader_assumer_iam_user_names : toset([])

  user       = each.value
  policy_arn = aws_iam_policy.benchmark_observability_reader_assume[0].arn
}

resource "aws_eks_access_entry" "benchmark_observability_reader" {
  count = var.benchmark_observability_reader_enabled ? 1 : 0

  cluster_name      = local.cluster_name
  principal_arn     = aws_iam_role.benchmark_observability_reader[0].arn
  kubernetes_groups = [local.benchmark_observability_reader_group]
  type              = "STANDARD"

  depends_on = [aws_eks_cluster.this]
}

output "benchmark_observability_handoff" {
  description = "Non-secret readiness and lifecycle handoff for the bounded 100 GB benchmark observer."
  value = {
    enabled           = var.benchmark_observability_reader_enabled
    owner             = var.benchmark_observability_owner
    kubernetes_group  = local.benchmark_observability_reader_group
    rbac_helm_value   = "observabilityRbac.enabled=true"
    s3_metric_filters = sort(keys(local.benchmark_observability_prefixes))
    ready_for_apply = (
      var.benchmark_observability_reader_enabled &&
      local.benchmark_observability_inputs_complete &&
      local.benchmark_observability_prefixes_in_boundary
    )
  }
}

output "benchmark_observability_reader_role_arn" {
  description = "Dedicated role used by the bounded 100 GB benchmark observer."
  value       = try(aws_iam_role.benchmark_observability_reader[0].arn, null)
}
