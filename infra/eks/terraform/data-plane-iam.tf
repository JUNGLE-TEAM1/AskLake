data "aws_iam_policy_document" "external_fixture_producer" {
  count = local.reference_msk ? 1 : 0

  statement {
    sid       = "ConnectToMskServerless"
    actions   = ["kafka-cluster:Connect"]
    resources = [local.msk_cluster_arn]
  }

  statement {
    sid = "ProduceFixtureTopic"
    actions = [
      "kafka-cluster:DescribeTopic",
      "kafka-cluster:WriteData",
    ]
    resources = [local.msk_topic_arn]
  }
}

data "aws_iam_policy_document" "msk_smoke" {
  count = local.reference_msk ? 1 : 0

  statement {
    sid       = "ConnectToMskServerless"
    actions   = ["kafka-cluster:Connect"]
    resources = [local.msk_cluster_arn]
  }

  statement {
    sid       = "DescribeFixtureTopic"
    actions   = ["kafka-cluster:DescribeTopic"]
    resources = [local.msk_topic_arn]
  }
}

data "aws_iam_policy_document" "spark" {
  count = local.reference_msk && local.use_storage ? 1 : 0

  statement {
    sid       = "ConnectToMskServerless"
    actions   = ["kafka-cluster:Connect"]
    resources = [local.msk_cluster_arn]
  }

  statement {
    sid = "ConsumeFixtureTopic"
    actions = [
      "kafka-cluster:DescribeTopic",
      "kafka-cluster:ReadData",
    ]
    resources = [local.msk_topic_arn]
  }

  statement {
    sid = "UseFixtureConsumerGroup"
    actions = [
      "kafka-cluster:DescribeGroup",
      "kafka-cluster:AlterGroup",
    ]
    resources = [local.msk_group_arn]
  }

  statement {
    sid = "ListSparkBuckets"
    actions = [
      "s3:ListBucket",
    ]
    resources = [
      local.storage_bucket_arns.raw,
      local.storage_bucket_arns.output,
      local.storage_bucket_arns.warehouse,
    ]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        var.storage_prefixes.raw,
        "${var.storage_prefixes.raw}/*",
        var.storage_prefixes.output,
        "${var.storage_prefixes.output}/*",
        var.storage_prefixes.warehouse,
        "${var.storage_prefixes.warehouse}/*",
        var.storage_prefixes.checkpoint,
        "${var.storage_prefixes.checkpoint}/*",
        var.storage_prefixes.quarantine,
        "${var.storage_prefixes.quarantine}/*",
      ]
    }
  }

  statement {
    sid = "ReadSparkObjects"
    actions = [
      "s3:GetObject",
    ]
    resources = [
      local.storage_object_arns.raw,
      local.storage_object_arns.output,
      local.storage_object_arns.warehouse,
    ]
  }

  statement {
    sid = "WriteSparkObjects"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:PutObject",
    ]
    resources = [
      local.storage_object_arns.output,
      local.storage_object_arns.warehouse,
      local.storage_object_arns.checkpoint,
      local.storage_object_arns.quarantine,
    ]
  }
}

data "aws_iam_policy_document" "backend" {
  count = local.use_storage ? 1 : 0

  statement {
    sid       = "ListBackendBuckets"
    actions   = ["s3:ListBucket"]
    resources = [local.storage_bucket_arns.output, local.storage_bucket_arns.warehouse, local.storage_bucket_arns.query_results]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        var.storage_prefixes.output,
        "${var.storage_prefixes.output}/*",
        var.storage_prefixes.warehouse,
        "${var.storage_prefixes.warehouse}/*",
        var.storage_prefixes.query_results,
        "${var.storage_prefixes.query_results}/*",
        var.storage_prefixes.evidence,
        "${var.storage_prefixes.evidence}/*",
      ]
    }
  }

  statement {
    sid       = "ReadBackendObjects"
    actions   = ["s3:GetObject"]
    resources = [local.storage_object_arns.output, local.storage_object_arns.warehouse, local.storage_object_arns.query_results]
  }

  statement {
    sid = "WriteBackendResultsAndEvidence"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:PutObject",
    ]
    resources = [local.storage_object_arns.query_results, local.storage_object_arns.evidence]
  }
}

data "aws_iam_policy_document" "trino" {
  count = local.use_storage ? 1 : 0

  statement {
    sid       = "ListTrinoBuckets"
    actions   = ["s3:ListBucket"]
    resources = [local.storage_bucket_arns.warehouse, local.storage_bucket_arns.query_results]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        var.storage_prefixes.warehouse,
        "${var.storage_prefixes.warehouse}/*",
        var.storage_prefixes.query_results,
        "${var.storage_prefixes.query_results}/*",
      ]
    }
  }

  statement {
    sid = "ReadWriteTrinoObjects"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = [local.storage_object_arns.warehouse, local.storage_object_arns.query_results]
  }
}
