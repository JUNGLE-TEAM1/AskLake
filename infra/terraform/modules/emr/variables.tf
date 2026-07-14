variable "name_prefix" {
  type = string
}

variable "release_label" {
  type = string

  validation {
    condition     = var.release_label == "emr-7.9.0"
    error_message = "AskLake graceful pause/resume requires emr-7.9.0."
  }
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "report_bucket_name" {
  type = string
}

variable "report_kms_key_arn" {
  type = string
}

variable "batch_log_group_name" {
  type = string
}

variable "continuous_log_group_name" {
  type = string
}

variable "maximum_vcpu" {
  type = number

  validation {
    condition     = var.maximum_vcpu == 16
    error_message = "The Phase 1 application vCPU cap must remain 16."
  }
}

variable "maximum_memory_gb" {
  type = number
}

variable "maximum_disk_gb" {
  type = number
}

variable "driver_cores" {
  type = number
}

variable "driver_memory_gb" {
  type = number
}

variable "driver_disk_gb" {
  type = number
}

variable "executor_cores" {
  type = number
}

variable "executor_memory_gb" {
  type = number
}

variable "executor_disk_gb" {
  type = number
}

variable "minimum_executors" {
  type = number
}

variable "initial_executors" {
  type = number
}

variable "maximum_executors" {
  type = number
}

variable "auto_stop_idle_minutes" {
  type = number
}
