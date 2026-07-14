variable "enabled" {
  type = bool
}

variable "name_prefix" {
  type = string
}

variable "ami_id" {
  type     = string
  default  = null
  nullable = true
}

variable "instance_type" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "security_group_id" {
  type = string
}

variable "instance_profile_name" {
  type = string
}
