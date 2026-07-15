locals {
  alb_ingress_enabled = var.ingress_mode == "auto-mode-alb"
  alb_subnet_ids = !local.alb_ingress_enabled ? [] : (
    var.alb_exposure == "internet-facing" ? (
      local.create_network ? local.created_public_subnet_ids : var.external_public_subnet_ids
      ) : var.alb_exposure == "internal" ? (
      local.create_network ? local.created_private_subnet_ids : try(
        local.create_cluster ? local.effective_cluster_subnet_ids : data.aws_eks_cluster.existing[0].vpc_config[0].subnet_ids,
        [],
      )
    ) : []
  )
  alb_subnet_selection_complete = local.create_network ? (
    length(var.network_availability_zones) >= 2 &&
    length(distinct(var.network_availability_zones)) == length(var.network_availability_zones)
    ) : (
    length(local.alb_subnet_ids) >= 2 &&
    length(distinct(local.alb_subnet_ids)) == length(local.alb_subnet_ids)
  )
  ingress_inputs_complete = (
    local.alb_ingress_enabled &&
    var.alb_exposure != null &&
    var.alb_target_type != null &&
    var.alb_ip_address_type != null &&
    try(trimspace(var.ingress_host), "") != "" &&
    try(trimspace(var.ingress_certificate_arn), "") != "" &&
    try(trimspace(var.ingress_dns_owner), "") != "" &&
    local.alb_subnet_selection_complete
  )
  private_network_decisions_complete = (
    var.private_egress_mode != "undecided" &&
    var.pod_network_enforcement != "undecided"
  )
}

check "alb_ingress_contract" {
  assert {
    condition     = !local.alb_ingress_enabled || local.ingress_inputs_complete
    error_message = "Auto Mode ALB requires exposure, target/address type, exact host, ACM certificate, DNS owner, and at least two distinct reviewed subnets."
  }
}

check "alb_subnet_contract" {
  assert {
    condition     = !local.alb_ingress_enabled || local.alb_subnet_selection_complete
    error_message = "Auto Mode ALB requires at least two distinct subnets from the selected public or private Phase 11 network path."
  }
}

check "disabled_ingress_has_no_runtime_values" {
  assert {
    condition = local.alb_ingress_enabled || (
      var.alb_exposure == null &&
      var.alb_target_type == null &&
      var.alb_ip_address_type == null &&
      var.ingress_host == null &&
      var.ingress_certificate_arn == null &&
      var.ingress_dns_owner == null
    )
    error_message = "disabled ingress must not carry partially approved ALB runtime values."
  }
}
