#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
VALUES="${ASKLAKE_DAY16_TRINO_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.day16-a.private-values.json}"
BASE_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.example.yaml"
STATE="${ASKLAKE_TERRAFORM_STATE:-$ROOT_DIR/infra/eks/terraform/terraform.tfstate}"
CHART="$ROOT_DIR/infra/eks/helm/asklake-workloads"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"

fail() {
  echo "$1" >&2
  exit 1
}

for command in git helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR")" || fail "current image receipt is invalid"
for file in "$VALUES" "$BASE_VALUES" "$STATE" "$RECEIPT"; do [[ -s "$file" ]] || fail "required private input is missing"; done
git -C "$ROOT_DIR" check-ignore -q -- "$VALUES" || fail "private Trino values must be ignored by Git"
if git -C "$ROOT_DIR" ls-files --error-unmatch -- "$VALUES" >/dev/null 2>&1; then fail "private Trino values must not be tracked"; fi
[[ "$(stat -f '%Lp' "$VALUES")" == "600" ]] || fail "private Trino values must use mode 0600"
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$RECEIPT" >/dev/null

jq -e --slurpfile state "$STATE" --slurpfile receipt "$RECEIPT" '
  ($state[0].outputs) as $o | ($receipt[0].images) as $images |
  def joined($image): ($image.repository + "@" + $image.digest);
  .namespace == "asklake-dev"
  and .global.awsRegion == $o.phase1_handoff.value.aws_region
  and joined(.frontend.image) == $images.frontend
  and joined(.backend.image) == $images.backend
  and joined(.airflow.image) == $images.airflow
  and joined(.sparkApplication.image) == $images.sparkRuntime
  and joined(.trino.image) == $images.trino
  and .trino.serviceAccountName == $o.service_account_names.value.trino
  and .trino.service.name == $o.trino_handoff.value.service.name
  and .trino.service.port == $o.trino_handoff.value.service.port
  and .trino.config.warehouseBucket == $o.storage_contract.value.buckets.warehouse
  and .trino.config.warehousePrefix == $o.storage_contract.value.prefixes.warehouse
  and .backend.config.trinoBaseUrl == $o.trino_handoff.value.service.in_cluster_url
  and .backend.config.trinoResultStorageBucket == $o.storage_contract.value.buckets.query_results
  and .sparkApplication.kafka.broker == $o.msk_contract.value.bootstrap_brokers_sasl_iam
  and .sparkApplication.kafka.topic == $o.msk_contract.value.test_topic
' "$VALUES" >/dev/null || fail "private Trino values differ from Terraform state or image receipt"

if jq -e '.. | objects | has("password") or has("token") or has("secretValue") or has("data") or has("stringData")' "$VALUES" >/dev/null; then
  fail "private Trino values contain a Secret-shaped property"
fi
if rg -q 'AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|BEGIN .*PRIVATE KEY' "$VALUES"; then
  fail "private Trino values contain a forbidden credential"
fi

rendered="$(mktemp)"
before="$(mktemp)"
after="$(mktemp)"
trap 'rm -f "$rendered" "$before" "$after"' EXIT
kubectl get deployment,service,configmap -n "$NAMESPACE" -o json | jq -S -c '[.items[]|select(.metadata.name|contains("trino"))|{kind,namespace:.metadata.namespace,name:.metadata.name,uid:.metadata.uid,resourceVersion:.metadata.resourceVersion}]|sort_by(.kind,.name)' >"$before"
component_overrides=(
  --set frontend.enabled=false
  --set backend.enabled=false
  --set airflow.enabled=false
)
helm lint "$CHART" -f "$BASE_VALUES" -f "$VALUES" "${component_overrides[@]}" >/dev/null
helm template asklake-trino "$CHART" -f "$BASE_VALUES" -f "$VALUES" \
  "${component_overrides[@]}" >"$rendered"
grep -q 'app.kubernetes.io/component: trino' "$rendered" || fail "rendered Trino resources are missing"
helm upgrade --install asklake-trino "$CHART" \
  --namespace "$NAMESPACE" --create-namespace=false \
  -f "$BASE_VALUES" -f "$VALUES" "${component_overrides[@]}" --dry-run=server >/dev/null
kubectl get deployment,service,configmap -n "$NAMESPACE" -o json | jq -S -c '[.items[]|select(.metadata.name|contains("trino"))|{kind,namespace:.metadata.namespace,name:.metadata.name,uid:.metadata.uid,resourceVersion:.metadata.resourceVersion}]|sort_by(.kind,.name)' >"$after"
cmp -s "$before" "$after" || fail "server dry-run changed live resources"

grep -q '^  name: asklake-trino$' "$rendered"
grep -q 'serviceAccountName: asklake-trino' "$rendered"
grep -q 'secretName: asklake-trino-runtime' "$rendered"
grep -q 'name: asklake-trino-runtime' "$rendered"
grep -q 'containerPort: 8443' "$rendered"
grep -q 'port: 8443' "$rendered"
grep -q 'TRINO_ICEBERG_JDBC_URL' "$rendered"
grep -q 'TRINO_TLS_KEYSTORE_PASSWORD' "$rendered"
grep -q 'mountPath: /etc/trino/tls/keystore.jks' "$rendered"
grep -q 'mountPath: /etc/trino/auth/password.db' "$rendered"
if grep -Eq 'AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|kind: Secret$|stringData:' "$rendered"; then
  fail "rendered workload contains a Secret value or static AWS credential"
fi

echo "EKS Day 16 Trino private values verification passed."
