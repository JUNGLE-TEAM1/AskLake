variable "ingress_mode" {
  description = "Keep ingress disabled or render the reviewed EKS Auto Mode ALB contract."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "auto-mode-alb"], var.ingress_mode)
    error_message = "ingress_mode must be disabled or auto-mode-alb."
  }
}

variable "alb_exposure" {
  description = "Reviewed ALB scheme; null while public versus internal exposure is undecided."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.alb_exposure == null || contains(["internal", "internet-facing"], var.alb_exposure)
    error_message = "alb_exposure must be null, internal, or internet-facing."
  }
}

variable "alb_target_type" {
  description = "Reviewed EKS Auto Mode ALB target type."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.alb_target_type == null || contains(["ip", "instance"], var.alb_target_type)
    error_message = "alb_target_type must be null, ip, or instance."
  }
}

variable "alb_ip_address_type" {
  description = "Reviewed ALB address family. Keep null until VPC and client requirements are known."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.alb_ip_address_type == null || contains(["ipv4", "dualstack"], var.alb_ip_address_type)
    error_message = "alb_ip_address_type must be null, ipv4, or dualstack."
  }
}

variable "ingress_host" {
  description = "Approved DNS hostname. Null until Route 53/domain ownership is confirmed."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.ingress_host == null || can(regex(
      "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$",
      var.ingress_host,
    ))
    error_message = "ingress_host must be null or an exact lowercase DNS hostname."
  }
}

variable "ingress_certificate_arn" {
  description = "Approved ACM certificate ARN reference. Certificate material never enters Terraform."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.ingress_certificate_arn == null || can(regex(
      "^arn:(aws|aws-us-gov|aws-cn):acm:[a-z0-9-]+:[0-9]{12}:certificate/[0-9a-f-]+$",
      var.ingress_certificate_arn,
    ))
    error_message = "ingress_certificate_arn must be null or a valid ACM certificate ARN."
  }
}

variable "ingress_dns_owner" {
  description = "Team or person responsible for validating the hostname and creating/removing its DNS record after the ALB hostname exists."
  type        = string
  default     = null
  nullable    = true
}

variable "private_egress_mode" {
  description = "Reviewed private subnet egress design. Cost-bearing NAT/endpoints remain undecided by default."
  type        = string
  default     = "undecided"

  validation {
    condition     = contains(["undecided", "nat_gateway", "vpc_endpoints", "hybrid"], var.private_egress_mode)
    error_message = "private_egress_mode must be undecided, nat_gateway, vpc_endpoints, or hybrid."
  }
}

variable "pod_network_enforcement" {
  description = "Reviewed Pod traffic enforcement mechanism; this state does not install a shared CNI add-on."
  type        = string
  default     = "undecided"

  validation {
    condition = contains([
      "undecided",
      "vpc_cni_network_policy",
      "security_groups_for_pods",
      "both",
    ], var.pod_network_enforcement)
    error_message = "pod_network_enforcement must be undecided, vpc_cni_network_policy, security_groups_for_pods, or both."
  }
}
