output "batch_application_id" {
  value = aws_emrserverless_application.this["batch"].id
}

output "batch_application_arn" {
  value = aws_emrserverless_application.this["batch"].arn
}

output "continuous_application_id" {
  value = aws_emrserverless_application.this["continuous"].id
}

output "continuous_application_arn" {
  value = aws_emrserverless_application.this["continuous"].arn
}

output "maximum_vcpu" {
  value = var.maximum_vcpu
}

output "capacity_contract" {
  value = {
    release_label           = var.release_label
    architecture            = "X86_64"
    maximum_vcpu            = var.maximum_vcpu
    maximum_memory_gb       = var.maximum_memory_gb
    maximum_disk_gb         = var.maximum_disk_gb
    maximum_concurrent_runs = 1
    queue_timeout_minutes   = 15
    auto_stop_idle_minutes  = var.auto_stop_idle_minutes
    driver = {
      cores     = var.driver_cores
      memory_gb = var.driver_memory_gb
      disk_gb   = var.driver_disk_gb
    }
    executor = {
      cores             = var.executor_cores
      memory_gb         = var.executor_memory_gb
      disk_gb           = var.executor_disk_gb
      minimum_executors = var.minimum_executors
      initial_executors = var.initial_executors
      maximum_executors = var.maximum_executors
    }
  }
}
