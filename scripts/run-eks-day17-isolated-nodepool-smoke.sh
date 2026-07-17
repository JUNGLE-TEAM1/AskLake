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
baseline_general_nodes="$temporary_directory/baseline-general-nodes"
baseline_spark_nodes="$temporary_directory/baseline-spark-nodes"
kubectl get nodes -l karpenter.sh/nodepool=asklake-general -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' >"$baseline_general_nodes"
kubectl get nodes -l karpenter.sh/nodepool=asklake-spark -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' >"$baseline_spark_nodes"
chmod 600 "$baseline_general_nodes" "$baseline_spark_nodes"
[[ "$(grep -c . "$baseline_general_nodes" || true)" == "$baseline_general" ]] || { echo "General baseline changed during preflight" >&2; exit 1; }
[[ "$(grep -c . "$baseline_spark_nodes" || true)" == "$baseline_spark" ]] || { echo "Spark baseline changed during preflight" >&2; exit 1; }

helm upgrade --install "$RELEASE" "$CHART" -n "$ASKLAKE_EKS_NAMESPACE" -f "$values_file"

general_pod=""
spark_pod=""
for _ in {1..24}; do
  general_pod="$(kubectl get pods -n "$ASKLAKE_EKS_NAMESPACE" -l app.kubernetes.io/name=asklake-day17-general-scale -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  spark_pod="$(kubectl get pods -n "$ASKLAKE_EKS_NAMESPACE" -l app.kubernetes.io/name=asklake-day17-spark-scale -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [[ -n "$general_pod" && -n "$spark_pod" ]] && break
  sleep 5
done
[[ -n "$general_pod" && -n "$spark_pod" ]] || { echo "positive scale Pods were not created" >&2; exit 1; }

general_uid="$(kubectl get pod "$general_pod" -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.metadata.uid}')"
spark_uid="$(kubectl get pod "$spark_pod" -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.metadata.uid}')"
general_pending=false
spark_pending=false
deadline=$((SECONDS + 1200))
while (( SECONDS < deadline )); do
  general_phase="$(kubectl get pod "$general_pod" -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.status.phase}')"
  spark_phase="$(kubectl get pod "$spark_pod" -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.status.phase}')"
  general_node_assignment="$(kubectl get pod "$general_pod" -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.spec.nodeName}')"
  spark_node_assignment="$(kubectl get pod "$spark_pod" -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.spec.nodeName}')"
  [[ "$general_phase" == "Pending" && -z "$general_node_assignment" ]] && general_pending=true
  [[ "$spark_phase" == "Pending" && -z "$spark_node_assignment" ]] && spark_pending=true
  if [[ "$general_pending" != "true" ]]; then
    OBJECT_UID="$general_uid" kubectl get events -n "$ASKLAKE_EKS_NAMESPACE" -o json | OBJECT_UID="$general_uid" node -e 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{const value=JSON.parse(raw);if(!value.items.some(event=>event.involvedObject?.uid===process.env.OBJECT_UID&&event.reason==="FailedScheduling"))process.exit(1)})' && general_pending=true || true
  fi
  if [[ "$spark_pending" != "true" ]]; then
    OBJECT_UID="$spark_uid" kubectl get events -n "$ASKLAKE_EKS_NAMESPACE" -o json | OBJECT_UID="$spark_uid" node -e 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{const value=JSON.parse(raw);if(!value.items.some(event=>event.involvedObject?.uid===process.env.OBJECT_UID&&event.reason==="FailedScheduling"))process.exit(1)})' && spark_pending=true || true
  fi
  general_ready="$(kubectl get pod "$general_pod" -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.status}{end}')"
  spark_ready="$(kubectl get pod "$spark_pod" -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.status}{end}')"
  [[ "$general_ready" == "True" && "$spark_ready" == "True" ]] && break
  sleep 5
done
[[ "${general_ready:-}" == "True" && "${spark_ready:-}" == "True" ]] || { echo "positive scale Pods did not become Ready" >&2; exit 1; }
[[ "$general_pending" == "true" && "$spark_pending" == "true" ]] || { echo "Pending or FailedScheduling transition was not observed for both pools" >&2; exit 1; }
kubectl rollout status deployment/asklake-day17-general-scale -n "$ASKLAKE_EKS_NAMESPACE" --timeout=2m
kubectl rollout status deployment/asklake-day17-spark-scale -n "$ASKLAKE_EKS_NAMESPACE" --timeout=2m

