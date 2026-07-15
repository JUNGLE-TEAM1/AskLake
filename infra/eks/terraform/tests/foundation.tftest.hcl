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

variables {
  existing_auto_mode_enabled       = true
  existing_auto_mode_node_role_arn = "arn:aws:iam::111122223333:role/asklake-existing-auto-node"
  cluster_admin_principal_arn      = "arn:aws:iam::111122223333:role/asklake-platform-admin"
}

run "existing_cluster_handoff" {
  command = plan

  variables {
    environment                = "dev"
    owner                      = "pair-a"
    resource_lifecycle         = "external"
    cluster_mode               = "existing"
    existing_cluster_name      = "shared-dev"
    external_public_subnet_ids = ["subnet-public-a", "subnet-public-b"]
    create_ecr_repositories    = false
    trino_image_digest         = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    trino_irsa_role_arn        = "arn:aws:iam::123456789012:role/asklake-dev-trino"
  }

  assert {
    condition     = output.cluster_name == "shared-dev"
    error_message = "existing cluster name must be preserved in the handoff."
  }

  assert {
    condition     = output.auto_mode_handoff.ownership == "external-confirmed"
    error_message = "existing clusters must remain externally owned after explicit Auto Mode confirmation."
  }

  assert {
    condition     = output.auto_mode_handoff.node_role_arn == "arn:aws:iam::111122223333:role/asklake-existing-auto-node"
    error_message = "existing cluster handoff must preserve its externally managed Auto Mode node role."
  }

  assert {
    condition = (
      length(output.phase11_network_handoff.subnets.public_alb) == 2 &&
      contains(output.phase11_network_handoff.subnets.public_alb, "subnet-public-a") &&
      contains(output.phase11_network_handoff.subnets.public_alb, "subnet-public-b")
    )
    error_message = "external networking must preserve the reviewed public ALB subnet handoff."
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

  assert {
    condition = (
      aws_eks_cluster.this[0].access_config[0].authentication_mode == "API" &&
      !aws_eks_cluster.this[0].access_config[0].bootstrap_cluster_creator_admin_permissions
    )
    error_message = "new Auto Mode clusters must use API access entries without implicit creator admin access."
  }

  assert {
    condition = (
      aws_eks_cluster.this[0].compute_config[0].enabled &&
      toset(aws_eks_cluster.this[0].compute_config[0].node_pools) == toset(["general-purpose", "system"]) &&
      !aws_eks_cluster.this[0].bootstrap_self_managed_addons
    )
    error_message = "new clusters must enable EKS Auto Mode with the reviewed built-in NodePools and disable self-managed add-on bootstrap."
  }

  assert {
    condition = (
      aws_eks_cluster.this[0].kubernetes_network_config[0].elastic_load_balancing[0].enabled &&
      aws_eks_cluster.this[0].storage_config[0].block_storage[0].enabled
    )
    error_message = "Auto Mode load balancing and block storage capabilities must be enabled with compute."
  }

  assert {
    condition     = length(aws_iam_role_policy_attachment.auto_cluster) == 5
    error_message = "the Auto Mode cluster role must receive all five AWS-managed cluster policies."
  }

  assert {
    condition     = length(aws_iam_role_policy_attachment.auto_node) == 2
    error_message = "the Auto Mode node role must receive only the minimal worker and ECR pull policies."
  }

  assert {
    condition     = aws_eks_access_entry.cluster_admin[0].principal_arn == "arn:aws:iam::111122223333:role/asklake-platform-admin"
    error_message = "new clusters must grant the reviewed administrator through an explicit EKS access entry."
  }

  assert {
    condition     = output.phase1_handoff.cluster_compute == "eks-auto-mode"
    error_message = "the cross-person handoff must identify EKS Auto Mode as the compute contract."
  }

  assert {
    condition = (
      output.phase1_handoff.contract_version == "2.5" &&
      output.phase1_handoff.network_output == "phase11_network_handoff" &&
      output.phase1_handoff.node_pool_output == "phase12_node_pool_handoff" &&
      output.phase1_handoff.ingress_output == "phase13_alb_handoff" &&
      output.phase1_handoff.web_output == "phase14_web_workload_handoff" &&
      output.phase1_handoff.metrics_output == "phase14_metrics_server_handoff"
    )
    error_message = "the Phase 12 foundation handoff version and output pointers must stay synchronized."
  }
}

run "created_custom_node_access_contract" {
  command = plan

  variables {
    environment              = "dev"
    owner                    = "pair-a"
    resource_lifecycle       = "mvp-owned"
    cluster_mode             = "create"
    control_plane_subnet_ids = ["subnet-test-a", "subnet-test-b"]
    create_ecr_repositories  = false
    custom_node_pool_mode    = "create"
  }

  assert {
    condition     = length(aws_iam_role.auto_custom_node) == 1 && length(aws_iam_role_policy_attachment.auto_custom_node) == 2
    error_message = "custom NodeClasses must use a dedicated MVP-owned node role with only the minimal worker and ECR pull policies."
  }

  assert {
    condition = (
      aws_eks_access_entry.auto_custom_node[0].type == "EC2" &&
      aws_eks_access_policy_association.auto_custom_node[0].policy_arn == "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAutoNodePolicy"
    )
    error_message = "custom node role must receive the EC2 access entry and AmazonEKSAutoNodePolicy association required by Auto Mode."
  }

  assert {
    condition = (
      output.phase12_node_pool_handoff.mode == "create" &&
      output.phase12_node_pool_handoff.manifest_render_ready &&
      output.phase12_node_pool_handoff.access_entry_owner == "terraform"
    )
    error_message = "created custom node access must open the non-secret manifest handoff."
  }

  assert {
    condition = (
      output.phase12_node_pool_handoff.workload_placement.spark.node_selector["asklake.io/workload-class"] == "spark" &&
      output.phase12_node_pool_handoff.workload_placement.spark.tolerations[0].effect == "NoSchedule"
    )
    error_message = "Spark placement must preserve its dedicated label and NoSchedule toleration contract."
  }
}

run "external_custom_node_access_contract" {
  command = plan

  variables {
    environment                       = "dev"
    owner                             = "pair-a"
    resource_lifecycle                = "external"
    cluster_mode                      = "existing"
    existing_cluster_name             = "shared-dev"
    create_ecr_repositories           = false
    custom_node_pool_mode             = "external-confirmed"
    existing_custom_node_role_name    = "asklake-shared-custom-node"
    existing_custom_node_role_arn     = "arn:aws:iam::111122223333:role/asklake-shared-custom-node"
    existing_custom_node_access_ready = true
  }

  assert {
    condition     = length(aws_iam_role.auto_custom_node) == 0 && length(aws_eks_access_entry.auto_custom_node) == 0
    error_message = "existing cluster custom node access must remain external and outside this Terraform state."
  }

  assert {
    condition = (
      output.phase12_node_pool_handoff.node_role_name == "asklake-shared-custom-node" &&
      output.phase12_node_pool_handoff.access_entry_owner == "external-confirmed"
    )
    error_message = "external custom node access must preserve the confirmed role name for NodeClass rendering."
  }
}

run "custom_node_pools_disabled_by_default" {
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
    condition = (
      output.phase12_node_pool_handoff.mode == "disabled" &&
      !output.phase12_node_pool_handoff.manifest_render_ready &&
      length(aws_iam_role.auto_custom_node) == 0
    )
    error_message = "default Phase 12 inputs must create no custom node access and keep manifest delivery closed."
  }
}

