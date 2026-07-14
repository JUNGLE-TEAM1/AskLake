variable "name_prefix" {
  type = string
}

variable "stack_id" {
  type = string
}

variable "budget_limit_usd" {
  type = number

  validation {
    condition     = var.budget_limit_usd == 30
    error_message = "The Phase 1 smoke budget must remain 30 USD."
  }
}

variable "alert_thresholds_percent" {
  type = list(number)

  validation {
    condition = (
      length(var.alert_thresholds_percent) == 3 &&
      var.alert_thresholds_percent[0] == 50 &&
      var.alert_thresholds_percent[1] == 80 &&
      var.alert_thresholds_percent[2] == 100
    )
    error_message = "Budget alert thresholds must remain 50, 80 and 100 percent."
  }
}

variable "notification_email" {
  type = string
}
