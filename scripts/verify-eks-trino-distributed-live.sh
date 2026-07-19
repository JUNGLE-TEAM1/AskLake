#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
CONTEXT="${ASKLAKE_EKS_CONTEXT:-asklake-dev}"
RELEASE="${ASKLAKE_TRINO_RELEASE:-asklake-trino}"
EXPECTED_WORKERS="${1:-}"

fail() {
  echo "$1" >&2
  exit 1
}

for command in helm jq kubectl python3; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ "$EXPECTED_WORKERS" == "2" ]] || fail "expected worker count must be exactly 2"
[[ "$(kubectl config current-context)" == "$CONTEXT" ]] || fail "unexpected Kubernetes context"
[[ "$(helm status "$RELEASE" -n "$NAMESPACE" -o json | jq -r '.info.status')" == "deployed" ]] || \
  fail "Trino Helm release is not deployed"

kubectl rollout status deployment/asklake-trino -n "$NAMESPACE" --timeout=10m >/dev/null
kubectl rollout status deployment/asklake-trino-worker -n "$NAMESPACE" --timeout=10m >/dev/null

workloads="$(kubectl get deployment asklake-trino asklake-trino-worker -n "$NAMESPACE" -o json)"
jq -e '
  [.items[] | select(.metadata.name == "asklake-trino")][0] as $coordinator |
  [.items[] | select(.metadata.name == "asklake-trino-worker")][0] as $workers |
  $coordinator.spec.replicas == 1 and
  $coordinator.status.readyReplicas == 1 and
  $coordinator.spec.strategy.type == "Recreate" and
  $workers.spec.replicas == $expected and
  $workers.status.readyReplicas == $expected and
  $coordinator.spec.template.spec.serviceAccountName == "asklake-trino" and
  $workers.spec.template.spec.serviceAccountName == "asklake-trino" and
  $coordinator.spec.template.spec.containers[0].image == $workers.spec.template.spec.containers[0].image
' --argjson expected "$EXPECTED_WORKERS" <<<"$workloads" >/dev/null || fail "Trino workload contract is not ready"

coordinator_ips="$(kubectl get pod -n "$NAMESPACE" -l 'app.kubernetes.io/component=trino' -o json | jq -r '
  [.items[] | select(.status.phase == "Running") |
    select(any(.status.conditions[]?; .type == "Ready" and .status == "True")) |
    .status.podIP] | unique | sort | join(",")
')"
[[ -n "$coordinator_ips" && "$coordinator_ips" != *,* ]] || fail "expected exactly one Ready coordinator Pod IP"

for service in asklake-trino asklake-trino-discovery; do
  endpoint_ips="$(kubectl get endpointslice -n "$NAMESPACE" \
    -l "kubernetes.io/service-name=$service" -o json | jq -r \
    '[.items[].endpoints[]?.addresses[]] | unique | sort | join(",")')"
  [[ "$endpoint_ips" == "$coordinator_ips" ]] || fail "$service does not resolve only to the Ready coordinator"
done

backend_pod="$(kubectl get pod -n "$NAMESPACE" -l 'app.kubernetes.io/component=backend' -o json | jq -r '
  [.items[] | select(.status.phase == "Running") |
    select(any(.status.conditions[]?; .type == "Ready" and .status == "True")) |
    .metadata.name] | sort | first // empty
')"
[[ -n "$backend_pod" ]] || fail "a Ready FastAPI Pod is required for the authenticated Trino node check"

node_gate_output=""
for _ in {1..18}; do
  set +e
  node_gate_output="$(kubectl exec -i -n "$NAMESPACE" "$backend_pod" -- \
    python - "$EXPECTED_WORKERS" <"$ROOT_DIR/scripts/lib/verify_eks_trino_active_workers.py" 2>/dev/null)"
  node_gate_status=$?
  set -e
  if [[ "$node_gate_status" -eq 0 ]]; then
    break
  fi
  node_gate_output=""
  [[ "$node_gate_status" -eq 75 ]] || fail "authenticated Trino node/query gate failed before worker-count evaluation"
  sleep 5
done
[[ -n "$node_gate_output" ]] || fail "Trino workers did not register before the 90-second discovery deadline"
printf '%s\n' "$node_gate_output"
echo "EKS distributed Trino live verification passed."
