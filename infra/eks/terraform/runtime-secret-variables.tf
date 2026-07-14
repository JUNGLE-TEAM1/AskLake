variable "secret_delivery_mode" {
  description = "Keep runtime Secret delivery disabled or select a reviewed external controller/workflow sync path."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "external_secrets", "workflow_sync"], var.secret_delivery_mode)
    error_message = "secret_delivery_mode must be disabled, external_secrets, or workflow_sync."
  }
}

variable "secret_controller_ready" {
  description = "True only when the external Secret controller is installed and owned by the named platform owner."
  type        = bool
  default     = false
}

variable "secret_controller_owner" {
  description = "Lifecycle owner for the selected external Secret controller."
  type        = string
  default     = null
  nullable    = true
}

variable "secret_rotation_owner" {
  description = "Owner responsible for source rotation, rollout and rollback evidence."
  type        = string
  default     = null
  nullable    = true
}

variable "secret_source_prefix" {
  description = "Non-secret reference prefix in the approved source; no secret value enters Terraform."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.secret_source_prefix == null || can(regex(
      "^[a-zA-Z0-9/_+=.@-]+$",
      var.secret_source_prefix,
    ))
    error_message = "secret_source_prefix must be null or a path-like non-secret reference."
  }
}
