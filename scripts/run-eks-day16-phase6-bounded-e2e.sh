#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
BASE_RUN="${ASKLAKE_PHASE5_RUN_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev.phase5-bounded-run.json}"
FIXTURE="${ASKLAKE_FIXTURE_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev.phase6.fixture-receipt.json}"
OUTPUT="${ASKLAKE_PHASE6_RUN_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev.phase6-bounded-run.json}"
SOURCE="$ROOT_DIR/backend/scripts/run_eks_phase6_bounded_e2e.py"

fail() { echo "$1" >&2; exit 1; }
[[ "${ASKLAKE_PHASE6_E2E_CONFIRM:-}" == "run-new-bounded-e2e-once" ]] || fail "set ASKLAKE_PHASE6_E2E_CONFIRM=run-new-bounded-e2e-once"
for command in cmp git helm jq kubectl; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
for file in "$BASE_RUN" "$FIXTURE"; do
  [[ -s "$file" ]] || fail "private bounded E2E input is missing"
  git -C "$ROOT_DIR" check-ignore -q -- "$file" || fail "private bounded E2E input must remain ignored"
  [[ "$(stat -f '%Lp' "$file")" == "600" ]] || fail "private bounded E2E input must use mode 0600"
done
[[ ! -e "$OUTPUT" ]] || fail "Phase 6 run receipt already exists"
git -C "$ROOT_DIR" check-ignore -q -- "$OUTPUT" || fail "Phase 6 run receipt must remain ignored"

job_id="$(jq -r '.jobId // empty' "$BASE_RUN")"
batch_id="$(jq -r '.batchId // empty' "$FIXTURE")"
expected_count="$(jq -r '.expectedCount // empty' "$FIXTURE")"
[[ -n "$job_id" && -n "$batch_id" && "$expected_count" == "100" ]] || fail "private bounded E2E input contract is invalid"

name="asklake-phase6-e2e-$(date -u +%H%M%S)-$RANDOM"
manifest="$(mktemp)"; raw="$(mktemp)"; runtime_before="$(mktemp)"; runtime_current="$(mktemp)"
cleanup() {
  kubectl delete job "$name" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  rm -f "$manifest" "$raw" "$runtime_before" "$runtime_current"
}
trap cleanup EXIT
chmod 600 "$manifest" "$raw" "$runtime_before" "$runtime_current"

capture_runtime_identity() {
  jq -n \
    --argjson releases "$(helm list -n "$NAMESPACE" -o json | jq -S '[.[] | select(.name == "asklake-web" or .name == "asklake-airflow" or .name == "asklake-trino" or .name == "asklake-runtime-config") | {name,revision,status}] | sort_by(.name)')" \
    --argjson deployments "$(kubectl get deployment frontend fastapi trino-result-collector asklake-airflow-apiserver asklake-airflow-scheduler asklake-airflow-dag-processor asklake-trino -n "$NAMESPACE" -o json | jq -S '[.items[] | {name:.metadata.name,uid:.metadata.uid,template:.spec.template}] | sort_by(.name)')" \
    '{releases:$releases,deployments:$deployments}'
}

capture_runtime_identity >"$runtime_before"
code="$(sed -n '1,$p' "$SOURCE")"
kubectl get deployment fastapi -n "$NAMESPACE" -o json | jq \
  --arg name "$name" --arg job "$job_id" --arg batch "$batch_id" --arg count "$expected_count" --arg code "$code" '
  {apiVersion:"batch/v1",kind:"Job",metadata:{name:$name,namespace:.metadata.namespace,labels:{"app.kubernetes.io/name":"asklake-phase6-e2e","asklake.io/temporary":"true"}},spec:{backoffLimit:0,activeDeadlineSeconds:9600,template:{metadata:{labels:{"app.kubernetes.io/name":"asklake-phase6-e2e","asklake.io/temporary":"true"}},spec:.spec.template.spec}}}
  | .spec.template.spec.restartPolicy="Never"
  | .spec.template.spec.containers=(.spec.template.spec.containers|map(select(.name=="fastapi")))
  | .spec.template.spec.containers[0].name="execute"
  | .spec.template.spec.containers[0].command=["python","-c",$code]
  | .spec.template.spec.containers[0].args=[]
  | .spec.template.spec.containers[0].env=((.spec.template.spec.containers[0].env//[])+[
      {name:"JOB_ID",value:$job},{name:"FIXTURE_BATCH_ID",value:$batch},{name:"EXPECTED_COUNT",value:$count}
    ])
  | del(.spec.template.spec.containers[0].livenessProbe,.spec.template.spec.containers[0].readinessProbe,.spec.template.spec.containers[0].startupProbe,.spec.template.spec.containers[0].ports)
' >"$manifest"
kubectl apply -f "$manifest" >/dev/null
deadline=$((SECONDS + 9600))
while ((SECONDS < deadline)); do
  capture_runtime_identity >"$runtime_current"
  if ! cmp -s "$runtime_before" "$runtime_current"; then
    fail "shared EKS runtime changed during the bounded E2E; retry only after the rollout is steady"
  fi
  succeeded="$(kubectl get job "$name" -n "$NAMESPACE" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)"
  failed="$(kubectl get job "$name" -n "$NAMESPACE" -o jsonpath='{.status.failed}' 2>/dev/null || true)"
  [[ "$succeeded" == "1" ]] && break
  if [[ "${failed:-0}" -gt 0 ]]; then
    kubectl logs "job/$name" -n "$NAMESPACE" --tail=100 >&2 || true
    fail "Phase 6 bounded E2E Job failed"
  fi
  sleep 5
done
[[ "${succeeded:-0}" == "1" ]] || fail "Phase 6 bounded E2E Job did not complete"
kubectl logs "job/$name" -n "$NAMESPACE" >"$raw"
jq -e '.contractVersion=="1.0" and .submitted==true and .expectedCount==100 and (.applicationName|length)>0 and (.applicationUid|length)>0' "$raw" >/dev/null || fail "Phase 6 bounded E2E receipt is invalid"
mv "$raw" "$OUTPUT"
chmod 600 "$OUTPUT"
kubectl delete job "$name" -n "$NAMESPACE" --wait=true >/dev/null
trap - EXIT
rm -f "$manifest" "$runtime_before" "$runtime_current"
printf 'phase6_bounded_e2e=submitted expected_count=100 residue=0\n'
