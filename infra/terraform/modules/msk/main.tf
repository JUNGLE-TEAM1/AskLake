terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

resource "aws_msk_serverless_cluster" "this" {
  cluster_name = var.cluster_name

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [var.security_group_id]
  }

  client_authentication {
    sasl {
      iam {
        enabled = true
      }
    }
  }

  timeouts {
    create = "120m"
    delete = "120m"
  }
}
