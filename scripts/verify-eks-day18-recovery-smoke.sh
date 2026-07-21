#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT_DIR/infra/eks/helm/asklake-day18-recovery-smoke"
RUNNER="$ROOT_DIR/scripts/run-eks-day18-isolated-recovery-smoke.sh"
DISABLED="$(mktemp)"
ENABLED="$(mktemp)"
VALUES="$(mktemp)"
trap 'rm -f "$DISABLED" "$ENABLED" "$VALUES"' EXIT

for command in helm node; do
  command -v "$command" >/dev/null 2>&1 || { echo "missing required command: $command" >&2; exit 1; }
done

helm lint "$CHART" >/dev/null
helm template asklake-day18-recovery-smoke "$CHART" >"$DISABLED"
! grep -q '[^[:space:]]' "$DISABLED" || { echo "disabled recovery chart must render no resources" >&2; exit 1; }

node - "$VALUES" <<'NODE'
const fs = require("fs");
fs.writeFileSync(process.argv[2], `${JSON.stringify({
  enabled: true,
  namespace: "asklake-dev",
  runFingerprint: "0123456789abcdef",
  image: "111122223333.dkr.ecr.ap-northeast-2.amazonaws.com/asklake-backend@sha256:" + "a".repeat(64),
  resources: {
    requests: {cpu: "1500m", memory: "512Mi"},
    limits: {cpu: "1500m", memory: "512Mi"},
  },
})}\n`);
NODE
helm lint "$CHART" -f "$VALUES" >/dev/null
helm template asklake-day18-recovery-smoke "$CHART" -f "$VALUES" >"$ENABLED"

[[ "$(grep -c '^kind: Deployment$' "$ENABLED")" == 1 ]]
grep -Fq 'name: asklake-day18-recovery-smoke' "$ENABLED"
grep -Fq 'replicas: 1' "$ENABLED"
grep -Fq 'automountServiceAccountToken: false' "$ENABLED"
grep -Fq 'asklake.io/workload-class: general' "$ENABLED"
grep -Fq 'eks.amazonaws.com/instance-cpu: "4"' "$ENABLED"
grep -Fq 'kubernetes.io/arch: amd64' "$ENABLED"
grep -Fq 'cpu: 1500m' "$ENABLED"
grep -Fq 'memory: 512Mi' "$ENABLED"
grep -Fq 'asklake-day18-recovery-smoke-started' "$ENABLED"
if grep -Eq '^kind: (Service|Secret|ServiceAccount|Role|RoleBinding|Node|NodeClaim)$' "$ENABLED"; then
  echo "recovery chart rendered a forbidden resource" >&2
  exit 1
fi

bash -n "$RUNNER"
for contract in \
  'terminate-isolated-general-nodeclaim' \
  'nonOwnedWorkloadsOnNode:0' \
  'kubectl delete nodeclaim' \
  'temporary_pool_cpu_limit' \
  'nodePoolCpuLimitRestored:true' \
  'verify-eks-day15-alb-runtime.sh" --steady' \
  'cloudWatchCorrelation:true' \
  'General NodePool did not scale back to baseline'; do
  grep -Fq "$contract" "$RUNNER" || { echo "recovery runner is missing contract: $contract" >&2; exit 1; }
done

echo "EKS Day 18 isolated recovery smoke contract passed."