run "reject_unconfirmed_external_custom_node_access" {
  command = plan

  variables {
    environment                       = "dev"
    owner                             = "pair-a"
    resource_lifecycle                = "external"
    cluster_mode                      = "existing"
    existing_cluster_name             = "shared-dev"
    create_ecr_repositories           = false
    custom_node_pool_mode             = "external-confirmed"
    existing_custom_node_role_name    = "asklake-shared-custom-node"
    existing_custom_node_role_arn     = "arn:aws:iam::111122223333:role/asklake-shared-custom-node"
    existing_custom_node_access_ready = false
  }

  expect_failures = [check.external_custom_node_access]
}

run "reject_mismatched_external_custom_node_role" {
  command = plan

  variables {
    environment                       = "dev"
    owner                             = "pair-a"
    resource_lifecycle                = "external"
    cluster_mode                      = "existing"
    existing_cluster_name             = "shared-dev"
    create_ecr_repositories           = false
    custom_node_pool_mode             = "external-confirmed"
    existing_custom_node_role_name    = "asklake-shared-custom-node"
    existing_custom_node_role_arn     = "arn:aws:iam::111122223333:role/a-different-node-role"
    existing_custom_node_access_ready = true
  }

  expect_failures = [check.external_custom_node_access]
}

run "reject_custom_node_access_ownership_mismatch" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false
    custom_node_pool_mode   = "create"
  }

  expect_failures = [check.custom_node_pool_ownership]
}

