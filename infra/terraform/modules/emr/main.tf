terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

locals {
  applications = {
    batch = {
      name                   = "${var.name_prefix}-batch"
      log_group_name         = var.batch_log_group_name
      log_stream_name_prefix = "batch"
    }
    continuous = {
      name                   = "${var.name_prefix}-continuous"
      log_group_name         = var.continuous_log_group_name
      log_stream_name_prefix = "continuous"
    }
  }

  spark_defaults = {
    "spark.driver.cores"                       = tostring(var.driver_cores)
    "spark.driver.memory"                      = "${var.driver_memory_gb}g"
    "spark.executor.cores"                     = tostring(var.executor_cores)
    "spark.executor.memory"                    = "${var.executor_memory_gb}g"
    "spark.dynamicAllocation.enabled"          = "true"
    "spark.dynamicAllocation.minExecutors"     = tostring(var.minimum_executors)
    "spark.dynamicAllocation.initialExecutors" = tostring(var.initial_executors)
    "spark.dynamicAllocation.maxExecutors"     = tostring(var.maximum_executors)
    "spark.emr-serverless.driver.disk"         = "${var.driver_disk_gb}g"
    "spark.emr-serverless.executor.disk"       = "${var.executor_disk_gb}g"
  }
}

resource "aws_emrserverless_application" "this" {
  for_each = local.applications

  name          = each.value.name
  release_label = var.release_label
  type          = "spark"
  architecture  = "X86_64"

  auto_start_configuration {
    enabled = true
  }

  auto_stop_configuration {
    enabled              = true
    idle_timeout_minutes = var.auto_stop_idle_minutes
  }

  maximum_capacity {
    cpu    = "${var.maximum_vcpu} vCPU"
    memory = "${var.maximum_memory_gb} GB"
    disk   = "${var.maximum_disk_gb} GB"
  }

  job_level_cost_allocation_configuration {
    enabled = true
  }

  scheduler_configuration {
    max_concurrent_runs   = 1
    queue_timeout_minutes = 15
  }

  network_configuration {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [var.security_group_id]
  }

  runtime_configuration {
    classification = "spark-defaults"
    properties     = local.spark_defaults
  }

  monitoring_configuration {
    cloudwatch_logging_configuration {
      enabled                = true
      log_group_name         = each.value.log_group_name
      log_stream_name_prefix = each.value.log_stream_name_prefix

      log_types {
        name   = "SPARK_DRIVER"
        values = ["STDOUT", "STDERR"]
      }

      log_types {
        name   = "SPARK_EXECUTOR"
        values = ["STDOUT", "STDERR"]
      }
    }

    s3_monitoring_configuration {
      log_uri            = "s3://${var.report_bucket_name}/emr-logs/${each.key}"
      encryption_key_arn = var.report_kms_key_arn
    }

    managed_persistence_monitoring_configuration {
      enabled = true
    }
  }

  tags = {
    Workload = each.key
  }

  lifecycle {
    precondition {
      condition = (
        var.driver_cores + (var.executor_cores * var.maximum_executors)
      ) <= var.maximum_vcpu
      error_message = "The driver plus maximum executors exceed application maximum capacity."
    }

    precondition {
      condition = (
        var.minimum_executors <= var.initial_executors &&
        var.initial_executors <= var.maximum_executors
      )
      error_message = "Executor min/initial/max ordering is invalid."
    }
  }
}
