variable "custom_node_pool_mode" {
  description = "Phase 12 custom NodeClass/NodePool access ownership. disabled creates nothing; create provisions an MVP-owned node role/access entry; external-confirmed only records an externally managed contract."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "create", "external-confirmed"], var.custom_node_pool_mode)
    error_message = "custom_node_pool_mode must be disabled, create, or external-confirmed."
  }
}

variable "existing_custom_node_role_name" {
  description = "IAM role name placed in custom EKS Auto Mode NodeClass manifests when access ownership is external-confirmed."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.existing_custom_node_role_name == null || can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.existing_custom_node_role_name))
    error_message = "existing_custom_node_role_name must be null or a valid IAM role name."
  }
}

variable "existing_custom_node_role_arn" {
  description = "Externally managed custom Auto Mode node role ARN. Terraform does not import or mutate it."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.existing_custom_node_role_arn == null || can(regex("^arn:aws:iam::[0-9]{12}:role/.+$", var.existing_custom_node_role_arn))
    error_message = "existing_custom_node_role_arn must be null or an IAM role ARN."
  }
}

variable "existing_custom_node_access_ready" {
  description = "Explicit confirmation that the external custom node role has an EC2 access entry and AmazonEKSAutoNodePolicy association."
  type        = bool
  default     = false
}