run "created_network_single_nat_contract" {
  command = plan

  variables {
    environment                = "dev"
    owner                      = "pair-a"
    resource_lifecycle         = "mvp-owned"
    cluster_mode               = "create"
    network_mode               = "create"
    vpc_cidr                   = "10.40.0.0/16"
    network_availability_zones = ["ap-northeast-2a", "ap-northeast-2c"]
    subnet_newbits             = 8
    public_subnet_netnums      = [0, 1]
    private_subnet_netnums     = [10, 11]
    private_egress_mode        = "nat_gateway"
    nat_gateway_mode           = "single"
    create_ecr_repositories    = false
  }

  assert {
    condition     = length(aws_subnet.public) == 2 && length(aws_subnet.private) == 2
    error_message = "created networking must pair public/private subnets across two reviewed Availability Zones."
  }

  assert {
    condition     = length(aws_nat_gateway.private) == 1 && length(aws_route.private_nat) == 2
    error_message = "single NAT mode must create one NAT Gateway and route every private subnet through it."
  }

  assert {
    condition     = !aws_subnet.public["ap-northeast-2a"].map_public_ip_on_launch
    error_message = "public ALB subnets must not automatically assign public IPs to arbitrary resources."
  }

  assert {
    condition     = aws_subnet.public["ap-northeast-2a"].tags["kubernetes.io/role/elb"] == "1"
    error_message = "public subnet discovery tag must be present for the later ALB phase."
  }

  assert {
    condition     = aws_subnet.private["ap-northeast-2a"].tags["kubernetes.io/role/internal-elb"] == "1"
    error_message = "private subnet discovery tag must identify internal load-balancer placement."
  }

  assert {
    condition = (
      output.phase11_network_handoff.ownership == "terraform" &&
      output.phase11_network_handoff.private_egress.mode == "nat_gateway" &&
      output.phase11_network_handoff.private_egress.nat_gateway_mode == "single"
    )
    error_message = "Phase 11 handoff must preserve network ownership and reviewed NAT placement."
  }

  assert {
    condition     = output.phase11_network_handoff.kubernetes_api.private_operator_path == "required-before-kubectl"
    error_message = "private-only Kubernetes API must keep the operator/CI access path as an explicit deployment gate."
  }
}

run "created_network_endpoint_contract" {
  command = plan

  variables {
    environment                = "dev"
    owner                      = "pair-a"
    resource_lifecycle         = "mvp-owned"
    cluster_mode               = "create"
    network_mode               = "create"
    vpc_cidr                   = "10.41.0.0/16"
    network_availability_zones = ["ap-northeast-2a", "ap-northeast-2c"]
    subnet_newbits             = 8
    public_subnet_netnums      = [0, 1]
    private_subnet_netnums     = [10, 11]
    private_egress_mode        = "vpc_endpoints"
    nat_gateway_mode           = "undecided"
    interface_vpc_endpoint_services = [
      "ec2",
      "ecr.api",
      "ecr.dkr",
      "logs",
      "sts",
    ]
    create_ecr_repositories = false
  }

  assert {
    condition     = length(aws_nat_gateway.private) == 0
    error_message = "endpoint-only mode must not create a NAT Gateway."
  }

  assert {
    condition     = length(aws_vpc_endpoint.interface) == 5 && length(aws_vpc_endpoint.s3) == 1
    error_message = "endpoint-only baseline must create the five reviewed interfaces and an S3 gateway endpoint."
  }

  assert {
    condition     = output.phase11_network_handoff.private_egress.s3_gateway_endpoint
    error_message = "Phase 11 handoff must expose the S3 gateway endpoint capability."
  }
}

