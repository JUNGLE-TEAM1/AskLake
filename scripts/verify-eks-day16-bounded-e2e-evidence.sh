#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
MODE="${1:---verify-only}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
RUN_RECEIPT="${ASKLAKE_PHASE5_RUN_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev.phase5-bounded-run.json}"
FIXTURE_RECEIPT="${ASKLAKE_FIXTURE_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev.fixture-receipt.json}"
OUTPUT="${ASKLAKE_PHASE5_EVIDENCE_OUTPUT:-$ROOT_DIR/infra/eks/delivery/dev.phase5-verified-evidence.json}"
PYTHON_SOURCE="$ROOT_DIR/backend/scripts/verify_eks_phase5_bounded_evidence.py"

fail() { echo "$1" >&2; exit 1; }
[[ "$MODE" == "--verify-only" || "$MODE" == "--verify-retry" ]] || \
  fail "usage: verify-eks-day16-bounded-e2e-evidence.sh [--verify-only|--verify-retry]"
if [[ "$MODE" == "--verify-retry" ]]; then
  [[ "${ASKLAKE_PHASE5_RETRY_CONFIRM:-}" == "verify-existing-success-retry" ]] || \
    fail "set ASKLAKE_PHASE5_RETRY_CONFIRM=verify-existing-success-retry"
fi
for command in git jq kubectl node; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR")" || fail "current image receipt is invalid"
for file in "$RUN_RECEIPT" "$FIXTURE_RECEIPT"; do
  [[ -s "$file" ]] || fail "private Phase 5 input is missing"
  git -C "$ROOT_DIR" check-ignore -q -- "$file" || fail "private Phase 5 input must remain ignored"
  [[ "$(stat -f '%Lp' "$file")" == "600" ]] || fail "private Phase 5 input must use mode 0600"
done
[[ -s "$PYTHON_SOURCE" ]] || fail "Phase 5 verifier source is missing"
git -C "$ROOT_DIR" check-ignore -q -- "$OUTPUT" || fail "private Phase 5 output must remain ignored"

job_id="$(jq -r '.jobId // empty' "$RUN_RECEIPT")"
run_id="$(jq -r '.runId // empty' "$RUN_RECEIPT")"
expected_count="$(jq -r '.expectedCount // empty' "$FIXTURE_RECEIPT")"
spark_image="$(jq -r '.images.sparkRuntime // empty' "$RECEIPT")"
[[ -n "$job_id" && -n "$run_id" && "$expected_count" =~ ^[0-9]+$ && -n "$spark_image" ]] || \
  fail "private Phase 5 input contract is invalid"

name="asklake-phase5-verify-$(date -u +%H%M%S)-$RANDOM"
manifest="$(mktemp)"
raw="$(mktemp)"
cleanup() {
  kubectl delete job "$name" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  rm -f "$manifest" "$raw"
}
trap cleanup EXIT
code="$(sed -n '1,$p' "$PYTHON_SOURCE")"
verify_retry=false
[[ "$MODE" == "--verify-retry" ]] && verify_retry=true

kubectl get deployment fastapi -n "$NAMESPACE" -o json | jq \
  --arg name "$name" --arg run "$run_id" --arg job "$job_id" \
  --arg count "$expected_count" --arg image "$spark_image" --arg code "$code" \
  --arg retry "$verify_retry" '
  {apiVersion:"batch/v1",kind:"Job",metadata:{name:$name,namespace:.metadata.namespace,labels:{"app.kubernetes.io/name":"asklake-phase5-evidence","asklake.io/temporary":"true"}},spec:{backoffLimit:0,template:{metadata:{labels:{"app.kubernetes.io/name":"asklake-phase5-evidence","asklake.io/temporary":"true"}},spec:.spec.template.spec}}}
  | .spec.template.spec.restartPolicy="Never"
  | .spec.template.spec.containers=(.spec.template.spec.containers|map(select(.name=="fastapi")))
  | .spec.template.spec.containers[0].name="verify"
  | .spec.template.spec.containers[0].command=["python","-c",$code]
  | .spec.template.spec.containers[0].args=[]
  | .spec.template.spec.containers[0].env=((.spec.template.spec.containers[0].env//[])+[
      {name:"RUN_ID",value:$run},{name:"JOB_ID",value:$job},{name:"EXPECTED_COUNT",value:$count},
      {name:"SPARK_IMAGE",value:$image},{name:"VERIFY_RETRY",value:$retry}
    ])
  | del(.spec.template.spec.containers[0].livenessProbe,.spec.template.spec.containers[0].readinessProbe,.spec.template.spec.containers[0].startupProbe,.spec.template.spec.containers[0].ports)
' >"$manifest"
chmod 600 "$manifest" "$raw"
kubectl apply -f "$manifest" >/dev/null
kubectl wait --for=condition=complete "job/$name" -n "$NAMESPACE" --timeout=10m >/dev/null || \
  fail "Phase 5 evidence Job did not complete"
kubectl logs "job/$name" -n "$NAMESPACE" >"$raw"
jq -e '.status=="passed" and ([.checks[]]|all)' "$raw" >/dev/null || fail "persisted Phase 5 evidence is inconsistent"

application_name="$(jq -r '.privateIdentity.applicationName // empty' "$raw")"
application_uid="$(jq -r '.privateIdentity.applicationUid // empty' "$raw")"
[[ -n "$application_name" && -n "$application_uid" ]] || fail "private SparkApplication identity is missing"
if ! application="$(kubectl get sparkapplication "$application_name" -n "$NAMESPACE" -o json 2>/dev/null)"; then
  fail "persisted SparkApplication is not present for live identity verification"
fi
uid_ready="$(jq -r --arg uid "$application_uid" '.metadata.uid==$uid' <<<"$application")"
state_ready="$(jq -r '.status.applicationState.state=="COMPLETED"' <<<"$application")"
image_ready="$(jq -r --arg image "$spark_image" '.spec.image==$image' <<<"$application")"
[[ "$uid_ready" == true && "$state_ready" == true && "$image_ready" == true ]] || \
  fail "live SparkApplication identity, state, or image differs from persisted evidence"

temporary="$(mktemp)"
jq --argjson uid "$uid_ready" --argjson completed "$state_ready" --argjson image "$image_ready" '
  del(.privateIdentity)
  | .checks.applicationUidMatches=$uid
  | .checks.applicationCompleted=$completed
  | .checks.applicationImageMatches=$image
  | .status=(if ([.checks[]]|all) then "passed" else "failed" end)
' "$raw" >"$temporary"
mv "$temporary" "$OUTPUT"
chmod 600 "$OUTPUT"

kubectl delete job "$name" -n "$NAMESPACE" --wait=true >/dev/null
residue_jobs="$(kubectl get jobs -n "$NAMESPACE" -l app.kubernetes.io/name=asklake-phase5-evidence -o json | jq '.items|length')"
residue_pods="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=asklake-phase5-evidence -o json | jq '.items|length')"
[[ "$residue_jobs" -eq 0 && "$residue_pods" -eq 0 ]] || fail "Phase 5 evidence verifier left temporary Kubernetes resources"
trap - EXIT
rm -f "$manifest" "$raw"
jq -r '"phase5_evidence="+.status+" checks="+([.checks[]]|length|tostring)+" rows="+(.counts.trinoVerifiedRows|tostring)+" materializations="+(.counts.materializationCount|tostring)+" residue=0"' "$OUTPUT"
