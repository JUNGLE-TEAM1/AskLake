locals {
  managed_msk = var.reference_msk ? {
    topic = format(
      "%s/%s",
      replace(var.msk_cluster_arn, ":cluster/", ":topic/"),
      "asklake.*",
    )
    preview_group = format(
      "%s/%s",
      replace(var.msk_cluster_arn, ":cluster/", ":group/"),
      "asklake-preview-*",
    )
    batch_group = format(
      "%s/%s",
      replace(var.msk_cluster_arn, ":cluster/", ":group/"),
      "asklake-batch-*",
    )
    stream_group = format(
      "%s/%s",
      replace(var.msk_cluster_arn, ":cluster/", ":group/"),
      "asklake-stream-*",
    )
  } : null

  realtime_v2_connect = var.reference_msk && length(var.msk_realtime_v2_topic_arns) == 5 && length(var.msk_realtime_v2_group_arns) == 2 ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectToMskServerless"
        Effect   = "Allow"
        Action   = ["kafka-cluster:Connect"]
        Resource = [var.msk_cluster_arn]
      },
      {
        Sid      = "WriteDataIdempotently"
        Effect   = "Allow"
        Action   = ["kafka-cluster:WriteDataIdempotently"]
        Resource = [var.msk_cluster_arn]
      },
      {
        Sid    = "UseGenerationScopedTopics"
        Effect = "Allow"
        Action = [
          "kafka-cluster:CreateTopic",
          "kafka-cluster:DescribeTopic",
          "kafka-cluster:ReadData",
          "kafka-cluster:WriteData",
        ]
        Resource = var.msk_realtime_v2_topic_arns
      },
      {
        Sid    = "UseGenerationScopedConsumerGroup"
        Effect = "Allow"
        Action = [
          "kafka-cluster:DescribeGroup",
          "kafka-cluster:AlterGroup",
        ]
        Resource = var.msk_realtime_v2_group_arns
      },
    ]
  } : null

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
        Sid      = "ProduceIdempotently"
        Effect   = "Allow"
        Action   = ["kafka-cluster:WriteDataIdempotently"]
        Resource = [var.msk_cluster_arn]
      },
      {
        Sid    = "ProduceFixtureTopic"
        Effect = "Allow"
        Action = [
          "kafka-cluster:DescribeTopic",
          "kafka-cluster:WriteData",
        ]
        Resource = concat(var.msk_topic_arns, [local.managed_msk.topic])
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
        Resource = var.msk_topic_arns
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
        Resource = var.msk_topic_arns
      },
      {
        Sid    = "UseFixtureConsumerGroup"
        Effect = "Allow"
        Action = [
          "kafka-cluster:DescribeGroup",
          "kafka-cluster:AlterGroup",
        ]
        Resource = concat(var.msk_group_arns, [
          local.managed_msk.batch_group,
          local.managed_msk.stream_group,
        ])
      },
      {
        Sid      = "ListSparkRawBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arns.raw]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.raw,
              "${var.storage_prefixes.raw}/*",
            ]
          }
        }
      },
      {
        Sid      = "ListSparkOutputBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arns.output]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.output,
              "${var.storage_prefixes.output}/*",
              var.storage_prefixes.checkpoint,
              "${var.storage_prefixes.checkpoint}/*",
              var.storage_prefixes.quarantine,
              "${var.storage_prefixes.quarantine}/*",
              var.storage_prefixes.continuous_runtime,
              "${var.storage_prefixes.continuous_runtime}/*",
            ]
          }
        }
      },
      {
        Sid      = "ListSparkWarehouseBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arns.warehouse]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.warehouse,
              "${var.storage_prefixes.warehouse}/*",
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
          var.storage_object_arns.continuous_runtime,
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
          var.storage_object_arns.continuous_runtime,
        ]
      },
    ]
  } : null

  backend = var.use_storage ? {
    Version = "2012-10-17"
    Statement = concat(var.reference_msk ? [
      {
        Sid      = "ConnectToManagedMsk"
        Effect   = "Allow"
        Action   = ["kafka-cluster:Connect"]
        Resource = [var.msk_cluster_arn]
      },
      {
        Sid    = "PreviewManagedKafkaTopics"
        Effect = "Allow"
        Action = [
          "kafka-cluster:DescribeTopic",
          "kafka-cluster:ReadData",
        ]
        Resource = [local.managed_msk.topic]
      },
      {
        Sid    = "UseManagedBackendGroups"
        Effect = "Allow"
        Action = [
          "kafka-cluster:DescribeGroup",
          "kafka-cluster:AlterGroup",
        ]
        Resource = [
          local.managed_msk.preview_group,
          local.managed_msk.batch_group,
        ]
      },
    ] : [], [
      {
        Sid      = "ListBackendRawBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arns.raw]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.raw,
              "${var.storage_prefixes.raw}/*",
            ]
          }
        }
      },
      {
        Sid      = "ListBackendOutputBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arns.output]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.output,
              "${var.storage_prefixes.output}/*",
              var.storage_prefixes.evidence,
              "${var.storage_prefixes.evidence}/*",
              var.storage_prefixes.continuous_runtime,
              "${var.storage_prefixes.continuous_runtime}/*",
            ]
          }
        }
      },
      {
        Sid      = "ListBackendWarehouseBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arns.warehouse]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.warehouse,
              "${var.storage_prefixes.warehouse}/*",
            ]
          }
        }
      },
      {
        Sid      = "ListBackendQueryResultBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arns.query_results]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.query_results,
              "${var.storage_prefixes.query_results}/*",
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
          var.storage_object_arns.continuous_runtime,
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
          var.storage_object_arns.continuous_runtime,
        ]
      },
    ])
  } : null

  realtime_v1_worker = var.use_storage ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListContinuousOutputAndRuntimeDocuments"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arns.output]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.output,
              "${var.storage_prefixes.output}/*",
              var.storage_prefixes.continuous_runtime,
              "${var.storage_prefixes.continuous_runtime}/*",
            ]
          }
        }
      },
      {
        Sid      = "ReadContinuousPublicationAndRuntimeDocuments"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = [
          var.storage_object_arns.output,
          var.storage_object_arns.continuous_runtime,
        ]
      },
      {
        Sid    = "WriteContinuousRuntimeDocuments"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:DeleteObject",
          "s3:PutObject",
        ]
        Resource = [var.storage_object_arns.continuous_runtime]
      },
    ]
  } : null

  trino = var.use_storage ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListTrinoWarehouseBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arns.warehouse]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              var.storage_prefixes.warehouse,
              "${var.storage_prefixes.warehouse}/*",
            ]
          }
        }
      },
      {
        Sid      = "ListTrinoQueryResultBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arns.query_results]
        Condition = {
          StringLike = {
            "s3:prefix" = [
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
    realtime_v1_spark         = local.spark
    backend                   = local.backend
    realtime_v1_worker        = local.realtime_v1_worker
    trino                     = local.trino
    realtime_v2_connect       = local.realtime_v2_connect
  }
}