run "created_network_data_plane_placement" {
  command = plan

  variables {
    environment                   = "dev"
    owner                         = "pair-a"
    resource_lifecycle            = "mvp-owned"
    cluster_mode                  = "create"
    network_mode                  = "create"
    vpc_cidr                      = "10.42.0.0/16"
    network_availability_zones    = ["ap-northeast-2a", "ap-northeast-2c"]
    subnet_newbits                = 8
    public_subnet_netnums         = [0, 1]
    private_subnet_netnums        = [10, 11]
    private_egress_mode           = "nat_gateway"
    nat_gateway_mode              = "per_az"
    create_ecr_repositories       = false
    msk_mode                      = "create"
    rds_mode                      = "create"
    rds_instance_class            = "db.t4g.small"
    rds_final_snapshot_identifier = "asklake-dev-test-final"
  }

  assert {
    condition     = length(local.effective_msk_subnet_ids) == 2
    error_message = "MSK Serverless must reuse the Phase 11 private subnets."
  }

  assert {
    condition     = length(local.effective_rds_subnet_ids) == 2
    error_message = "RDS must reuse the Phase 11 private subnets."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.msk_from_eks[0].from_port == 9098 &&
      aws_vpc_security_group_ingress_rule.rds_from_eks[0].from_port == 5432
    )
    error_message = "created MSK/RDS security groups must expose only their exact service ports from EKS."
  }

  assert {
    condition     = length(aws_nat_gateway.private) == 2
    error_message = "per-AZ NAT mode must create one NAT Gateway in each selected Availability Zone."
  }
}

run "reject_network_creation_for_existing_cluster" {
  command = plan

  variables {
    environment                = "dev"
    owner                      = "pair-a"
    resource_lifecycle         = "mvp-owned"
    cluster_mode               = "existing"
    existing_cluster_name      = "shared-dev"
    network_mode               = "create"
    vpc_cidr                   = "10.43.0.0/16"
    network_availability_zones = ["ap-northeast-2a", "ap-northeast-2c"]
    subnet_newbits             = 8
    public_subnet_netnums      = [0, 1]
    private_subnet_netnums     = [10, 11]
    private_egress_mode        = "nat_gateway"
    nat_gateway_mode           = "single"
    create_ecr_repositories    = false
  }

  expect_failures = [check.network_creation_ownership]
}

run "reject_created_network_without_egress_choice" {
  command = plan

  variables {
    environment                = "dev"
    owner                      = "pair-a"
    resource_lifecycle         = "mvp-owned"
    cluster_mode               = "create"
    network_mode               = "create"
    vpc_cidr                   = "10.44.0.0/16"
    network_availability_zones = ["ap-northeast-2a", "ap-northeast-2c"]
    subnet_newbits             = 8
    public_subnet_netnums      = [0, 1]
    private_subnet_netnums     = [10, 11]
    private_egress_mode        = "undecided"
    nat_gateway_mode           = "undecided"
    create_ecr_repositories    = false
  }

  expect_failures = [check.private_egress_selection]
}

run "reject_incomplete_private_endpoint_set" {
  command = plan

  variables {
    environment                = "dev"
    owner                      = "pair-a"
    resource_lifecycle         = "mvp-owned"
    cluster_mode               = "create"
    network_mode               = "create"
    vpc_cidr                   = "10.45.0.0/16"
    network_availability_zones = ["ap-northeast-2a", "ap-northeast-2c"]
    subnet_newbits             = 8
    public_subnet_netnums      = [0, 1]
    private_subnet_netnums     = [10, 11]
    private_egress_mode        = "vpc_endpoints"
    nat_gateway_mode           = "undecided"
    interface_vpc_endpoint_services = [
      "ecr.api",
      "ecr.dkr",
      "logs",
      "sts",
    ]
    create_ecr_repositories = false
  }

  expect_failures = [check.private_endpoint_selection]
}

run "reject_duplicate_subnet_netnums" {
  command = plan

  variables {
    environment                = "dev"
    owner                      = "pair-a"
    resource_lifecycle         = "mvp-owned"
    cluster_mode               = "create"
    network_mode               = "create"
    vpc_cidr                   = "10.46.0.0/16"
    network_availability_zones = ["ap-northeast-2a", "ap-northeast-2c"]
    subnet_newbits             = 8
    public_subnet_netnums      = [0, 1]
    private_subnet_netnums     = [0, 11]
    private_egress_mode        = "nat_gateway"
    nat_gateway_mode           = "single"
    create_ecr_repositories    = false
  }

  expect_failures = [check.network_cidr_contract]
}

