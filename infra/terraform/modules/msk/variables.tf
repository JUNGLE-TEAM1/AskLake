variable "cluster_name" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)

  validation {
    condition     = length(var.private_subnet_ids) == 3
    error_message = "MSK Serverless must use all three staging private subnets."
  }
}

variable "security_group_id" {
  type = string
}
