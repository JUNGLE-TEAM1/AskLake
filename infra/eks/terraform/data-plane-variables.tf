variable "msk_mode" {
  description = "Disable MSK wiring, reference an existing cluster, or create an MVP-owned Serverless cluster."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "existing", "create"], var.msk_mode)
    error_message = "msk_mode must be disabled, existing, or create."
  }
}

variable "existing_msk_cluster_arn" {
  description = "Existing MSK Serverless cluster ARN supplied by the deployment environment."
  type        = string
  default     = null
  nullable    = true
}

variable "existing_msk_bootstrap_brokers_sasl_iam" {
  description = "Existing private IAM bootstrap brokers supplied outside repository documentation."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "msk_subnet_ids" {
  description = "Reviewed private subnets used only when creating MSK Serverless."
  type        = list(string)
  default     = []
}

variable "msk_security_group_ids" {
  description = "Security groups allowing only approved IAM clients to reach MSK."
  type        = set(string)
  default     = []
}

variable "msk_test_topic" {
  description = "Topic isolated from the existing EC2 Continuous runtime."
  type        = string
  default     = "asklake.eks-mvp.fixture.v1"

  validation {
    condition     = trimspace(var.msk_test_topic) != ""
    error_message = "msk_test_topic must not be empty."
  }
}

variable "msk_test_consumer_group" {
  description = "Consumer group isolated from the existing EC2 Continuous runtime."
  type        = string
  default     = "asklake-eks-mvp-spark-v1"

  validation {
    condition     = trimspace(var.msk_test_consumer_group) != ""
    error_message = "msk_test_consumer_group must not be empty."
  }
}

variable "rds_mode" {
  description = "Disable RDS wiring, reference an existing instance, or create an MVP-owned PostgreSQL instance."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "existing", "create"], var.rds_mode)
    error_message = "rds_mode must be disabled, existing, or create."
  }
}

variable "existing_rds_endpoint" {
  description = "Existing PostgreSQL endpoint supplied by the deployment environment."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "existing_rds_port" {
  description = "Existing PostgreSQL port."
  type        = number
  default     = 5432
}

variable "existing_rds_master_secret_arn" {
  description = "Existing RDS master secret reference; secret values are never Terraform inputs."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "rds_subnet_ids" {
  description = "Reviewed private subnets used only when creating RDS."
  type        = list(string)
  default     = []
}

variable "rds_security_group_ids" {
  description = "Security groups allowing PostgreSQL only from approved EKS workloads."
  type        = set(string)
  default     = []
}

variable "rds_instance_class" {
  description = "Explicitly reviewed RDS instance class."
  type        = string
  default     = null
  nullable    = true
}

variable "rds_engine_version" {
  description = "Optional PostgreSQL engine version confirmed before apply."
  type        = string
  default     = null
  nullable    = true
}

variable "rds_allocated_storage_gib" {
  description = "Initial encrypted gp3 storage in GiB."
  type        = number
  default     = 20

  validation {
    condition     = var.rds_allocated_storage_gib >= 20
    error_message = "rds_allocated_storage_gib must be at least 20 GiB."
  }
}

variable "rds_max_allocated_storage_gib" {
  description = "Storage autoscaling ceiling for an MVP-owned RDS instance."
  type        = number
  default     = 100

  validation {
    condition     = var.rds_max_allocated_storage_gib >= 20
    error_message = "rds_max_allocated_storage_gib must be at least 20 GiB."
  }
}

variable "rds_backup_retention_days" {
  description = "Automated backup retention for an MVP-owned RDS instance."
  type        = number
  default     = 7

  validation {
    condition     = var.rds_backup_retention_days >= 1
    error_message = "rds_backup_retention_days must be at least 1."
  }
}

variable "rds_multi_az" {
  description = "Enable only after availability and cost review."
  type        = bool
  default     = false
}

variable "rds_backup_window" {
  description = "UTC automated backup window; dev default is 03:00 KST."
  type        = string
  default     = "18:00-18:30"
}

variable "rds_maintenance_window" {
  description = "UTC weekly maintenance window; dev default is Monday 04:00 KST."
  type        = string
  default     = "sun:19:00-sun:20:00"
}

variable "rds_enabled_cloudwatch_logs_exports" {
  description = "PostgreSQL logs exported for bootstrap and upgrade diagnosis."
  type        = set(string)
  default     = ["postgresql", "upgrade"]

  validation {
    condition = alltrue([
      for log_type in var.rds_enabled_cloudwatch_logs_exports :
      contains(["postgresql", "upgrade"], log_type)
    ])
    error_message = "RDS CloudWatch log exports may contain only postgresql and upgrade."
  }
}

variable "rds_final_snapshot_identifier" {
  description = "Explicit unique final snapshot identifier for an MVP-owned RDS instance; change it before recreating a previously destroyed instance."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.rds_final_snapshot_identifier == null || can(regex(
      "^[a-z][a-z0-9-]{1,62}$",
      var.rds_final_snapshot_identifier,
    ))
    error_message = "rds_final_snapshot_identifier must be null or a lowercase RDS-compatible identifier."
  }
}

variable "storage_mode" {
  description = "Disable storage wiring, reference unmanaged buckets, adopt existing buckets into this state, or create MVP-owned buckets."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "existing", "managed-existing", "create"], var.storage_mode)
    error_message = "storage_mode must be disabled, existing, managed-existing, or create."
  }
}

variable "storage_bucket_names" {
  description = "Deployment-provided bucket names; empty defaults keep storage disabled safely."
  type = object({
    raw           = string
    output        = string
    warehouse     = string
    query_results = string
  })
  default = {
    raw           = ""
    output        = ""
    warehouse     = ""
    query_results = ""
  }
}

variable "storage_prefixes" {
  description = "Stable least-privilege prefixes consumed by workloads and IAM policy documents."
  type = object({
    raw           = string
    output        = string
    warehouse     = string
    query_results = string
    checkpoint    = string
    quarantine    = string
    evidence      = string
  })
  default = {
    raw           = "raw"
    output        = "output"
    warehouse     = "warehouse"
    query_results = "query-results"
    checkpoint    = "checkpoints"
    quarantine    = "quarantine"
    evidence      = "evidence"
  }
}

variable "storage_sse_algorithm" {
  description = "Server-side encryption for S3 buckets managed by this state, selected after the environment key-management review."
  type        = string
  default     = "AES256"

  validation {
    condition     = contains(["AES256", "aws:kms"], var.storage_sse_algorithm)
    error_message = "storage_sse_algorithm must be AES256 or aws:kms."
  }
}

variable "storage_kms_key_arn" {
  description = "Approved KMS key ARN when storage_sse_algorithm is aws:kms; never put key material in Terraform variables."
  type        = string
  default     = null
  nullable    = true
}
