#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-ingress"
VALUES_FILE="$ROOT_DIR/infra/eks/values/ingress/alb.example.yaml"
DISABLED_RENDER="$(mktemp)"
FOUNDATION_RENDER="$(mktemp)"
ENABLED_RENDER="$(mktemp)"
trap 'rm -f "$DISABLED_RENDER" "$FOUNDATION_RENDER" "$ENABLED_RENDER"' EXIT

helm lint "$CHART_DIR"
helm template asklake-ingress "$CHART_DIR" >"$DISABLED_RENDER"
helm template asklake-ingress "$CHART_DIR" -f "$VALUES_FILE" \
  --set routesEnabled=false >"$FOUNDATION_RENDER"
helm template asklake-ingress "$CHART_DIR" -f "$VALUES_FILE" >"$ENABLED_RENDER"

if grep -q '^kind:' "$DISABLED_RENDER"; then
  echo "disabled ingress rendered a Kubernetes resource" >&2
  exit 1
fi

if helm template asklake-ingress "$CHART_DIR" \
  --set enabled=true >/dev/null 2>&1; then
  echo "enabled ingress accepted unresolved Auto Mode/subnet/listener choices" >&2
  exit 1
fi

foundation_ingress_count="$(grep -c '^kind: Ingress$' "$FOUNDATION_RENDER" || true)"
foundation_class_count="$(grep -c '^kind: IngressClass$' "$FOUNDATION_RENDER")"
foundation_params_count="$(grep -c '^kind: IngressClassParams$' "$FOUNDATION_RENDER")"
if [[ "$foundation_ingress_count" -ne 0 || "$foundation_class_count" -ne 1 || "$foundation_params_count" -ne 1 ]]; then
  echo "foundation-only values must render one class/params pair and no Ingress" >&2
  exit 1
fi

ingress_count="$(grep -c '^kind: Ingress$' "$ENABLED_RENDER")"
ingress_class_count="$(grep -c '^kind: IngressClass$' "$ENABLED_RENDER")"
ingress_params_count="$(grep -c '^kind: IngressClassParams$' "$ENABLED_RENDER")"
if [[ "$ingress_count" -ne 2 || "$ingress_class_count" -ne 1 || "$ingress_params_count" -ne 1 ]]; then
  echo "expected separate backend/frontend ALB ingress rules, rendered $ingress_count" >&2
  exit 1
fi

grep -q 'apiVersion: eks.amazonaws.com/v1' "$ENABLED_RENDER"
grep -q 'controller: eks.amazonaws.com/alb' "$ENABLED_RENDER"
grep -q 'name: asklake-dev-alb' "$ENABLED_RENDER"
grep -q 'asklake.io/ingress-access: asklake-dev' "$ENABLED_RENDER"
grep -q 'scheme: internet-facing' "$ENABLED_RENDER"
grep -q 'ipAddressType: ipv4' "$ENABLED_RENDER"
grep -q 'subnet-test-public-a' "$ENABLED_RENDER"
grep -q 'alb.ingress.kubernetes.io/listen-ports:.*HTTP' "$ENABLED_RENDER"
if grep -Eq 'certificateARNs:|alb.ingress.kubernetes.io/ssl-redirect|  host:' "$ENABLED_RENDER"; then
  echo "HTTP/default-DNS render unexpectedly contains HTTPS host or certificate settings" >&2
  exit 1
fi
grep -q 'alb.ingress.kubernetes.io/healthcheck-path: "/api/health"' "$ENABLED_RENDER"
grep -q 'alb.ingress.kubernetes.io/healthcheck-path: "/"' "$ENABLED_RENDER"
grep -q 'path: /api' "$ENABLED_RENDER"
grep -q 'name: fastapi' "$ENABLED_RENDER"
grep -q 'number: 8080' "$ENABLED_RENDER"
grep -q 'name: frontend' "$ENABLED_RENDER"
grep -q 'number: 80' "$ENABLED_RENDER"

if grep -Eq 'kubernetes.io/ingress.class|alb.ingress.kubernetes.io/(group.name|scheme|certificate-arn)' "$ENABLED_RENDER"; then
  echo "self-managed AWS Load Balancer Controller annotations remain in the Auto Mode render" >&2
  exit 1
fi

if helm template asklake-ingress "$CHART_DIR" -f "$VALUES_FILE" \
  --set targetType=instance >/dev/null 2>&1; then
  echo "instance target type accepted ClusterIP service contracts" >&2
  exit 1
fi

if helm template asklake-ingress "$CHART_DIR" -f "$VALUES_FILE" \
  --set listenerProtocol=HTTPS >/dev/null 2>&1; then
  echo "HTTPS listener accepted without an exact host and ACM certificate" >&2
  exit 1
fi

if grep -Eiq 'AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|asklake-replay-producer' \
  "$CHART_DIR"/values.yaml \
  "$CHART_DIR"/templates/*.yaml \
  "$VALUES_FILE" \
  "$ROOT_DIR/infra/eks/terraform/network-ingress"*.tf; then
  echo "credential or out-of-scope Replay content found in the network contract" >&2
  exit 1
fi

grep -Eq '^ingress_mode[[:space:]]*=[[:space:]]*"disabled"$' "$ROOT_DIR/infra/eks/terraform/dev.tfvars.example"
grep -Eq '^private_egress_mode[[:space:]]*=[[:space:]]*"undecided"$' "$ROOT_DIR/infra/eks/terraform/dev.tfvars.example"
grep -Eq '^pod_network_enforcement[[:space:]]*=[[:space:]]*"undecided"$' "$ROOT_DIR/infra/eks/terraform/dev.tfvars.example"
grep -q 'asklake.io/ingress-access: asklake-dev' "$ROOT_DIR/infra/eks/values/dev.example.yaml"
grep -q 'output "phase13_alb_handoff"' "$ROOT_DIR/infra/eks/terraform/network-ingress-outputs.tf"

bash -n "$ROOT_DIR/scripts/deploy-eks-auto-mode-ingress.sh"
bash -n "$ROOT_DIR/scripts/destroy-eks-auto-mode-ingress.sh"
grep -q 'create-cost-bearing-auto-mode-alb' "$ROOT_DIR/scripts/deploy-eks-auto-mode-ingress.sh"
grep -q 'apply-auto-mode-ingress-foundation' "$ROOT_DIR/scripts/deploy-eks-auto-mode-ingress.sh"
grep -q 'delete-auto-mode-alb-before-cluster' "$ROOT_DIR/scripts/destroy-eks-auto-mode-ingress.sh"
grep -q 'dns-record-removed-or-not-created' "$ROOT_DIR/scripts/destroy-eks-auto-mode-ingress.sh"
grep -q -- '--dry-run=server' "$ROOT_DIR/scripts/deploy-eks-auto-mode-ingress.sh"

echo "EKS Auto Mode ALB ingress contract verification passed."
