#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-scale-smoke"
VALUES_FILE="${1:-}"
IMAGE_RECEIPT="${2:-}"
EVIDENCE_FILE="${3:-}"

if [[ ! -s "$VALUES_FILE" ]] || [[ ! -s "$IMAGE_RECEIPT" ]] || [[ -z "$EVIDENCE_FILE" ]]; then
  echo "usage: $0 <private-scale-values.yaml> <image-receipt.json> <evidence.json>" >&2
  exit 2
fi

: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
: "${ASKLAKE_EKS_NAMESPACE:?ASKLAKE_EKS_NAMESPACE is required}"
if [[ "${ASKLAKE_SCALE_SMOKE_CONFIRM:-}" != "run-cost-bearing-node-scale-smoke" ]]; then
  echo "set ASKLAKE_SCALE_SMOKE_CONFIRM=run-cost-bearing-node-scale-smoke after capacity and cost approval" >&2
  exit 1
fi

case "$(cd "$(dirname "$VALUES_FILE")" && pwd)/$(basename "$VALUES_FILE")" in
  "$ROOT_DIR"/*) echo "repository fixture values cannot be applied to EKS" >&2; exit 1 ;;
esac
case "$(cd "$(dirname "$EVIDENCE_FILE")" && pwd)" in
  "$ROOT_DIR"*) echo "runtime evidence must be written outside the repository" >&2; exit 1 ;;
esac

for command in aws kubectl helm node; do
  command -v "$command" >/dev/null 2>&1 || { echo "required command is missing: $command" >&2; exit 1; }
done

bash "$ROOT_DIR/scripts/verify-eks-metrics-scale.sh"
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$IMAGE_RECEIPT"
helm lint "$CHART_DIR" -f "$VALUES_FILE"

expected_endpoint="$(aws eks describe-cluster --name "$ASKLAKE_EKS_CLUSTER_NAME" --query 'cluster.endpoint' --output text)"
current_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
[[ "$current_endpoint" == "$expected_endpoint" ]] || { echo "kubectl context does not match ASKLAKE_EKS_CLUSTER_NAME" >&2; exit 1; }

[[ "$(aws eks describe-addon --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" --addon-name metrics-server --query 'addon.status' --output text)" == "ACTIVE" ]] || { echo "Metrics Server EKS add-on is not ACTIVE" >&2; exit 1; }
kubectl wait --for=condition=Available apiservice/v1beta1.metrics.k8s.io --timeout=5m
kubectl top nodes >/dev/null

backend_image="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.images.backend)' "$IMAGE_RECEIPT")"
rendered="$(helm template asklake-scale-smoke "$CHART_DIR" -f "$VALUES_FILE")"
grep -Fq "image: \"$backend_image\"" <<<"$rendered" || { echo "scale smoke image must match the verified backend receipt" >&2; exit 1; }
grep -q "namespace: $ASKLAKE_EKS_NAMESPACE" <<<"$rendered" || { echo "scale smoke namespace mismatch" >&2; exit 1; }

baseline_nodes="$(kubectl get nodes --no-headers | wc -l | tr -d ' ')"
baseline_node_names="$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cleanup_required=true
cleanup() {
  if [[ "$cleanup_required" == "true" ]]; then
    helm uninstall asklake-scale-smoke -n "$ASKLAKE_EKS_NAMESPACE" --wait >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
helm upgrade --install asklake-scale-smoke "$CHART_DIR" -n "$ASKLAKE_EKS_NAMESPACE" -f "$VALUES_FILE"

deadline=$((SECONDS + 1200))
scaled_nodes="$baseline_nodes"
while (( SECONDS < deadline )); do
  scaled_nodes="$(kubectl get nodes --no-headers | wc -l | tr -d ' ')"
  if (( scaled_nodes > baseline_nodes )); then break; fi
  sleep 15
done

if (( scaled_nodes <= baseline_nodes )); then
  helm uninstall asklake-scale-smoke -n "$ASKLAKE_EKS_NAMESPACE" || true
  echo "no node scale-out observed within 20 minutes; review requests, NodePool limits and scheduling events" >&2
  exit 1
fi

kubectl rollout status deployment/asklake-node-scale-smoke -n "$ASKLAKE_EKS_NAMESPACE" --timeout=10m
metrics_ready=false
for _ in {1..36}; do
  if kubectl top pods -n "$ASKLAKE_EKS_NAMESPACE" -l app.kubernetes.io/name=asklake-node-scale-smoke >/dev/null 2>&1; then
    metrics_ready=true
    break
  fi
  sleep 5
done
if [[ "$metrics_ready" != "true" ]]; then
  echo "Metrics Server did not publish smoke Pod metrics within 3 minutes" >&2
  exit 1
fi
used_new_node=false
while IFS= read -r pod_node; do
  if [[ -n "$pod_node" ]] && ! grep -Fxq -- "$pod_node" <<<"$baseline_node_names"; then
    used_new_node=true
    break
  fi
done < <(kubectl get pods -n "$ASKLAKE_EKS_NAMESPACE" -l app.kubernetes.io/name=asklake-node-scale-smoke -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}')
if [[ "$used_new_node" != "true" ]]; then
  helm uninstall asklake-scale-smoke -n "$ASKLAKE_EKS_NAMESPACE" || true
  echo "node count increased, but no smoke Pod was scheduled on a newly observed node" >&2
  exit 1
fi
completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

node -e '
  const fs=require("fs");
  const [path, cluster, namespace, start, end, before, after]=process.argv.slice(1);
  fs.writeFileSync(path, JSON.stringify({contractVersion:"1.0",clusterReference:cluster,namespace,startedAt:start,completedAt:end,metricsApi:true,nodeScaleOut:{before:Number(before),after:Number(after),smokePodScheduledOnNewNode:true},scaleIn:{status:"pending"}},null,2)+"\n", {mode:0o600});
' "$EVIDENCE_FILE" "$ASKLAKE_EKS_CLUSTER_NAME" "$ASKLAKE_EKS_NAMESPACE" "$started_at" "$completed_at" "$baseline_nodes" "$scaled_nodes"

helm uninstall asklake-scale-smoke -n "$ASKLAKE_EKS_NAMESPACE" --wait
cleanup_required=false
echo "Scale-out evidence written. Observe and append scale-in evidence after Auto Mode consolidation."
