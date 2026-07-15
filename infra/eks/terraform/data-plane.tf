data "aws_partition" "current" {}

locals {
  create_msk     = var.msk_mode == "create"
  reference_msk  = var.msk_mode != "disabled"
  create_rds     = var.rds_mode == "create"
  reference_rds  = var.rds_mode != "disabled"
  create_storage = var.storage_mode == "create"
  use_storage    = var.storage_mode != "disabled"

  msk_cluster_arn = local.create_msk ? try(aws_msk_serverless_cluster.mvp[0].arn, null) : var.existing_msk_cluster_arn
  msk_bootstrap_brokers_sasl_iam = local.create_msk ? try(
    aws_msk_serverless_cluster.mvp[0].bootstrap_brokers_sasl_iam,
    null,
  ) : var.existing_msk_bootstrap_brokers_sasl_iam
  msk_topic_arn = local.msk_cluster_arn == null ? null : format(
    "%s/%s",
    replace(local.msk_cluster_arn, ":cluster/", ":topic/"),
    var.msk_test_topic,
  )
  msk_group_arn = local.msk_cluster_arn == null ? null : format(
    "%s/%s",
    replace(local.msk_cluster_arn, ":cluster/", ":group/"),
    var.msk_test_consumer_group,
  )

  rds_endpoint = local.create_rds ? try(aws_db_instance.metadata[0].address, null) : var.existing_rds_endpoint
  rds_port     = local.create_rds ? try(aws_db_instance.metadata[0].port, 5432) : var.existing_rds_port
  rds_master_secret_arn = local.create_rds ? try(
    aws_db_instance.metadata[0].master_user_secret[0].secret_arn,
    null,
  ) : var.existing_rds_master_secret_arn

  logical_databases = {
    asklake_app     = "asklake_app"
    airflow         = "airflow_metadata"
    iceberg_catalog = "iceberg_catalog"
  }

  storage_bucket_arns = local.use_storage ? {
    for component, bucket in var.storage_bucket_names :
    component => "arn:${data.aws_partition.current.partition}:s3:::${bucket}"
  } : {}

  storage_object_arns = local.use_storage ? {
    raw           = "${local.storage_bucket_arns.raw}/${var.storage_prefixes.raw}/*"
    output        = "${local.storage_bucket_arns.output}/${var.storage_prefixes.output}/*"
    warehouse     = "${local.storage_bucket_arns.warehouse}/${var.storage_prefixes.warehouse}/*"
    query_results = "${local.storage_bucket_arns.query_results}/${var.storage_prefixes.query_results}/*"
    checkpoint    = "${local.storage_bucket_arns.output}/${var.storage_prefixes.checkpoint}/*"
    quarantine    = "${local.storage_bucket_arns.output}/${var.storage_prefixes.quarantine}/*"
    evidence      = "${local.storage_bucket_arns.output}/${var.storage_prefixes.evidence}/*"
  } : {}
}

check "data_plane_creation_gate" {
  assert {
    condition = !(
      local.create_msk ||
      local.create_rds ||
      local.create_storage
    ) || var.resource_lifecycle == "mvp-owned"
    error_message = "MSK, RDS, and S3 resources created by this state must use resource_lifecycle=mvp-owned."
  }
}

check "existing_msk_contract" {
  assert {
    condition = var.msk_mode != "existing" || (
      try(trimspace(var.existing_msk_cluster_arn), "") != "" &&
      try(trimspace(var.existing_msk_bootstrap_brokers_sasl_iam), "") != ""
    )
    error_message = "existing MSK mode requires cluster ARN and private IAM bootstrap brokers."
  }
}

check "existing_rds_contract" {
  assert {
    condition = var.rds_mode != "existing" || (
      try(trimspace(var.existing_rds_endpoint), "") != "" &&
      try(trimspace(var.existing_rds_master_secret_arn), "") != ""
    )
    error_message = "existing RDS mode requires endpoint and master secret ARN references."
  }
}

check "storage_contract" {
  assert {
    condition = !local.use_storage || alltrue([
      for bucket in values(var.storage_bucket_names) : trimspace(bucket) != ""
    ]) && length(toset(values(var.storage_bucket_names))) == 4
    error_message = "existing/create storage mode requires four non-empty, distinct raw, output, warehouse, and query result bucket names."
  }
}

