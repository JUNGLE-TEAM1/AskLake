variable "observability_mode" {
  description = "Day 18 observability ownership: disabled or the managed CloudWatch Observability EKS add-on."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "eks_addon"], var.observability_mode)
    error_message = "observability_mode must be disabled or eks_addon."
  }
}
variable "observability_addon_version" {
  description = "Exact cluster-compatible amazon-cloudwatch-observability add-on version."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.observability_addon_version == null || can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+-eksbuild\\.[0-9]+$", var.observability_addon_version))
    error_message = "observability_addon_version must be null or an exact vX.Y.Z-eksbuild.N version."
  }
}

variable "observability_owner" {
  description = "Lifecycle owner for add-on, Pod Identity, retention and rollback."
  type        = string
  default     = null
  nullable    = true
}

variable "observability_application_retention_days" {
  description = "Retention for EKS application stdout/stderr logs."
  type        = number
  default     = 7

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.observability_application_retention_days)
    error_message = "application retention must be one of 1, 3, 5, 7, 14, or 30 days."
  }
}

variable "observability_control_plane_retention_days" {
  description = "Retention for the existing EKS control-plane log group after explicit import."
  type        = number
  default     = 7

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.observability_control_plane_retention_days)
    error_message = "control-plane retention must be one of 1, 3, 5, 7, 14, or 30 days."
  }
}

variable "observability_rds_retention_days" {
  description = "Retention for the existing MVP PostgreSQL log group after explicit import."
  type        = number
  default     = 7

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.observability_rds_retention_days)
    error_message = "RDS retention must be one of 1, 3, 5, 7, 14, or 30 days."
  }
}
