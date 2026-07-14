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

run "network_ingress_defaults_fail_closed" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false
  }

  assert {
    condition     = output.phase7_network_handoff.ingress.mode == "disabled"
    error_message = "ALB ingress must be disabled by default."
  }

  assert {
    condition     = !output.phase7_network_handoff.ready_for_ingress_render
    error_message = "default network inputs must not be render-ready."
  }

  assert {
    condition     = !output.phase7_network_handoff.decisions_complete
    error_message = "default private network decisions must remain incomplete."
  }
}

run "reviewed_network_ingress_handoff" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    ingress_mode            = "alb"
    alb_controller_ready    = true
    alb_controller_owner    = "platform-team"
    alb_exposure            = "internet-facing"
    alb_target_type         = "ip"
    ingress_host            = "asklake.example.invalid"
    ingress_certificate_arn = "arn:aws:acm:ap-northeast-2:111122223333:certificate/00000000-0000-0000-0000-000000000000"
    private_egress_mode     = "hybrid"
    pod_network_enforcement = "both"
  }

  assert {
    condition     = output.phase7_network_handoff.ready_for_ingress_render
    error_message = "reviewed ALB inputs must become render-ready without creating an ALB in Terraform."
  }

  assert {
    condition     = output.phase7_network_handoff.decisions_complete
    error_message = "reviewed ingress and private network choices must complete the network handoff."
  }

  assert {
    condition     = output.phase7_network_handoff.ingress.routes.backend.health_path == "/api/health"
    error_message = "backend ALB target group must keep its real health endpoint."
  }
}

run "reject_partial_alb_contract" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false
    ingress_mode            = "alb"
  }

  expect_failures = [check.alb_ingress_contract]
}

run "reject_disabled_ingress_runtime_values" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false
    alb_exposure            = "internal"
  }

  expect_failures = [check.disabled_ingress_has_no_runtime_values]
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

  assert {
    condition = contains(
      one([for statement in module.workload_iam_policies.contracts.spark.Statement : statement if statement.Sid == "ReadSparkObjects"]).Resource,
      local.storage_object_arns.checkpoint,
      ) && contains(
      one([for statement in module.workload_iam_policies.contracts.spark.Statement : statement if statement.Sid == "ReadSparkObjects"]).Resource,
      local.storage_object_arns.quarantine,
    )
    error_message = "Spark must be able to read its exact checkpoint and quarantine prefixes."
  }

  assert {
    condition = contains(
      one([for statement in module.workload_iam_policies.contracts.backend.Statement : statement if statement.Sid == "ReadBackendObjects"]).Resource,
      local.storage_object_arns.evidence,
    )
    error_message = "Backend must be able to read its exact evidence prefix."
  }

  assert {
    condition = (
      one([for statement in module.workload_iam_policies.contracts.spark.Statement : statement if statement.Sid == "ConsumeFixtureTopic"]).Resource == [local.msk_topic_arn] &&
      one([for statement in module.workload_iam_policies.contracts.spark.Statement : statement if statement.Sid == "UseFixtureConsumerGroup"]).Resource == [local.msk_group_arn] &&
      one([for statement in module.workload_iam_policies.contracts.msk_smoke.Statement : statement if statement.Sid == "DescribeFixtureTopic"]).Resource == [local.msk_topic_arn]
    )
    error_message = "Spark and MSK smoke policies must stay on the isolated test topic and consumer group."
  }

  assert {
    condition = alltrue(flatten([
      for contract in values(module.workload_iam_policies.contracts) : contract == null ? [] : [
        for statement in contract.Statement :
        alltrue([for action in statement.Action : action != "s3:*" && action != "kafka-cluster:*"]) &&
        alltrue([for resource in statement.Resource : resource != "*"])
      ]
    ]))
    error_message = "Rendered workload policies must not contain broad actions or Resource star."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role.workload["spark"].assume_role_policy).Statement[0].Principal.Federated[0] == var.irsa_oidc_provider_arn &&
      jsondecode(aws_iam_role.workload["spark"].assume_role_policy).Statement[0].Action == ["sts:AssumeRoleWithWebIdentity"] &&
      jsondecode(aws_iam_role.workload["spark"].assume_role_policy).Statement[0].Condition.StringEquals["${local.cluster_oidc_host}:aud"] == "sts.amazonaws.com" &&
      jsondecode(aws_iam_role.workload["spark"].assume_role_policy).Statement[0].Condition.StringEquals["${local.cluster_oidc_host}:sub"] == "system:serviceaccount:${var.namespace}:${var.service_account_names["spark"]}"
    )
    error_message = "IRSA trust must bind the exact provider, audience, namespace, and Spark service account."
  }
}

run "create_mode_irsa_has_static_identity_keys" {
  command = plan

  variables {
    environment              = "dev"
    owner                    = "pair-a"
    resource_lifecycle       = "mvp-owned"
    cluster_mode             = "create"
    control_plane_subnet_ids = ["subnet-private-a", "subnet-private-b"]
    create_ecr_repositories  = false

    msk_mode               = "create"
    msk_subnet_ids         = ["subnet-private-a", "subnet-private-b"]
    msk_security_group_ids = ["sg-msk-client"]

    storage_mode = "create"
    storage_bucket_names = {
      raw           = "asklake-dev-111122223333-raw"
      output        = "asklake-dev-111122223333-output"
      warehouse     = "asklake-dev-111122223333-warehouse"
      query_results = "asklake-dev-111122223333-query-results"
    }

    workload_identity_mode = "irsa"
    irsa_oidc_provider_arn = "arn:aws:iam::111122223333:oidc-provider/oidc.example.invalid/created"
  }

  assert {
    condition     = toset(keys(aws_iam_role.workload)) == toset(["backend", "trino", "mskSmoke", "spark"])
    error_message = "Create mode IRSA identity resource keys must be fully known during plan."
  }
}

