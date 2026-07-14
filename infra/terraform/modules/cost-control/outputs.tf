output "budget_arn" {
  value = aws_budgets_budget.smoke.arn
}

output "budget_limit_usd" {
  value = var.budget_limit_usd
}
