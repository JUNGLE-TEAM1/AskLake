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

variable "airflow_api_auth_mode" {
  description = "Keep Airflow API authentication undecided or record the reviewed token/basic-auth contract."
  type        = string
  default     = "undecided"

  validation {
    condition     = contains(["undecided", "api_token", "username_password"], var.airflow_api_auth_mode)
    error_message = "airflow_api_auth_mode must be undecided, api_token, or username_password."
  }
}

variable "ai_runtime_mode" {
  description = "Keep the AI runtime undecided or record the reviewed gateway/direct contract."
  type        = string
  default     = "undecided"

  validation {
    condition     = contains(["undecided", "gateway", "direct"], var.ai_runtime_mode)
    error_message = "ai_runtime_mode must be undecided, gateway, or direct."
  }
}

variable "ai_provider_workload_contract_ready" {
  description = "True only after a separate AI provider workload image, identity, network and provider-key contract is approved."
  type        = bool
  default     = false
}
