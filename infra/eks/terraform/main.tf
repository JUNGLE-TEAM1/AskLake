locals {
  create_cluster = var.cluster_mode == "create"
  cluster_name   = local.create_cluster ? "${var.name_prefix}-${var.environment}" : var.existing_cluster_name

  ecr_repositories = var.create_ecr_repositories ? {
    for component in var.ecr_repository_names :
    component => "${var.name_prefix}/${var.environment}/${component}"
  } : {}
}

check "existing_cluster_name" {
  assert {
    condition     = local.create_cluster || (var.existing_cluster_name != null && trimspace(var.existing_cluster_name) != "")
    error_message = "existing mode requires existing_cluster_name."
  }
}

check "mvp_owned_resource_creation" {
  assert {
    condition = !(
      local.create_cluster ||
      var.create_ecr_repositories
    ) || var.resource_lifecycle == "mvp-owned"
    error_message = "resources created by this state must use resource_lifecycle=mvp-owned. Shared and external resources are references only."
  }
}

check "existing_auto_mode_contract" {
  assert {
    condition = local.create_cluster || (
      var.existing_auto_mode_enabled &&
      var.existing_auto_mode_node_role_arn != null &&
      trimspace(var.existing_auto_mode_node_role_arn) != ""
    )
    error_message = "existing mode requires explicit Auto Mode confirmation and its externally managed node role ARN."
  }
}

check "new_auto_mode_admin_access" {
  assert {
    condition     = !local.create_cluster || (var.cluster_admin_principal_arn != null && trimspace(var.cluster_admin_principal_arn) != "")
    error_message = "create mode requires an explicit cluster_admin_principal_arn because bootstrap creator admin access is disabled."
  }
}

data "aws_eks_cluster" "existing" {
  count = local.create_cluster ? 0 : 1
  name  = var.existing_cluster_name
}

resource "aws_iam_role" "cluster" {
  count = local.create_cluster ? 1 : 0
  name  = "${var.name_prefix}-${var.environment}-eks-cluster"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "eks.amazonaws.com"
      }
      Action = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role_policy_attachment" "auto_cluster" {
  for_each = local.create_cluster ? toset([
    "AmazonEKSClusterPolicy",
    "AmazonEKSComputePolicy",
    "AmazonEKSBlockStoragePolicy",
    "AmazonEKSLoadBalancingPolicy",
    "AmazonEKSNetworkingPolicy",
  ]) : toset([])

  role       = aws_iam_role.cluster[0].name
  policy_arn = "arn:aws:iam::aws:policy/${each.value}"
}

resource "aws_iam_role" "auto_node" {
  count = local.create_cluster ? 1 : 0
  name  = "${var.name_prefix}-${var.environment}-eks-auto-node"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "auto_node" {
  for_each = local.create_cluster ? toset([
    "AmazonEKSWorkerNodeMinimalPolicy",
    "AmazonEC2ContainerRegistryPullOnly",
  ]) : toset([])

  role       = aws_iam_role.auto_node[0].name
  policy_arn = "arn:aws:iam::aws:policy/${each.value}"
}

resource "aws_eks_cluster" "this" {
  count                         = local.create_cluster ? 1 : 0
  name                          = local.cluster_name
  role_arn                      = aws_iam_role.cluster[0].arn
  version                       = var.kubernetes_version
  bootstrap_self_managed_addons = false

  enabled_cluster_log_types = var.enabled_cluster_log_types

  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }

  compute_config {
    enabled       = true
    node_pools    = var.auto_mode_builtin_node_pools
    node_role_arn = aws_iam_role.auto_node[0].arn
  }

  kubernetes_network_config {
    elastic_load_balancing {
      enabled = true
    }
  }

  storage_config {
    block_storage {
      enabled = true
    }
  }

  vpc_config {
    subnet_ids              = local.effective_cluster_subnet_ids
    endpoint_private_access = var.endpoint_private_access
    endpoint_public_access  = var.endpoint_public_access
    public_access_cidrs     = var.endpoint_public_access ? var.public_access_cidrs : []
  }

  lifecycle {
    precondition {
      condition     = length(local.effective_cluster_subnet_ids) >= 2
      error_message = "create mode requires at least two reviewed control-plane subnets."
    }

    precondition {
      condition     = var.endpoint_private_access || var.endpoint_public_access
      error_message = "at least one EKS API endpoint mode must be enabled."
    }

    precondition {
      condition     = !var.endpoint_public_access || length(var.public_access_cidrs) > 0
      error_message = "public EKS endpoint access requires an explicit CIDR allowlist."
    }

    precondition {
      condition     = alltrue([for cidr in var.public_access_cidrs : cidr != "0.0.0.0/0"])
      error_message = "0.0.0.0/0 is not allowed for the EKS public endpoint."
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.auto_cluster,
    aws_iam_role_policy_attachment.auto_node,
  ]
}

resource "aws_eks_access_entry" "cluster_admin" {
  count = local.create_cluster && var.cluster_admin_principal_arn != null ? 1 : 0

  cluster_name  = aws_eks_cluster.this[0].name
  principal_arn = var.cluster_admin_principal_arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "cluster_admin" {
  count = local.create_cluster && var.cluster_admin_principal_arn != null ? 1 : 0

  cluster_name  = aws_eks_cluster.this[0].name
  principal_arn = var.cluster_admin_principal_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }

  depends_on = [aws_eks_access_entry.cluster_admin]
}

resource "aws_ecr_repository" "workload" {
  for_each = local.ecr_repositories

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.ecr_force_delete

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "workload" {
  for_each = var.ecr_untagged_retention_days == null ? {} : aws_ecr_repository.workload

  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images after 14 days"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = var.ecr_untagged_retention_days
      }
      action = {
        type = "expire"
      }
    }]
  })
}
