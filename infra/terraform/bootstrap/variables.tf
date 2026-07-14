variable "region" {
  description = "AWS region that owns the staging state bucket."
  type        = string
  default     = "ap-northeast-2"

  validation {
    condition     = var.region == "ap-northeast-2"
    error_message = "AskLake staging state must remain in ap-northeast-2."
  }
}

variable "state_bucket_name" {
  description = "Globally unique S3 bucket name for Terraform state."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid S3 bucket name."
  }
}

variable "state_key_prefix" {
  description = "Prefix reserved for AskLake Terraform state objects."
  type        = string
  default     = "asklake"

  validation {
    condition     = var.state_key_prefix == "asklake"
    error_message = "The bootstrap stack only manages the AskLake state prefix."
  }
}
