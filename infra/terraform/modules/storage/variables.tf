variable "name_prefix" {
  type = string
}

variable "bucket_prefix" {
  type = string

  validation {
    condition     = length("${var.bucket_prefix}-checkpoint") <= 63
    error_message = "bucket_prefix is too long for the longest Phase 1 bucket name."
  }
}