check "storage_prefix_contract" {
  assert {
    condition = !local.use_storage || (
      alltrue([for prefix in values(var.storage_prefixes) : trim(prefix, "/ ") != ""]) &&
      length(toset([for prefix in values(var.storage_prefixes) : trim(prefix, "/ ")])) == length(values(var.storage_prefixes))
    )
    error_message = "storage prefixes must be non-empty and distinct."
  }
}

check "storage_encryption_contract" {
  assert {
    condition = !local.create_storage || var.storage_sse_algorithm != "aws:kms" || (
      try(trimspace(var.storage_kms_key_arn), "") != ""
    )
    error_message = "aws:kms storage encryption requires an approved storage_kms_key_arn."
  }
}

resource "aws_msk_serverless_cluster" "mvp" {
  count = local.create_msk ? 1 : 0

  cluster_name = "${var.name_prefix}-${var.environment}-serverless"

  vpc_config {
    subnet_ids = local.effective_msk_subnet_ids
    security_group_ids = local.create_network ? toset([
      aws_security_group.msk_private[0].id,
    ]) : var.msk_security_group_ids
  }

  client_authentication {
    sasl {
      iam {
        enabled = true
      }
    }
  }

  lifecycle {
    precondition {
      condition     = length(toset(local.effective_msk_subnet_ids)) >= 2
      error_message = "MSK Serverless creation requires at least two reviewed private subnets."
    }

    precondition {
      condition     = local.create_network || length(var.msk_security_group_ids) > 0
      error_message = "MSK Serverless creation requires an explicit client security group."
    }
  }
}

resource "aws_db_subnet_group" "metadata" {
  count = local.create_rds ? 1 : 0

  name       = "${var.name_prefix}-${var.environment}-metadata"
  subnet_ids = local.effective_rds_subnet_ids

  lifecycle {
    precondition {
      condition     = length(toset(local.effective_rds_subnet_ids)) >= 2
      error_message = "RDS creation requires at least two reviewed private subnets."
    }
  }
}

resource "aws_db_instance" "metadata" {
  count = local.create_rds ? 1 : 0

  identifier                  = "${var.name_prefix}-${var.environment}-metadata"
  engine                      = "postgres"
  engine_version              = var.rds_engine_version
  instance_class              = var.rds_instance_class
  allocated_storage           = var.rds_allocated_storage_gib
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = local.logical_databases.asklake_app
  username                    = "asklake_admin"
  manage_master_user_password = true
  port                        = 5432
  db_subnet_group_name        = aws_db_subnet_group.metadata[0].name
  vpc_security_group_ids = local.create_network ? toset([
    aws_security_group.rds_private[0].id,
  ]) : var.rds_security_group_ids
  publicly_accessible        = false
  multi_az                   = var.rds_multi_az
  backup_retention_period    = var.rds_backup_retention_days
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name_prefix}-${var.environment}-metadata-final"
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  apply_immediately          = false

  lifecycle {
    precondition {
      condition     = try(trimspace(var.rds_instance_class), "") != ""
      error_message = "RDS creation requires an explicitly reviewed instance class."
    }

    precondition {
      condition     = local.create_network || length(var.rds_security_group_ids) > 0
      error_message = "RDS creation requires an explicit workload security group."
    }
  }
}

resource "aws_s3_bucket" "data" {
  for_each = local.create_storage ? var.storage_bucket_names : {}

  bucket        = each.value
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "data" {
  for_each = aws_s3_bucket.data

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  for_each = aws_s3_bucket.data

  bucket = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.storage_sse_algorithm
      kms_master_key_id = var.storage_sse_algorithm == "aws:kms" ? var.storage_kms_key_arn : null
    }

    bucket_key_enabled = var.storage_sse_algorithm == "aws:kms"
  }
}

resource "aws_s3_bucket_versioning" "data" {
  for_each = aws_s3_bucket.data

  bucket = each.value.id

  versioning_configuration {
    status = "Enabled"
  }
}
