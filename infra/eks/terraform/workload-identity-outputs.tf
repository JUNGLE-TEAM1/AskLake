output "workload_identity_contract" {
  description = "Selected workload identity delivery contract. IRSA annotations stay empty for Pod Identity."
  value = {
    mode = var.workload_identity_mode
    roles = {
      for workload, role in aws_iam_role.workload :
      workload => role.arn
    }
    service_account_annotations = local.use_irsa ? {
      for workload, role in aws_iam_role.workload :
      workload => {
        "eks.amazonaws.com/role-arn" = role.arn
      }
    } : {}
    pod_identity_associations = local.use_pod_identity ? {
      for workload, association in aws_eks_pod_identity_association.workload :
      workload => {
        namespace       = association.namespace
        service_account = association.service_account
      }
    } : {}
  }
}
