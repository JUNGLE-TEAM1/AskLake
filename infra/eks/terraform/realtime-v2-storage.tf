variable "realtime_v2_snapshot_controller_mode" {
  description = "Snapshot controller ownership for the EKS Realtime V2 recovery contract: disabled, managed here as an EKS add-on, or externally managed and confirmed."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "eks_addon", "external"], var.realtime_v2_snapshot_controller_mode)
    error_message = "realtime_v2_snapshot_controller_mode must be disabled, eks_addon, or external."
  }
}

variable "realtime_v2_snapshot_controller_version" {
  description = "Exact cluster-compatible snapshot-controller version returned by aws eks describe-addon-versions."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.realtime_v2_snapshot_controller_version == null || can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+-eksbuild\\.[0-9]+$", var.realtime_v2_snapshot_controller_version))
    error_message = "realtime_v2_snapshot_controller_version must be null or an exact vX.Y.Z-eksbuild.N version."
  }
}

variable "realtime_v2_snapshot_controller_owner" {
  description = "Lifecycle owner for snapshot controller installation, upgrades, verification, and removal."
  type        = string
  default     = null
  nullable    = true
}

variable "realtime_v2_external_snapshot_controller_confirmed" {
  description = "Explicit evidence that an external owner operates the compatible snapshot controller and CRDs."
  type        = bool
  default     = false
}

locals {
  create_realtime_v2_snapshot_controller = var.realtime_v2_snapshot_controller_mode == "eks_addon"
  realtime_v2_snapshot_controller_inputs_complete = (
    var.realtime_v2_snapshot_controller_version != null &&
    trimspace(coalesce(var.realtime_v2_snapshot_controller_owner, "")) != ""
  )
}

check "realtime_v2_snapshot_controller_contract" {
  assert {
    condition = (
      var.realtime_v2_snapshot_controller_mode == "disabled" ? (
        var.realtime_v2_snapshot_controller_version == null &&
        var.realtime_v2_snapshot_controller_owner == null &&
        !var.realtime_v2_external_snapshot_controller_confirmed
        ) : var.realtime_v2_snapshot_controller_mode == "eks_addon" ? (
        local.realtime_v2_snapshot_controller_inputs_complete &&
        !var.realtime_v2_external_snapshot_controller_confirmed &&
        var.resource_lifecycle == "mvp-owned"
        ) : (
        local.realtime_v2_snapshot_controller_inputs_complete &&
        var.realtime_v2_external_snapshot_controller_confirmed
      )
    )
    error_message = "Snapshot controller must stay empty when disabled; EKS add-on creation requires exact version, owner and MVP ownership; external mode requires explicit confirmation."
  }
}

resource "aws_eks_addon" "realtime_v2_snapshot_controller" {
  count = local.create_realtime_v2_snapshot_controller ? 1 : 0

  cluster_name                = local.cluster_name
  addon_name                  = "snapshot-controller"
  addon_version               = var.realtime_v2_snapshot_controller_version
  resolve_conflicts_on_create = "NONE"
  resolve_conflicts_on_update = "PRESERVE"
  configuration_values = jsonencode({
    nodeSelector = {
      "karpenter.sh/nodepool" = "asklake-general"
    }
  })

  tags = merge(var.additional_tags, {
    Name        = "${var.name_prefix}-${var.environment}-realtime-v2-snapshot-controller"
    Environment = var.environment
    Owner       = var.realtime_v2_snapshot_controller_owner
    Lifecycle   = "mvp-owned"
  })

  depends_on = [
    aws_eks_cluster.this,
    aws_eks_access_policy_association.cluster_admin,
  ]
}

output "realtime_v2_snapshot_controller_handoff" {
  description = "Fail-closed snapshot controller handoff for the Realtime V2 paired PVC recovery drill."
  value = {
    mode                 = var.realtime_v2_snapshot_controller_mode
    addon_name           = "snapshot-controller"
    addon_version        = var.realtime_v2_snapshot_controller_version
    owner                = var.realtime_v2_snapshot_controller_owner
    created_by_terraform = local.create_realtime_v2_snapshot_controller
    external_confirmed   = var.realtime_v2_external_snapshot_controller_confirmed
    ready_for_apply      = var.realtime_v2_snapshot_controller_mode != "disabled" && local.realtime_v2_snapshot_controller_inputs_complete
    node_pool            = "asklake-general"
    required_crds = [
      "volumesnapshotclasses.snapshot.storage.k8s.io",
      "volumesnapshotcontents.snapshot.storage.k8s.io",
      "volumesnapshots.snapshot.storage.k8s.io",
    ]
  }
}
