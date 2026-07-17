#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

RECEIPT_PATH="${1:-${ASKLAKE_IMAGE_RECEIPT:-}}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-web"
TEMP_DIR="$(mktemp -d)"
CURRENT_VALUES="$TEMP_DIR/current-values.json"
CANDIDATE_VALUES="$TEMP_DIR/candidate-values.json"
MONITOR_FILE="$TEMP_DIR/health-monitor.txt"
MONITOR_RECHECK_FILE="$TEMP_DIR/health-transport-rechecks.txt"
MONITOR_PID=""
RELEASE_REVISION_BEFORE=""
UPGRADE_STARTED=false
ROLLOUT_COMPLETE=false

fail() {
  echo "$1" >&2
  return 1
}

stop_monitor() {
  if [[ -n "$MONITOR_PID" ]] && kill -0 "$MONITOR_PID" >/dev/null 2>&1; then
    kill "$MONITOR_PID" >/dev/null 2>&1 || true
    wait "$MONITOR_PID" 2>/dev/null || true
  fi
  MONITOR_PID=""
}

rollback_on_error() {
  local exit_code=$? rollback_deadline rollback_steady collector_rollback_restored
  trap - ERR
  set +e
  stop_monitor
  if [[ "$UPGRADE_STARTED" == "true" && "$ROLLOUT_COMPLETE" != "true" && -n "$RELEASE_REVISION_BEFORE" ]]; then
    echo "Backend rollout postcheck failed; restoring the previous Helm revision" >&2
    helm rollback asklake-web "$RELEASE_REVISION_BEFORE" \
      --namespace "$NAMESPACE" --wait --timeout 10m >/dev/null
    if [[ $? -eq 0 ]]; then
      rollback_deadline=$((SECONDS + 420))
      rollback_steady=false
      while ((SECONDS < rollback_deadline)); do
        if bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null 2>&1; then
          rollback_steady=true
          break
        fi
        sleep 5
      done
      collector_rollback_restored=false
      if [[ "$old_collector_present" == "true" ]]; then
        if [[ "$(kubectl get deployment trino-result-collector -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[?(@.name=="trino-result-collector")].image}' 2>/dev/null)" == "$old_collector_image" ]]; then
          collector_rollback_restored=true
        fi
      elif ! kubectl get deployment trino-result-collector -n "$NAMESPACE" >/dev/null 2>&1; then
        collector_rollback_restored=true
      fi
      if [[ "$rollback_steady" == "true" ]] \
        && [[ "$(kubectl get deployment fastapi -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[?(@.name=="fastapi")].image}')" == "$old_backend_image" ]] \
        && [[ "$collector_rollback_restored" == "true" ]]; then
        echo "backend_rollout_rollback=completed_and_steady" >&2
      else
        echo "backend_rollout_rollback=workload_restored_but_postcheck_failed" >&2
      fi
    else
      echo "backend_rollout_rollback=failed_manual_recovery_required" >&2
    fi
  fi
  exit "$exit_code"
}

cleanup() {
  stop_monitor
  rm -rf "$TEMP_DIR"
}

trap rollback_on_error ERR
trap cleanup EXIT

for command in aws curl git helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ "${ASKLAKE_BACKEND_IMAGE_ROLLOUT_CONFIRM:-}" == "deploy-new-immutable-backend" ]] || \
  fail "set ASKLAKE_BACKEND_IMAGE_ROLLOUT_CONFIRM=deploy-new-immutable-backend"
[[ -n "$RECEIPT_PATH" && -f "$RECEIPT_PATH" ]] || fail "a private ASKLAKE_IMAGE_RECEIPT file is required"

verify_asklake_eks_context
bash "$ROOT_DIR/scripts/preflight-eks-backend-image-rollout.sh" "$RECEIPT_PATH" >/dev/null

