#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
EXPECTED_COMMIT="${ASKLAKE_EXPECTED_BACKEND_COMMIT:-}"

for command in aws jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 1
  }
done
[[ "${ASKLAKE_FINAL_INTEGRATION_CONFIRM:-}" == "run-final-integration-with-s3-sentinels" ]] || {
  echo "set ASKLAKE_FINAL_INTEGRATION_CONFIRM=run-final-integration-with-s3-sentinels" >&2
  exit 1
}
[[ "${ASKLAKE_BACKEND_S3_SMOKE_CONFIRM:-}" == "run-backend-s3-boundary-smoke" ]] || {
  echo "set ASKLAKE_BACKEND_S3_SMOKE_CONFIRM=run-backend-s3-boundary-smoke" >&2
  exit 1
}
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "ASKLAKE_EXPECTED_BACKEND_COMMIT must be a full 40-character Git SHA" >&2
  exit 1
}
verify_asklake_eks_context

deployment="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
image="$(jq -r '.spec.template.spec.containers[] | select(.name == "fastapi") | .image' <<<"$deployment")"
[[ "$image" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || {
  echo "FastAPI image is not pinned by immutable digest" >&2
  exit 1
}
jq -e '
  (.spec.replicas // 0) == 2
  and (.status.readyReplicas // 0) == 2
  and (.status.updatedReplicas // 0) == 2
  and (.status.availableReplicas // 0) == 2
  and (.status.unavailableReplicas // 0) == 0
' <<<"$deployment" >/dev/null

digest="${image##*@}"
bash "$ROOT_DIR/scripts/verify-eks-backend-image-provenance.sh" \
  "${ASKLAKE_IMAGE_RECEIPT:-}" "$image" "$EXPECTED_COMMIT" >/dev/null

pods="$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json)"
jq -e --arg digest "$digest" '
  (.items | length) == 2
  and all(.items[];
    .status.phase == "Running"
    and any(.status.containerStatuses[]?;
      .name == "fastapi"
      and .ready == true
      and .restartCount == 0
      and (.imageID | endswith($digest))
    )
  )
' <<<"$pods" >/dev/null

runtime_config="$(kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json)"
jq -e '
  .data.ASKLAKE_CONTINUOUS_CONTROL_PLANE == "external_ec2"
  and .data.ASKLAKE_SPARK_RUNNER == "kubernetes"
' <<<"$runtime_config" >/dev/null
unset runtime_config

bash "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh" >/dev/null

bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-day15-backend-secret-runtime.sh" >/dev/null

bash "$ROOT_DIR/scripts/run-eks-backend-s3-smoke.sh" >/dev/null

smoke_pods="$(kubectl get pod -n "$NAMESPACE" -o json | jq '[.items[] | select(
  .metadata.labels["app.kubernetes.io/name"] == "asklake-backend-s3-smoke"
  or (.metadata.name | startswith("asklake-backend-s3-"))
)] | length')"
smoke_configmaps="$(kubectl get configmap -n "$NAMESPACE" -o json | jq '[.items[] | select(
  .metadata.labels["app.kubernetes.io/name"] == "asklake-backend-s3-smoke"
  or (.metadata.name | startswith("asklake-backend-s3-"))
)] | length')"
[[ "$smoke_pods" -eq 0 && "$smoke_configmaps" -eq 0 ]] || {
  echo "Backend S3 smoke Kubernetes resources remain after cleanup" >&2
  exit 1
}

bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-day15-backend-secret-runtime.sh" >/dev/null

printf 'final_backend_source_commit=%s\n' "$EXPECTED_COMMIT"
printf 'final_backend_ecr_digest=verified_immutable\n'
printf 'final_backend_replicas=2_of_2_zero_restart\n'
printf 'final_alb_secret_rds=passed\n'
printf 'final_backend_s3_boundary=passed_cleanup_zero\n'
printf 'final_external_ec2_instance=running_status_checks_ok\n'
printf 'final_continuous_runtime_health=not_asserted\n'
printf 'final_eks_continuous_processes=0\n'
printf 'eks_day15_final_integration=passed\n'