run "reject_unconfirmed_existing_auto_mode" {
  command = plan

  variables {
    environment                      = "dev"
    owner                            = "pair-a"
    resource_lifecycle               = "external"
    cluster_mode                     = "existing"
    existing_cluster_name            = "shared-dev"
    existing_auto_mode_enabled       = false
    existing_auto_mode_node_role_arn = null
    create_ecr_repositories          = false
  }

  expect_failures = [check.existing_auto_mode_contract]
}

run "reject_new_cluster_without_admin_access" {
  command = plan

  variables {
    environment                 = "dev"
    owner                       = "pair-a"
    resource_lifecycle          = "mvp-owned"
    cluster_mode                = "create"
    control_plane_subnet_ids    = ["subnet-test-a", "subnet-test-b"]
    cluster_admin_principal_arn = null
    create_ecr_repositories     = false
  }

  expect_failures = [check.new_auto_mode_admin_access]
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

    ingress_mode               = "auto-mode-alb"
    alb_exposure               = "internet-facing"
    alb_target_type            = "ip"
    alb_ip_address_type        = "ipv4"
    external_public_subnet_ids = ["subnet-public-a", "subnet-public-b"]
    ingress_listener_protocol  = "HTTP"
    private_egress_mode        = "hybrid"
    pod_network_enforcement    = "both"
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

  assert {
    condition = (
      output.phase13_alb_handoff.auto_mode_controller == "eks.amazonaws.com/alb" &&
      !output.phase13_alb_handoff.self_managed_controller &&
      output.phase13_alb_handoff.listener_protocol == "HTTP" &&
      output.phase13_alb_handoff.host == null &&
      output.phase13_alb_handoff.certificate_arn == null &&
      output.phase13_alb_handoff.ready_for_server_dry_run &&
      length(output.phase13_alb_handoff.subnet_ids) == 2
    )
    error_message = "Phase 13 must hand off the EKS-managed ALB class and exact reviewed subnets."
  }
}

run "created_network_internal_auto_mode_alb_handoff" {
  command = apply

  variables {
    environment                = "dev"
    owner                      = "pair-a"
    resource_lifecycle         = "mvp-owned"
    cluster_mode               = "create"
    network_mode               = "create"
    vpc_cidr                   = "10.48.0.0/16"
    network_availability_zones = ["ap-northeast-2a", "ap-northeast-2c"]
    subnet_newbits             = 8
    public_subnet_netnums      = [0, 1]
    private_subnet_netnums     = [10, 11]
    private_egress_mode        = "nat_gateway"
    nat_gateway_mode           = "single"
    create_ecr_repositories    = false

    ingress_mode              = "auto-mode-alb"
    alb_exposure              = "internal"
    alb_target_type           = "ip"
    alb_ip_address_type       = "ipv4"
    ingress_listener_protocol = "HTTPS"
    ingress_host              = "asklake.internal.example.invalid"
    ingress_certificate_arn   = "arn:aws:acm:ap-northeast-2:111122223333:certificate/00000000-0000-0000-0000-000000000000"
    ingress_dns_owner         = "platform-team"
  }

  assert {
    condition = (
      output.phase13_alb_handoff.exposure == "internal" &&
      length(output.phase13_alb_handoff.subnet_ids) == 2 &&
      toset(output.phase13_alb_handoff.subnet_ids) == toset(output.phase11_network_handoff.subnets.cluster_private)
    )
    error_message = "internal Auto Mode ALB must use the Phase 11 private subnets rather than public ALB subnets."
  }
}

run "reject_partial_alb_contract" {
  command = plan

  variables {
    environment                = "dev"
    owner                      = "pair-a"
    resource_lifecycle         = "external"
    cluster_mode               = "existing"
    existing_cluster_name      = "shared-dev"
    create_ecr_repositories    = false
    ingress_mode               = "auto-mode-alb"
    external_public_subnet_ids = ["subnet-public-a", "subnet-public-b"]
  }

  expect_failures = [check.alb_ingress_contract, check.alb_subnet_contract]
}

