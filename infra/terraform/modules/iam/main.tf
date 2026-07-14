terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

locals {
  all_bucket_arns = values(var.bucket_arns)
  all_object_arns = [for arn in local.all_bucket_arns : "${arn}/*"]
  writable_object_arns = [
    "${var.bucket_arns.output}/*",
    "${var.bucket_arns.checkpoint}/*",
    "${var.bucket_arns.report}/*",
    "${var.bucket_arns.artifact}/emr-serverless/runs/*",
    "${var.bucket_arns.artifact}/emr-serverless/continuous/jobs/*",
  ]
  topic_arn       = "${replace(var.msk_cluster_arn, ":cluster/", ":topic/")}/${var.topic_namespace}*"
  group_arn       = "${replace(var.msk_cluster_arn, ":cluster/", ":group/")}/${var.topic_namespace}*"
  log_stream_arns = [for arn in values(var.log_group_arns) : "${arn}:*"]
}

data "aws_iam_policy_document" "emr_assume_role" {
  statement {
    sid     = "AllowEMRServerless"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["emr-serverless.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

  }
}

resource "aws_iam_role" "emr_execution" {
  name                 = "${var.name_prefix}-emr-execution"
  description          = "Least-privilege AskLake staging EMR Serverless runtime role"
  assume_role_policy   = data.aws_iam_policy_document.emr_assume_role.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "emr_execution" {
  statement {
    sid       = "ListStagingBuckets"
    effect    = "Allow"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = local.all_bucket_arns
  }

  statement {
    sid       = "ReadStagingObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = local.all_object_arns
  }

  statement {
    sid    = "WriteRuntimeObjects"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:PutObject",
    ]
    resources = local.writable_object_arns
  }

  statement {
    sid    = "UseDataKey"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [var.data_kms_key_arn]
  }

  statement {
    sid       = "ConnectMSKCluster"
    effect    = "Allow"
    actions   = ["kafka-cluster:Connect", "kafka-cluster:DescribeCluster"]
    resources = [var.msk_cluster_arn]
  }

  statement {
    sid    = "ReadMSKTopics"
    effect = "Allow"
    actions = [
      "kafka-cluster:DescribeTopic",
      "kafka-cluster:ReadData",
    ]
    resources = [local.topic_arn]
  }

  statement {
    sid    = "ManageMSKConsumerGroups"
    effect = "Allow"
    actions = [
      "kafka-cluster:AlterGroup",
      "kafka-cluster:DescribeGroup",
    ]
    resources = [local.group_arn]
  }

  statement {
    sid       = "DescribeRuntimeLogGroups"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:aws:logs:${var.region}:${var.aws_account_id}:*"]
  }

  statement {
    sid    = "PublishRuntimeLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]
    resources = local.log_stream_arns
  }
}

resource "aws_iam_role_policy" "emr_execution" {
  name   = "${var.name_prefix}-emr-runtime"
  role   = aws_iam_role.emr_execution.id
  policy = data.aws_iam_policy_document.emr_execution.json
}

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "smoke_runner" {
  name                 = "${var.name_prefix}-smoke-runner"
  description          = "Private SSM runner for bounded AskLake AWS smoke"
  assume_role_policy   = data.aws_iam_policy_document.ec2_assume_role.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "smoke_runner_ssm" {
  role       = aws_iam_role.smoke_runner.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "smoke_runner" {
  statement {
    sid       = "ListStagingBuckets"
    effect    = "Allow"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = local.all_bucket_arns
  }

  statement {
    sid    = "ManageSmokeObjects"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = local.all_object_arns
  }

  statement {
    sid    = "UseDataKey"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = [var.data_kms_key_arn]
  }

  statement {
    sid       = "ConnectMSKCluster"
    effect    = "Allow"
    actions   = ["kafka-cluster:Connect", "kafka-cluster:DescribeCluster"]
    resources = [var.msk_cluster_arn]
  }

  statement {
    sid    = "ManageSmokeTopics"
    effect = "Allow"
    actions = [
      "kafka-cluster:CreateTopic",
      "kafka-cluster:DescribeTopic",
      "kafka-cluster:DescribeTopicDynamicConfiguration",
      "kafka-cluster:ReadData",
      "kafka-cluster:WriteData",
    ]
    resources = [local.topic_arn]
  }

  statement {
    sid    = "ManageSmokeConsumerGroups"
    effect = "Allow"
    actions = [
      "kafka-cluster:AlterGroup",
      "kafka-cluster:DescribeGroup",
    ]
    resources = [local.group_arn]
  }

  statement {
    sid    = "ControlBoundedEMRApplications"
    effect = "Allow"
    actions = [
      "emr-serverless:CancelJobRun",
      "emr-serverless:GetApplication",
      "emr-serverless:GetJobRun",
      "emr-serverless:ListJobRuns",
      "emr-serverless:StartApplication",
      "emr-serverless:StartJobRun",
      "emr-serverless:StopApplication",
    ]
    resources = var.emr_application_arns
  }

  statement {
    sid       = "PassOnlyAskLakeRuntimeRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.emr_execution.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["emr-serverless.amazonaws.com"]
    }
  }

  statement {
    sid    = "ReadSmokeEvidenceMetrics"
    effect = "Allow"
    actions = [
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:ListMetrics",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ReadRuntimeLogs"
    effect = "Allow"
    actions = [
      "logs:DescribeLogStreams",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
    ]
    resources = local.log_stream_arns
  }
}

resource "aws_iam_role_policy" "smoke_runner" {
  name   = "${var.name_prefix}-smoke"
  role   = aws_iam_role.smoke_runner.id
  policy = data.aws_iam_policy_document.smoke_runner.json
}

resource "aws_iam_instance_profile" "smoke_runner" {
  name = "${var.name_prefix}-smoke-runner"
  role = aws_iam_role.smoke_runner.name
}
