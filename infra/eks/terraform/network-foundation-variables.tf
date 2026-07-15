variable "network_mode" {
  description = "Reference externally managed subnets or create an MVP-owned VPC foundation."
  type        = string
  default     = "external"

  validation {
    condition     = contains(["external", "create"], var.network_mode)
    error_message = "network_mode must be external or create."
  }
}

variable "vpc_cidr" {
  description = "Reviewed non-overlapping RFC1918 CIDR used only when network_mode is create."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.vpc_cidr == null || try(
      can(cidrnetmask(var.vpc_cidr)) &&
      can(regex("^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)", var.vpc_cidr)) &&
      tonumber(split("/", var.vpc_cidr)[1]) >= 16 &&
      tonumber(split("/", var.vpc_cidr)[1]) <= 28,
      false,
    )
    error_message = "vpc_cidr must be null or an RFC1918 IPv4 CIDR with a /16 through /28 prefix."
  }
}

variable "network_availability_zones" {
  description = "Reviewed Availability Zones for paired public/private subnets."
  type        = list(string)
  default     = []
}

variable "external_public_subnet_ids" {
  description = "At least two externally managed public subnet IDs reserved for a later internet-facing ALB selection; actual distinct-AZ placement requires inventory evidence."
  type        = list(string)
  default     = []
}

variable "subnet_newbits" {
  description = "Additional prefix bits used to derive every equal-sized subnet from vpc_cidr. For example, 8 derives /24 subnets from a /16 VPC."
  type        = number
  default     = null
  nullable    = true
}

variable "public_subnet_netnums" {
  description = "Distinct cidrsubnet netnums paired with network_availability_zones for later public ALB placement."
  type        = list(number)
  default     = []
}

variable "private_subnet_netnums" {
  description = "Distinct cidrsubnet netnums paired with network_availability_zones for EKS Auto Mode, MSK Serverless, and RDS."
  type        = list(number)
  default     = []
}

variable "nat_gateway_mode" {
  description = "NAT cost/availability choice when private_egress_mode uses NAT."
  type        = string
  default     = "undecided"

  validation {
    condition     = contains(["undecided", "single", "per_az"], var.nat_gateway_mode)
    error_message = "nat_gateway_mode must be undecided, single, or per_az."
  }
}

variable "interface_vpc_endpoint_services" {
  description = "Explicit interface endpoint suffixes selected after workload and hourly-cost review. S3 gateway is managed separately."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for service in var.interface_vpc_endpoint_services : contains([
        "autoscaling",
        "ec2",
        "ecr.api",
        "ecr.dkr",
        "eks-auth",
        "elasticloadbalancing",
        "kms",
        "logs",
        "monitoring",
        "secretsmanager",
        "sts",
      ], service)
    ])
    error_message = "interface_vpc_endpoint_services contains an unsupported service suffix."
  }
}
