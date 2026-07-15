locals {
  external_fixture_producer = var.reference_msk ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectToMskServerless"
        Effect   = "Allow"
        Action   = ["kafka-cluster:Connect"]
        Resource = [var.msk_cluster_arn]
      },
      {
        Sid    = "ProduceFixtureTopic"
        Effect = "Allow"
        Action = [
          "kafka-cluster:DescribeTopic",
          "kafka-cluster:WriteData",
        ]
        Resource = [var.msk_topic_arn]
      },
    ]
  } : null

  msk_smoke = var.reference_msk ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectToMskServerless"
        Effect   = "Allow"
        Action   = ["kafka-cluster:Connect"]
        Resource = [var.msk_cluster_arn]
      },
      {
        Sid      = "DescribeFixtureTopic"
        Effect   = "Allow"
        Action   = ["kafka-cluster:DescribeTopic"]
        Resource = [var.msk_topic_arn]
      },
    ]
  } : null

  spark = var.reference_msk && var.use_storage ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectToMskServerless"
        Effect   = "Allow"
        Action   = ["kafka-cluster:Connect"]
        Resource = [var.msk_cluster_arn]
      },
      {
        Sid    = "ConsumeFixtureTopic"
        Effect = "Allow"
        Action = [
          "kafka-cluster:DescribeTopic",
          "kafka-cluster:ReadData",
        ]
        Resource = [var.msk_topic_arn]
      },
      {
        Sid    = "UseFixtureConsumerGroup"
        Effect = "Allow"
        Action = [
          "kafka-cluster:DescribeGroup",
          "kafka-cluster:AlterGroup",
        ]
        Resource = [var.msk_group_arn]
      },
      {
        Sid    = "ListSparkBuckets"
        Effect = "Allow"
        Action = ["s3:ListBucket"]
        Resource = [
          var.storage_bucket_arns.raw,
          var.storage_bucket_arns.output,
          var.storage_bucket_arns.warehouse,
        ]
        Condition = {
          StringLike = {
            "s3:prefix" = [
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
      },
      {
        Sid    = "ReadSparkObjects"
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = [
          var.storage_object_arns.raw,
          var.storage_object_arns.output,
          var.storage_object_arns.warehouse,
          var.storage_object_arns.checkpoint,
          var.storage_object_arns.quarantine,
        ]
      },
      {
        Sid    = "WriteSparkObjects"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:DeleteObject",
          "s3:PutObject",
        ]
        Resource = [
          var.storage_object_arns.output,
          var.storage_object_arns.warehouse,
          var.storage_object_arns.checkpoint,
          var.storage_object_arns.quarantine,
        ]
      },
    ]
  } : null

  backend = var.use_storage ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ListBackendBuckets"
        Effect = "Allow"
        Action = ["s3:ListBucket"]
        Resource = [
          var.storage_bucket_arns.raw,
          var.storage_bucket_arns.output,
          var.storage_bucket_arns.warehouse,
          var.storage_bucket_arns.query_results,
        ]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.raw,
              "${var.storage_prefixes.raw}/*",
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
      },
      {
        Sid    = "ReadBackendObjects"
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = [
          var.storage_object_arns.raw,
          var.storage_object_arns.output,
          var.storage_object_arns.warehouse,
          var.storage_object_arns.query_results,
          var.storage_object_arns.evidence,
        ]
      },
      {
        Sid    = "WriteBackendResultsAndEvidence"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:DeleteObject",
          "s3:PutObject",
        ]
        Resource = [
          var.storage_object_arns.query_results,
          var.storage_object_arns.evidence,
        ]
      },
    ]
  } : null

  trino = var.use_storage ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ListTrinoBuckets"
        Effect = "Allow"
        Action = ["s3:ListBucket"]
        Resource = [
          var.storage_bucket_arns.warehouse,
          var.storage_bucket_arns.query_results,
        ]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.warehouse,
              "${var.storage_prefixes.warehouse}/*",
              var.storage_prefixes.query_results,
              "${var.storage_prefixes.query_results}/*",
            ]
          }
        }
      },
      {
        Sid    = "ReadWriteTrinoObjects"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:PutObject",
        ]
        Resource = [
          var.storage_object_arns.warehouse,
          var.storage_object_arns.query_results,
        ]
      },
    ]
  } : null

  contracts = {
    external_fixture_producer = local.external_fixture_producer
    msk_smoke                 = local.msk_smoke
    spark                     = local.spark
    backend                   = local.backend
    trino                     = local.trino
  }
}
