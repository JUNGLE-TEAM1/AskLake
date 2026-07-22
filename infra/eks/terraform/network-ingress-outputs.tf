output "phase7_network_handoff" {
  description = "Compatibility view of the Phase 7 network decisions after the Phase 13 Auto Mode ALB migration."
  value = {
    contract_version = "2.0"
    ingress = {
      mode              = var.ingress_mode
      controller        = "eks.amazonaws.com/alb"
      controller_owner  = "eks-auto-mode-managed"
      ingress_class     = "${var.name_prefix}-${var.environment}-alb"
      exposure          = var.alb_exposure
      target_type       = var.alb_target_type
      ip_address_type   = var.alb_ip_address_type
      subnet_ids        = local.alb_subnet_ids
      listener_protocol = var.ingress_listener_protocol
      host              = var.ingress_host
      certificate_arn   = var.ingress_certificate_arn
      dns_owner         = var.ingress_dns_owner
      group_name        = "${var.name_prefix}-${var.environment}"
      namespace         = var.namespace
      routes = {
        frontend = {
          path         = "/"
          service_name = "frontend"
          service_port = 80
          health_path  = "/"
        }
        backend = {
          path         = "/api"
          service_name = "fastapi"
          service_port = 8080
          health_path  = "/api/health"
        }
      }
      required_service_type = var.alb_target_type == "instance" ? "NodePort" : var.alb_target_type == "ip" ? "ClusterIP-compatible" : null
    }
    private_network = {
      egress_mode     = var.private_egress_mode
      pod_enforcement = var.pod_network_enforcement
      required_destinations = {
        kubernetes_api = 443
        ecr_s3_sts     = 443
        rds            = 5432
        msk_iam        = 9098
        trino          = 8443
        airflow_api    = 8080
      }
    }
    ready_for_ingress_render = local.ingress_inputs_complete
    decisions_complete       = local.ingress_inputs_complete && local.private_network_decisions_complete
  }
}

output "phase13_alb_handoff" {
  description = "Non-secret EKS Auto Mode IngressClassParams and deployment handoff."
  value = {
    contract_version          = "1.0"
    mode                      = var.ingress_mode
    auto_mode_controller      = "eks.amazonaws.com/alb"
    self_managed_controller   = false
    ingress_class_name        = "${var.name_prefix}-${var.environment}-alb"
    ingress_class_params_name = "${var.name_prefix}-${var.environment}-alb"
    namespace                 = var.namespace
    namespace_selector        = { "asklake.io/ingress-access" = var.namespace }
    group_name                = "${var.name_prefix}-${var.environment}"
    exposure                  = var.alb_exposure
    target_type               = var.alb_target_type
    ip_address_type           = var.alb_ip_address_type
    subnet_ids                = local.alb_subnet_ids
    listener_protocol         = var.ingress_listener_protocol
    host                      = var.ingress_host
    certificate_arn           = var.ingress_certificate_arn
    dns_owner                 = var.ingress_dns_owner
    ready_for_server_dry_run  = local.ingress_inputs_complete
    actual_alb_hostname       = "available-only-after-ingress-reconciliation"
    runtime_and_cost_smoke    = "required-after-apply"
    deletion_order            = ["dns-record", "ingress", "alb-finalizer-complete", "ingress-class", "cluster"]
  }
}
