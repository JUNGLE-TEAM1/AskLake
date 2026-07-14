variable "name_prefix" {
  type = string
}

variable "region" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "availability_zones" {
  type = list(string)
}

variable "private_subnet_cidrs" {
  type = list(string)

  validation {
    condition     = length(var.private_subnet_cidrs) == 3
    error_message = "The staging network requires exactly three private subnets."
  }
}
