locals {
  create_network = var.network_mode == "create"
  use_nat_egress = contains(["nat_gateway", "hybrid"], var.private_egress_mode)
  use_endpoints  = contains(["vpc_endpoints", "hybrid"], var.private_egress_mode)

  public_subnet_cidrs = local.create_network ? [
    for netnum in var.public_subnet_netnums : cidrsubnet(var.vpc_cidr, var.subnet_newbits, netnum)
  ] : []
  private_subnet_cidrs = local.create_network ? [
    for netnum in var.private_subnet_netnums : cidrsubnet(var.vpc_cidr, var.subnet_newbits, netnum)
  ] : []

  network_subnets = local.create_network ? {
    for index, availability_zone in var.network_availability_zones :
    availability_zone => {
      public_cidr  = try(local.public_subnet_cidrs[index], null)
      private_cidr = try(local.private_subnet_cidrs[index], null)
    }
  } : {}

  nat_gateway_zones = !local.create_network || !local.use_nat_egress ? toset([]) : (
    var.nat_gateway_mode == "single" ? toset(slice(var.network_availability_zones, 0, 1)) : toset(var.network_availability_zones)
  )

  required_private_endpoint_services = toset(["ec2", "ecr.api", "ecr.dkr", "logs", "sts"])
  all_network_subnet_netnums         = concat(var.public_subnet_netnums, var.private_subnet_netnums)
  created_private_subnet_ids         = [for zone in var.network_availability_zones : aws_subnet.private[zone].id]
  created_public_subnet_ids          = [for zone in var.network_availability_zones : aws_subnet.public[zone].id]
  effective_cluster_subnet_ids       = local.create_network ? local.created_private_subnet_ids : var.control_plane_subnet_ids
  effective_msk_subnet_ids           = local.create_network ? local.created_private_subnet_ids : var.msk_subnet_ids
  effective_rds_subnet_ids           = local.create_network ? local.created_private_subnet_ids : var.rds_subnet_ids
}

check "network_creation_ownership" {
  assert {
    condition     = !local.create_network || (local.create_cluster && var.resource_lifecycle == "mvp-owned")
    error_message = "network creation is allowed only with an MVP-owned newly created EKS cluster. Existing/shared networks remain references."
  }
}

check "external_public_subnet_contract" {
  assert {
    condition = local.create_network ? length(var.external_public_subnet_ids) == 0 : (
      length(var.external_public_subnet_ids) == 0 || (
        length(var.external_public_subnet_ids) >= 2 &&
        length(distinct(var.external_public_subnet_ids)) == length(var.external_public_subnet_ids)
      )
    )
    error_message = "created networks derive public subnets internally; external networking must provide zero or at least two distinct public ALB subnet IDs."
  }
}

check "network_cidr_contract" {
  assert {
    condition = !local.create_network || (
      try(trimspace(var.vpc_cidr), "") != "" &&
      var.subnet_newbits != null &&
      var.subnet_newbits >= 1 &&
      tonumber(split("/", var.vpc_cidr)[1]) + var.subnet_newbits <= 28 &&
      length(var.network_availability_zones) >= 2 &&
      length(distinct(var.network_availability_zones)) == length(var.network_availability_zones) &&
      length(var.public_subnet_netnums) == length(var.network_availability_zones) &&
      length(var.private_subnet_netnums) == length(var.network_availability_zones) &&
      length(distinct(local.all_network_subnet_netnums)) == length(local.all_network_subnet_netnums) &&
      alltrue([
        for netnum in local.all_network_subnet_netnums :
        can(cidrsubnet(var.vpc_cidr, var.subnet_newbits, netnum))
      ])
    )
    error_message = "network creation requires a reviewed VPC CIDR, valid subnet_newbits, and distinct paired public/private netnums in at least two unique Availability Zones."
  }
}

check "private_egress_selection" {
  assert {
    condition     = !local.create_network || var.private_egress_mode != "undecided"
    error_message = "network creation requires an explicit nat_gateway, vpc_endpoints, or hybrid private egress decision."
  }
}

check "nat_gateway_selection" {
  assert {
    condition = !local.create_network || (
      local.use_nat_egress ? var.nat_gateway_mode != "undecided" : var.nat_gateway_mode == "undecided"
    )
    error_message = "NAT egress requires single/per_az selection; endpoint-only egress must keep nat_gateway_mode undecided."
  }
}

check "private_endpoint_selection" {
  assert {
    condition = !local.create_network || (
      local.use_endpoints ? length(setsubtract(local.required_private_endpoint_services, var.interface_vpc_endpoint_services)) == 0 : length(var.interface_vpc_endpoint_services) == 0
    )
    error_message = "endpoint egress requires ec2, ecr.api, ecr.dkr, logs, and sts; NAT-only egress must not create unreviewed interface endpoints."
  }
}

resource "aws_vpc" "mvp" {
  count = local.create_network ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name_prefix}-${var.environment}-vpc"
  }
}

