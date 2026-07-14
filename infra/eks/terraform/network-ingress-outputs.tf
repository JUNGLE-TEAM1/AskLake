output "phase7_network_handoff" {
  description = "Non-secret, resource-free input for the AskLake ALB ingress chart and private network review."
  value = {
    contract_version = "1.0"
    ingress = {
      mode             = var.ingress_mode
      controller_ready = var.alb_controller_ready
      controller_owner = var.alb_controller_owner
      ingress_class    = "alb"
      exposure         = var.alb_exposure
      target_type      = var.alb_target_type
      host             = var.ingress_host
      certificate_arn  = var.ingress_certificate_arn
      group_name       = "${var.name_prefix}-${var.environment}"
      namespace        = var.namespace
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
