terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

resource "aws_instance" "this" {
  count = var.enabled ? 1 : 0

  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [var.security_group_id]
  iam_instance_profile        = var.instance_profile_name
  associate_public_ip_address = false
  monitoring                  = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    encrypted   = true
    volume_size = 20
    volume_type = "gp3"
  }

  user_data = <<-EOT
    #!/bin/sh
    set -eu
    install -d -m 0750 /opt/asklake-smoke
    printf '%s\n' 'ready-for-ssm-bundle' > /opt/asklake-smoke/phase1-status
  EOT

  tags = {
    Name     = "${var.name_prefix}-smoke-runner"
    Workload = "smoke-runner"
  }

  lifecycle {
    precondition {
      condition     = var.ami_id != null && can(regex("^ami-[0-9a-f]+$", var.ami_id))
      error_message = "enable_smoke_runner requires an approved AMI ID."
    }
  }
}
