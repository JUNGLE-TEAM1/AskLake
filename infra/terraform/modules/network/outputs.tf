output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "msk_security_group_id" {
  value = aws_security_group.msk.id
}

output "emr_security_group_id" {
  value = aws_security_group.emr.id
}

output "runner_security_group_id" {
  value = aws_security_group.runner.id
}

output "interface_endpoint_ids" {
  value = { for service, endpoint in aws_vpc_endpoint.interface : service => endpoint.id }
}

output "s3_endpoint_id" {
  value = aws_vpc_endpoint.s3.id
}
