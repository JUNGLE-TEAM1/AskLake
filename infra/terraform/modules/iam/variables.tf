variable "name_prefix" {
  type = string
}

variable "region" {
  type = string
}

variable "aws_account_id" {
  type = string
}

variable "topic_namespace" {
  type = string
}

variable "bucket_arns" {
  type = map(string)
}

variable "data_kms_key_arn" {
  type = string
}

variable "msk_cluster_arn" {
  type = string
}

variable "emr_application_arns" {
  type = list(string)
}

variable "log_group_arns" {
  type = map(string)
}
