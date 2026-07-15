#!/usr/bin/env bash
set -euo pipefail

EVIDENCE_FILE="${1:-}"
if [[ ! -s "$EVIDENCE_FILE" ]]; then
  echo "usage: $0 <day14-scale-evidence.json>" >&2
  exit 2
fi

: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
: "${ASKLAKE_EKS_NAMESPACE:?ASKLAKE_EKS_NAMESPACE is required}"
for command in aws kubectl helm node; do
  command -v "$command" >/dev/null 2>&1 || { echo "required command is missing: $command" >&2; exit 1; }
done

expected_endpoint="$(aws eks describe-cluster --name "$ASKLAKE_EKS_CLUSTER_NAME" --query 'cluster.endpoint' --output text)"
current_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
[[ "$current_endpoint" == "$expected_endpoint" ]] || { echo "kubectl context does not match ASKLAKE_EKS_CLUSTER_NAME" >&2; exit 1; }

node -e '
  const fs=require("fs"); const evidence=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if (evidence.clusterReference !== process.argv[2] || evidence.namespace !== process.argv[3] || !evidence.nodeScaleOut?.smokePodScheduledOnNewNode) process.exit(1);
' "$EVIDENCE_FILE" "$ASKLAKE_EKS_CLUSTER_NAME" "$ASKLAKE_EKS_NAMESPACE" || { echo "evidence does not match the target cluster or lacks valid scale-out proof" >&2; exit 1; }

if helm status asklake-scale-smoke -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null 2>&1 || \
   kubectl get deployment asklake-node-scale-smoke -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null 2>&1; then
  echo "scale smoke workload must be removed before verifying scale-in" >&2
  exit 1
fi

baseline_nodes="$(node -e 'const fs=require("fs"); const e=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(e.nodeScaleOut.before))' "$EVIDENCE_FILE")"
deadline=$((SECONDS + 1800))
current_nodes="$(kubectl get nodes --no-headers | wc -l | tr -d ' ')"
while (( SECONDS < deadline )) && (( current_nodes > baseline_nodes )); do
  sleep 30
  current_nodes="$(kubectl get nodes --no-headers | wc -l | tr -d ' ')"
done

if (( current_nodes > baseline_nodes )); then
  echo "node count did not return to the pre-smoke baseline within 30 minutes" >&2
  exit 1
fi

verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e '
  const fs=require("fs"); const [path,at,count]=process.argv.slice(1); const e=JSON.parse(fs.readFileSync(path,"utf8"));
  e.scaleIn={status:"verified",verifiedAt:at,nodeCount:Number(count)};
  fs.writeFileSync(path,JSON.stringify(e,null,2)+"\n",{mode:0o600});
' "$EVIDENCE_FILE" "$verified_at" "$current_nodes"

echo "Node scale-in evidence verified and appended."
