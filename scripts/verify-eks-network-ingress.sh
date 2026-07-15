#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-ingress"
VALUES_FILE="$ROOT_DIR/infra/eks/values/ingress/alb.example.yaml"
DISABLED_RENDER="$(mktemp)"
ENABLED_RENDER="$(mktemp)"
trap 'rm -f "$DISABLED_RENDER" "$ENABLED_RENDER"' EXIT

helm lint "$CHART_DIR"
helm template asklake-ingress "$CHART_DIR" >"$DISABLED_RENDER"
helm template asklake-ingress "$CHART_DIR" -f "$VALUES_FILE" >"$ENABLED_RENDER"

if grep -q '^kind: Ingress$' "$DISABLED_RENDER"; then
  echo "disabled ingress rendered an AWS resource" >&2
  exit 1
fi

if helm template asklake-ingress "$CHART_DIR" \
  --set enabled=true >/dev/null 2>&1; then
  echo "enabled ingress accepted unresolved controller/DNS/ACM choices" >&2
  exit 1
fi

ingress_count="$(grep -c '^kind: Ingress$' "$ENABLED_RENDER")"
if [[ "$ingress_count" -ne 2 ]]; then
  echo "expected separate backend/frontend ALB ingress rules, rendered $ingress_count" >&2
  exit 1
fi

grep -q 'alb.ingress.kubernetes.io/listen-ports:.*HTTPS' "$ENABLED_RENDER"
grep -q 'alb.ingress.kubernetes.io/ssl-redirect: "443"' "$ENABLED_RENDER"
grep -q 'alb.ingress.kubernetes.io/group.order: "10"' "$ENABLED_RENDER"
grep -q 'alb.ingress.kubernetes.io/group.order: "20"' "$ENABLED_RENDER"
grep -q 'alb.ingress.kubernetes.io/healthcheck-path: "/api/health"' "$ENABLED_RENDER"
grep -q 'alb.ingress.kubernetes.io/healthcheck-path: "/"' "$ENABLED_RENDER"
grep -q 'path: /api' "$ENABLED_RENDER"
grep -q 'name: fastapi' "$ENABLED_RENDER"
grep -q 'number: 8080' "$ENABLED_RENDER"
grep -q 'name: frontend' "$ENABLED_RENDER"
grep -q 'number: 80' "$ENABLED_RENDER"

if helm template asklake-ingress "$CHART_DIR" -f "$VALUES_FILE" \
  --set targetType=instance >/dev/null 2>&1; then
  echo "instance target type accepted ClusterIP service contracts" >&2
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

echo "EKS network and ingress contract verification passed."
