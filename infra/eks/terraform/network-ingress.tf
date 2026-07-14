locals {
  alb_ingress_enabled = var.ingress_mode == "alb"
  ingress_inputs_complete = (
    local.alb_ingress_enabled &&
    var.alb_controller_ready &&
    try(trimspace(var.alb_controller_owner), "") != "" &&
    var.alb_exposure != null &&
    var.alb_target_type != null &&
    try(trimspace(var.ingress_host), "") != "" &&
    try(trimspace(var.ingress_certificate_arn), "") != ""
  )
  private_network_decisions_complete = (
    var.private_egress_mode != "undecided" &&
    var.pod_network_enforcement != "undecided"
  )
}

check "alb_ingress_contract" {
  assert {
    condition     = !local.alb_ingress_enabled || local.ingress_inputs_complete
    error_message = "ALB ingress requires a ready controller with an owner, exposure, target type, exact host, and ACM certificate ARN."
  }
}

check "disabled_ingress_has_no_runtime_values" {
  assert {
    condition = local.alb_ingress_enabled || (
      !var.alb_controller_ready &&
      var.alb_controller_owner == null &&
      var.alb_exposure == null &&
      var.alb_target_type == null &&
      var.ingress_host == null &&
      var.ingress_certificate_arn == null
    )
    error_message = "disabled ingress must not carry partially approved ALB runtime values."
  }
}
