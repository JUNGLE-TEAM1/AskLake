output "phase8_runtime_secret_handoff" {
  description = "Secret names and key names only; values and rendered Kubernetes Secret data are forbidden."
  value = {
    contract_version = "1.0"
    namespace        = var.namespace
    delivery = {
      mode             = var.secret_delivery_mode
      controller_ready = var.secret_controller_ready
      controller_owner = var.secret_controller_owner
      rotation_owner   = var.secret_rotation_owner
      source_prefix    = var.secret_source_prefix
    }
    secrets                            = local.runtime_secret_contract
    shared_bindings                    = local.runtime_secret_static_contract.sharedBindings
    env_bindings                       = local.runtime_secret_static_contract.envBindings
    file_mounts                        = local.runtime_secret_static_contract.fileMounts
    forbidden_keys                     = local.runtime_secret_static_contract.forbiddenKeys
    runtime_decisions                  = local.runtime_decisions
    ready_for_sync                     = local.secret_delivery_ready
    full_service_secret_contract_ready = local.full_service_secret_contract_ready
    values_in_state                    = false
  }
}