run "reject_auto_mode_alb_without_selected_subnets" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "external"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    ingress_mode              = "auto-mode-alb"
    alb_exposure              = "internet-facing"
    alb_target_type           = "ip"
    alb_ip_address_type       = "ipv4"
    ingress_listener_protocol = "HTTPS"
    ingress_host              = "asklake.example.invalid"
    ingress_certificate_arn   = "arn:aws:acm:ap-northeast-2:111122223333:certificate/00000000-0000-0000-0000-000000000000"
    ingress_dns_owner         = "platform-team"
  }

  expect_failures = [check.alb_ingress_contract, check.alb_subnet_contract]
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
  command = plan

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

    rds_mode                      = "create"
    rds_subnet_ids                = ["subnet-private-a", "subnet-private-b"]
    rds_security_group_ids        = ["sg-rds-client"]
    rds_instance_class            = "db.t4g.small"
    rds_final_snapshot_identifier = "asklake-dev-test-final"

    storage_mode = "create"
    storage_bucket_names = {
      raw           = "asklake-dev-111122223333-raw"
      output        = "asklake-dev-111122223333-output"
      warehouse     = "asklake-dev-111122223333-warehouse"
      query_results = "asklake-dev-111122223333-query-results"
    }
    storage_prefixes = {
      raw           = "*"
      output        = "*"
      warehouse     = "warehouse"
      query_results = "query-results"
      checkpoint    = "checkpoints"
      quarantine    = "quarantine"
      evidence      = "evidence"
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
    condition = (
      aws_db_instance.metadata[0].max_allocated_storage == 100 &&
      aws_db_instance.metadata[0].backup_retention_period == 7 &&
      aws_db_instance.metadata[0].backup_window == "18:00-18:30" &&
      aws_db_instance.metadata[0].maintenance_window == "sun:19:00-sun:20:00"
    )
    error_message = "RDS must keep the reviewed autoscaling, backup and maintenance settings."
  }

  assert {
    condition     = length(aws_s3_bucket.data) == 4
    error_message = "The data plane must create isolated raw, output, warehouse, and query result buckets."
  }

  assert {
    condition     = output.rds_contract.logical_databases.iceberg_catalog == "iceberg_catalog"
    error_message = "RDS handoff must expose the Iceberg JDBC Catalog database."
  }

}

