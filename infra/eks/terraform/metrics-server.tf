variable "metrics_server_mode" {
  description = "Metrics Server ownership: disabled, EKS community add-on managed here, or externally managed and confirmed."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "eks_addon", "external"], var.metrics_server_mode)
    error_message = "metrics_server_mode must be disabled, eks_addon, or external."
  }
}

variable "metrics_server_addon_version" {
  description = "Exact cluster-compatible version returned by aws eks describe-addon-versions --addon-name metrics-server."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.metrics_server_addon_version == null || can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+-eksbuild\\.[0-9]+$", var.metrics_server_addon_version))
    error_message = "metrics_server_addon_version must be null or an exact vX.Y.Z-eksbuild.N version."
  }
}

variable "metrics_server_owner" {
  description = "Lifecycle owner for installation, upgrades, verification, and removal."
  type        = string
  default     = null
  nullable    = true
}

variable "external_metrics_server_confirmed" {
  description = "Explicit evidence that an external owner already operates a compatible Metrics Server."
  type        = bool
  default     = false
}

locals {
  create_metrics_server_addon = var.metrics_server_mode == "eks_addon"
  metrics_server_inputs_complete = (
    var.metrics_server_addon_version != null &&
    trimspace(coalesce(var.metrics_server_owner, "")) != ""
  )
}

check "metrics_server_contract" {
  assert {
    condition = (
      var.metrics_server_mode == "disabled" ? (
        var.metrics_server_addon_version == null &&
        var.metrics_server_owner == null &&
        !var.external_metrics_server_confirmed
        ) : var.metrics_server_mode == "eks_addon" ? (
        local.metrics_server_inputs_complete &&
        !var.external_metrics_server_confirmed &&
        var.resource_lifecycle == "mvp-owned"
        ) : (
        local.metrics_server_inputs_complete &&
        var.external_metrics_server_confirmed
      )
    )
    error_message = "Metrics Server must stay empty when disabled; EKS add-on creation requires exact version, owner and MVP ownership; external mode requires explicit confirmation."
  }
}

resource "aws_eks_addon" "metrics_server" {
  count = local.create_metrics_server_addon ? 1 : 0

  cluster_name                = local.cluster_name
  addon_name                  = "metrics-server"
  addon_version               = var.metrics_server_addon_version
  resolve_conflicts_on_create = "NONE"
  resolve_conflicts_on_update = "PRESERVE"

  tags = merge(var.additional_tags, {
    Name        = "${var.name_prefix}-${var.environment}-metrics-server"
    Environment = var.environment
    Owner       = var.metrics_server_owner
    Lifecycle   = "mvp-owned"
  })

  depends_on = [
    aws_eks_cluster.this,
    aws_eks_access_policy_association.cluster_admin,
  ]
}

output "phase14_metrics_server_handoff" {
  description = "Metrics API ownership and runtime verification gate for Day 14 scale evidence."
  value = {
    contract_version      = "1.0"
    mode                  = var.metrics_server_mode
    addon_name            = "metrics-server"
    addon_version         = var.metrics_server_addon_version
    owner                 = var.metrics_server_owner
    namespace             = "kube-system"
    created_by_terraform  = local.create_metrics_server_addon
    external_confirmed    = var.external_metrics_server_confirmed
    ready_for_apply       = var.metrics_server_mode != "disabled" && local.metrics_server_inputs_complete
    runtime_evidence      = ["addon-active", "metrics-api-available", "kubectl-top-nodes", "kubectl-top-pods"]
    historical_monitoring = false
  }
}
