output "phase14_web_workload_handoff" {
  description = "Non-secret Frontend/FastAPI workload manifest and dependency contract."
  value = {
    contract_version = "1.0"
    namespace        = var.namespace
    chart            = "infra/eks/helm/asklake-web"
    default_enabled  = false
    workloads = {
      frontend = {
        deployment      = "frontend"
        service         = "frontend"
        service_port    = 80
        health_path     = "/"
        service_account = var.service_account_names["frontend"]
      }
      backend = {
        deployment      = "fastapi"
        service         = "fastapi"
        service_port    = 8080
        health_path     = "/api/health"
        service_account = var.service_account_names["backend"]
      }
    }
    placement = {
      node_selector = { "asklake.io/workload-class" = "general" }
      node_pool     = "phase12_node_pool_handoff.general"
    }
    required_references = {
      runtime_config_map          = "asklake-runtime"
      runtime_boundary_config_map = "asklake-runtime-boundary"
      backend_secret              = "asklake-backend-runtime"
      image_receipt               = "immutable-linux-amd64-digests"
    }
    apply_gates = [
      "foundation-ready",
      "general-node-pool-ready",
      "image-receipt-verified",
      "runtime-config-ready",
      "runtime-secret-ready",
      "backend-runtime-boundary-ready",
    ]
    ingress_dependency = "deploy-web-before-phase13-ingress"
    deletion_order     = ["phase13-ingress", "phase14-web", "foundation"]
    runtime_smoke      = "required-after-apply"
  }
}