namespace_json="$(kubectl get namespace "$NAMESPACE" -o json)"
jq -e '.metadata.labels["eks.amazonaws.com/pod-readiness-gate-inject"] == "enabled"' \
  <<<"$namespace_json" >/dev/null || fail "the namespace does not enable ALB Pod readiness gate injection"
target_group_bindings="$(kubectl get targetgroupbindings -n "$NAMESPACE" -o json)"
jq -e '
  [.items[] | select(.spec.serviceRef.name == "fastapi" and .spec.targetType == "ip")] | length == 1
' <<<"$target_group_bindings" >/dev/null || fail "FastAPI must have exactly one IP TargetGroupBinding for readiness gates"
unset namespace_json target_group_bindings

receipt_commit="$(jq -r '.gitRevision' "$RECEIPT_PATH")"
new_backend_image="$(jq -r '.images.backend' "$RECEIPT_PATH")"
new_backend_digest="${new_backend_image##*@}"

helm get values asklake-web -n "$NAMESPACE" -o json >"$CURRENT_VALUES"
jq --arg image "$new_backend_image" '.backend.image = $image' "$CURRENT_VALUES" >"$CANDIDATE_VALUES"
jq -e --slurp '
  (.[0] | del(.backend.image)) == (.[1] | del(.backend.image))
  and .[0].backend.image != .[1].backend.image
' "$CURRENT_VALUES" "$CANDIDATE_VALUES" >/dev/null || fail "rollout values changed more than backend.image"

RELEASE_REVISION_BEFORE="$(helm list -n "$NAMESPACE" -o json | jq -r '.[] | select(.name == "asklake-web") | .revision')"
[[ "$RELEASE_REVISION_BEFORE" =~ ^[0-9]+$ ]] || fail "the current Helm release revision is unavailable"

backend_before="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
frontend_before="$(kubectl get deployment frontend -n "$NAMESPACE" -o json)"
old_backend_image="$(jq -r '.spec.template.spec.containers[] | select(.name == "fastapi") | .image' <<<"$backend_before")"
collector_before=""
old_collector_image=""
old_collector_present=false
if collector_before="$(kubectl get deployment trino-result-collector -n "$NAMESPACE" -o json 2>/dev/null)"; then
  old_collector_present=true
  old_collector_image="$(jq -r '.spec.template.spec.containers[] | select(.name == "trino-result-collector") | .image' <<<"$collector_before")"
fi
frontend_image_before="$(jq -r '.spec.template.spec.containers[] | select(.name == "frontend") | .image' <<<"$frontend_before")"
frontend_generation_before="$(jq -r '.metadata.generation' <<<"$frontend_before")"
frontend_pod_uids_before="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=frontend -o json | jq -r '.items[].metadata.uid' | LC_ALL=C sort)"
[[ "$old_backend_image" != "$new_backend_image" ]] || fail "the new Backend image is already deployed"
if [[ "$old_collector_present" == "true" ]]; then
  [[ "$old_collector_image" == "$old_backend_image" ]] || fail "FastAPI and collector currently use different Backend images"
fi

target_secret_before="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json)"
secret_keys_before="$(jq -c '.data | keys | sort' <<<"$target_secret_before")"
secret_hash_before="$(jq -S -c '.data | with_entries(.value |= @base64d)' <<<"$target_secret_before" | asklake_sha256)"
unset target_secret_before

ingresses="$(kubectl get ingress asklake-backend asklake-frontend -n "$NAMESPACE" -o json)"
backend_host="$(jq -r '[.items[] | select(.metadata.name == "asklake-backend") | .status.loadBalancer.ingress[0].hostname][0] // ""' <<<"$ingresses")"
frontend_host="$(jq -r '[.items[] | select(.metadata.name == "asklake-frontend") | .status.loadBalancer.ingress[0].hostname][0] // ""' <<<"$ingresses")"
[[ -n "$backend_host" && "$backend_host" == "$frontend_host" ]] || fail "Frontend and Backend do not share one ready ALB"
unset ingresses frontend_host

