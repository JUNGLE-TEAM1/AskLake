#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
EXPECTED_COMMIT="${ASKLAKE_EXPECTED_BACKEND_COMMIT:-}"

for command in aws git jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 1
  }
done
[[ "${ASKLAKE_FINAL_INTEGRATION_CONFIRM:-}" == "run-read-mostly-final-integration" ]] || {
  echo "set ASKLAKE_FINAL_INTEGRATION_CONFIRM=run-read-mostly-final-integration" >&2
  exit 1
}
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || {
  echo "ASKLAKE_EXPECTED_BACKEND_COMMIT must be a Git commit" >&2
  exit 1
}
git -C "$ROOT_DIR" merge-base --is-ancestor "$EXPECTED_COMMIT" HEAD || {
  echo "expected Backend commit is not contained in the current branch" >&2
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

repository_uri="${image%@*}"
digest="${image##*@}"
repository_name="${repository_uri#*/}"
expected_tag="git-${EXPECTED_COMMIT:0:7}"
image_detail="$(aws ecr describe-images \
  --region "$REGION" \
  --repository-name "$repository_name" \
  --image-ids "imageDigest=$digest" \
  --output json)"
jq -e --arg tag "$expected_tag" '
  (.imageDetails | length) == 1
  and any(.imageDetails[0].imageTags[]?; . == $tag)
' <<<"$image_detail" >/dev/null
mutability="$(aws ecr describe-repositories \
  --region "$REGION" \
  --repository-names "$repository_name" \
  --query 'repositories[0].imageTagMutability' \
  --output text)"
[[ "$mutability" == "IMMUTABLE" || "$mutability" == "IMMUTABLE_WITH_EXCLUSION" ]]
unset image_detail mutability repository_uri repository_name expected_tag

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

continuous_processes=0
while IFS= read -r pod; do
  [[ "$(kubectl exec -n "$NAMESPACE" "$pod" -c fastapi -- printenv ASKLAKE_CONTINUOUS_CONTROL_PLANE)" == "external_ec2" ]]
  process_count="$(kubectl exec -n "$NAMESPACE" "$pod" -c fastapi -- python -c '
import os

current = os.getpid()
needles = ("kafka_continuous_stream.py", "manage-kafka-continuous.mjs")
count = 0
for entry in os.listdir("/proc"):
    if not entry.isdigit() or int(entry) == current:
        continue
    try:
        command = open(f"/proc/{entry}/cmdline", "rb").read().replace(b"\x00", b" ").decode("utf-8", "ignore")
    except OSError:
        continue
    if any(needle in command for needle in needles):
        count += 1
print(count)
')"
  continuous_processes=$((continuous_processes + process_count))
done < <(jq -r '.items[].metadata.name' <<<"$pods")
[[ "$continuous_processes" -eq 0 ]]

running_instances="$(aws ec2 describe-instances \
  --region "$REGION" \
  --filters Name=instance-state-name,Values=running \
  --output json \
  | jq '[.Reservations[].Instances[]] | length')"
[[ "$running_instances" -ge 1 ]] || {
  echo "the existing EC2 rollback/Continuous runtime is not running" >&2
  exit 1
}

bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-day15-backend-secret-runtime.sh" >/dev/null

export ASKLAKE_BACKEND_S3_SMOKE_CONFIRM=run-backend-s3-boundary-smoke
bash "$ROOT_DIR/scripts/run-eks-backend-s3-smoke.sh" >/dev/null

smoke_pods="$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/name=asklake-backend-s3-smoke -o json | jq '.items | length')"
smoke_configmaps="$(kubectl get configmap -n "$NAMESPACE" -l app.kubernetes.io/name=asklake-backend-s3-smoke -o json | jq '.items | length')"
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
printf 'final_external_ec2_boundary=preserved\n'
printf 'final_continuous_processes=%d\n' "$continuous_processes"
printf 'final_existing_ec2_runtime=preserved\n'
printf 'eks_day15_final_integration=passed\n'
