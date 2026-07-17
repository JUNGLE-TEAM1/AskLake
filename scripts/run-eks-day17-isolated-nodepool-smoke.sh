#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT_DIR/infra/eks/helm/asklake-day17-nodepool-smoke"
RELEASE="asklake-day17-nodepool-smoke"
IMAGE_RECEIPT="${1:-}"
EVIDENCE_FILE="${2:-}"

if [[ ! -s "$IMAGE_RECEIPT" ]] || [[ -z "$EVIDENCE_FILE" ]]; then
  echo "usage: $0 <private-image-receipt.json> <ignored-private-evidence.json>" >&2
  exit 2
fi
: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
: "${ASKLAKE_EKS_NAMESPACE:=asklake-dev}"
if [[ "${ASKLAKE_DAY17_PHASE3_CONFIRM:-}" != "run-cost-bearing-isolated-nodepool-smoke" ]]; then
  echo "set ASKLAKE_DAY17_PHASE3_CONFIRM=run-cost-bearing-isolated-nodepool-smoke" >&2
  exit 1
fi

for command in aws kubectl helm node openssl git; do
  command -v "$command" >/dev/null 2>&1 || { echo "missing required command: $command" >&2; exit 1; }
done

bash "$ROOT_DIR/scripts/verify-eks-day17-nodepool-smoke.sh" >/dev/null
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$IMAGE_RECEIPT" >/dev/null
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
verify_asklake_eks_context

evidence_directory="$(cd "$(dirname "$EVIDENCE_FILE")" 2>/dev/null && pwd || true)"
[[ -n "$evidence_directory" ]] || { echo "evidence directory must already exist" >&2; exit 1; }
evidence_absolute="$evidence_directory/$(basename "$EVIDENCE_FILE")"
case "$evidence_absolute" in
  "$ROOT_DIR"/*) git -C "$ROOT_DIR" check-ignore -q "$evidence_absolute" || { echo "repository-local evidence must be ignored" >&2; exit 1; } ;;
esac
[[ ! -e "$evidence_absolute" ]] || { echo "evidence already exists" >&2; exit 1; }
if helm status "$RELEASE" -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null 2>&1; then
  echo "Day 17 smoke release already exists; do not adopt another run" >&2
  exit 1
fi

backend_image="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(value.images.backend)' "$IMAGE_RECEIPT")"
live_backend_image="$(kubectl get deployment fastapi -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}')"
[[ "$backend_image" == "$live_backend_image" ]] || { echo "image receipt does not match the live FastAPI image" >&2; exit 1; }

export ASKLAKE_DAY17_RUN_TOKEN="$(openssl rand -hex 32)"
export ASKLAKE_DAY17_SCOPE=isolated
run_fingerprint="$(printf '%s' "$ASKLAKE_DAY17_RUN_TOKEN" | asklake_sha256 | cut -c1-16)"
temporary_directory="$(mktemp -d)"
chmod 700 "$temporary_directory"
cleanup_required=true
cleanup() {
  if [[ "$cleanup_required" == "true" ]]; then
    helm uninstall "$RELEASE" -n "$ASKLAKE_EKS_NAMESPACE" --wait >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

values_file="$temporary_directory/values.json"
IMAGE="$backend_image" RUN="$run_fingerprint" NAMESPACE="$ASKLAKE_EKS_NAMESPACE" node - "$values_file" <<'NODE'
const fs = require("fs");
const value = {
  enabled: true,
  namespace: process.env.NAMESPACE,
  runFingerprint: process.env.RUN,
  image: process.env.IMAGE,
  general: { replicas: 1, resources: { requests: { cpu: "1", memory: "512Mi" }, limits: { cpu: "1", memory: "512Mi" } } },
  spark: { replicas: 1, resources: { requests: { cpu: "2", memory: "2Gi" }, limits: { cpu: "2", memory: "2Gi" } } },
  negativeSparkProbe: true,
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(value)}\n`, { mode: 0o600 });
NODE

bash "$ROOT_DIR/scripts/capture-eks-day17-autoscaling-evidence.sh" baseline "$evidence_absolute" >/dev/null
node - "$evidence_absolute" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const gates = evidence.snapshots[0].gates;
if (!gates.poolReady || !gates.exclusiveWindowReady) process.exit(1);
NODE
baseline_general="$(node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(String(e.snapshots[0].capacity.general.nodes))' "$evidence_absolute")"
baseline_spark="$(node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(String(e.snapshots[0].capacity.spark.nodes))' "$evidence_absolute")"

helm upgrade --install "$RELEASE" "$CHART" -n "$ASKLAKE_EKS_NAMESPACE" -f "$values_file"
kubectl rollout status deployment/asklake-day17-general-scale -n "$ASKLAKE_EKS_NAMESPACE" --timeout=20m
kubectl rollout status deployment/asklake-day17-spark-scale -n "$ASKLAKE_EKS_NAMESPACE" --timeout=20m

general_nodes="$(kubectl get nodes -l karpenter.sh/nodepool=asklake-general -o json | node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(String(JSON.parse(value).items.length)))')"
spark_nodes="$(kubectl get nodes -l karpenter.sh/nodepool=asklake-spark -o json | node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(String(JSON.parse(value).items.length)))')"
(( general_nodes > baseline_general )) || { echo "General NodePool did not scale out" >&2; exit 1; }
(( spark_nodes > baseline_spark )) || { echo "Spark NodePool did not scale out" >&2; exit 1; }

negative_phase="$(kubectl get pod asklake-day17-spark-negative -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.status.phase}')"
[[ "$negative_phase" == "Pending" ]] || { echo "Spark negative probe unexpectedly scheduled" >&2; exit 1; }
if ! kubectl get events -n "$ASKLAKE_EKS_NAMESPACE" --field-selector involvedObject.name=asklake-day17-spark-negative -o json | \
  node -e 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{const value=JSON.parse(raw);if(!value.items.some(event=>event.reason==="FailedScheduling"))process.exit(1)})'; then
  echo "Spark negative probe lacks FailedScheduling evidence" >&2
  exit 1
fi

bash "$ROOT_DIR/scripts/capture-eks-day17-autoscaling-evidence.sh" sample "$evidence_absolute" >/dev/null
helm uninstall "$RELEASE" -n "$ASKLAKE_EKS_NAMESPACE" --wait
cleanup_required=false

deadline=$((SECONDS + 2400))
while (( SECONDS < deadline )); do
  general_nodes="$(kubectl get nodes -l karpenter.sh/nodepool=asklake-general -o json | node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(String(JSON.parse(value).items.length)))')"
  spark_nodes="$(kubectl get nodes -l karpenter.sh/nodepool=asklake-spark -o json | node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(String(JSON.parse(value).items.length)))')"
  if (( general_nodes <= baseline_general && spark_nodes <= baseline_spark )); then break; fi
  sleep 30
done
(( general_nodes <= baseline_general )) || { echo "General NodePool did not scale in within 40 minutes" >&2; exit 1; }
(( spark_nodes <= baseline_spark )) || { echo "Spark NodePool did not scale in within 40 minutes" >&2; exit 1; }

bash "$ROOT_DIR/scripts/capture-eks-day17-autoscaling-evidence.sh" final "$evidence_absolute" >/dev/null
echo "Day 17 isolated General/Spark NodePool scale-out, negative taint, cleanup and scale-in verified."
