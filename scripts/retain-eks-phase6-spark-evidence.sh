#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
RUN_RECEIPT="${ASKLAKE_PHASE6_RUN_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev.phase6-bounded-run.json}"
RETAIN_SECONDS="${ASKLAKE_SPARK_EVIDENCE_TTL_SECONDS:-604800}"

fail() { echo "$1" >&2; exit 1; }
[[ "${ASKLAKE_SPARK_EVIDENCE_CONFIRM:-}" == "retain-completed-phase6-evidence" ]] || fail "set ASKLAKE_SPARK_EVIDENCE_CONFIRM=retain-completed-phase6-evidence"
[[ "$RETAIN_SECONDS" =~ ^[0-9]+$ && "$RETAIN_SECONDS" -ge 86400 && "$RETAIN_SECONDS" -le 2592000 ]] || fail "evidence retention must be 1-30 days"
for command in git jq kubectl node; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR")" || fail "current image receipt is invalid"
[[ -s "$RUN_RECEIPT" ]] || fail "private Phase 6 run receipt is missing"
git -C "$ROOT_DIR" check-ignore -q -- "$RUN_RECEIPT" || fail "private Phase 6 run receipt must remain ignored"
[[ "$(stat -f '%Lp' "$RUN_RECEIPT")" == "600" ]] || fail "private Phase 6 run receipt must use mode 0600"

name="$(jq -r '.applicationName // empty' "$RUN_RECEIPT")"
uid="$(jq -r '.applicationUid // empty' "$RUN_RECEIPT")"
image="$(jq -r '.images.sparkRuntime' "$RECEIPT")"
application="$(kubectl get sparkapplication "$name" -n "$NAMESPACE" -o json 2>/dev/null)" || fail "completed SparkApplication is missing before retention"
jq -e --arg uid "$uid" --arg image "$image" '
  .metadata.uid==$uid and .spec.image==$image and .status.applicationState.state=="COMPLETED"
' <<<"$application" >/dev/null || fail "SparkApplication identity, image, or state differs from the run receipt"

retain_until="$(date -u -v+"${RETAIN_SECONDS}"S +%Y-%m-%dT%H:%M:%SZ)"
patch="$(jq -n --arg ttl "$RETAIN_SECONDS" --arg until "$retain_until" '{
  metadata:{labels:{"asklake.io/evidence-retention":"phase6"},annotations:{"asklake.io/evidence-retain-until":$until}},
  spec:{timeToLiveSeconds:($ttl|tonumber)}
}')"
kubectl patch sparkapplication "$name" -n "$NAMESPACE" --type merge -p "$patch" >/dev/null
kubectl get sparkapplication "$name" -n "$NAMESPACE" -o json | jq -e \
  --arg uid "$uid" --argjson ttl "$RETAIN_SECONDS" '
    .metadata.uid==$uid and .spec.timeToLiveSeconds==$ttl
    and .metadata.labels["asklake.io/evidence-retention"]=="phase6"
    and (.metadata.annotations["asklake.io/evidence-retain-until"]|length)>0
  ' >/dev/null || fail "SparkApplication evidence retention was not applied"
printf 'spark_evidence=retained ttl_seconds=%s\n' "$RETAIN_SECONDS"
