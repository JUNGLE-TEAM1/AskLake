mock_provider "aws" {
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

  mock_resource "aws_eks_cluster" {
    defaults = {
      endpoint = "https://created.example.invalid"
      certificate_authority = [{
        data = "mock-ca"
      }]
      identity = [{
        oidc = [{
          issuer = "https://oidc.example.invalid/created"
        }]
      }]
    }
  }
}

run "existing_cluster_handoff" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false
    trino_image_digest      = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    trino_irsa_role_arn     = "arn:aws:iam::123456789012:role/asklake-dev-trino"
  }

  assert {
    condition     = output.cluster_name == "shared-dev"
    error_message = "existing cluster name must be preserved in the handoff."
  }

  assert {
    condition     = output.phase1_handoff.kafka_runtime == "msk-serverless"
    error_message = "deployment Kafka runtime must remain MSK Serverless."
  }

  assert {
    condition     = output.phase1_handoff.continuous_owner == "ec2-mvp"
    error_message = "MVP Continuous ownership must remain on EC2."
  }

  assert {
    condition     = output.phase1_handoff.trino_runtime == "eks"
    error_message = "Trino must remain an EKS workload for the MVP."
  }

  assert {
    condition     = output.trino_handoff.service.in_cluster_url == "https://asklake-trino.asklake-dev.svc:8443"
    error_message = "Trino handoff must expose the stable in-cluster HTTPS Service endpoint."
  }

  assert {
    condition     = output.trino_handoff.image.digest == "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    error_message = "Trino handoff must preserve the immutable image digest."
  }

  assert {
    condition     = output.trino_handoff.irsa_role_arn == "arn:aws:iam::123456789012:role/asklake-dev-trino"
    error_message = "Trino handoff must preserve the approved workload identity role."
  }

  assert {
    condition     = output.trino_handoff.iceberg_catalog.database == "iceberg_catalog"
    error_message = "Trino must use the dedicated Iceberg catalog database."
  }

  assert {
    condition     = output.trino_handoff.iceberg_catalog.jdbc_secret_name == "asklake-trino-iceberg-jdbc"
    error_message = "Trino handoff must expose the JDBC Secret reference without secret values."
  }
}

run "new_cluster_contract" {
  command = plan

  variables {
    environment              = "dev"
    owner                    = "pair-a"
    resource_lifecycle       = "mvp-owned"
    cluster_mode             = "create"
    control_plane_subnet_ids = ["subnet-test-a", "subnet-test-b"]
    create_ecr_repositories  = false
  }

  assert {
    condition     = output.cluster_name == "asklake-dev"
    error_message = "new cluster name must use the stable prefix and environment."
  }

  assert {
    condition     = output.namespace == "asklake-dev"
    error_message = "Terraform and Helm must share the default namespace."
  }

  assert {
    condition     = output.service_account_names["spark"] == "asklake-spark"
    error_message = "Spark service account must remain stable for Pair B manifests."
  }

  assert {
    condition     = output.service_account_names["trino"] == "asklake-trino"
    error_message = "Trino service account must remain stable for the EKS workload."
  }

  assert {
    condition     = output.service_account_names["mskSmoke"] == "asklake-msk-smoke"
    error_message = "MSK smoke service account must remain isolated from application workloads."
  }
}

run "workload_repository_contract" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "mvp-owned"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = true
  }

  assert {
    condition = alltrue([
      for component in ["frontend", "backend", "airflow", "trino", "spark-runtime"] :
      contains(keys(output.ecr_repository_urls), component)
    ])
    error_message = "ECR outputs must expose every EKS workload image component."
  }

  assert {
    condition     = !contains(keys(output.ecr_repository_urls), "replay-producer")
    error_message = "The external fixture producer must not receive an EKS workload repository."
  }
}

run "reject_shared_resource_creation" {
  command = plan

  variables {
    environment              = "dev"
    owner                    = "pair-a"
    resource_lifecycle       = "shared"
    cluster_mode             = "create"
    control_plane_subnet_ids = ["subnet-test-a", "subnet-test-b"]
    create_ecr_repositories  = false
  }

  expect_failures = [check.mvp_owned_resource_creation]
}
