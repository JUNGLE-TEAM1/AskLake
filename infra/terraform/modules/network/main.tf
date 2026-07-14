terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

locals {
  interface_endpoint_services = toset([
    "ssm",
    "ssmmessages",
    "ec2messages",
    "logs",
    "emr-serverless",
  ])
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.name_prefix}-vpc"
  }
}

resource "aws_subnet" "private" {
  count = length(var.private_subnet_cidrs)

  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = var.private_subnet_cidrs[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name_prefix}-private-${count.index + 1}"
    Tier = "private"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-private"
  }
}

resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "endpoint" {
  name        = "${var.name_prefix}-endpoint"
  description = "PrivateLink ingress from AskLake runtime and smoke runner"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-endpoint"
  }
}

resource "aws_security_group" "msk" {
  name        = "${var.name_prefix}-msk"
  description = "MSK Serverless IAM data-plane access"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-msk"
  }
}

resource "aws_security_group" "emr" {
  name        = "${var.name_prefix}-emr"
  description = "EMR Serverless workers without public ingress"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-emr"
  }
}

resource "aws_security_group" "runner" {
  name        = "${var.name_prefix}-runner"
  description = "Private SSM smoke runner without SSH ingress"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-runner"
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = {
    Name = "${var.name_prefix}-s3"
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoint_services

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoint.id]

  tags = {
    Name = "${var.name_prefix}-${each.value}"
  }
}

resource "aws_vpc_security_group_ingress_rule" "endpoint_from_emr" {
  security_group_id            = aws_security_group.endpoint.id
  referenced_security_group_id = aws_security_group.emr.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "HTTPS from EMR Serverless workers"
}

resource "aws_vpc_security_group_ingress_rule" "endpoint_from_runner" {
  security_group_id            = aws_security_group.endpoint.id
  referenced_security_group_id = aws_security_group.runner.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "HTTPS from the SSM smoke runner"
}

resource "aws_vpc_security_group_ingress_rule" "msk_from_emr" {
  security_group_id            = aws_security_group.msk.id
  referenced_security_group_id = aws_security_group.emr.id
  from_port                    = 9098
  to_port                      = 9098
  ip_protocol                  = "tcp"
  description                  = "Kafka IAM from EMR Serverless"
}

resource "aws_vpc_security_group_ingress_rule" "msk_from_runner" {
  security_group_id            = aws_security_group.msk.id
  referenced_security_group_id = aws_security_group.runner.id
  from_port                    = 9098
  to_port                      = 9098
  ip_protocol                  = "tcp"
  description                  = "Kafka IAM from the smoke runner"
}

resource "aws_vpc_security_group_egress_rule" "msk_within_vpc" {
  security_group_id = aws_security_group.msk.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "-1"
  description       = "Stateful MSK responses stay inside the staging VPC"
}

resource "aws_vpc_security_group_egress_rule" "emr_to_msk" {
  security_group_id            = aws_security_group.emr.id
  referenced_security_group_id = aws_security_group.msk.id
  from_port                    = 9098
  to_port                      = 9098
  ip_protocol                  = "tcp"
  description                  = "Kafka IAM data plane"
}

resource "aws_vpc_security_group_egress_rule" "runner_to_msk" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.msk.id
  from_port                    = 9098
  to_port                      = 9098
  ip_protocol                  = "tcp"
  description                  = "Kafka IAM probe and fixture producer"
}

resource "aws_vpc_security_group_egress_rule" "emr_to_endpoints" {
  security_group_id            = aws_security_group.emr.id
  referenced_security_group_id = aws_security_group.endpoint.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "Private AWS service endpoints"
}

resource "aws_vpc_security_group_egress_rule" "runner_to_endpoints" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.endpoint.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "SSM, Logs and EMR Serverless endpoints"
}

resource "aws_vpc_security_group_egress_rule" "emr_to_s3" {
  security_group_id = aws_security_group.emr.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "S3 gateway endpoint"
}

resource "aws_vpc_security_group_egress_rule" "runner_to_s3" {
  security_group_id = aws_security_group.runner.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "S3 artifact and evidence transfer"
}

resource "aws_vpc_security_group_egress_rule" "emr_dns_udp" {
  security_group_id = aws_security_group.emr.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
  description       = "VPC DNS"
}

resource "aws_vpc_security_group_egress_rule" "emr_dns_tcp" {
  security_group_id = aws_security_group.emr.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
  description       = "VPC DNS fallback"
}

resource "aws_vpc_security_group_egress_rule" "runner_dns_udp" {
  security_group_id = aws_security_group.runner.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
  description       = "VPC DNS"
}

resource "aws_vpc_security_group_egress_rule" "runner_dns_tcp" {
  security_group_id = aws_security_group.runner.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
  description       = "VPC DNS fallback"
}
