variable "realtime_kafka_connect_identity_enabled" {
  description = "Create the opt-in EKS Pod Identity used only by Kafka Connect V2."
  type        = bool
  default     = false
}

variable "realtime_kafka_connect_service_account_name" {
  description = "Stable Kafka Connect V2 ServiceAccount. The legacy EKS identity is preserved during the canonical chart migration."
  type        = string
  default     = "asklake-realtime-v2-connect"

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", var.realtime_kafka_connect_service_account_name))
    error_message = "realtime_kafka_connect_service_account_name must be DNS-compatible."
  }
}

variable "realtime_msk_topic_arns" {
  description = "Exact data, DLQ, config, offset and status topic ARNs used by Kafka Connect V2. Wildcards are forbidden."
  type        = list(string)
  default     = []

  validation {
    condition = (
      length(var.realtime_msk_topic_arns) <= 32 &&
      length(var.realtime_msk_topic_arns) == length(toset(var.realtime_msk_topic_arns)) &&
      alltrue([
        for arn in var.realtime_msk_topic_arns :
        can(regex("^arn:[^:]+:kafka:[^:]+:[0-9]{12}:topic/[^/]+/[^/]+/[^/*]+$", arn))
      ])
    )
    error_message = "realtime_msk_topic_arns must contain at most 32 unique exact MSK topic ARNs without wildcards."
  }
}

variable "realtime_msk_group_arns" {
  description = "Exact Kafka Connect worker and connector consumer-group ARNs. Wildcards are forbidden."
  type        = list(string)
  default     = []

  validation {
    condition = (
      length(var.realtime_msk_group_arns) <= 32 &&
      length(var.realtime_msk_group_arns) == length(toset(var.realtime_msk_group_arns)) &&
      alltrue([
        for arn in var.realtime_msk_group_arns :
        can(regex("^arn:[^:]+:kafka:[^:]+:[0-9]{12}:group/[^/]+/[^/]+/[^/*]+$", arn))
      ])
    )
    error_message = "realtime_msk_group_arns must contain at most 32 unique exact MSK group ARNs without wildcards."
  }
}

locals {
  realtime_kafka_connect_identity_ready = (
    var.realtime_kafka_connect_identity_enabled &&
    local.identity_resources_ready &&
    local.use_pod_identity
  )

  realtime_kafka_connect_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ConnectToMskServerless"
        Effect = "Allow"
        Action = [
          "kafka-cluster:Connect",
          "kafka-cluster:WriteDataIdempotently",
        ]
        Resource = [local.msk_cluster_arn]
      },
      {
        Sid    = "UseExactRealtimeTopics"
        Effect = "Allow"
        Action = [
          "kafka-cluster:CreateTopic",
          "kafka-cluster:DescribeTopic",
          "kafka-cluster:ReadData",
          "kafka-cluster:WriteData",
        ]
        Resource = var.realtime_msk_topic_arns
      },
      {
        Sid    = "UseExactRealtimeGroups"
        Effect = "Allow"
        Action = [
          "kafka-cluster:DescribeGroup",
          "kafka-cluster:AlterGroup",
        ]
        Resource = var.realtime_msk_group_arns
      },
    ]
  }
}

check "realtime_kafka_connect_identity_contract" {
  assert {
    condition = !var.realtime_kafka_connect_identity_enabled || (
      var.workload_identity_mode == "pod_identity" &&
      local.identity_resources_ready &&
      length(var.realtime_msk_topic_arns) > 0 &&
      length(var.realtime_msk_group_arns) > 0
    )
    error_message = "Kafka Connect V2 identity requires ready EKS Pod Identity plus non-empty exact topic and group ARN lists."
  }
}

resource "aws_iam_role" "realtime_kafka_connect" {
  count = local.realtime_kafka_connect_identity_ready ? 1 : 0

  name = "${var.name_prefix}-${var.environment}-kafka-connect-v2"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AssumeRoleWithPodIdentity"
      Effect = "Allow"
      Action = ["sts:AssumeRole", "sts:TagSession"]
      Principal = {
        Service = ["pods.eks.amazonaws.com"]
      }
    }]
  })
}

resource "aws_iam_policy" "realtime_kafka_connect" {
  count = local.realtime_kafka_connect_identity_ready ? 1 : 0

  name   = "${var.name_prefix}-${var.environment}-kafka-connect-v2"
  policy = jsonencode(local.realtime_kafka_connect_policy)
}

resource "aws_iam_role_policy_attachment" "realtime_kafka_connect" {
  count = local.realtime_kafka_connect_identity_ready ? 1 : 0

  role       = aws_iam_role.realtime_kafka_connect[0].name
  policy_arn = aws_iam_policy.realtime_kafka_connect[0].arn
}

resource "aws_eks_pod_identity_association" "realtime_kafka_connect" {
  count = local.realtime_kafka_connect_identity_ready ? 1 : 0

  cluster_name    = local.cluster_name
  namespace       = var.namespace
  service_account = var.realtime_kafka_connect_service_account_name
  role_arn        = aws_iam_role.realtime_kafka_connect[0].arn
}

output "realtime_kafka_connect_identity_contract" {
  description = "Opt-in Kafka Connect V2 Pod Identity association; empty while disabled."
  value = local.realtime_kafka_connect_identity_ready ? {
    service_account = var.realtime_kafka_connect_service_account_name
    role_arn        = aws_iam_role.realtime_kafka_connect[0].arn
    topic_arns      = var.realtime_msk_topic_arns
    group_arns      = var.realtime_msk_group_arns
  } : null
}
