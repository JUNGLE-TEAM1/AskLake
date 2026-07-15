variable "aws_region" {
  description = "AWS region for EKS and ECR resources."
  type        = string
  default     = "ap-northeast-2"
}

variable "environment" {
  description = "Deployment environment used in names and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging"], var.environment)
    error_message = "environment must be dev or staging for the MVP foundation."
  }
}

variable "name_prefix" {
  description = "Stable resource name prefix."
  type        = string
  default     = "asklake"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name_prefix))
    error_message = "name_prefix must be a lowercase DNS-compatible prefix."
  }
}

variable "owner" {
  description = "Team or person responsible for lifecycle decisions."
  type        = string
}

variable "resource_lifecycle" {
  description = "Resource lifecycle classification."
  type        = string
  default     = "mvp-owned"

  validation {
    condition     = contains(["mvp-owned", "shared", "external"], var.resource_lifecycle)
    error_message = "resource_lifecycle must be mvp-owned, shared, or external."
  }
}

variable "additional_tags" {
  description = "Additional non-secret AWS resource tags."
  type        = map(string)
  default     = {}
}

variable "cluster_mode" {
  description = "Use an existing EKS cluster or create an MVP-owned cluster."
  type        = string

  validation {
    condition     = contains(["existing", "create"], var.cluster_mode)
    error_message = "cluster_mode must be existing or create."
  }
}

variable "existing_cluster_name" {
  description = "Required when cluster_mode is existing."
  type        = string
  default     = null
  nullable    = true
}

variable "kubernetes_version" {
  description = "Explicit EKS Kubernetes version for a new cluster. Confirm support before apply."
  type        = string
  default     = null
  nullable    = true
}

variable "control_plane_subnet_ids" {
  description = "At least two subnets in different AZs for a newly created EKS control plane."
  type        = list(string)
  default     = []
}

variable "endpoint_private_access" {
  description = "Enable the private Kubernetes API endpoint for a new cluster."
  type        = bool
  default     = true
}

variable "endpoint_public_access" {
  description = "Enable the public Kubernetes API endpoint for a new cluster."
  type        = bool
  default     = false
}

variable "public_access_cidrs" {
  description = "Explicit allowlist when endpoint_public_access is true. Never use 0.0.0.0/0 for shared environments."
  type        = list(string)
  default     = []
}

variable "enabled_cluster_log_types" {
  description = "EKS control-plane logs enabled for a newly created cluster."
  type        = list(string)
  default     = ["api", "audit", "authenticator"]
}

variable "existing_auto_mode_enabled" {
  description = "Explicit confirmation that an externally owned existing cluster has all EKS Auto Mode capabilities enabled."
  type        = bool
  default     = false
}

variable "existing_auto_mode_node_role_arn" {
  description = "Externally managed EKS Auto Mode node role ARN for an existing cluster."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.existing_auto_mode_node_role_arn == null || can(regex("^arn:aws:iam::[0-9]{12}:role/.+$", var.existing_auto_mode_node_role_arn))
    error_message = "existing_auto_mode_node_role_arn must be null or an IAM role ARN."
  }
}

variable "auto_mode_builtin_node_pools" {
  description = "AWS-managed built-in NodePools enabled at cluster creation. Custom General/Spark pools are a later phase."
  type        = set(string)
  default     = ["general-purpose", "system"]

  validation {
    condition     = var.auto_mode_builtin_node_pools == toset(["general-purpose", "system"])
    error_message = "auto_mode_builtin_node_pools must contain exactly general-purpose and system for the Phase 10 baseline."
  }
}

variable "cluster_admin_principal_arn" {
  description = "Explicit IAM role/user granted EKS cluster-admin through an access entry for a newly created Auto Mode cluster."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.cluster_admin_principal_arn == null || can(regex("^arn:aws:iam::[0-9]{12}:(role|user)/.+$", var.cluster_admin_principal_arn))
    error_message = "cluster_admin_principal_arn must be null or an IAM role/user ARN, never an STS session ARN."
  }
}

variable "ecr_repository_names" {
  description = "Component suffixes for immutable ECR repositories."
  type        = set(string)
  default = [
    "frontend",
    "backend",
    "airflow",
    "trino",
    "spark-runtime",
  ]

  validation {
    condition = alltrue([
      for component in ["frontend", "backend", "airflow", "trino", "spark-runtime"] :
      contains(var.ecr_repository_names, component)
    ])
    error_message = "ecr_repository_names must include frontend, backend, airflow, trino, and spark-runtime."
  }
}

