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

  mock_resource "aws_msk_serverless_cluster" {
    defaults = {
      arn                        = "arn:aws:kafka:ap-northeast-2:111122223333:cluster/asklake-dev-serverless/mock-uuid"
      bootstrap_brokers_sasl_iam = "mock-broker.example.invalid:9098"
    }
  }

  mock_resource "aws_db_instance" {
    defaults = {
      address = "mock-rds.example.invalid"
      port    = 5432
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/mock-workload"
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

run "mvp_data_plane_contract" {
  command = apply

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "mvp-owned"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    msk_mode               = "create"
    msk_subnet_ids         = ["subnet-private-a", "subnet-private-b"]
    msk_security_group_ids = ["sg-msk-client"]

    rds_mode               = "create"
    rds_subnet_ids         = ["subnet-private-a", "subnet-private-b"]
    rds_security_group_ids = ["sg-rds-client"]
    rds_instance_class     = "db.t4g.small"

    storage_mode = "create"
    storage_bucket_names = {
      raw           = "asklake-dev-111122223333-raw"
      output        = "asklake-dev-111122223333-output"
      warehouse     = "asklake-dev-111122223333-warehouse"
      query_results = "asklake-dev-111122223333-query-results"
    }
  }

  assert {
    condition     = aws_msk_serverless_cluster.mvp[0].client_authentication[0].sasl[0].iam[0].enabled
    error_message = "MSK Serverless must enforce IAM authentication."
  }

  assert {
    condition     = aws_db_instance.metadata[0].publicly_accessible == false
    error_message = "RDS must not be publicly accessible."
  }

  assert {
    condition     = aws_db_instance.metadata[0].deletion_protection
    error_message = "MVP-owned RDS must keep deletion protection enabled."
  }

  assert {
    condition     = length(aws_s3_bucket.data) == 4
    error_message = "The data plane must create isolated raw, output, warehouse, and query result buckets."
  }

  assert {
    condition     = output.rds_contract.logical_databases.iceberg_catalog == "iceberg_catalog"
    error_message = "RDS handoff must expose the Iceberg JDBC Catalog database."
  }

  assert {
    condition = alltrue([
      for policy in values(output.workload_iam_policy_documents) :
      policy == null || !strcontains(policy, "kafka-cluster:*") && !strcontains(policy, "s3:*")
    ])
    error_message = "Generated workload policies must not contain broad Kafka or S3 wildcard actions."
  }
}

run "reject_shared_data_plane_creation" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "shared"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    storage_mode = "create"
    storage_bucket_names = {
      raw           = "asklake-dev-111122223333-raw"
      output        = "asklake-dev-111122223333-output"
      warehouse     = "asklake-dev-111122223333-warehouse"
      query_results = "asklake-dev-111122223333-query-results"
    }
  }

  expect_failures = [check.data_plane_creation_gate]
}

run "reject_incomplete_kms_contract" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "mvp-owned"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    storage_mode = "create"
    storage_bucket_names = {
      raw           = "asklake-dev-111122223333-raw"
      output        = "asklake-dev-111122223333-output"
      warehouse     = "asklake-dev-111122223333-warehouse"
      query_results = "asklake-dev-111122223333-query-results"
    }
    storage_sse_algorithm = "aws:kms"
    storage_kms_key_arn   = null
  }

  expect_failures = [check.storage_encryption_contract]
}

run "irsa_workload_identity_contract" {
  command = plan

  override_data {
    target = data.aws_iam_policy_document.backend
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::mock/*\"}]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.trino
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::mock/*\"}]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.msk_smoke
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"kafka-cluster:Connect\",\"Resource\":\"arn:aws:kafka:ap-northeast-2:111122223333:cluster/mock/id\"}]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.spark
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"kafka-cluster:ReadData\",\"Resource\":\"arn:aws:kafka:ap-northeast-2:111122223333:topic/mock/id/topic\"}]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.workload_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Principal\":{\"Federated\":\"arn:aws:iam::111122223333:oidc-provider/mock\"}}]}"
    }
  }

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "mvp-owned"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    msk_mode                                = "existing"
    existing_msk_cluster_arn                = "arn:aws:kafka:ap-northeast-2:111122223333:cluster/shared-dev/mock-uuid"
    existing_msk_bootstrap_brokers_sasl_iam = "mock-broker.example.invalid:9098"

    storage_mode = "existing"
    storage_bucket_names = {
      raw           = "asklake-dev-111122223333-raw"
      output        = "asklake-dev-111122223333-output"
      warehouse     = "asklake-dev-111122223333-warehouse"
      query_results = "asklake-dev-111122223333-query-results"
    }

    workload_identity_mode = "irsa"
    irsa_oidc_provider_arn = "arn:aws:iam::111122223333:oidc-provider/oidc.example.invalid/existing"
  }

  assert {
    condition     = length(aws_iam_role.workload) == 4
    error_message = "IRSA must create isolated backend, Trino, MSK smoke, and Spark roles."
  }

  assert {
    condition     = length(output.workload_identity_contract.service_account_annotations) == 4
    error_message = "IRSA must hand off one role annotation per AWS-enabled service account."
  }

  assert {
    condition     = length(aws_eks_pod_identity_association.workload) == 0
    error_message = "IRSA mode must not create Pod Identity associations."
  }
}

run "reject_unready_pod_identity" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "mvp-owned"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    msk_mode                                = "existing"
    existing_msk_cluster_arn                = "arn:aws:kafka:ap-northeast-2:111122223333:cluster/shared-dev/mock-uuid"
    existing_msk_bootstrap_brokers_sasl_iam = "mock-broker.example.invalid:9098"

    storage_mode = "existing"
    storage_bucket_names = {
      raw           = "asklake-dev-111122223333-raw"
      output        = "asklake-dev-111122223333-output"
      warehouse     = "asklake-dev-111122223333-warehouse"
      query_results = "asklake-dev-111122223333-query-results"
    }

    workload_identity_mode   = "pod_identity"
    pod_identity_agent_ready = false
  }

  expect_failures = [check.pod_identity_agent_contract]
}

run "reject_shared_workload_identity_creation" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "shared"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    msk_mode                                = "existing"
    existing_msk_cluster_arn                = "arn:aws:kafka:ap-northeast-2:111122223333:cluster/shared-dev/mock-uuid"
    existing_msk_bootstrap_brokers_sasl_iam = "mock-broker.example.invalid:9098"

    storage_mode = "existing"
    storage_bucket_names = {
      raw           = "asklake-dev-111122223333-raw"
      output        = "asklake-dev-111122223333-output"
      warehouse     = "asklake-dev-111122223333-warehouse"
      query_results = "asklake-dev-111122223333-query-results"
    }

    workload_identity_mode = "irsa"
    irsa_oidc_provider_arn = "arn:aws:iam::111122223333:oidc-provider/oidc.example.invalid/existing"
  }

  expect_failures = [check.workload_identity_creation_gate]
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
