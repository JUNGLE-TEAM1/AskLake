#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-auto-mode"
TEST_VALUES="$ROOT_DIR/infra/eks/values/auto-mode/node-pools.test.example.yaml"
DEFAULT_RENDER="$(mktemp)"
ENABLED_RENDER="$(mktemp)"
trap 'rm -f "$DEFAULT_RENDER" "$ENABLED_RENDER"' EXIT

required_files=(
  "$CHART_DIR/Chart.yaml"
  "$CHART_DIR/values.yaml"
  "$CHART_DIR/values.schema.json"
  "$CHART_DIR/templates/nodeclasses.yaml"
  "$CHART_DIR/templates/nodepools.yaml"
  "$TEST_VALUES"
  "$ROOT_DIR/infra/eks/terraform/auto-mode-node-pools.tf"
  "$ROOT_DIR/infra/eks/terraform/auto-mode-node-pools-variables.tf"
  "$ROOT_DIR/infra/eks/terraform/auto-mode-node-pools-outputs.tf"
  "$ROOT_DIR/docs/eks-phase-12-auto-mode-node-pools.md"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "$required_file" ]]; then
    echo "missing Phase 12 file: $required_file" >&2
    exit 1
  fi
done

helm lint "$CHART_DIR"
helm template asklake-auto-mode "$CHART_DIR" >"$DEFAULT_RENDER"

if grep -q '^kind:' "$DEFAULT_RENDER"; then
  echo "disabled Phase 12 defaults rendered Kubernetes resources" >&2
  exit 1
fi

if helm template asklake-auto-mode "$CHART_DIR" --set enabled=true >/dev/null 2>&1; then
  echo "enabled Phase 12 chart accepted missing capacity, disruption and selector decisions" >&2
  exit 1
fi

helm lint "$CHART_DIR" -f "$TEST_VALUES"
helm template asklake-auto-mode "$CHART_DIR" -f "$TEST_VALUES" >"$ENABLED_RENDER"

node_class_count="$(grep -c '^kind: NodeClass$' "$ENABLED_RENDER")"
node_pool_count="$(grep -c '^kind: NodePool$' "$ENABLED_RENDER")"
if [[ "$node_class_count" -ne 2 || "$node_pool_count" -ne 2 ]]; then
  echo "expected two NodeClasses and two NodePools, rendered $node_class_count/$node_pool_count" >&2
  exit 1
fi

for resource_name in asklake-general asklake-spark; do
  if ! grep -q "name: $resource_name" "$ENABLED_RENDER"; then
    echo "rendered Phase 12 contract is missing $resource_name" >&2
    exit 1
  fi
done

for contract in \
  'apiVersion: eks.amazonaws.com/v1' \
  'apiVersion: karpenter.sh/v1' \
  'group: eks.amazonaws.com' \
  'kind: NodeClass' \
  'key: kubernetes.io/arch' \
  'values: \["amd64"\]' \
  'key: eks.amazonaws.com/instance-category' \
  'key: eks.amazonaws.com/instance-generation' \
  'values: \["4"\]' \
  'key: asklake.io/workload-class' \
  'effect: NoSchedule' \
  'budgets:'; do
  if ! grep -q "$contract" "$ENABLED_RENDER"; then
    echo "rendered Phase 12 contract is missing: $contract" >&2
    exit 1
  fi
done

if grep -Eiq '(AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|subnet-[0-9a-f]{8,}|sg-[0-9a-f]{8,})' \
  "$TEST_VALUES" "$CHART_DIR"/*.yaml "$CHART_DIR"/templates/*.yaml; then
  echo "credential or real infrastructure identifier found in Phase 12 examples" >&2
  exit 1
fi

grep -q 'custom_node_pool_mode.*=.*"disabled"' "$ROOT_DIR/infra/eks/terraform/dev.tfvars.example"
grep -q 'resource "aws_eks_access_entry" "auto_custom_node"' "$ROOT_DIR/infra/eks/terraform/auto-mode-node-pools.tf"
grep -q 'AmazonEKSAutoNodePolicy' "$ROOT_DIR/infra/eks/terraform/auto-mode-node-pools.tf"

echo "EKS Auto Mode NodePool contract verification passed."
