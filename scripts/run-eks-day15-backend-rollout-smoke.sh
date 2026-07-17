#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
EXPECTED_COMMIT="${ASKLAKE_EXPECTED_BACKEND_COMMIT:-}"
MONITOR_FILE="$(mktemp)"
MONITOR_PID=""

cleanup() {
  if [[ -n "$MONITOR_PID" ]] && kill -0 "$MONITOR_PID" >/dev/null 2>&1; then
    kill "$MONITOR_PID" >/dev/null 2>&1 || true
    wait "$MONITOR_PID" 2>/dev/null || true
  fi
  rm -f "$MONITOR_FILE"
}
trap cleanup EXIT

for command in aws curl jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 1
  }
done
[[ "${ASKLAKE_BACKEND_ROLLOUT_CONFIRM:-}" == "restart-same-immutable-backend" ]] || {
  echo "set ASKLAKE_BACKEND_ROLLOUT_CONFIRM=restart-same-immutable-backend" >&2
  exit 1
}
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "ASKLAKE_EXPECTED_BACKEND_COMMIT must be a full 40-character Git SHA" >&2
  exit 1
}
verify_asklake_eks_context

deployment_before="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
image="$(jq -r '.spec.template.spec.containers[] | select(.name == "fastapi") | .image' <<<"$deployment_before")"
[[ "$image" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || {
  echo "FastAPI image is not pinned by immutable digest" >&2
  exit 1
}
jq -e '
  (.spec.replicas // 0) >= 2
  and (.status.readyReplicas // 0) == .spec.replicas
  and (.status.updatedReplicas // 0) == .spec.replicas
  and (.status.unavailableReplicas // 0) == 0
  and any(.spec.template.spec.containers[] | select(.name == "fastapi") | .envFrom[]?; .configMapRef.name == "asklake-runtime")
  and any(.spec.template.spec.containers[] | select(.name == "fastapi") | .envFrom[]?; .secretRef.name == "asklake-backend-runtime")
' <<<"$deployment_before" >/dev/null
generation_before="$(jq -r '.metadata.generation' <<<"$deployment_before")"
revision_before="$(jq -r '.metadata.annotations["deployment.kubernetes.io/revision"] | tonumber' <<<"$deployment_before")"

runtime_config="$(kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json)"
jq -e '
  .data.ASKLAKE_CONTINUOUS_CONTROL_PLANE == "external_ec2"
  and .data.ASKLAKE_SPARK_RUNNER == "kubernetes"
' <<<"$runtime_config" >/dev/null || {
  echo "FastAPI runtime boundary does not preserve external EC2 Continuous ownership" >&2
  exit 1
}

external_secret="$(kubectl get externalsecret asklake-backend-runtime -n "$NAMESPACE" -o json)"
target_secret="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json)"
jq -e 'any(.status.conditions[]?; .type == "Ready" and .status == "True")' <<<"$external_secret" >/dev/null
jq -e '
  any(.metadata.ownerReferences[]?;
    .apiVersion == "external-secrets.io/v1"
    and .kind == "ExternalSecret"
    and .name == "asklake-backend-runtime"
    and .controller == true
  )
' <<<"$target_secret" >/dev/null
unset external_secret target_secret runtime_config

digest="${image##*@}"
bash "$ROOT_DIR/scripts/verify-eks-backend-image-provenance.sh" \
  "${ASKLAKE_IMAGE_RECEIPT:-}" "$image" "$EXPECTED_COMMIT" >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh" >/dev/null

ingresses="$(kubectl get ingress asklake-backend asklake-frontend -n "$NAMESPACE" -o json)"
backend_host="$(jq -r '[.items[] | select(.metadata.name == "asklake-backend") | .status.loadBalancer.ingress[0].hostname][0] // ""' <<<"$ingresses")"
frontend_host="$(jq -r '[.items[] | select(.metadata.name == "asklake-frontend") | .status.loadBalancer.ingress[0].hostname][0] // ""' <<<"$ingresses")"
[[ -n "$backend_host" && "$backend_host" == "$frontend_host" ]] || {
  echo "Frontend and Backend do not share one ready ALB" >&2
  exit 1
}
unset ingresses frontend_host

bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null
bash "$ROOT_DIR/scripts/migrate-eks-backend-runtime-secret.sh" --verify-existing >/dev/null

monitor_external_health() {
  local code sample_number=0
  while true; do
    if ! code="$(curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 3 --max-time 10 \
      "http://$backend_host/api/health" 2>/dev/null)"; then
      code="000"
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
kubectl rollout restart deployment/fastapi -n "$NAMESPACE" >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --rollout >/dev/null
kubectl rollout status deployment/fastapi -n "$NAMESPACE" --timeout=5m >/dev/null

steady_deadline=$((SECONDS + 420))
steady_ready=false
while ((SECONDS < steady_deadline)); do
  if bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null 2>&1; then
    steady_ready=true
    break
  fi
  sleep 5
done
[[ "$steady_ready" == "true" ]] || {
  echo "ALB did not return to exact steady targets after rollout" >&2
  exit 1
}

kill "$MONITOR_PID" >/dev/null 2>&1 || true
wait "$MONITOR_PID" 2>/dev/null || true
MONITOR_PID=""

sample_count="$(wc -l <"$MONITOR_FILE" | tr -d ' ')"
failure_count="$(awk '$1 != "200" {count++} END {print count+0}' "$MONITOR_FILE")"
[[ "$sample_count" -ge 3 && "$failure_count" -eq 0 ]] || {
  echo "external Backend health was not continuously available during rollout" >&2
  exit 1
}

deployment_after="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
generation_after="$(jq -r '.metadata.generation' <<<"$deployment_after")"
revision_after="$(jq -r '.metadata.annotations["deployment.kubernetes.io/revision"] | tonumber' <<<"$deployment_after")"
jq -e --arg image "$image" '
  (.spec.replicas // 0) >= 2
  and (.status.readyReplicas // 0) == .spec.replicas
  and (.status.updatedReplicas // 0) == .spec.replicas
  and (.status.availableReplicas // 0) == .spec.replicas
  and (.status.unavailableReplicas // 0) == 0
  and ([.spec.template.spec.containers[] | select(.name == "fastapi") | .image] == [$image])
' <<<"$deployment_after" >/dev/null
[[ "$generation_after" -gt "$generation_before" && "$revision_after" -gt "$revision_before" ]] || {
  echo "FastAPI rollout did not advance Deployment generation and revision" >&2
  exit 1
}

pods="$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json)"
jq -e --arg digest "$digest" '
  [.items[] | select(.metadata.deletionTimestamp == null)] as $active
  | ($active | length) >= 2
  and all($active[];
    .status.phase == "Running"
    and any(.status.containerStatuses[]?;
      .name == "fastapi"
      and .ready == true
      and .restartCount == 0
      and (.imageID | endswith($digest))
    )
  )
' <<<"$pods" >/dev/null

bash "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" >/dev/null

bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-day15-backend-secret-runtime.sh" >/dev/null

printf 'backend_source_commit=%s\n' "$EXPECTED_COMMIT"
printf 'backend_rollout_http_samples=%d\n' "$sample_count"
printf 'backend_rollout_http_failures=%d\n' "$failure_count"
printf 'backend_rollout_replicas=%s_of_%s\n' \
  "$(jq -r '.status.readyReplicas' <<<"$deployment_after")" \
  "$(jq -r '.spec.replicas' <<<"$deployment_after")"
printf 'backend_rollout_digest=unchanged_immutable\n'
printf 'backend_external_ec2_instance=running_status_checks_ok\n'
printf 'backend_continuous_runtime_health=not_asserted\n'
printf 'backend_eks_continuous_processes=0\n'
printf 'backend_alb_secret_rds_postcheck=passed\n'
