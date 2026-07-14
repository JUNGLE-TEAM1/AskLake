module "network" {
  source = "../../modules/network"

  name_prefix          = local.name_prefix
  region               = var.region
  vpc_cidr             = local.vpc_cidr
  availability_zones   = var.availability_zones
  private_subnet_cidrs = local.private_subnet_cidrs
}

module "storage" {
  source = "../../modules/storage"

  name_prefix   = local.name_prefix
  bucket_prefix = local.bucket_prefix
}

module "observability" {
  source = "../../modules/observability"

  name_prefix        = local.name_prefix
  log_retention_days = 7
}

module "msk" {
  source = "../../modules/msk"

  cluster_name       = "${local.name_prefix}-msk"
  private_subnet_ids = module.network.private_subnet_ids
  security_group_id  = module.network.msk_security_group_id
}

module "emr" {
  source = "../../modules/emr"

  name_prefix               = local.name_prefix
  release_label             = "emr-7.9.0"
  private_subnet_ids        = module.network.private_subnet_ids
  security_group_id         = module.network.emr_security_group_id
  report_bucket_name        = module.storage.bucket_names.report
  report_kms_key_arn        = module.storage.kms_key_arn
  batch_log_group_name      = module.observability.batch_log_group_name
  continuous_log_group_name = module.observability.continuous_log_group_name
  maximum_vcpu              = 16
  maximum_memory_gb         = 64
  maximum_disk_gb           = 320
  driver_cores              = 1
  driver_memory_gb          = 4
  driver_disk_gb            = 20
  executor_cores            = 2
  executor_memory_gb        = 4
  executor_disk_gb          = 20
  minimum_executors         = 0
  initial_executors         = 2
  maximum_executors         = 7
  auto_stop_idle_minutes    = 10
}

module "iam" {
  source = "../../modules/iam"

  name_prefix          = local.name_prefix
  region               = var.region
  aws_account_id       = var.aws_account_id
  topic_namespace      = local.topic_namespace
  bucket_arns          = module.storage.bucket_arns
  data_kms_key_arn     = module.storage.kms_key_arn
  msk_cluster_arn      = module.msk.cluster_arn
  emr_application_arns = [module.emr.batch_application_arn, module.emr.continuous_application_arn]
  log_group_arns       = module.observability.log_group_arns
}

module "smoke_runner" {
  source = "../../modules/smoke-runner"

  enabled               = var.enable_smoke_runner
  name_prefix           = local.name_prefix
  ami_id                = var.smoke_runner_ami_id
  instance_type         = var.smoke_runner_instance_type
  subnet_id             = module.network.private_subnet_ids[0]
  security_group_id     = module.network.runner_security_group_id
  instance_profile_name = module.iam.smoke_runner_instance_profile_name
}

module "cost_control" {
  source = "../../modules/cost-control"

  name_prefix              = local.name_prefix
  stack_id                 = var.stack_id
  budget_limit_usd         = 30
  alert_thresholds_percent = [50, 80, 100]
  notification_email       = var.budget_notification_email
}