monitor_external_health() {
  local code retry_code sample_number=0
  while true; do
    if ! code="$(curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 3 --max-time 10 "http://$backend_host/api/health" 2>/dev/null)"; then
      code="000"
    fi
    if [[ "$code" == "000" ]]; then
      printf 'recheck\n' >>"$MONITOR_RECHECK_FILE"
      sleep 0.2
      if ! retry_code="$(curl -sS -o /dev/null -w '%{http_code}' \
        --connect-timeout 3 --max-time 10 "http://$backend_host/api/health" 2>/dev/null)"; then
        retry_code="000"
      fi
      code="$retry_code"
    fi
    printf '%s\n' "$code" >>"$MONITOR_FILE"
    sample_number=$((sample_number + 1))
    if ((sample_number % 30 == 0)); then
      printf 'backend_rollout_monitor_samples=%d failures=%d\n' \
        "$sample_number" "$(awk '$1 != "200" {count++} END {print count+0}' "$MONITOR_FILE")"
    fi
    sleep 1
  done
}

monitor_external_health &
MONITOR_PID=$!
sleep 1

UPGRADE_STARTED=true
helm upgrade --install asklake-web "$CHART_DIR" \
  --namespace "$NAMESPACE" --create-namespace=false \
  -f "$CANDIDATE_VALUES" --rollback-on-failure --wait --timeout 10m >/dev/null

kubectl rollout status deployment/fastapi -n "$NAMESPACE" --timeout=10m >/dev/null
kubectl rollout status deployment/trino-result-collector -n "$NAMESPACE" --timeout=10m >/dev/null

steady_deadline=$((SECONDS + 420))
steady_ready=false
while ((SECONDS < steady_deadline)); do
  if bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null 2>&1; then
    steady_ready=true
    break
  fi
  sleep 5
done
[[ "$steady_ready" == "true" ]] || fail "ALB did not return to exact steady targets after Backend rollout"

stop_monitor
sample_count="$(wc -l <"$MONITOR_FILE" | tr -d ' ')"
failure_count="$(awk '$1 != "200" {count++} END {print count+0}' "$MONITOR_FILE")"
if [[ "$sample_count" -lt 3 || "$failure_count" -ne 0 ]]; then
  failure_summary="$(awk '$1 != "200" {count[$1]++} END {for (code in count) printf "%s:%d ", code, count[code]}' "$MONITOR_FILE")"
  echo "backend_rollout_non_200_summary=${failure_summary% }" >&2
  fail "external Backend health was not continuously available during rollout"
fi

release_revision_after="$(helm list -n "$NAMESPACE" -o json | jq -r '.[] | select(.name == "asklake-web") | .revision')"
[[ "$release_revision_after" =~ ^[0-9]+$ && "$release_revision_after" -gt "$RELEASE_REVISION_BEFORE" ]] || \
  fail "Backend rollout did not advance the Helm release revision"