run "create_mode_pod_identity_has_static_keys" {
  command = plan

  variables {
    environment              = "dev"
    owner                    = "pair-a"
    resource_lifecycle       = "mvp-owned"
    cluster_mode             = "create"
    control_plane_subnet_ids = ["subnet-private-a", "subnet-private-b"]
    create_ecr_repositories  = false

    msk_mode               = "create"
    msk_subnet_ids         = ["subnet-private-a", "subnet-private-b"]
    msk_security_group_ids = ["sg-msk-client"]

    storage_mode = "create"
    storage_bucket_names = {
      raw           = "asklake-dev-111122223333-raw"
      output        = "asklake-dev-111122223333-output"
      warehouse     = "asklake-dev-111122223333-warehouse"
      query_results = "asklake-dev-111122223333-query-results"
    }

    workload_identity_mode   = "pod_identity"
    pod_identity_agent_ready = true
  }

  assert {
    condition     = toset(keys(aws_eks_pod_identity_association.workload)) == toset(["backend", "trino", "mskSmoke", "spark"])
    error_message = "Create mode Pod Identity association keys must be fully known during plan."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role.workload["spark"].assume_role_policy).Statement[0].Principal.Service[0] == "pods.eks.amazonaws.com" &&
      toset(jsondecode(aws_iam_role.workload["spark"].assume_role_policy).Statement[0].Action) == toset(["sts:AssumeRole", "sts:TagSession"])
    )
    error_message = "Pod Identity trust must contain only the EKS Pod Identity principal and session actions."
  }

  assert {
    condition     = output.trino_handoff.irsa_role_arn == null
    error_message = "Pod Identity mode must not expose a Trino IRSA role ARN."
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

run "runtime_secret_defaults_fail_closed" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false
  }

  assert {
    condition     = output.phase8_runtime_secret_handoff.delivery.mode == "disabled"
    error_message = "runtime Secret delivery must remain disabled by default."
  }

  assert {
    condition     = !output.phase8_runtime_secret_handoff.ready_for_sync
    error_message = "default Secret delivery inputs must not be sync-ready."
  }

  assert {
    condition     = !output.phase8_runtime_secret_handoff.values_in_state
    error_message = "Terraform must never claim to persist runtime Secret values."
  }

  assert {
    condition     = !output.phase8_runtime_secret_handoff.full_service_secret_contract_ready
    error_message = "unresolved Airflow and AI decisions must keep the full-service Secret contract closed."
  }
}

run "external_secret_delivery_handoff" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    secret_delivery_mode    = "external_secrets"
    secret_controller_ready = true
    secret_controller_owner = "platform-team"
    secret_rotation_owner   = "service-team"
    secret_source_prefix    = "/asklake/dev/runtime"
  }

  assert {
    condition     = output.phase8_runtime_secret_handoff.ready_for_sync
    error_message = "reviewed external Secret inputs must become sync-ready."
  }

  assert {
    condition = alltrue([
      contains(output.phase8_runtime_secret_handoff.secrets.backend.keys, "TRINO_RESULT_CURSOR_SECRET"),
      contains(output.phase8_runtime_secret_handoff.secrets.backend.keys, "TRINO_QUERY_CONFIRMATION_SECRET"),
    ])
    error_message = "backend Secret contract must include the current cursor and confirmation signing keys."
  }

  assert {
    condition = one([
      for binding in output.phase8_runtime_secret_handoff.env_bindings : binding.env
      if binding.binding == "airflow:AIRFLOW_EXECUTION_API_TOKEN"
    ]) == "ASKLAKE_EXECUTION_API_TOKEN"
    error_message = "Terraform handoff must expose the Airflow execution token environment mapping."
  }
}

run "workflow_secret_delivery_handoff" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    secret_delivery_mode  = "workflow_sync"
    secret_rotation_owner = "service-team"
    secret_source_prefix  = "/asklake/dev/runtime"
  }

  assert {
    condition     = output.phase8_runtime_secret_handoff.ready_for_sync
    error_message = "reviewed workflow sync inputs must become sync-ready without a controller."
  }

  assert {
    condition     = output.phase8_runtime_secret_handoff.delivery.controller_owner == null
    error_message = "workflow sync must not claim an external Secret controller owner."
  }
}

run "reject_partial_secret_delivery" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    secret_delivery_mode = "external_secrets"
  }

  expect_failures = [check.runtime_secret_delivery_contract]
}

run "direct_ai_full_service_secret_contract" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    secret_delivery_mode  = "workflow_sync"
    secret_rotation_owner = "service-team"
    secret_source_prefix  = "/asklake/dev/runtime"
    airflow_api_auth_mode = "api_token"
    ai_runtime_mode       = "direct"
  }

  assert {
    condition     = output.phase8_runtime_secret_handoff.full_service_secret_contract_ready
    error_message = "selected Airflow auth and direct AI contracts must open the full-service Secret contract gate."
  }
}

run "gateway_ai_requires_provider_contract" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    secret_delivery_mode  = "workflow_sync"
    secret_rotation_owner = "service-team"
    secret_source_prefix  = "/asklake/dev/runtime"
    airflow_api_auth_mode = "username_password"
    ai_runtime_mode       = "gateway"
  }

  assert {
    condition     = !output.phase8_runtime_secret_handoff.full_service_secret_contract_ready
    error_message = "gateway AI must stay closed until its provider workload contract is separately approved."
  }
}
