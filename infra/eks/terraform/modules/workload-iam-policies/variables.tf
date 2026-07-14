variable "reference_msk" {
  type = bool
}

variable "use_storage" {
  type = bool
}

variable "msk_cluster_arn" {
  type     = string
  nullable = true
}

variable "msk_topic_arn" {
  type     = string
  nullable = true
}

variable "msk_group_arn" {
  type     = string
  nullable = true
}

variable "storage_bucket_arns" {
  type = map(string)
}

variable "storage_object_arns" {
  type = map(string)
}

variable "storage_prefixes" {
  type = object({
    raw           = string
    output        = string
    warehouse     = string
    query_results = string
    checkpoint    = string
    quarantine    = string
    evidence      = string
  })
}
