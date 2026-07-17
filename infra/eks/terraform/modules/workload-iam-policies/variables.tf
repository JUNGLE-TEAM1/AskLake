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

variable "msk_group_arns" {
  type = list(string)

  validation {
    condition = (
      length(var.msk_group_arns) <= 5 &&
      length(var.msk_group_arns) == length(toset(var.msk_group_arns)) &&
      alltrue([
        for arn in var.msk_group_arns :
        can(regex("^arn:[^:]+:kafka:[^:]+:[0-9]{12}:group/[^/]+/[^/]+/[^/*]+$", arn))
      ])
    )
    error_message = "msk_group_arns must contain at most five unique exact MSK group ARNs without wildcard resources."
  }
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
