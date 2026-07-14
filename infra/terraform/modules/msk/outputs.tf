output "cluster_name" {
  value = aws_msk_serverless_cluster.this.cluster_name
}

output "cluster_arn" {
  value = aws_msk_serverless_cluster.this.arn
}

output "cluster_uuid" {
  value = aws_msk_serverless_cluster.this.cluster_uuid
}

output "bootstrap_brokers_sasl_iam" {
  value     = aws_msk_serverless_cluster.this.bootstrap_brokers_sasl_iam
  sensitive = true
}
