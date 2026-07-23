data "aws_caller_identity" "current" {}

locals {
  runtime_secret_static_contract = jsondecode(file("${path.module}/../secrets/runtime-secret-contract.example.json"))
  secret_delivery_enabled        = var.secret_delivery_mode != "disabled"
  external_secrets_enabled       = var.secret_delivery_mode == "external_secrets"
  workflow_sync_enabled          = var.secret_delivery_mode == "workflow_sync"
  secret_delivery_ready = (
    local.secret_delivery_enabled &&
    try(trimspace(var.secret_rotation_owner), "") != "" &&
    try(trimspace(var.secret_source_prefix), "") != "" &&
    (
      local.external_secrets_enabled ? (
        var.secret_controller_ready &&
        try(trimspace(var.secret_controller_owner), "") != ""
        ) : (
        local.workflow_sync_enabled &&
        !var.secret_controller_ready &&
        var.secret_controller_owner == null
      )
    )
  )
  runtime_secret_contract       = local.runtime_secret_static_contract.secrets
  external_secret_source_prefix = var.secret_source_prefix == null ? "" : trim(var.secret_source_prefix, "/")
  runtime_decisions = {
    airflow_api_auth = {
      status   = var.airflow_api_auth_mode == "undecided" ? "learning-required" : "selected"
      selected = var.airflow_api_auth_mode == "undecided" ? null : var.airflow_api_auth_mode
    }
    ai_runtime = {
      status   = var.ai_runtime_mode == "undecided" ? "learning-required" : "selected"
      selected = var.ai_runtime_mode == "undecided" ? null : var.ai_runtime_mode
    }
    ai_provider_workload = {
      status   = var.ai_provider_workload_contract_ready ? "selected" : "learning-required"
      selected = var.ai_provider_workload_contract_ready ? "contract-approved" : null
    }
  }
  airflow_auth_contract_ready = var.airflow_api_auth_mode != "undecided"
  ai_runtime_contract_ready = (
    var.ai_runtime_mode == "direct" ||
    (var.ai_runtime_mode == "gateway" && var.ai_provider_workload_contract_ready)
  )
  full_service_secret_contract_ready = (
    local.secret_delivery_ready &&
    local.airflow_auth_contract_ready &&
    local.ai_runtime_contract_ready
  )
}

check "external_secret_identity_contract" {
  assert {
    condition = !local.external_secrets_enabled || (
      var.resource_lifecycle == "mvp-owned" &&
      var.pod_identity_agent_ready
    )
    error_message = "external_secrets requires mvp-owned IAM resources and a ready EKS Pod Identity Agent."
  }
}

resource "aws_iam_role" "external_secrets" {
  count = local.external_secrets_enabled ? 1 : 0

  name = "${var.name_prefix}-${var.environment}-external-secrets"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AssumeRoleWithPodIdentity"
      Effect = "Allow"
      Action = [
        "sts:AssumeRole",
        "sts:TagSession",
      ]
      Principal = {
        Service = ["pods.eks.amazonaws.com"]
      }
    }]
  })
}

resource "aws_iam_policy" "external_secrets" {
  count = local.external_secrets_enabled ? 1 : 0

  name = "${var.name_prefix}-${var.environment}-external-secrets"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ReadApprovedRuntimeSecrets"
      Effect = "Allow"
      Action = [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:ListSecretVersionIds",
      ]
      Resource = concat(
        [
          "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${local.external_secret_source_prefix}/*",
        ],
        local.reference_rds ? compact([local.rds_master_secret_arn]) : [],
      )
    }]
  })
}

resource "aws_iam_role_policy_attachment" "external_secrets" {
  count = local.external_secrets_enabled ? 1 : 0

  role       = aws_iam_role.external_secrets[0].name
  policy_arn = aws_iam_policy.external_secrets[0].arn
}

resource "aws_eks_pod_identity_association" "external_secrets" {
  count = local.external_secrets_enabled ? 1 : 0

  cluster_name    = local.cluster_name
  namespace       = var.external_secrets_namespace
  service_account = var.external_secrets_service_account
  role_arn        = aws_iam_role.external_secrets[0].arn
}

check "runtime_secret_delivery_contract" {
  assert {
    condition     = !local.secret_delivery_enabled || local.secret_delivery_ready
    error_message = "enabled Secret delivery requires a rotation owner and source prefix; external_secrets also requires a ready controller owner."
  }
}

check "disabled_secret_delivery_has_no_runtime_values" {
  assert {
    condition = local.secret_delivery_enabled || (
      !var.secret_controller_ready &&
      var.secret_controller_owner == null &&
      var.secret_rotation_owner == null &&
      var.secret_source_prefix == null
    )
    error_message = "disabled Secret delivery must not carry partial controller, rotation, or source values."
  }
}
