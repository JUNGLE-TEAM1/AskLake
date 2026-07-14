output "batch_log_group_name" {
  value = aws_cloudwatch_log_group.this["batch"].name
}

output "continuous_log_group_name" {
  value = aws_cloudwatch_log_group.this["continuous"].name
}

output "smoke_log_group_name" {
  value = aws_cloudwatch_log_group.this["smoke"].name
}

output "log_group_arns" {
  value = { for workload, group in aws_cloudwatch_log_group.this : workload => group.arn }
}
