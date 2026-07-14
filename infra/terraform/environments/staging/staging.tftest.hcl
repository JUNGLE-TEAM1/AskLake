mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_vpc_endpoint" {
    defaults = {
      prefix_list_id = "pl-12345678"
    }
  }

  mock_resource "aws_msk_serverless_cluster" {
    defaults = {
      arn                        = "arn:aws:kafka:ap-northeast-2:123456789012:cluster/asklake-staging-phase1-test-msk/00000000-0000-0000-0000-000000000000"
      bootstrap_brokers_sasl_iam = "boot.example.kafka-serverless.ap-northeast-2.amazonaws.com:9098"
      cluster_uuid               = "00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_emrserverless_application" {
    defaults = {
      arn = "arn:aws:emr-serverless:ap-northeast-2:123456789012:/applications/00fakestaging"
      id  = "00fakestaging"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:ap-northeast-2:123456789012:key/00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/asklake-staging-phase1-test-role"
    }
  }
}

run "phase1_plan" {
  command = plan

  variables {
    aws_account_id                           = "123456789012"
    stack_id                                 = "phase1-test"
    expires_at                               = "2030-01-01T00:00:00Z"
    github_oidc_role_arn                     = "arn:aws:iam::123456789012:role/asklake-github-oidc"
    available_emr_serverless_concurrent_vcpu = 16
    budget_notification_email                = "platform@example.com"
    enable_smoke_runner                      = false
  }

  assert {
    condition     = output.infrastructure_contract.environment == "staging"
    error_message = "The environment contract drifted."
  }

  assert {
    condition     = output.infrastructure_contract.region == "ap-northeast-2"
    error_message = "The region contract drifted."
  }

  assert {
    condition     = output.infrastructure_contract.stack_id == "phase1-test"
    error_message = "The stack identity drifted."
  }

  assert {
    condition     = output.infrastructure_contract.vpc_cidr == "10.77.0.0/16"
    error_message = "The dedicated VPC CIDR drifted."
  }

  assert {
    condition     = length(output.infrastructure_contract.bucket_names) == 4
    error_message = "Artifact, output, checkpoint and report buckets are required."
  }

  assert {
    condition     = output.infrastructure_contract.maximum_application_vcpu == 16
    error_message = "The EMR Serverless application cap drifted."
  }

  assert {
    condition     = !output.infrastructure_contract.public_ingress_enabled && !output.infrastructure_contract.nat_gateway_enabled
    error_message = "The staging network must remain private and no-NAT."
  }

  assert {
    condition     = !output.infrastructure_contract.applications_concurrent
    error_message = "Batch and Continuous smoke must remain sequential."
  }

  assert {
    condition     = output.infrastructure_contract.budget_limit_usd == 30
    error_message = "The smoke budget drifted."
  }

  assert {
    condition     = !output.infrastructure_contract.smoke_runner_enabled
    error_message = "Credential-free plan validation must not create an EC2 runner."
  }
}

run "private_smoke_runner_plan" {
  command = plan

  variables {
    aws_account_id                           = "123456789012"
    stack_id                                 = "phase1-test"
    expires_at                               = "2030-01-01T00:00:00Z"
    github_oidc_role_arn                     = "arn:aws:iam::123456789012:role/asklake-github-oidc"
    available_emr_serverless_concurrent_vcpu = 16
    budget_notification_email                = "platform@example.com"
    enable_smoke_runner                      = true
    smoke_runner_ami_id                      = "ami-0123456789abcdef0"
  }

  assert {
    condition     = output.infrastructure_contract.smoke_runner_enabled
    error_message = "The approved private smoke runner was not included in the plan."
  }
}

run "rejects_low_emr_quota" {
  command = plan

  variables {
    aws_account_id                           = "123456789012"
    stack_id                                 = "phase1-test"
    expires_at                               = "2030-01-01T00:00:00Z"
    github_oidc_role_arn                     = "arn:aws:iam::123456789012:role/asklake-github-oidc"
    available_emr_serverless_concurrent_vcpu = 15
    budget_notification_email                = "platform@example.com"
    enable_smoke_runner                      = false
  }

  expect_failures = [var.available_emr_serverless_concurrent_vcpu]
}

run "rejects_oidc_role_from_another_account" {
  command = plan

  variables {
    aws_account_id                           = "123456789012"
    stack_id                                 = "phase1-test"
    expires_at                               = "2030-01-01T00:00:00Z"
    github_oidc_role_arn                     = "arn:aws:iam::210987654321:role/asklake-github-oidc"
    available_emr_serverless_concurrent_vcpu = 16
    budget_notification_email                = "platform@example.com"
    enable_smoke_runner                      = false
  }

  expect_failures = [terraform_data.contract_guard]
}