run "managed_existing_storage_contract" {
  command = plan

  variables {
    environment             = "dev"
    owner                   = "pair-a"
    resource_lifecycle      = "mvp-owned"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    storage_mode = "managed-existing"
    storage_bucket_names = {
      raw           = "asklake-dev-111122223333-raw"
      output        = "asklake-dev-111122223333-output"
      warehouse     = "asklake-dev-111122223333-warehouse"
      query_results = "asklake-dev-111122223333-query-results"
    }
    storage_prefixes = {
      raw           = "*"
      output        = "*"
      warehouse     = "warehouse"
      query_results = "query-results"
      checkpoint    = "checkpoints"
      quarantine    = "quarantine"
      evidence      = "evidence"
    }
  }

  assert {
    condition     = length(aws_s3_bucket.data) == 4
    error_message = "managed-existing storage must expose four importable bucket resource addresses."
  }

  assert {
    condition = alltrue([
      for bucket in values(aws_s3_bucket.data) : bucket.tags["Lifecycle"] == "shared-preserved"
    ])
    error_message = "Imported buckets must override the state lifecycle tag with shared-preserved."
  }

  assert {
    condition     = length(aws_s3_bucket_versioning.data) == 4
    error_message = "managed-existing storage must manage versioning for every imported bucket."
  }

  assert {
    condition = (
      endswith(local.storage_object_arns.raw, ":s3:::asklake-dev-111122223333-raw/*") &&
      endswith(local.storage_object_arns.output, ":s3:::asklake-dev-111122223333-output/*") &&
      !endswith(local.storage_object_arns.raw, "*/*") &&
      !endswith(local.storage_object_arns.output, "*/*")
    )
    error_message = "Dedicated Raw/Output bucket-wide access must render a bucket-scoped object ARN, not a malformed wildcard prefix."
  }

  assert {
    condition = contains(
      one([for statement in module.workload_iam_policies.contracts.backend.Statement : statement if statement.Sid == "ReadBackendObjects"]).Resource,
      local.storage_object_arns.raw,
    )
    error_message = "Backend source browsing must be able to read objects from the approved Raw bucket boundary."
  }

  assert {
    condition = (
      one([for statement in module.workload_iam_policies.contracts.backend.Statement : statement if statement.Sid == "ListBackendRawBucket"]).Resource == [local.storage_bucket_arns.raw] &&
      one([for statement in module.workload_iam_policies.contracts.backend.Statement : statement if statement.Sid == "ListBackendRawBucket"]).Condition.StringLike["s3:prefix"] == ["*", "*/*"] &&
      one([for statement in module.workload_iam_policies.contracts.backend.Statement : statement if statement.Sid == "ListBackendOutputBucket"]).Resource == [local.storage_bucket_arns.output] &&
      one([for statement in module.workload_iam_policies.contracts.backend.Statement : statement if statement.Sid == "ListBackendOutputBucket"]).Condition.StringLike["s3:prefix"] == ["*", "*/*", "evidence", "evidence/*"] &&
      one([for statement in module.workload_iam_policies.contracts.backend.Statement : statement if statement.Sid == "ListBackendWarehouseBucket"]).Resource == [local.storage_bucket_arns.warehouse] &&
      one([for statement in module.workload_iam_policies.contracts.backend.Statement : statement if statement.Sid == "ListBackendWarehouseBucket"]).Condition.StringLike["s3:prefix"] == ["warehouse", "warehouse/*"] &&
      one([for statement in module.workload_iam_policies.contracts.backend.Statement : statement if statement.Sid == "ListBackendQueryResultBucket"]).Resource == [local.storage_bucket_arns.query_results] &&
      one([for statement in module.workload_iam_policies.contracts.backend.Statement : statement if statement.Sid == "ListBackendQueryResultBucket"]).Condition.StringLike["s3:prefix"] == ["query-results", "query-results/*"]
    )
    error_message = "Backend ListBucket conditions must be isolated per bucket so a wildcard for Raw/Output cannot widen Warehouse or Query Result prefixes."
  }

  assert {
    condition = (
      one([for statement in module.workload_iam_policies.contracts.trino.Statement : statement if statement.Sid == "ListTrinoWarehouseBucket"]).Resource == [local.storage_bucket_arns.warehouse] &&
      one([for statement in module.workload_iam_policies.contracts.trino.Statement : statement if statement.Sid == "ListTrinoWarehouseBucket"]).Condition.StringLike["s3:prefix"] == ["warehouse", "warehouse/*"] &&
      one([for statement in module.workload_iam_policies.contracts.trino.Statement : statement if statement.Sid == "ListTrinoQueryResultBucket"]).Resource == [local.storage_bucket_arns.query_results] &&
      one([for statement in module.workload_iam_policies.contracts.trino.Statement : statement if statement.Sid == "ListTrinoQueryResultBucket"]).Condition.StringLike["s3:prefix"] == ["query-results", "query-results/*"]
    )
    error_message = "Trino ListBucket conditions must be isolated between Warehouse and Query Result buckets."
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
      one([for statement in module.workload_iam_policies.contracts.spark.Statement : statement if statement.Sid == "ListSparkRawBucket"]).Resource == [local.storage_bucket_arns.raw] &&
      one([for statement in module.workload_iam_policies.contracts.spark.Statement : statement if statement.Sid == "ListSparkRawBucket"]).Condition.StringLike["s3:prefix"] == ["raw", "raw/*"] &&
      one([for statement in module.workload_iam_policies.contracts.spark.Statement : statement if statement.Sid == "ListSparkOutputBucket"]).Resource == [local.storage_bucket_arns.output] &&
      one([for statement in module.workload_iam_policies.contracts.spark.Statement : statement if statement.Sid == "ListSparkOutputBucket"]).Condition.StringLike["s3:prefix"] == ["output", "output/*", "checkpoints", "checkpoints/*", "quarantine", "quarantine/*"] &&
      one([for statement in module.workload_iam_policies.contracts.spark.Statement : statement if statement.Sid == "ListSparkWarehouseBucket"]).Resource == [local.storage_bucket_arns.warehouse] &&
      one([for statement in module.workload_iam_policies.contracts.spark.Statement : statement if statement.Sid == "ListSparkWarehouseBucket"]).Condition.StringLike["s3:prefix"] == ["warehouse", "warehouse/*"]
    )
    error_message = "Spark ListBucket conditions must be isolated so Raw/Output prefixes cannot widen Warehouse listing."
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
    resource_lifecycle      = "mvp-owned"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    secret_delivery_mode     = "external_secrets"
    secret_controller_ready  = true
    secret_controller_owner  = "platform-team"
    secret_rotation_owner    = "service-team"
    secret_source_prefix     = "/asklake/dev/runtime"
    pod_identity_agent_ready = true
  }

  assert {
    condition     = output.phase8_runtime_secret_handoff.ready_for_sync
    error_message = "reviewed external Secret inputs must become sync-ready."
  }

  assert {
    condition = (
      length(aws_iam_role.external_secrets) == 1 &&
      length(aws_iam_policy.external_secrets) == 1 &&
      length(aws_eks_pod_identity_association.external_secrets) == 1
    )
    error_message = "external_secrets mode must provision one least-privilege Pod Identity path."
  }

  assert {
    condition = (
      output.phase8_runtime_secret_handoff.delivery.external_secrets_identity.namespace == "external-secrets" &&
      output.phase8_runtime_secret_handoff.delivery.external_secrets_identity.service_account == "asklake-external-secrets"
    )
    error_message = "External Secrets handoff must expose the controller namespace and ServiceAccount."
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
    resource_lifecycle      = "mvp-owned"
    cluster_mode            = "existing"
    existing_cluster_name   = "shared-dev"
    create_ecr_repositories = false

    secret_delivery_mode     = "external_secrets"
    pod_identity_agent_ready = true
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

run "phase14_web_workload_handoff_is_fail_closed" {
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
    condition     = output.phase1_handoff.contract_version == "2.5" && output.phase1_handoff.web_output == "phase14_web_workload_handoff"
    error_message = "Phase 1 handoff must expose the Phase 14 web workload contract."
  }

  assert {
    condition     = !output.phase14_web_workload_handoff.default_enabled
    error_message = "Phase 14 web workloads must remain disabled by default."
  }

  assert {
    condition = (
      output.phase14_web_workload_handoff.workloads.frontend.service == "frontend" &&
      output.phase14_web_workload_handoff.workloads.frontend.service_port == 80 &&
      output.phase14_web_workload_handoff.workloads.backend.service == "fastapi" &&
      output.phase14_web_workload_handoff.workloads.backend.service_port == 8080
    )
    error_message = "Phase 14 Services must match the Phase 13 ALB routes."
  }

  assert {
    condition     = contains(output.phase14_web_workload_handoff.apply_gates, "backend-runtime-boundary-ready")
    error_message = "FastAPI multi-replica deployment must remain gated by Pair B's runtime boundary."
  }
}

