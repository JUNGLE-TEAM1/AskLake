output "day18_observability_handoff" {
  description = "Non-secret Day 18 add-on, identity, retention and runtime verification contract."
  value = {
    contract_version           = "1.0"
    mode                       = var.observability_mode
    addon_name                 = "amazon-cloudwatch-observability"
    addon_version              = var.observability_addon_version
    owner                      = var.observability_owner
    created_by_terraform       = local.observability_enabled
    identity_mode              = local.observability_enabled ? "eks-pod-identity" : "disabled"
    service_account            = local.observability_enabled ? "cloudwatch-agent" : null
    node_role_permission       = false
    application_signals        = false
    classic_container_insights = false
    otel_container_insights    = local.observability_enabled
    application_log_delivery   = local.observability_enabled ? "addon-managed-fluent-bit" : "disabled"
    application_log_scope      = local.observability_enabled ? var.namespace : null
    standalone_fluent_bit      = false
    standalone_adot            = false
    post_apply_reconcile       = "scripts/reconcile-eks-day18-observability-runtime.sh"
    cluster_scraper_network    = "pod-network"
    retention_days = {
      application    = var.observability_application_retention_days
      control_plane  = var.observability_control_plane_retention_days
      rds_postgresql = var.observability_rds_retention_days
    }
    cost_guardrails = {
      daily_ingest_warning_gib = var.observability_daily_log_ingest_warning_gib
      stored_log_warning_gib   = var.observability_stored_log_warning_gib
      alarm_actions_enabled    = false
      notification_target      = "phase-3-follow-up"
    }
    log_groups_preserved_on_destroy = true
    runtime_evidence = [
      "addon-active",
      "agent-ready-on-current-nodes",
      "container-insights-metrics-follow-up",
      "application-log-delivered",
      "event-private-receipt",
    ]
  }
}
