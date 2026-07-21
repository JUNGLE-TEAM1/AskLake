output "phase12_node_pool_handoff" {
  description = "Non-secret access and workload-placement contract for Phase 12 custom Auto Mode NodeClass/NodePool manifests."
  value = {
    mode                  = var.custom_node_pool_mode
    manifest_render_ready = var.custom_node_pool_mode != "disabled"
    node_role_name        = local.custom_node_role_name
    node_role_arn         = local.custom_node_role_arn
    access_entry_owner    = local.create_custom_node_access ? "terraform" : local.external_custom_node_access ? "external-confirmed" : "none"
    builtin_node_pools    = local.create_cluster ? var.auto_mode_builtin_node_pools : toset([])
    custom_node_classes   = ["asklake-general", "asklake-spark"]
    custom_node_pools     = ["asklake-general", "asklake-spark"]
    workload_placement = {
      general = {
        node_selector = { "asklake.io/workload-class" = "general" }
        tolerations   = []
      }
      spark = {
        node_selector = { "asklake.io/workload-class" = "spark" }
        tolerations = [{
          key      = "asklake.io/workload-class"
          operator = "Equal"
          value    = "spark"
          effect   = "NoSchedule"
        }]
      }
    }
    runtime_values = "explicit-helm-selection-required"
    aws_smoke      = "required-after-apply"
  }
}
