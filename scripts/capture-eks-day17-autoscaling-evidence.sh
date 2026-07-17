#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHASE="${1:-}"
EVIDENCE_FILE="${2:-}"

if [[ ! "$PHASE" =~ ^(baseline|sample|final)$ ]] || [[ -z "$EVIDENCE_FILE" ]]; then
  echo "usage: $0 <baseline|sample|final> <ignored-private-evidence.json>" >&2
  exit 2
fi
: "${ASKLAKE_DAY17_RUN_TOKEN:?ASKLAKE_DAY17_RUN_TOKEN is required}"
: "${ASKLAKE_EKS_NAMESPACE:=asklake-dev}"

for command in aws kubectl helm node git; do
  command -v "$command" >/dev/null 2>&1 || { echo "missing required command: $command" >&2; exit 1; }
done

evidence_directory="$(cd "$(dirname "$EVIDENCE_FILE")" 2>/dev/null && pwd || true)"
[[ -n "$evidence_directory" ]] || { echo "evidence directory must already exist" >&2; exit 1; }
evidence_absolute="$evidence_directory/$(basename "$EVIDENCE_FILE")"
case "$evidence_absolute" in
  "$ROOT_DIR"/*)
    git -C "$ROOT_DIR" check-ignore -q "$evidence_absolute" || {
      echo "repository-local evidence must be excluded by .gitignore" >&2
      exit 1
    }
    ;;
esac
if [[ "$PHASE" == "baseline" && -e "$evidence_absolute" ]]; then
  echo "baseline evidence already exists; use a new path or sample/final" >&2
  exit 1
fi
if [[ "$PHASE" != "baseline" && ! -s "$evidence_absolute" ]]; then
  echo "sample/final requires existing baseline evidence" >&2
  exit 1
fi

source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
verify_asklake_eks_context

temporary_directory="$(mktemp -d)"
chmod 700 "$temporary_directory"
trap 'rm -rf "$temporary_directory"' EXIT

kubectl get nodepools.karpenter.sh -o json >"$temporary_directory/nodepools.json"
kubectl get nodes -o json >"$temporary_directory/nodes.json"
kubectl get pods -n "$ASKLAKE_EKS_NAMESPACE" -o json >"$temporary_directory/pods.json"
kubectl get deployments -n "$ASKLAKE_EKS_NAMESPACE" -o json >"$temporary_directory/deployments.json"
kubectl get horizontalpodautoscalers -n "$ASKLAKE_EKS_NAMESPACE" -o json >"$temporary_directory/hpas.json"
kubectl get jobs -n "$ASKLAKE_EKS_NAMESPACE" -o json >"$temporary_directory/jobs.json"
kubectl get endpointslices.discovery.k8s.io -n "$ASKLAKE_EKS_NAMESPACE" -o json >"$temporary_directory/endpointslices.json"
if ! kubectl get sparkapplications.sparkoperator.k8s.io -n "$ASKLAKE_EKS_NAMESPACE" -o json >"$temporary_directory/sparkapplications.json" 2>/dev/null; then
  printf '{"items":[]}\n' >"$temporary_directory/sparkapplications.json"
fi
helm list -A -o json >"$temporary_directory/helm-releases.json"
helm get values asklake-auto-mode -n "$ASKLAKE_EKS_NAMESPACE" -o json >"$temporary_directory/auto-mode-values.json"
if [[ "$PHASE" != "baseline" ]]; then
  cp "$evidence_absolute" "$temporary_directory/existing-evidence.json"
fi

temporary_evidence="$(mktemp "$evidence_directory/.day17-autoscaling.XXXXXX")"
chmod 600 "$temporary_evidence"
ASKLAKE_EKS_NAMESPACE="$ASKLAKE_EKS_NAMESPACE" ASKLAKE_DAY17_RUN_TOKEN="$ASKLAKE_DAY17_RUN_TOKEN" node \
  "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" \
  "$temporary_directory" "$temporary_evidence" "$PHASE"
mv "$temporary_evidence" "$evidence_absolute"
chmod 600 "$evidence_absolute"

node - "$evidence_absolute" "$PHASE" <<'NODE'
const fs = require("fs");
const [path, phase] = process.argv.slice(2);
const evidence = JSON.parse(fs.readFileSync(path, "utf8"));
const snapshot = evidence.snapshots.at(-1);
const summary = {
  phase,
  poolReady: snapshot.gates.poolReady,
  placementReady: snapshot.gates.placementReady,
  exclusiveWindowReady: snapshot.gates.exclusiveWindowReady,
  identityMatchesBaseline: snapshot.identityMatchesBaseline ?? true,
  cleanupVerified: evidence.cleanup.verified,
  finalGatePassed: evidence.finalGatePassed ?? null,
};
console.log(JSON.stringify(summary));
if (phase === "sample" && snapshot.identityMatchesBaseline === false) process.exit(1);
if (phase === "final" && evidence.finalGatePassed !== true) process.exit(1);
NODE
