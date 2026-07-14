output "infrastructure_contract" {
  description = "Non-sensitive Phase 1 infrastructure values consumed by Phase 2 Runtime rendering."
  value = {
    environment                    = local.environment
    region                         = var.region
    stack_id                       = var.stack_id
    name_prefix                    = local.name_prefix
    bucket_prefix                  = local.bucket_prefix
    topic_namespace                = local.topic_namespace
    vpc_id                         = module.network.vpc_id
    vpc_cidr                       = module.network.vpc_cidr
    private_subnet_ids             = module.network.private_subnet_ids
    public_ingress_enabled         = false
    nat_gateway_enabled            = false
    bucket_names                   = module.storage.bucket_names
    batch_application_id           = module.emr.batch_application_id
    continuous_application_id      = module.emr.continuous_application_id
    emr_execution_role_arn         = module.iam.emr_execution_role_arn
    msk_cluster_arn                = module.msk.cluster_arn
    maximum_application_vcpu       = module.emr.maximum_vcpu
    emr_capacity                   = module.emr.capacity_contract
    batch_maximum_queued_runs      = 2
    continuous_maximum_queued_runs = 1
    applications_concurrent        = false
    budget_limit_usd               = module.cost_control.budget_limit_usd
    smoke_runner_enabled           = var.enable_smoke_runner
    expires_at                     = var.expires_at
  }
}

output "msk_bootstrap_brokers_sasl_iam" {
  description = "Operational MSK endpoint consumed explicitly by Phase 2; redacted in normal output."
  value       = module.msk.bootstrap_brokers_sasl_iam
  sensitive   = true
}

output "smoke_runner_instance_id" {
  description = "Private SSM runner ID when enable_smoke_runner is true."
  value       = module.smoke_runner.instance_id
}

output "github_oidc_role_arn" {
  description = "External platform role expected to execute this stack."
  value       = var.github_oidc_role_arn
}
