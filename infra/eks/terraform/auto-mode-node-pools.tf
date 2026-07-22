locals {
  custom_node_access_requested = var.custom_node_pool_mode == "create"
  create_custom_node_access    = local.create_cluster && local.custom_node_access_requested
  external_custom_node_access  = var.custom_node_pool_mode == "external-confirmed"
  custom_node_role_name = (
    local.create_custom_node_access ? aws_iam_role.auto_custom_node[0].name :
    local.external_custom_node_access ? var.existing_custom_node_role_name : null
  )
  custom_node_role_arn = (
    local.create_custom_node_access ? aws_iam_role.auto_custom_node[0].arn :
    local.external_custom_node_access ? var.existing_custom_node_role_arn : null
  )
}

check "custom_node_pool_ownership" {
  assert {
    condition = (
      var.custom_node_pool_mode == "disabled" ||
      (local.create_cluster && var.custom_node_pool_mode == "create") ||
      (!local.create_cluster && var.custom_node_pool_mode == "external-confirmed")
    )
    error_message = "new clusters may use create; existing clusters may use external-confirmed; disabled is valid for both."
  }
}

check "external_custom_node_access" {
  assert {
    condition = !local.external_custom_node_access || (
      var.existing_custom_node_access_ready &&
      var.existing_custom_node_role_name != null &&
      trimspace(var.existing_custom_node_role_name) != "" &&
      var.existing_custom_node_role_arn != null &&
      trimspace(var.existing_custom_node_role_arn) != "" &&
      basename(var.existing_custom_node_role_arn) == var.existing_custom_node_role_name
    )
    error_message = "external-confirmed custom node access requires a matching role name/ARN and explicit access-entry readiness confirmation."
  }
}

resource "aws_iam_role" "auto_custom_node" {
  count = local.create_custom_node_access ? 1 : 0
  name  = "${var.name_prefix}-${var.environment}-eks-custom-node"

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

resource "aws_iam_role_policy_attachment" "auto_custom_node" {
  for_each = local.create_custom_node_access ? toset([
    "AmazonEKSWorkerNodeMinimalPolicy",
    "AmazonEC2ContainerRegistryPullOnly",
  ]) : toset([])

  role       = aws_iam_role.auto_custom_node[0].name
  policy_arn = "arn:aws:iam::aws:policy/${each.value}"
}

resource "aws_eks_access_entry" "auto_custom_node" {
  count = local.create_custom_node_access ? 1 : 0

  cluster_name  = aws_eks_cluster.this[0].name
  principal_arn = aws_iam_role.auto_custom_node[0].arn
  type          = "EC2"

  depends_on = [aws_iam_role_policy_attachment.auto_custom_node]
}

resource "aws_eks_access_policy_association" "auto_custom_node" {
  count = local.create_custom_node_access ? 1 : 0

  cluster_name  = aws_eks_cluster.this[0].name
  principal_arn = aws_iam_role.auto_custom_node[0].arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAutoNodePolicy"

  access_scope {
    type = "cluster"
  }

  depends_on = [aws_eks_access_entry.auto_custom_node]
}