run "phase14_metrics_server_defaults_fail_closed" {
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
    condition     = output.phase14_metrics_server_handoff.mode == "disabled" && !output.phase14_metrics_server_handoff.ready_for_apply
    error_message = "Metrics Server must remain disabled until ownership and an exact compatible version are reviewed."
  }
}

run "phase14_metrics_server_eks_addon_contract" {
  command = plan

  variables {
    environment                       = "dev"
    owner                             = "pair-a"
    resource_lifecycle                = "mvp-owned"
    cluster_mode                      = "create"
    control_plane_subnet_ids          = ["subnet-test-a", "subnet-test-b"]
    create_ecr_repositories           = false
    metrics_server_mode               = "eks_addon"
    metrics_server_addon_version      = "v0.8.0-eksbuild.1"
    metrics_server_owner              = "pair-a"
    external_metrics_server_confirmed = false
  }

  assert {
    condition = (
      aws_eks_addon.metrics_server[0].addon_name == "metrics-server" &&
      aws_eks_addon.metrics_server[0].addon_version == "v0.8.0-eksbuild.1" &&
      output.phase14_metrics_server_handoff.ready_for_apply
    )
    error_message = "Reviewed Metrics Server inputs must create the exact EKS community add-on."
  }
}

run "reject_partial_metrics_server_contract" {
  command = plan

  variables {
    environment              = "dev"
    owner                    = "pair-a"
    resource_lifecycle       = "mvp-owned"
    cluster_mode             = "create"
    control_plane_subnet_ids = ["subnet-test-a", "subnet-test-b"]
    create_ecr_repositories  = false
    metrics_server_mode      = "eks_addon"
  }

  expect_failures = [check.metrics_server_contract]
}
