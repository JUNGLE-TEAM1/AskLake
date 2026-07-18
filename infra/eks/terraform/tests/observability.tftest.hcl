mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111122223333"
      arn        = "arn:aws:iam::111122223333:user/mock"
      user_id    = "mock-user"
    }
  }

  mock_data "aws_eks_cluster" {
    defaults = {
      endpoint = "https://existing.example.invalid"
      certificate_authority = [{
        data = "mock-ca"
      }]
      identity = [{
        oidc = [{
          issuer = "https://oidc.example.invalid/existing"
        }]
      }]
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/mock-observability"
    }
  }

  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::111122223333:policy/mock-observability"
    }
  }
}

variables {
  environment                      = "dev"
  owner                            = "pair-a"
  resource_lifecycle               = "mvp-owned"
  cluster_mode                     = "existing"
  existing_cluster_name            = "asklake-dev"
  existing_auto_mode_enabled       = true
  existing_auto_mode_node_role_arn = "arn:aws:iam::111122223333:role/asklake-auto-node"
  cluster_admin_principal_arn      = "arn:aws:iam::111122223333:role/asklake-admin"
  pod_identity_agent_ready         = true
}

run "observability_disabled_is_empty" {
  command = plan

  assert {
    condition = (
      length(aws_eks_addon.cloudwatch_observability) == 0 &&
      length(aws_iam_role.cloudwatch_observability) == 0 &&
      length(aws_cloudwatch_log_group.observability_application) == 0 &&
      output.day18_observability_handoff.mode == "disabled"
    )
    error_message = "disabled observability must not create add-on, IAM or log-group resources."
  }
}

run "observability_enabled_is_otel_only" {
  command = apply

  variables {
    observability_mode          = "eks_addon"
    observability_addon_version = "v6.3.0-eksbuild.1"
    observability_owner         = "pair-a"
  }

  assert {
    condition = (
      length(aws_eks_addon.cloudwatch_observability) == 1 &&
      aws_eks_addon.cloudwatch_observability[0].addon_name == "amazon-cloudwatch-observability" &&
      aws_eks_addon.cloudwatch_observability[0].addon_version == "v6.3.0-eksbuild.1"
    )
    error_message = "enabled mode must pin the managed CloudWatch Observability add-on."
  }

  assert {
    condition = (
      jsondecode(aws_eks_addon.cloudwatch_observability[0].configuration_values).applicationSignals.enabled == false &&
      jsondecode(aws_eks_addon.cloudwatch_observability[0].configuration_values).containerInsights.enabled == false &&
      jsondecode(aws_eks_addon.cloudwatch_observability[0].configuration_values).otelContainerInsights.enabled == true &&
      jsondecode(aws_eks_addon.cloudwatch_observability[0].configuration_values).otelContainerInsights.logs.enabled == true &&
      jsondecode(aws_eks_addon.cloudwatch_observability[0].configuration_values).containerLogs.enabled == false &&
      jsondecode(aws_eks_addon.cloudwatch_observability[0].configuration_values).nodeExporter.resources.requests.cpu == "25m" &&
      jsondecode(aws_eks_addon.cloudwatch_observability[0].configuration_values).agents[0].env[0].value == "NODE" &&
      jsondecode(aws_eks_addon.cloudwatch_observability[0].configuration_values).agents[1].env[0].value == "LEADER" &&
      !can(jsondecode(aws_eks_addon.cloudwatch_observability[0].configuration_values).agents[1].otelConfig)
    )
    error_message = "add-on configuration must keep Application Signals, Classic and legacy containerLogs off while enabling OTel metrics/logs."
  }

  assert {
    condition = (
      one(aws_eks_addon.cloudwatch_observability[0].pod_identity_association).service_account == "cloudwatch-agent" &&
      output.day18_observability_handoff.identity_mode == "eks-pod-identity" &&
      output.day18_observability_handoff.node_role_permission == false
    )
    error_message = "CloudWatch agent must use its dedicated Pod Identity without node-role permissions."
  }

  assert {
    condition = (
      aws_cloudwatch_log_group.observability_application[0].retention_in_days == 7 &&
      aws_cloudwatch_log_group.observability_application[0].skip_destroy == true &&
      aws_cloudwatch_log_group.observability_control_plane[0].retention_in_days == 7 &&
      aws_cloudwatch_log_group.observability_control_plane[0].skip_destroy == true
    )
    error_message = "application and imported control-plane logs must have explicit retention and survive destroy."
  }

  assert {
    condition = (
      !strcontains(aws_iam_policy.cloudwatch_observability[0].policy, "xray:") &&
      !strcontains(aws_iam_policy.cloudwatch_observability[0].policy, "ssm:") &&
      !strcontains(aws_iam_policy.cloudwatch_observability[0].policy, "ec2:") &&
      strcontains(aws_iam_policy.cloudwatch_observability[0].policy, "cloudwatch:PutMetricData") &&
      strcontains(aws_iam_policy.cloudwatch_observability[0].policy, "logs:PutLogEvents") &&
      startswith(aws_cloudwatch_log_group.observability_application[0].name, "/aws/otel/containerinsights/")
    )
    error_message = "observability IAM must omit X-Ray/SSM/EC2 and restrict delivery to the OTel application log group and required metric action."
  }
}

run "observability_missing_version_fails" {
  command = plan

  variables {
    observability_mode  = "eks_addon"
    observability_owner = "pair-a"
  }

  expect_failures = [check.observability_contract]
}