variable "create_ecr_repositories" {
  description = "Create MVP-owned workload ECR repositories in this state."
  type        = bool
  default     = true
}

variable "ecr_force_delete" {
  description = "Keep false so destroy cannot silently delete images."
  type        = bool
  default     = false
}

variable "ecr_untagged_retention_days" {
  description = "Optional untagged image retention. Null keeps automatic deletion disabled until policy approval."
  type        = number
  default     = null
  nullable    = true

  validation {
    condition     = var.ecr_untagged_retention_days == null || var.ecr_untagged_retention_days >= 1
    error_message = "ecr_untagged_retention_days must be null or at least 1 day."
  }
}

variable "namespace" {
  description = "Kubernetes namespace handed to Helm and Pair B."
  type        = string
  default     = "asklake-dev"

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", var.namespace))
    error_message = "namespace must be a DNS-compatible Kubernetes namespace."
  }
}

variable "service_account_names" {
  description = "Stable workload service account names. IAM roles are attached only after B supplies least-privilege actions."
  type        = map(string)
  default = {
    frontend = "asklake-frontend"
    backend  = "asklake-backend"
    airflow  = "asklake-airflow"
    trino    = "asklake-trino"
    mskSmoke = "asklake-msk-smoke"
    spark    = "asklake-spark"
  }

  validation {
    condition = (
      toset(keys(var.service_account_names)) == toset(["frontend", "backend", "airflow", "trino", "mskSmoke", "spark"]) &&
      alltrue([
        for name in values(var.service_account_names) :
        can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", name))
      ])
    )
    error_message = "service_account_names must define DNS-compatible frontend, backend, airflow, trino, mskSmoke, and spark names."
  }
}

variable "trino_image_digest" {
  description = "Immutable Trino image digest supplied by the image delivery workflow. Null until a mirror image is pushed."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.trino_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.trino_image_digest))
    error_message = "trino_image_digest must be null or an immutable sha256 digest."
  }
}

variable "trino_irsa_role_arn" {
  description = "IRSA role ARN for asklake-trino. Null until the workload identity and S3 boundary are approved."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.trino_irsa_role_arn == null || can(regex("^arn:aws:iam::[0-9]{12}:role/.+$", var.trino_irsa_role_arn))
    error_message = "trino_irsa_role_arn must be null or an IAM role ARN."
  }
}

variable "trino_service_name" {
  description = "Stable in-cluster Service name for the EKS Trino coordinator."
  type        = string
  default     = "asklake-trino"

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", var.trino_service_name))
    error_message = "trino_service_name must be a DNS-compatible Kubernetes Service name."
  }
}

variable "trino_service_port" {
  description = "HTTPS port exposed by the in-cluster Trino coordinator Service."
  type        = number
  default     = 8443

  validation {
    condition     = var.trino_service_port == 8443
    error_message = "the EKS MVP Trino contract requires HTTPS port 8443."
  }
}

variable "trino_tls_auth_secret_name" {
  description = "Kubernetes Secret reference for Trino TLS, password auth and internal shared secret values."
  type        = string
  default     = "asklake-trino-tls-auth"
}

variable "trino_jdbc_secret_name" {
  description = "Kubernetes Secret reference for the RDS Iceberg JDBC catalog credentials."
  type        = string
  default     = "asklake-trino-iceberg-jdbc"
}

variable "trino_iceberg_catalog_database" {
  description = "Logical RDS PostgreSQL database used by the Iceberg JDBC catalog."
  type        = string
  default     = "iceberg_catalog"
}

variable "trino_rds_endpoint_reference" {
  description = "Non-secret deployment reference that resolves to the RDS Iceberg JDBC endpoint."
  type        = string
  default     = "TRINO_ICEBERG_JDBC_URL"
}

variable "trino_rds_security_group_reference" {
  description = "Security-group reference allowing Trino to reach the RDS Iceberg catalog. Null until AWS inventory is approved."
  type        = string
  default     = null
  nullable    = true
}

variable "trino_warehouse_bucket_reference" {
  description = "Non-secret deployment reference that resolves to the S3 Iceberg warehouse bucket."
  type        = string
  default     = "TRINO_ICEBERG_WAREHOUSE_BUCKET"
}

variable "trino_warehouse_prefix_reference" {
  description = "Non-secret deployment reference that resolves to the S3 Iceberg warehouse prefix."
  type        = string
  default     = "TRINO_ICEBERG_WAREHOUSE_PREFIX"
}
