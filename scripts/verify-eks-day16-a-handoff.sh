#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HANDOFF="${ASKLAKE_DAY16_HANDOFF:-$ROOT_DIR/infra/eks/delivery/dev.day16-a.handoff.json}"
RUNTIME="${ASKLAKE_DAY16_RUNTIME_CONTRACT:-$ROOT_DIR/infra/eks/secrets/dev.day16-a.runtime-secret-contract.json}"
VALUES="${ASKLAKE_DAY16_TRINO_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.day16-a.private-values.json}"
BASE_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.example.yaml"
RECEIPT="${ASKLAKE_IMAGE_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev-8d4414df.image-receipt.json}"
STATE="${ASKLAKE_TERRAFORM_STATE:-$ROOT_DIR/infra/eks/terraform/terraform.tfstate}"
FIXTURE_RECEIPT="${ASKLAKE_FIXTURE_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev.fixture-receipt.json}"
CHART="$ROOT_DIR/infra/eks/helm/asklake-workloads"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
MODE="${1:---audit}"

fail() { echo "$1" >&2; exit 1; }
[[ "$MODE" == "--audit" || "$MODE" == "--ready" ]] || fail "usage: verify-eks-day16-a-handoff.sh [--audit|--ready]"
for command in git helm jq kubectl node; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
for file in "$HANDOFF" "$RUNTIME" "$VALUES" "$BASE_VALUES" "$RECEIPT" "$STATE"; do [[ -s "$file" ]] || fail "Phase 5 handoff input is missing"; done
export ASKLAKE_EKS_CLUSTER_NAME="${ASKLAKE_EKS_CLUSTER_NAME:-$(jq -r '.outputs.cluster_name.value' "$STATE")}"
for file in "$HANDOFF" "$RUNTIME" "$VALUES" "$RECEIPT" "$STATE"; do
  git -C "$ROOT_DIR" check-ignore -q -- "$file" || fail "private Phase 5 input is not ignored"
  [[ "$(stat -f '%Lp' "$file")" == "600" || "$file" == "$STATE" ]] || fail "private Phase 5 input must use mode 0600"
done
git merge-base --is-ancestor origin/pair1 HEAD || fail "current branch does not contain latest origin/pair1"
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$RECEIPT" >/dev/null
if [[ "$MODE" == "--ready" ]]; then
  node "$ROOT_DIR/scripts/verify-eks-delivery-handoff.mjs" --ready "$HANDOFF" >/dev/null
else
  node "$ROOT_DIR/scripts/verify-eks-delivery-handoff.mjs" "$HANDOFF" >/dev/null
fi
node "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs" --ready "$RUNTIME" >/dev/null
deploy_readiness_args=(--delivery "$HANDOFF" --runtime-secrets "$RUNTIME")
[[ "$MODE" == "--ready" ]] && deploy_readiness_args=(--ready "${deploy_readiness_args[@]}")
node "$ROOT_DIR/scripts/verify-eks-deploy-readiness.mjs" "${deploy_readiness_args[@]}" >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-delivery.sh" >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-day16-trino-values.sh" >/dev/null

jq -e --slurpfile state "$STATE" --slurpfile receipt "$RECEIPT" '
  .kubernetes.clusterName==$state[0].outputs.cluster_name.value
  and .images==$receipt[0].images
  and .dataPlaneReferences.mskClusterArn==$state[0].outputs.msk_contract.value.cluster_arn
  and .dataPlaneReferences.rdsEndpoint==$state[0].outputs.rds_contract.value.endpoint
  and .dataPlaneReferences.storageBuckets==$state[0].outputs.storage_contract.value.buckets
  and .isolatedFixture.checkpointPrefix==($state[0].outputs.storage_contract.value.prefixes.checkpoint+"/eks-mvp/")
' "$HANDOFF" >/dev/null || fail "private handoff differs from actual state or receipt"

rendered="$(mktemp)"; trino_rendered="$(mktemp)"; dryrun_error="$(mktemp)"; before="$(mktemp)"; after="$(mktemp)"
trap 'rm -f "$rendered" "$trino_rendered" "$dryrun_error" "$before" "$after"' EXIT
kubectl get deployment,service,configmap,job -n "$NAMESPACE" -o json | jq -S -c '[.items[]|{kind,name:.metadata.name,uid:.metadata.uid,resourceVersion:.metadata.resourceVersion}]|sort_by(.kind,.name)' >"$before"
helm lint "$CHART" -f "$BASE_VALUES" -f "$VALUES" >/dev/null
helm template asklake-workloads "$CHART" -f "$BASE_VALUES" -f "$VALUES" >"$rendered"
awk 'BEGIN{RS="---";ORS="---\n"}/app.kubernetes.io\/component: trino/{print $0}' "$rendered" >"$trino_rendered"
kubectl apply --dry-run=server -f "$trino_rendered" >/dev/null

release_ownership="ready"
blockers=0
if ! kubectl apply --dry-run=server -f "$rendered" >/dev/null 2>"$dryrun_error"; then
  if rg -q 'field is immutable|already exists|invalid ownership metadata' "$dryrun_error"; then
    release_ownership="blocked"
    blockers=$((blockers+1))
  else
    fail "full workload server dry-run failed for an unexpected reason"
  fi
fi

kubectl get deployment,service,configmap,job -n "$NAMESPACE" -o json | jq -S -c '[.items[]|{kind,name:.metadata.name,uid:.metadata.uid,resourceVersion:.metadata.resourceVersion}]|sort_by(.kind,.name)' >"$after"
cmp -s "$before" "$after" || fail "Phase 5 dry-run changed live resources"

fixture_state="blocked"
if [[ -s "$FIXTURE_RECEIPT" ]] \
  && git -C "$ROOT_DIR" check-ignore -q -- "$FIXTURE_RECEIPT" \
  && [[ "$(stat -f '%Lp' "$FIXTURE_RECEIPT")" == "600" ]] \
  && jq -e --arg topic "$(jq -r '.isolatedFixture.topic' "$HANDOFF")" '
    .contractVersion=="1.0" and .topic==$topic
    and .expectedCount==100 and .producedCount==100
    and .sequence=={first:1,last:100}
    and (.batchId|test("^eks-mvp-[a-z0-9-]{8,80}$"))
    and (.payloadSha256|test("^[0-9a-f]{64}$"))
    and (.partitionsAcknowledged|type=="number" and .>=1)
  ' "$FIXTURE_RECEIPT" >/dev/null; then
  fixture_state="ready"
else
  blockers=$((blockers+1))
fi

backend_contract="blocked"
expected_backend_keys="$(jq -c '.secrets.backend.keys|sort' "$RUNTIME")"
actual_backend_keys="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json | jq -c '.data|keys|sort')"
if [[ "$expected_backend_keys" == "$actual_backend_keys" ]]; then
  backend_contract="ready"
else
  blockers=$((blockers+1))
fi

full_service_contract="blocked"
if node "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs" --full-service-ready "$RUNTIME" >/dev/null 2>&1; then
  full_service_contract="ready"
else
  blockers=$((blockers+1))
fi

status="ready"
[[ "$blockers" -gt 0 ]] && status="integration_blocked"
printf 'phase5_handoff_status=%s blockers=%d fixture_receipt=%s release_ownership=%s backend_runtime=%s full_service_contract=%s\n' \
  "$status" "$blockers" "$fixture_state" "$release_ownership" "$backend_contract" "$full_service_contract"
[[ "$MODE" == "--audit" || "$blockers" -eq 0 ]] || exit 1
