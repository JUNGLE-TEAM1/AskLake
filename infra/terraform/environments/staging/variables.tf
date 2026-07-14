variable "region" {
  description = "AWS staging region."
  type        = string
  default     = "ap-northeast-2"

  validation {
    condition     = var.region == "ap-northeast-2"
    error_message = "Issue #727 staging is restricted to ap-northeast-2."
  }
}

variable "aws_account_id" {
  description = "Twelve-digit AWS account ID used for globally unique names and IAM boundaries."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must contain exactly 12 digits."
  }
}

variable "stack_id" {
  description = "Unique 3-16 character staging stack identifier."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,15}$", var.stack_id))
    error_message = "stack_id must match ^[a-z0-9][a-z0-9-]{2,15}$."
  }
}

variable "expires_at" {
  description = "ISO-8601 expiry timestamp used by TTL cleanup and cost tags."
  type        = string

  validation {
    condition     = can(formatdate("YYYY-MM-DD'T'hh:mm:ssZ", var.expires_at))
    error_message = "expires_at must be an ISO-8601 timestamp."
  }
}

variable "availability_zones" {
  description = "Three Seoul availability zones used by private subnets."
  type        = list(string)
  default = [
    "ap-northeast-2a",
    "ap-northeast-2b",
    "ap-northeast-2c",
  ]

  validation {
    condition = length(var.availability_zones) == 3 && alltrue([
      for zone in var.availability_zones : startswith(zone, "ap-northeast-2")
    ])
    error_message = "availability_zones must contain exactly three ap-northeast-2 zones."
  }
}

variable "github_oidc_role_arn" {
  description = "Platform-owned GitHub OIDC role used to run plan/apply/destroy."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/.+", var.github_oidc_role_arn))
    error_message = "github_oidc_role_arn must be an IAM role ARN."
  }
}

variable "available_emr_serverless_concurrent_vcpu" {
  description = "Account quota observed before apply; the Phase 1 stack requires at least 16 vCPU."
  type        = number

  validation {
    condition     = var.available_emr_serverless_concurrent_vcpu >= 16
    error_message = "The account must expose at least 16 EMR Serverless concurrent vCPU."
  }
}

variable "budget_notification_email" {
  description = "External email subscriber for stack-scoped AWS Budget notifications."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.budget_notification_email))
    error_message = "budget_notification_email must be a valid email address."
  }
}

variable "enable_smoke_runner" {
  description = "Create the private SSM smoke runner. It remains off for plan-only validation."
  type        = bool
  default     = false
}

variable "smoke_runner_ami_id" {
  description = "Approved Seoul AMI with SSM Agent and the prebuilt AskLake smoke bundle prerequisites."
  type        = string
  default     = null
  nullable    = true
}

variable "smoke_runner_instance_type" {
  description = "Bounded smoke runner instance type."
  type        = string
  default     = "t3.small"

  validation {
    condition     = contains(["t3.small", "t3.medium"], var.smoke_runner_instance_type)
    error_message = "The Phase 1 smoke runner is limited to t3.small or t3.medium."
  }
}
