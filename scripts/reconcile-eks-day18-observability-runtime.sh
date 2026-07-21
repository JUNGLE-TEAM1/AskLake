#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="amazon-cloudwatch"
SCRAPER="cloudwatch-agent-cluster-scraper"

fail() {
  echo "$1" >&2
  exit 1
}

for command in aws jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

if [[ -z "${ASKLAKE_EKS_CLUSTER_NAME:-}" ]]; then
  ASKLAKE_EKS_CLUSTER_NAME="$(jq -er '.outputs.cluster_name.value' \
    "$ROOT_DIR/infra/eks/terraform/terraform.tfstate")"
  export ASKLAKE_EKS_CLUSTER_NAME
fi
verify_asklake_eks_context

addon_status="$(aws eks describe-addon \
  --region "${AWS_REGION:-ap-northeast-2}" \
  --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --addon-name amazon-cloudwatch-observability \
  --query addon.status \
  --output text)"
[[ "$addon_status" == "ACTIVE" ]] || fail "CloudWatch Observability add-on is not ACTIVE"

kubectl get amazoncloudwatchagent.cloudwatch.aws.amazon.com \
  -n "$NAMESPACE" "$SCRAPER" >/dev/null
kubectl patch amazoncloudwatchagent.cloudwatch.aws.amazon.com \
  -n "$NAMESPACE" "$SCRAPER" --type=merge \
  -p '{"spec":{"hostNetwork":false}}' >/dev/null
kubectl patch deployment -n "$NAMESPACE" "$SCRAPER" --type=merge \
  -p '{"spec":{"template":{"spec":{"hostNetwork":false,"dnsPolicy":"ClusterFirst"}}}}' >/dev/null
kubectl rollout status deployment/"$SCRAPER" -n "$NAMESPACE" --timeout=120s >/dev/null

runtime="$(kubectl get deployment -n "$NAMESPACE" "$SCRAPER" -o json)"
jq -e '
  (.spec.template.spec.hostNetwork // false) == false
  and .spec.template.spec.dnsPolicy == "ClusterFirst"
  and (.status.readyReplicas // 0) == (.spec.replicas // 1)
  and (.status.unavailableReplicas // 0) == 0
' <<<"$runtime" >/dev/null || fail "cluster scraper Pod-network reconciliation failed"

echo "Day 18 CloudWatch cluster scraper reconciled to the Pod network."