backend_after="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
jq -e --arg image "$new_backend_image" '
  (.spec.replicas // 0) == 2
  and (.status.readyReplicas // 0) == 2
  and (.status.updatedReplicas // 0) == 2
  and (.status.availableReplicas // 0) == 2
  and (.status.unavailableReplicas // 0) == 0
  and ([.spec.template.spec.containers[] | select(.name == "fastapi") | .image] == [$image])
' <<<"$backend_after" >/dev/null || fail "Backend Deployment did not converge on the new image"

collector_after="$(kubectl get deployment trino-result-collector -n "$NAMESPACE" -o json)"
jq -e --arg image "$new_backend_image" '
  (.spec.replicas // 0) == 1
  and (.status.readyReplicas // 0) == 1
  and (.status.updatedReplicas // 0) == 1
  and (.status.availableReplicas // 0) == 1
  and (.status.unavailableReplicas // 0) == 0
  and .spec.template.spec.serviceAccountName == "asklake-backend"
  and .spec.template.spec.automountServiceAccountToken == false
  and ([.spec.template.spec.containers[] | select(.name == "trino-result-collector") | .image] == [$image])
' <<<"$collector_after" >/dev/null || fail "Trino result collector Deployment did not converge on the new image"

pods_after="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json)"
jq -e --arg digest "$new_backend_digest" '
  (.items | length) == 2
  and all(.items[];
    .status.phase == "Running"
    and ([.spec.readinessGates[]?.conditionType | select(startswith("target-health."))] | length) >= 1
    and any(.status.conditions[]?;
      (.type | startswith("target-health."))
      and .status == "True"
    )
    and any(.status.containerStatuses[]?;
      .name == "fastapi"
      and .ready == true
      and .restartCount == 0
      and (.imageID | endswith($digest))
    )
  )
' <<<"$pods_after" >/dev/null || fail "Backend Pods do not match the new immutable digest"

collector_pods_after="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=trino-result-collector -o json)"
jq -e --arg digest "$new_backend_digest" '
  (.items | length) == 1
  and all(.items[];
    .status.phase == "Running"
    and any(.status.containerStatuses[]?;
      .name == "trino-result-collector"
      and .ready == true
      and .restartCount == 0
      and (.imageID | endswith($digest))
    )
  )
' <<<"$collector_pods_after" >/dev/null || fail "Trino result collector Pod does not match the new immutable digest"

frontend_after="$(kubectl get deployment frontend -n "$NAMESPACE" -o json)"
frontend_image_after="$(jq -r '.spec.template.spec.containers[] | select(.name == "frontend") | .image' <<<"$frontend_after")"
frontend_generation_after="$(jq -r '.metadata.generation' <<<"$frontend_after")"
frontend_pod_uids_after="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=frontend -o json | jq -r '.items[].metadata.uid' | LC_ALL=C sort)"
[[ "$frontend_image_after" == "$frontend_image_before" \
  && "$frontend_generation_after" == "$frontend_generation_before" \
  && "$frontend_pod_uids_after" == "$frontend_pod_uids_before" ]] || \
  fail "Backend-only rollout changed the Frontend workload"

target_secret_after="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json)"
secret_keys_after="$(jq -c '.data | keys | sort' <<<"$target_secret_after")"
secret_hash_after="$(jq -S -c '.data | with_entries(.value |= @base64d)' <<<"$target_secret_after" | asklake_sha256)"
[[ "$secret_keys_after" == "$secret_keys_before" && "$secret_hash_after" == "$secret_hash_before" ]] || \
  fail "Backend runtime Secret changed during image rollout"
unset target_secret_after secret_hash_before secret_hash_after

bash "$ROOT_DIR/scripts/verify-eks-backend-image-provenance.sh" \
  "$RECEIPT_PATH" "$new_backend_image" "$receipt_commit" >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh" >/dev/null

ROLLOUT_COMPLETE=true
transport_rechecks=0
if [[ -f "$MONITOR_RECHECK_FILE" ]]; then
  transport_rechecks="$(wc -l <"$MONITOR_RECHECK_FILE" | tr -d ' ')"
fi
echo "backend_rollout_values_change=backend_image_only"
echo "backend_rollout_atomic_upgrade=passed"
echo "backend_rollout_replicas=2_of_2"
echo "backend_rollout_pod_digest=verified"
echo "backend_rollout_collector_replicas=1_of_1"
echo "backend_rollout_collector_digest=verified"
echo "backend_rollout_collector_baseline=$([[ "$old_collector_present" == "true" ]] && echo present || echo absent)"
echo "backend_rollout_frontend_mutation=zero"
echo "backend_rollout_secret_mutation=zero"
echo "backend_rollout_http_samples=$sample_count"
echo "backend_rollout_http_failures=$failure_count"
echo "backend_rollout_transport_rechecks=$transport_rechecks"
echo "backend_rollout_alb_rds_continuous_ec2=passed"