general_nodes="$(kubectl get nodes -l karpenter.sh/nodepool=asklake-general -o json | node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(String(JSON.parse(value).items.length)))')"
spark_nodes="$(kubectl get nodes -l karpenter.sh/nodepool=asklake-spark -o json | node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(String(JSON.parse(value).items.length)))')"
(( general_nodes > baseline_general )) || { echo "General NodePool did not scale out" >&2; exit 1; }
(( spark_nodes > baseline_spark )) || { echo "Spark NodePool did not scale out" >&2; exit 1; }
general_pod_node="$(kubectl get pod "$general_pod" -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.spec.nodeName}')"
spark_pod_node="$(kubectl get pod "$spark_pod" -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.spec.nodeName}')"
[[ -n "$general_pod_node" && -n "$spark_pod_node" ]] || { echo "positive scale Pod node assignment is missing" >&2; exit 1; }
! grep -Fxq -- "$general_pod_node" "$baseline_general_nodes" || { echo "General scale Pod used a baseline node" >&2; exit 1; }
! grep -Fxq -- "$spark_pod_node" "$baseline_spark_nodes" || { echo "Spark scale Pod used a baseline node" >&2; exit 1; }
[[ "$(kubectl get node "$general_pod_node" -o jsonpath='{.metadata.labels.karpenter\.sh/nodepool}')" == "asklake-general" ]] || { echo "General scale Pod used the wrong NodePool" >&2; exit 1; }
[[ "$(kubectl get node "$spark_pod_node" -o jsonpath='{.metadata.labels.karpenter\.sh/nodepool}')" == "asklake-spark" ]] || { echo "Spark scale Pod used the wrong NodePool" >&2; exit 1; }

negative_phase="$(kubectl get pod asklake-day17-spark-negative -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.status.phase}')"
[[ "$negative_phase" == "Pending" ]] || { echo "Spark negative probe unexpectedly scheduled" >&2; exit 1; }
negative_uid="$(kubectl get pod asklake-day17-spark-negative -n "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.metadata.uid}')"
kubectl get pod asklake-day17-spark-negative -n "$ASKLAKE_EKS_NAMESPACE" -o json | node -e 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{const pod=JSON.parse(raw);const selects=pod.spec?.nodeSelector?.["asklake.io/workload-class"]==="spark";const tolerates=(pod.spec?.tolerations||[]).some(entry=>entry.key==="asklake.io/workload-class"&&entry.value==="spark"&&entry.effect==="NoSchedule");if(!selects||tolerates)process.exit(1)})' || { echo "Spark negative probe selector/toleration contract is invalid" >&2; exit 1; }
kubectl get nodepool asklake-spark -o json | node -e 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{const pool=JSON.parse(raw);const exact=(pool.spec?.template?.spec?.taints||[]).some(taint=>taint.key==="asklake.io/workload-class"&&taint.value==="spark"&&taint.effect==="NoSchedule");if(!exact)process.exit(1)})' || { echo "Spark NodePool exact taint is missing" >&2; exit 1; }
kubectl get node "$spark_pod_node" -o json | node -e 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{const node=JSON.parse(raw);const exact=(node.spec?.taints||[]).some(taint=>taint.key==="asklake.io/workload-class"&&taint.value==="spark"&&taint.effect==="NoSchedule");if(!exact)process.exit(1)})' || { echo "Spark node exact taint is missing" >&2; exit 1; }
exact_negative=false
for _ in {1..24}; do
  if kubectl get events -n "$ASKLAKE_EKS_NAMESPACE" -o json | OBJECT_UID="$negative_uid" node -e 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{const value=JSON.parse(raw);const matched=value.items.some(event=>event.involvedObject?.uid===process.env.OBJECT_UID&&event.reason==="FailedScheduling"&&/untolerated taint/i.test(event.message||""));if(!matched)process.exit(1)})'; then
    exact_negative=true
    break
  fi
  sleep 5
done
[[ "$exact_negative" == "true" ]] || { echo "Spark negative probe lacks exact untolerated taint evidence" >&2; exit 1; }

transition_proof="$temporary_directory/transition-proof.json"
RUN="$run_fingerprint" node - "$transition_proof" <<'NODE'
const fs = require("fs");
const passed = { pendingObserved: true, newNodeObserved: true, scheduledOnNewNode: true, runningObserved: true };
fs.writeFileSync(process.argv[2], `${JSON.stringify({ runFingerprint: process.env.RUN, general: passed, spark: passed })}\n`, { mode: 0o600 });
NODE
export ASKLAKE_DAY17_TRANSITION_PROOF_FILE="$transition_proof"

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
