output "contracts" {
  value = local.contracts
}

output "documents" {
  value = {
    for workload, contract in local.contracts :
    workload => contract == null ? null : jsonencode(contract)
  }
}
