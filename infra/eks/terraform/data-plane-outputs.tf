output "msk_contract" {
  description = "MSK Serverless references consumed by deployment automation; endpoint is redacted in normal output."
  sensitive   = true
  value = {
    mode                       = var.msk_mode
    cluster_arn                = local.msk_cluster_arn
    bootstrap_brokers_sasl_iam = local.msk_bootstrap_brokers_sasl_iam
    broker_port                = 9098
    test_topic                 = var.msk_test_topic
    test_consumer_group        = var.msk_test_consumer_group
  }
}

output "rds_contract" {
  description = "RDS endpoint, managed secret reference, and logical database bootstrap contract."
  sensitive   = true
  value = {
    mode              = var.rds_mode
    endpoint          = local.rds_endpoint
    port              = local.rds_port
    master_secret_arn = local.rds_master_secret_arn
    logical_databases = local.logical_databases
    operations = local.create_rds ? {
      initial_storage_gib = var.rds_allocated_storage_gib
      max_storage_gib     = var.rds_max_allocated_storage_gib
      backup_retention    = var.rds_backup_retention_days
      backup_window       = var.rds_backup_window
      maintenance_window  = var.rds_maintenance_window
      final_snapshot      = var.rds_final_snapshot_identifier
    } : null
  }
}

output "storage_contract" {
  description = "Bucket and prefix references used by workloads; deployment logs must not expand real names unnecessarily."
  sensitive   = true
  value = {
    mode                 = var.storage_mode
    buckets              = local.use_storage ? var.storage_bucket_names : null
    prefixes             = var.storage_prefixes
    create_sse_algorithm = local.create_storage ? var.storage_sse_algorithm : null
    kms_key_enabled      = local.create_storage && var.storage_sse_algorithm == "aws:kms"
  }
}

output "workload_iam_policy_documents" {
  description = "Least-privilege policy documents to attach after IRSA or Pod Identity is selected."
  sensitive   = true
  value       = local.workload_iam_policy_documents
}
