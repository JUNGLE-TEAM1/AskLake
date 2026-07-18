locals {
  observability_enabled = var.observability_mode == "eks_addon"
  observability_configuration = {
    applicationSignals = {
      enabled = false
    }
    containerInsights = {
      enabled = false
    }
    otelContainerInsights = {
      enabled          = true
      metricResolution = "30s"
      logs = {
        enabled = false
      }
    }
    containerLogs = {
      enabled = true
      fluentBit = {
        tolerations = [{
          key      = "asklake.io/workload-class"
          operator = "Equal"
          value    = "spark"
          effect   = "NoSchedule"
        }]
        config = {
          extraFiles = {
            "application-log.conf" = <<-EOT
              [INPUT]
                Name                tail
                Tag                 application.*
                Path                /var/log/containers/*_${var.namespace}_*.log
                multiline.parser    docker, cri
                DB                  /var/fluent-bit/state/flb_asklake_application.db
                Mem_Buf_Limit       25MB
                Skip_Long_Lines     On
                Refresh_Interval    10
                Rotate_Wait         30
                storage.type        filesystem
                Read_from_Head      $${READ_FROM_HEAD}

              [FILTER]
                Name                aws
                Match               application.*
                az                  false
                ec2_instance_id     false
                Enable_Entity       true

              [FILTER]
                Name                kubernetes
                Match               application.*
                Kube_URL            https://kubernetes.default.svc:443
                Kube_Tag_Prefix     application.var.log.containers.
                Merge_Log           On
                Merge_Log_Key       log_processed
                K8S-Logging.Parser  On
                K8S-Logging.Exclude Off
                Labels              Off
                Annotations         Off
                Use_Kubelet         On
                Kubelet_Port        10250
                Buffer_Size         0
                Use_Pod_Association Off

              [OUTPUT]
                Name                cloudwatch_logs
                Match               application.*
                region              $${AWS_REGION}
                log_group_name      ${local.observability_application_log_group}
                log_stream_prefix   $${HOST_NAME}-
                auto_create_group   false
                extra_user_agent    asklake-container-logs
                add_entity          true
            EOT
            "dataplane-log.conf"   = ""
            "host-log.conf"        = ""
          }
        }
      }
    }
    agents = [
      {
        name = "cloudwatch-agent"
        env = [{
          name  = "CWAGENT_ROLE"
          value = "NODE"
        }]
        tolerations = [{
          key      = "asklake.io/workload-class"
          operator = "Equal"
          value    = "spark"
          effect   = "NoSchedule"
        }]
      },
      {
        name = "cloudwatch-agent-cluster-scraper"
        mode = "deployment"
        env = [{
          name  = "CWAGENT_ROLE"
          value = "LEADER"
        }]
      },
    ]
    nodeExporter = {
      resources = {
        requests = {
          cpu    = "25m"
          memory = "30Mi"
        }
        limits = {
          cpu    = "200m"
          memory = "100Mi"
        }
      }
    }
  }
  observability_application_log_group   = "/aws/otel/containerinsights/${local.cluster_name}/application"
  observability_control_plane_log_group = "/aws/eks/${local.cluster_name}/cluster"
  observability_rds_log_group = local.create_rds ? (
    "/aws/rds/instance/${aws_db_instance.metadata[0].identifier}/postgresql"
  ) : null
  observability_managed_log_groups = local.observability_enabled ? merge(
    {
      application   = aws_cloudwatch_log_group.observability_application[0].name
      control_plane = aws_cloudwatch_log_group.observability_control_plane[0].name
    },
    local.create_rds ? {
      rds_postgresql = aws_cloudwatch_log_group.observability_rds[0].name
    } : {},
  ) : {}
}

check "observability_contract" {
  assert {
    condition = !local.observability_enabled || (
      var.resource_lifecycle == "mvp-owned" &&
      var.pod_identity_agent_ready &&
      try(trimspace(var.observability_addon_version), "") != "" &&
      try(trimspace(var.observability_owner), "") != ""
    )
    error_message = "CloudWatch Observability requires MVP ownership, a ready Pod Identity Agent, an exact add-on version and lifecycle owner."
  }
}

check "observability_rds_log_contract" {
  assert {
    condition = !local.observability_enabled || !local.create_rds || contains(
      var.rds_enabled_cloudwatch_logs_exports,
      "postgresql",
    )
    error_message = "managed RDS log retention requires the postgresql CloudWatch log export."
  }
}

resource "aws_cloudwatch_log_group" "observability_application" {
  count = local.observability_enabled ? 1 : 0

  name              = local.observability_application_log_group
  retention_in_days = var.observability_application_retention_days
  skip_destroy      = true

  tags = {
    Name      = "${var.name_prefix}-${var.environment}-eks-application"
    Owner     = var.observability_owner
    Lifecycle = "shared-preserved"
  }
}

resource "aws_cloudwatch_log_group" "observability_control_plane" {
  count = local.observability_enabled ? 1 : 0

  name              = local.observability_control_plane_log_group
  retention_in_days = var.observability_control_plane_retention_days
  skip_destroy      = true

  tags = {
    Name      = "${var.name_prefix}-${var.environment}-eks-control-plane"
    Owner     = var.observability_owner
    Lifecycle = "shared-preserved"
  }
}

resource "aws_cloudwatch_log_group" "observability_rds" {
  count = local.observability_enabled && local.create_rds ? 1 : 0

  name              = local.observability_rds_log_group
  retention_in_days = var.observability_rds_retention_days
  skip_destroy      = true

  tags = {
    Name      = "${var.name_prefix}-${var.environment}-rds-postgresql"
    Owner     = var.observability_owner
    Lifecycle = "shared-preserved"
  }
}

resource "aws_cloudwatch_metric_alarm" "observability_daily_log_ingest" {
  count = local.observability_enabled ? 1 : 0

  alarm_name          = "${var.name_prefix}-${var.environment}-daily-log-ingest-warning"
  alarm_description   = "Day 18 warning when managed EKS/RDS logs exceed the reviewed daily ingest boundary."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = var.observability_daily_log_ingest_warning_gib * 1024 * 1024 * 1024
  treat_missing_data  = "notBreaching"
  actions_enabled     = false

  dynamic "metric_query" {
    for_each = local.observability_managed_log_groups

    content {
      id          = "m_${metric_query.key}"
      return_data = false

      metric {
        metric_name = "IncomingBytes"
        namespace   = "AWS/Logs"
        period      = 86400
        stat        = "Sum"
        dimensions = {
          LogGroupName = metric_query.value
        }
      }
    }
  }

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "Managed log ingest bytes per day"
    return_data = true
  }

  tags = {
    Name      = "${var.name_prefix}-${var.environment}-daily-log-ingest-warning"
    Owner     = var.observability_owner
    Lifecycle = "mvp-owned"
  }
}

resource "aws_cloudwatch_metric_alarm" "observability_stored_logs" {
  count = local.observability_enabled ? 1 : 0

  alarm_name          = "${var.name_prefix}-${var.environment}-stored-log-warning"
  alarm_description   = "Day 18 warning when managed EKS/RDS stored logs exceed the reviewed storage boundary."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = var.observability_stored_log_warning_gib * 1024 * 1024 * 1024
  treat_missing_data  = "notBreaching"
  actions_enabled     = false

  dynamic "metric_query" {
    for_each = local.observability_managed_log_groups

    content {
      id          = "m_${metric_query.key}"
      return_data = false

      metric {
        metric_name = "StoredBytes"
        namespace   = "AWS/Logs"
        period      = 86400
        stat        = "Maximum"
        dimensions = {
          LogGroupName = metric_query.value
        }
      }
    }
  }

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "Managed stored log bytes"
    return_data = true
  }

  tags = {
    Name      = "${var.name_prefix}-${var.environment}-stored-log-warning"
    Owner     = var.observability_owner
    Lifecycle = "mvp-owned"
  }
}

resource "aws_iam_role" "cloudwatch_observability" {
  count = local.observability_enabled ? 1 : 0

  name = "${var.name_prefix}-${var.environment}-cloudwatch-observability"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AssumeRoleWithPodIdentity"
      Effect = "Allow"
      Action = [
        "sts:AssumeRole",
        "sts:TagSession",
      ]
      Principal = {
        Service = ["pods.eks.amazonaws.com"]
      }
    }]
  })
}

resource "aws_iam_policy" "cloudwatch_observability" {
  count = local.observability_enabled ? 1 : 0

  name = "${var.name_prefix}-${var.environment}-cloudwatch-observability"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DescribeLogDelivery"
        Effect   = "Allow"
        Action   = ["logs:DescribeLogGroups", "logs:DescribeLogStreams"]
        Resource = "*"
      },
      {
        Sid    = "WriteExactContainerInsightsLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = [
          "${aws_cloudwatch_log_group.observability_application[0].arn}",
          "${aws_cloudwatch_log_group.observability_application[0].arn}:*",
        ]
      },
      {
        Sid      = "PublishContainerInsightsMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "cloudwatch_observability" {
  count = local.observability_enabled ? 1 : 0

  role       = aws_iam_role.cloudwatch_observability[0].name
  policy_arn = aws_iam_policy.cloudwatch_observability[0].arn
}

resource "aws_eks_addon" "cloudwatch_observability" {
  count = local.observability_enabled ? 1 : 0

  cluster_name                = local.cluster_name
  addon_name                  = "amazon-cloudwatch-observability"
  addon_version               = var.observability_addon_version
  configuration_values        = jsonencode(local.observability_configuration)
  resolve_conflicts_on_create = "NONE"
  resolve_conflicts_on_update = "PRESERVE"
  preserve                    = false

  pod_identity_association {
    service_account = "cloudwatch-agent"
    role_arn        = aws_iam_role.cloudwatch_observability[0].arn
  }

  tags = {
    Name      = "${var.name_prefix}-${var.environment}-cloudwatch-observability"
    Owner     = var.observability_owner
    Lifecycle = "mvp-owned"
  }

  depends_on = [
    aws_iam_role_policy_attachment.cloudwatch_observability,
    aws_cloudwatch_log_group.observability_application,
  ]
}
