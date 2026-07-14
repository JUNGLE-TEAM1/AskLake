output "emr_execution_role_arn" {
  value = aws_iam_role.emr_execution.arn
}

output "smoke_runner_role_arn" {
  value = aws_iam_role.smoke_runner.arn
}

output "smoke_runner_instance_profile_name" {
  value = aws_iam_instance_profile.smoke_runner.name
}
