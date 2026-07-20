locals {
  workload_identity_enabled = var.workload_identity_mode != "disabled"
  use_irsa                  = var.workload_identity_mode == "irsa"
  use_pod_identity          = var.workload_identity_mode == "pod_identity"
  cluster_oidc_issuer       = local.create_cluster ? try(aws_eks_cluster.this[0].identity[0].oidc[0].issuer, null) : try(data.aws_eks_cluster.existing[0].identity[0].oidc[0].issuer, null)
  cluster_oidc_host         = replace(coalesce(local.cluster_oidc_issuer, ""), "https://", "")
  identity_configuration_ready = (
    local.use_irsa ? try(trimspace(var.irsa_oidc_provider_arn), "") != "" :
    local.use_pod_identity ? var.pod_identity_agent_ready :
    false
  )
  identity_resources_ready = (
    local.identity_configuration_ready &&
    var.resource_lifecycle == "mvp-owned" &&
    local.reference_msk &&
    local.use_storage
  )
  identity_role_suffixes = {
    backend          = "backend"
    trino            = "trino"
    mskSmoke         = "msk-smoke"
    spark            = "spark"
    realtimeV1Spark  = "realtime-v1-spark"
    realtimeV1Worker = "realtime-v1-worker"
  }

  base_identity_policy_documents = local.identity_resources_ready ? {
    backend          = local.workload_iam_policy_documents.backend
    trino            = local.workload_iam_policy_documents.trino
    mskSmoke         = local.workload_iam_policy_documents.msk_smoke
    spark            = local.workload_iam_policy_documents.spark
    realtimeV1Spark  = local.workload_iam_policy_documents.realtime_v1_spark
    realtimeV1Worker = local.workload_iam_policy_documents.realtime_v1_worker
  } : {}
  active_identity_policy_documents = local.base_identity_policy_documents

  workload_assume_role_policies = local.identity_resources_ready ? {
    for workload in keys(local.active_identity_policy_documents) :
    workload => local.use_irsa ? jsonencode({
      Version = "2012-10-17"
      Statement = [
        {
          Sid    = "AssumeRoleWithWebIdentity"
          Effect = "Allow"
          Action = ["sts:AssumeRoleWithWebIdentity"]
          Principal = {
            Federated = [var.irsa_oidc_provider_arn]
          }
          Condition = {
            StringEquals = {
              "${local.cluster_oidc_host}:aud" = "sts.amazonaws.com"
              "${local.cluster_oidc_host}:sub" = "system:serviceaccount:${var.namespace}:${var.service_account_names[workload]}"
            }
          }
        }
      ]
      }) : jsonencode({
      Version = "2012-10-17"
      Statement = [
        {
          Sid    = "AssumeRoleWithPodIdentity"
          Effect = "Allow"
          Action = [
            "sts:AssumeRole",
            "sts:TagSession",
          ]
          Principal = {
            Service = ["pods.eks.amazonaws.com"]
          }
        },
      ]
    })
  } : {}
}

check "workload_identity_creation_gate" {
  assert {
    condition     = !local.workload_identity_enabled || var.resource_lifecycle == "mvp-owned"
    error_message = "workload IAM roles and associations created by this state require resource_lifecycle=mvp-owned."
  }
}

check "workload_identity_data_plane" {
  assert {
    condition = !local.workload_identity_enabled || (
      local.reference_msk && local.use_storage
    )
    error_message = "workload identity requires non-disabled MSK and S3 contracts so every MVP policy has an exact resource boundary."
  }
}

check "irsa_provider_contract" {
  assert {
    condition     = !local.use_irsa || try(trimspace(var.irsa_oidc_provider_arn), "") != ""
    error_message = "IRSA requires the reviewed EKS IAM OIDC provider ARN. A new cluster supplies its issuer after the cluster stage."
  }
}

check "pod_identity_agent_contract" {
  assert {
    condition     = !local.use_pod_identity || var.pod_identity_agent_ready
    error_message = "Pod Identity requires explicit confirmation that the cluster Pod Identity Agent is ready."
  }
}

check "workload_identity_policy_completeness" {
  assert {
    condition = !local.identity_resources_ready || toset(keys(local.active_identity_policy_documents)) == toset([
      "backend",
      "trino",
      "mskSmoke",
      "spark",
      "realtimeV1Spark",
      "realtimeV1Worker",
    ])
    error_message = "workload identity requires the exact reviewed V1 policy documents."
  }
}

resource "aws_iam_role" "workload" {
  for_each = local.active_identity_policy_documents

  name               = "${var.name_prefix}-${var.environment}-${local.identity_role_suffixes[each.key]}"
  assume_role_policy = local.workload_assume_role_policies[each.key]
}

resource "aws_iam_policy" "workload" {
  for_each = local.active_identity_policy_documents

  name   = "${var.name_prefix}-${var.environment}-${local.identity_role_suffixes[each.key]}"
  policy = each.value
}

resource "aws_iam_role_policy_attachment" "workload" {
  for_each = local.active_identity_policy_documents

  role       = aws_iam_role.workload[each.key].name
  policy_arn = aws_iam_policy.workload[each.key].arn
}

resource "aws_eks_pod_identity_association" "workload" {
  for_each = local.use_pod_identity ? local.active_identity_policy_documents : {}

  cluster_name    = local.cluster_name
  namespace       = var.namespace
  service_account = var.service_account_names[each.key]
  role_arn        = aws_iam_role.workload[each.key].arn
}
