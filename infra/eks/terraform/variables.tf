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

variable "node_subnet_ids" {
  description = "At least two subnets for an optional managed node group. Prefer private subnets after network review."
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

variable "create_managed_node_group" {
  description = "Create the baseline managed node group after subnet and cost review."
  type        = bool
  default     = false
}

variable "node_instance_types" {
  description = "Explicit instance types selected after workload capacity and cost review."
  type        = list(string)
  default     = []
}

variable "node_capacity_type" {
  description = "Baseline node capacity type."
  type        = string
  default     = "ON_DEMAND"

  validation {
    condition     = contains(["ON_DEMAND", "SPOT"], var.node_capacity_type)
    error_message = "node_capacity_type must be ON_DEMAND or SPOT."
  }
}

variable "node_min_size" {
  type    = number
  default = 1
}

variable "node_desired_size" {
  type    = number
  default = 1
}

variable "node_max_size" {
  type    = number
  default = 3
}

variable "ecr_repository_names" {
  description = "Component suffixes for immutable ECR repositories."
  type        = set(string)
  default = [
    "frontend",
    "backend",
    "airflow",
    "replay-producer",
    "spark-runtime",
  ]
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
}

variable "service_account_names" {
  description = "Stable workload service account names. IAM roles are attached only after B supplies least-privilege actions."
  type        = map(string)
  default = {
    frontend       = "asklake-frontend"
    backend        = "asklake-backend"
    airflow        = "asklake-airflow"
    replayProducer = "asklake-replay-producer"
    spark          = "asklake-spark"
  }
}
