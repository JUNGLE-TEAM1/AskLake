variable "name_prefix" {
  type = string
}

variable "log_retention_days" {
  type = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.log_retention_days)
    error_message = "log_retention_days must be a bounded CloudWatch retention value."
  }
}
