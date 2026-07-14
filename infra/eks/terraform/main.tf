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
      var.create_managed_node_group ||
      var.create_ecr_repositories
    ) || var.resource_lifecycle == "mvp-owned"
    error_message = "resources created by this state must use resource_lifecycle=mvp-owned. Shared and external resources are references only."
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
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster_policy" {
  count      = local.create_cluster ? 1 : 0
  role       = aws_iam_role.cluster[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_eks_cluster" "this" {
  count    = local.create_cluster ? 1 : 0
  name     = local.cluster_name
  role_arn = aws_iam_role.cluster[0].arn
  version  = var.kubernetes_version

  enabled_cluster_log_types = var.enabled_cluster_log_types

  vpc_config {
    subnet_ids              = var.control_plane_subnet_ids
    endpoint_private_access = var.endpoint_private_access
    endpoint_public_access  = var.endpoint_public_access
    public_access_cidrs     = var.endpoint_public_access ? var.public_access_cidrs : []
  }

  lifecycle {
    precondition {
      condition     = length(var.control_plane_subnet_ids) >= 2
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

  depends_on = [aws_iam_role_policy_attachment.cluster_policy]
}

resource "aws_iam_role" "node" {
  count = var.create_managed_node_group ? 1 : 0
  name  = "${var.name_prefix}-${var.environment}-eks-node"

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

resource "aws_iam_role_policy_attachment" "node_worker" {
  count      = var.create_managed_node_group ? 1 : 0
  role       = aws_iam_role.node[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_ecr" {
  count      = var.create_managed_node_group ? 1 : 0
  role       = aws_iam_role.node[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly"
}

resource "aws_iam_role_policy_attachment" "node_cni" {
  count      = var.create_managed_node_group ? 1 : 0
  role       = aws_iam_role.node[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_eks_node_group" "baseline" {
  count = var.create_managed_node_group ? 1 : 0

  cluster_name    = local.cluster_name
  node_group_name = "${var.name_prefix}-${var.environment}-baseline"
  node_role_arn   = aws_iam_role.node[0].arn
  subnet_ids      = var.node_subnet_ids
  instance_types  = var.node_instance_types
  capacity_type   = var.node_capacity_type

  scaling_config {
    min_size     = var.node_min_size
    desired_size = var.node_desired_size
    max_size     = var.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    "asklake.io/node-pool" = "baseline"
  }

  lifecycle {
    precondition {
      condition     = length(var.node_subnet_ids) >= 2
      error_message = "managed node group creation requires at least two reviewed subnets."
    }

    precondition {
      condition     = length(var.node_instance_types) > 0
      error_message = "managed node group creation requires an explicitly reviewed instance type."
    }

    precondition {
      condition     = var.node_min_size <= var.node_desired_size && var.node_desired_size <= var.node_max_size
      error_message = "node sizes must satisfy min <= desired <= max."
    }
  }

  depends_on = [
    aws_eks_cluster.this,
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_ecr,
    aws_iam_role_policy_attachment.node_cni,
  ]
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
