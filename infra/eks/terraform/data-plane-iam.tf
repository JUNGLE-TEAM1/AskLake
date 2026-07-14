module "workload_iam_policies" {
  source = "./modules/workload-iam-policies"

  reference_msk = local.reference_msk
  use_storage   = local.use_storage

  msk_cluster_arn = local.msk_cluster_arn
  msk_topic_arn   = local.msk_topic_arn
  msk_group_arn   = local.msk_group_arn

  storage_bucket_arns = local.storage_bucket_arns
  storage_object_arns = local.storage_object_arns
  storage_prefixes    = var.storage_prefixes
}

locals {
  workload_iam_policy_contracts = module.workload_iam_policies.contracts
  workload_iam_policy_documents = module.workload_iam_policies.documents
}
