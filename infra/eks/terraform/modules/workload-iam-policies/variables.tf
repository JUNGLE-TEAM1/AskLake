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

variable "msk_topic_arns" {
  type = list(string)

  validation {
    condition = (
      length(var.msk_topic_arns) <= 3 &&
      length(var.msk_topic_arns) == length(toset(var.msk_topic_arns)) &&
      alltrue([
        for arn in var.msk_topic_arns :
        can(regex("^arn:[^:]+:kafka:[^:]+:[0-9]{12}:topic/[^/]+/[^/]+/[^/*]+$", arn))
      ])
    )
    error_message = "msk_topic_arns must contain at most three unique exact MSK topic ARNs without wildcard resources."
  }
}

variable "msk_group_arns" {
  type = list(string)

  validation {
    condition = (
      length(var.msk_group_arns) <= 7 &&
      length(var.msk_group_arns) == length(toset(var.msk_group_arns)) &&
      alltrue([
        for arn in var.msk_group_arns :
        can(regex("^arn:[^:]+:kafka:[^:]+:[0-9]{12}:group/[^/]+/[^/]+/[^/*]+$", arn))
      ])
    )
    error_message = "msk_group_arns must contain at most seven unique exact MSK group ARNs without wildcard resources."
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
    raw                = string
    output             = string
    warehouse          = string
    query_results      = string
    checkpoint         = string
    quarantine         = string
    evidence           = string
    continuous_runtime = string
  })
}
