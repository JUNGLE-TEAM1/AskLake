output "cluster_name" {
  description = "Cluster name consumed by kubeconfig and deployment workflows."
  value       = local.cluster_name
}

output "cluster_endpoint" {
  description = "Sensitive deployment input; do not copy into repository docs."
  value       = local.create_cluster ? aws_eks_cluster.this[0].endpoint : data.aws_eks_cluster.existing[0].endpoint
  sensitive   = true
}

output "cluster_certificate_authority_data" {
  description = "Sensitive deployment input used to configure Kubernetes clients."
  value       = local.create_cluster ? aws_eks_cluster.this[0].certificate_authority[0].data : data.aws_eks_cluster.existing[0].certificate_authority[0].data
  sensitive   = true
}

output "cluster_oidc_issuer" {
  description = "Input for the selected IRSA or Pod Identity implementation."
  value       = local.create_cluster ? aws_eks_cluster.this[0].identity[0].oidc[0].issuer : data.aws_eks_cluster.existing[0].identity[0].oidc[0].issuer
}

output "cluster_vpc_id" {
  description = "VPC identity used by MSK, RDS, Trino and security-group contract wiring."
  value       = try(local.create_cluster ? aws_eks_cluster.this[0].vpc_config[0].vpc_id : data.aws_eks_cluster.existing[0].vpc_config[0].vpc_id, null)
}

output "cluster_security_group_id" {
  description = "EKS-managed cluster security group reference. Workload-specific ingress remains explicit."
  value       = try(local.create_cluster ? aws_eks_cluster.this[0].vpc_config[0].cluster_security_group_id : data.aws_eks_cluster.existing[0].vpc_config[0].cluster_security_group_id, null)
}

output "cluster_subnet_ids" {
  description = "Control-plane subnet references for inventory and network handoff."
  value       = try(local.create_cluster ? local.effective_cluster_subnet_ids : data.aws_eks_cluster.existing[0].vpc_config[0].subnet_ids, [])
}

output "auto_mode_handoff" {
  description = "Non-secret EKS Auto Mode capability and ownership contract."
  value = {
    enabled            = true
    ownership          = local.create_cluster ? "terraform" : "external-confirmed"
    authentication     = "API"
    node_role_arn      = local.create_cluster ? aws_iam_role.auto_node[0].arn : var.existing_auto_mode_node_role_arn
    builtin_node_pools = local.create_cluster ? var.auto_mode_builtin_node_pools : toset([])
    custom_node_pools  = "phase12_node_pool_handoff"
    capabilities = {
      compute        = true
      load_balancing = true
      block_storage  = true
    }
  }
}

output "namespace" {
  value = var.namespace
}

output "service_account_names" {
  value = var.service_account_names
}

output "ecr_repository_urls" {
  value = {
    for component, repository in aws_ecr_repository.workload :
    component => repository.repository_url
  }
}

output "trino_handoff" {
  description = "Non-secret EKS Trino deployment contract. Null AWS values remain explicit resource-creation gates."
  value = {
    service_account_name = var.service_account_names["trino"]
    irsa_role_arn = (
      local.use_pod_identity ? null :
      local.use_irsa ? try(aws_iam_role.workload["trino"].arn, null) :
      var.trino_irsa_role_arn
    )
    image = {
      repository_url = try(aws_ecr_repository.workload["trino"].repository_url, null)
      digest         = var.trino_image_digest
    }
    service = {
      name           = var.trino_service_name
      namespace      = var.namespace
      scheme         = "https"
      port           = var.trino_service_port
      in_cluster_url = "https://${var.trino_service_name}.${var.namespace}.svc:${var.trino_service_port}"
    }
    iceberg_catalog = {
      database               = var.trino_iceberg_catalog_database
      rds_endpoint_reference = var.trino_rds_endpoint_reference
      jdbc_secret_name       = var.trino_jdbc_secret_name
      warehouse_bucket_ref   = var.trino_warehouse_bucket_reference
      warehouse_prefix_ref   = var.trino_warehouse_prefix_reference
    }
    tls_auth_secret_name = var.trino_tls_auth_secret_name
    network = {
      rds = {
        protocol                 = "tcp"
        port                     = 5432
        security_group_reference = var.trino_rds_security_group_reference
      }
      s3_sts = {
        protocol = "https"
        port     = 443
      }
    }
  }
}

output "phase1_handoff" {
  description = "Non-secret fields Pair B can consume without reading Terraform internals."
  value = {
    contract_version = "2.2"
    aws_region       = var.aws_region
    environment      = var.environment
    cluster_name     = local.cluster_name
    namespace        = var.namespace
    service_accounts = var.service_account_names
    image_delivery   = "immutable-ecr-digest"
    kafka_runtime    = "msk-serverless"
    kafka_auth       = "iam"
    trino_runtime    = "eks"
    trino_output     = "trino_handoff"
    continuous_owner = "ec2-mvp"
    cluster_compute  = "eks-auto-mode"
    auto_mode_output = "auto_mode_handoff"
    network_output   = "phase11_network_handoff"
    node_pool_output = "phase12_node_pool_handoff"
    network_outputs = {
      vpc                    = "cluster_vpc_id"
      cluster_security_group = "cluster_security_group_id"
      control_plane_subnets  = "cluster_subnet_ids"
    }
  }
}
