output "phase11_network_handoff" {
  description = "Non-secret VPC placement, egress, and ownership contract for EKS workloads and data-plane resources."
  value = {
    mode      = var.network_mode
    ownership = local.create_network ? "terraform" : "external"
    vpc_id    = local.create_network ? aws_vpc.mvp[0].id : try(local.create_cluster ? aws_eks_cluster.this[0].vpc_config[0].vpc_id : data.aws_eks_cluster.existing[0].vpc_config[0].vpc_id, null)
    subnets = {
      cluster_private = local.create_network ? local.created_private_subnet_ids : try(local.create_cluster ? aws_eks_cluster.this[0].vpc_config[0].subnet_ids : data.aws_eks_cluster.existing[0].vpc_config[0].subnet_ids, [])
      public_alb      = local.create_network ? local.created_public_subnet_ids : var.external_public_subnet_ids
    }
    availability_zones = local.create_network ? var.network_availability_zones : []
    kubernetes_api = {
      private_enabled       = var.endpoint_private_access
      public_enabled        = var.endpoint_public_access
      private_operator_path = var.endpoint_private_access && !var.endpoint_public_access ? "required-before-kubectl" : "environment-specific"
    }
    private_egress = {
      mode                 = var.private_egress_mode
      nat_gateway_mode     = local.use_nat_egress ? var.nat_gateway_mode : null
      interface_endpoints  = local.use_endpoints ? var.interface_vpc_endpoint_services : toset([])
      s3_gateway_endpoint  = local.use_endpoints
      cost_review_required = true
    }
    service_security_groups = {
      msk = try(aws_security_group.msk_private[0].id, null)
      rds = try(aws_security_group.rds_private[0].id, null)
    }
    pod_network_enforcement = var.pod_network_enforcement
    alb_contract            = "phase-13"
    custom_node_placement   = "phase12_node_pool_handoff"
    runtime_smoke_required  = true
  }
}