resource "aws_internet_gateway" "mvp" {
  count = local.create_network ? 1 : 0

  vpc_id = aws_vpc.mvp[0].id

  tags = {
    Name = "${var.name_prefix}-${var.environment}-igw"
  }
}

resource "aws_subnet" "public" {
  for_each = local.network_subnets

  vpc_id                  = aws_vpc.mvp[0].id
  availability_zone       = each.key
  cidr_block              = each.value.public_cidr
  map_public_ip_on_launch = false

  tags = {
    Name                     = "${var.name_prefix}-${var.environment}-public-${each.key}"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "private" {
  for_each = local.network_subnets

  vpc_id                  = aws_vpc.mvp[0].id
  availability_zone       = each.key
  cidr_block              = each.value.private_cidr
  map_public_ip_on_launch = false

  tags = {
    Name                              = "${var.name_prefix}-${var.environment}-private-${each.key}"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

resource "aws_route_table" "public" {
  count = local.create_network ? 1 : 0

  vpc_id = aws_vpc.mvp[0].id

  tags = {
    Name = "${var.name_prefix}-${var.environment}-public"
  }
}

resource "aws_route" "public_internet" {
  count = local.create_network ? 1 : 0

  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.mvp[0].id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table" "private" {
  for_each = local.network_subnets

  vpc_id = aws_vpc.mvp[0].id

  tags = {
    Name = "${var.name_prefix}-${var.environment}-private-${each.key}"
  }
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_eip" "nat" {
  for_each = local.nat_gateway_zones

  domain = "vpc"

  tags = {
    Name = "${var.name_prefix}-${var.environment}-nat-${each.key}"
  }

  depends_on = [aws_internet_gateway.mvp]
}

resource "aws_nat_gateway" "private" {
  for_each = local.nat_gateway_zones

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id

  tags = {
    Name = "${var.name_prefix}-${var.environment}-nat-${each.key}"
  }
}

resource "aws_route" "private_nat" {
  for_each = local.create_network && local.use_nat_egress ? local.network_subnets : {}

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id = var.nat_gateway_mode == "single" ? (
    aws_nat_gateway.private[var.network_availability_zones[0]].id
  ) : aws_nat_gateway.private[each.key].id
}

resource "aws_security_group" "interface_endpoints" {
  count = local.create_network && local.use_endpoints ? 1 : 0

  name        = "${var.name_prefix}-${var.environment}-interface-endpoints"
  description = "HTTPS from reviewed AskLake private subnet CIDRs"
  vpc_id      = aws_vpc.mvp[0].id
}

resource "aws_vpc_security_group_ingress_rule" "interface_endpoints_https" {
  for_each = local.create_network && local.use_endpoints ? toset(local.private_subnet_cidrs) : toset([])

  security_group_id = aws_security_group.interface_endpoints[0].id
  description       = "HTTPS from AskLake private subnet ${each.value}"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.create_network && local.use_endpoints ? var.interface_vpc_endpoint_services : toset([])

  vpc_id              = aws_vpc.mvp[0].id
  service_name        = "com.amazonaws.${var.aws_region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = local.created_private_subnet_ids
  security_group_ids  = [aws_security_group.interface_endpoints[0].id]

  tags = {
    Name = "${var.name_prefix}-${var.environment}-${replace(each.value, ".", "-")}"
  }
}

resource "aws_vpc_endpoint" "s3" {
  count = local.create_network && local.use_endpoints ? 1 : 0

  vpc_id            = aws_vpc.mvp[0].id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for route_table in aws_route_table.private : route_table.id]

  tags = {
    Name = "${var.name_prefix}-${var.environment}-s3"
  }
}

resource "aws_security_group" "msk_private" {
  count = local.create_network && local.create_msk ? 1 : 0

  name        = "${var.name_prefix}-${var.environment}-msk-private"
  description = "MSK IAM listener from the EKS cluster security group"
  vpc_id      = aws_vpc.mvp[0].id
}

resource "aws_vpc_security_group_ingress_rule" "msk_from_eks" {
  count = local.create_network && local.create_msk ? 1 : 0

  security_group_id            = aws_security_group.msk_private[0].id
  description                  = "MSK Serverless IAM from EKS"
  referenced_security_group_id = aws_eks_cluster.this[0].vpc_config[0].cluster_security_group_id
  from_port                    = 9098
  to_port                      = 9098
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "rds_private" {
  count = local.create_network && local.create_rds ? 1 : 0

  name        = "${var.name_prefix}-${var.environment}-rds-private"
  description = "PostgreSQL from the EKS cluster security group"
  vpc_id      = aws_vpc.mvp[0].id
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_eks" {
  count = local.create_network && local.create_rds ? 1 : 0

  security_group_id            = aws_security_group.rds_private[0].id
  description                  = "PostgreSQL from EKS"
  referenced_security_group_id = aws_eks_cluster.this[0].vpc_config[0].cluster_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
