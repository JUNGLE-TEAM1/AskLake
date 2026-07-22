variable "workload_identity_mode" {
  description = "Keep workload identity disabled or explicitly select IRSA or EKS Pod Identity after the platform review."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "irsa", "pod_identity"], var.workload_identity_mode)
    error_message = "workload_identity_mode must be disabled, irsa, or pod_identity."
  }
}

variable "irsa_oidc_provider_arn" {
  description = "Existing IAM OIDC provider ARN for the selected EKS cluster. Required only for IRSA; provider creation remains a platform decision."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.irsa_oidc_provider_arn == null || can(regex("^arn:aws:iam::[0-9]{12}:oidc-provider/.+$", var.irsa_oidc_provider_arn))
    error_message = "irsa_oidc_provider_arn must be null or an IAM OIDC provider ARN."
  }
}

variable "pod_identity_agent_ready" {
  description = "Explicit confirmation that the EKS Pod Identity Agent is installed and owned outside this application state."
  type        = bool
  default     = false
}
