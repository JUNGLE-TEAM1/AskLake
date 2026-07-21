#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
FAKE_BIN="$TEMP_DIR/bin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
  echo "EKS Day 15 validation hardening test failed: $1" >&2
  exit 1
}

expect_pass() {
  "$@" >/dev/null 2>&1 || fail "expected success: $*"
}

expect_fail() {
  if "$@" >/dev/null 2>&1; then
    fail "expected failure: $*"
  fi
}

cat >"$FAKE_BIN/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
service="${1:-}"
operation="${2:-}"
case "$service:$operation" in
  eks:describe-cluster)
    echo https://fake.eks.local
    ;;
  ec2:describe-instances)
    [[ "${FAKE_EC2_SCENARIO:-healthy}" != "missing" ]] || exit 254
    if [[ "${FAKE_EC2_SCENARIO:-healthy}" == "stopped" ]]; then
      echo stopped
    else
      echo running
    fi
    ;;
  ec2:describe-instance-status)
    if [[ "${FAKE_EC2_SCENARIO:-healthy}" == "impaired" ]]; then
      printf 'impaired\tok\n'
    else
      printf 'ok\tok\n'
    fi
    ;;
  ecr:describe-images)
    echo 1
    ;;
  ecr:describe-repositories)
    echo IMMUTABLE
    ;;
  elbv2:describe-load-balancers)
    cat <<'JSON'
{"LoadBalancers":[{"DNSName":"fake-alb.local","LoadBalancerArn":"arn:fake:alb","State":{"Code":"active"},"Scheme":"internet-facing","Type":"application","IpAddressType":"ipv4","AvailabilityZones":[{},{}]}]}
JSON
    ;;
  elbv2:describe-listeners)
    cat <<'JSON'
{"Listeners":[{"ListenerArn":"arn:fake:listener","Protocol":"HTTP","Port":80}]}
JSON
    ;;
  elbv2:describe-rules)
    if [[ "${FAKE_ALB_SCENARIO:-healthy}" == "weighted_extra" ]]; then
      cat <<'JSON'
{"Rules":[{"Conditions":[{"Field":"path-pattern","Values":["/api","/api/*"]}],"Actions":[{"Type":"forward","ForwardConfig":{"TargetGroups":[{"TargetGroupArn":"arn:fake:backend","Weight":50},{"TargetGroupArn":"arn:fake:frontend","Weight":50}]}}]},{"Conditions":[{"Field":"path-pattern","Values":["/","/*"]}],"Actions":[{"Type":"forward","TargetGroupArn":"arn:fake:frontend"}]}]}
JSON
    else
      cat <<'JSON'
{"Rules":[{"Conditions":[{"Field":"path-pattern","Values":["/api","/api/*"]}],"Actions":[{"Type":"forward","TargetGroupArn":"arn:fake:backend"}]},{"Conditions":[{"Field":"path-pattern","Values":["/","/*"]}],"Actions":[{"Type":"forward","TargetGroupArn":"arn:fake:frontend"}]}]}
JSON
    fi
    ;;
  elbv2:describe-target-groups)
    if [[ "${FAKE_ALB_SCENARIO:-healthy}" == "duplicate_backend" ]]; then
      cat <<'JSON'
{"TargetGroups":[{"TargetGroupArn":"arn:fake:backend","TargetType":"ip","Protocol":"HTTP","HealthCheckPath":"/api/health"},{"TargetGroupArn":"arn:fake:backend-2","TargetType":"ip","Protocol":"HTTP","HealthCheckPath":"/api/health"}]}
JSON
    else
      cat <<'JSON'
{"TargetGroups":[{"TargetGroupArn":"arn:fake:backend","TargetType":"ip","Protocol":"HTTP","HealthCheckPath":"/api/health"},{"TargetGroupArn":"arn:fake:frontend","TargetType":"ip","Protocol":"HTTP","HealthCheckPath":"/"}]}
JSON
    fi
    ;;
  elbv2:describe-target-health)
    target=""
    while (($#)); do
      if [[ "$1" == "--target-group-arn" ]]; then target="$2"; break; fi
      shift
    done
    if [[ "$target" == "arn:fake:backend" ]]; then
      port=8080
      [[ "${FAKE_ALB_SCENARIO:-healthy}" != "wrong_port" ]] || port=9999
      printf '{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.1","Port":%d},"TargetHealth":{"State":"healthy"}},{"Target":{"Id":"10.0.0.2","Port":%d},"TargetHealth":{"State":"healthy"}}]}\n' "$port" "$port"
    else
      cat <<'JSON'
{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.3","Port":80},"TargetHealth":{"State":"healthy"}},{"Target":{"Id":"10.0.0.4","Port":80},"TargetHealth":{"State":"healthy"}}]}
JSON
    fi
    ;;
  s3api:list-object-versions)
    if [[ "${FAKE_S3_RESIDUE_SCENARIO:-clean}" == "residue" ]]; then
      cat <<'JSON'
{"Versions":[{"Key":"approved/smoke/old-object","VersionId":"v1"},{"Key":"business/object","VersionId":"v2"}],"DeleteMarkers":[{"Key":"approved/smoke/old-object","VersionId":"d1"}]}
JSON
    else
      cat <<'JSON'
{"Versions":[{"Key":"business/object","VersionId":"v2"}],"DeleteMarkers":[]}
JSON
    fi
    ;;
  *)
    echo "unexpected fake aws call: $*" >&2
    exit 2
    ;;
esac
EOF
chmod +x "$FAKE_BIN/aws"

cat >"$FAKE_BIN/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "config" ]]; then
  echo https://fake.eks.local
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "namespace" ]]; then
  exit 0
fi
if [[ "${1:-}" == "delete" ]]; then
  [[ "${FAKE_SECRET_ROLLBACK_SCENARIO:-healthy}" != "delete_failure" ]]
  exit
fi
if [[ "${1:-}" == "apply" ]]; then
  input="$(cat)"
  [[ -n "$input" ]]
  [[ "${FAKE_SECRET_ROLLBACK_SCENARIO:-healthy}" != "apply_failure" ]]
  exit
fi
if [[ "${1:-}" == "rollout" ]]; then
  if [[ "$*" == *" status "* && "${FAKE_SECRET_ROLLBACK_SCENARIO:-healthy}" == "rollout_failure" ]]; then
    exit 1
  fi
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then
  source_json="${FAKE_BACKEND_SOURCE_JSON:?}"
  case "${FAKE_SECRET_ROLLBACK_SCENARIO:-healthy}" in
    hash_mismatch)
      source_json="$(jq '.BOOTSTRAP_ADMIN_PASSWORD="wrong"' <<<"$source_json")"
      ;;
    missing_key)
      source_json="$(jq 'del(.TRINO_AUTH_PASSWORD)' <<<"$source_json")"
      ;;
    extra_key)
      source_json="$(jq '.UNAPPROVED="fixture"' <<<"$source_json")"
      ;;
  esac
  jq -cn --argjson source "$source_json" '{type:"Opaque",metadata:{ownerReferences:[]},data:($source|with_entries(.value|=@base64))}'
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "deployment" ]]; then
  cat <<'JSON'
{"spec":{"replicas":2,"template":{"spec":{"containers":[{"envFrom":[{"secretRef":{"name":"asklake-backend-runtime"}}]}]}}},"status":{"readyReplicas":2,"updatedReplicas":2,"availableReplicas":2,"unavailableReplicas":0}}
JSON
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "ingress" ]]; then
  cat <<'JSON'
{"items":[{"metadata":{"name":"asklake-backend"},"status":{"loadBalancer":{"ingress":[{"hostname":"fake-alb.local"}]}}},{"metadata":{"name":"asklake-frontend"},"status":{"loadBalancer":{"ingress":[{"hostname":"fake-alb.local"}]}}}]}
JSON
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "endpointslice" ]]; then
  if [[ "$*" == *"kubernetes.io/service-name=fastapi"* ]]; then
    cat <<'JSON'
{"items":[{"endpoints":[{"conditions":{"ready":true},"addresses":["10.0.0.1"]},{"conditions":{"ready":true},"addresses":["10.0.0.2"]}]}]}
JSON
  else
    cat <<'JSON'
{"items":[{"endpoints":[{"conditions":{"ready":true},"addresses":["10.0.0.3"]},{"conditions":{"ready":true},"addresses":["10.0.0.4"]}]}]}
JSON
  fi
  exit 0
fi
echo "unexpected fake kubectl call: $*" >&2
exit 2
EOF
chmod +x "$FAKE_BIN/kubectl"

cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
url="${!#}"
while (($#)); do
  if [[ "$1" == "-o" ]]; then output="$2"; shift 2; continue; fi
  shift
done
if [[ "$url" == */api/health ]]; then
  printf '{"database":{"ok":true}}' >"$output"
else
  printf 'frontend' >"$output"
fi
printf '200'
EOF
chmod +x "$FAKE_BIN/curl"

export PATH="$FAKE_BIN:$PATH"
export ASKLAKE_EXPECTED_EC2_INSTANCE_ID="i-0123456789abcdef0"
export FAKE_EC2_SCENARIO=healthy
expect_pass bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh"
export FAKE_EC2_SCENARIO=stopped
expect_fail bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh"
export FAKE_EC2_SCENARIO=impaired
expect_fail bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh"
export FAKE_EC2_SCENARIO=missing
expect_fail bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh"
unset FAKE_EC2_SCENARIO

full_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
digest="sha256:$(printf 'a%.0s' {1..64})"
image="000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/asklake/dev/backend@$digest"
receipt="$TEMP_DIR/valid.image-receipt.json"
jq \
  --arg revision "$full_commit" \
  --arg image "$image" \
  --arg digest "$digest" '
    .gitRevision=$revision
    | .images.backend=$image
    | .images.aiGateway=(.images.aiGateway | sub("sha256:[a-f0-9]{64}$"; $digest))
    | .images.frontend=(.images.frontend | sub("sha256:[a-f0-9]{64}$"; $digest))
    | .images.airflow=(.images.airflow | sub("sha256:[a-f0-9]{64}$"; $digest))
    | .images.sparkRuntime=(.images.sparkRuntime | sub("sha256:[a-f0-9]{64}$"; $digest))
    | .images.trino=(.images.trino | sub("sha256:[a-f0-9]{64}$"; $digest))
    | .createdAt="2026-07-16T00:00:00.000Z"
  ' "$ROOT_DIR/infra/eks/delivery/image-receipt.example.json" >"$receipt"

expect_pass bash "$ROOT_DIR/scripts/verify-eks-backend-image-provenance.sh" \
  "$receipt" "$image" "$full_commit"
expect_fail bash "$ROOT_DIR/scripts/verify-eks-backend-image-provenance.sh" \
  "$TEMP_DIR/missing.json" "$image" "$full_commit"
expect_fail bash "$ROOT_DIR/scripts/verify-eks-backend-image-provenance.sh" \
  "$receipt" "$image" "${full_commit:0:7}"
expect_fail bash "$ROOT_DIR/scripts/verify-eks-backend-image-provenance.sh" \
  "$receipt" "${image%$digest}sha256:$(printf 'b%.0s' {1..64})" "$full_commit"

wrong_platform="$TEMP_DIR/wrong-platform.image-receipt.json"
jq '.platform="linux/arm64"' "$receipt" >"$wrong_platform"
expect_fail bash "$ROOT_DIR/scripts/verify-eks-backend-image-provenance.sh" \
  "$wrong_platform" "$image" "$full_commit"

for signature in \
  kafka_continuous_stream.py \
  manage-kafka-continuous.mjs \
  kafka_continuous_maintenance.py \
  manage-kafka-continuous-maintenance.mjs; do
  grep -Fq "$signature" "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" \
    || fail "missing Continuous process signature: $signature"
done

export ASKLAKE_EKS_CLUSTER_NAME=fake-cluster
export FAKE_ALB_SCENARIO=healthy
expect_pass bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady
export FAKE_ALB_SCENARIO=duplicate_backend
expect_fail bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady
export FAKE_ALB_SCENARIO=weighted_extra
expect_fail bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady
export FAKE_ALB_SCENARIO=wrong_port
expect_fail bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady
unset FAKE_ALB_SCENARIO

source "$ROOT_DIR/scripts/lib/audit-eks-s3-smoke-residue.sh"
export FAKE_S3_RESIDUE_SCENARIO=clean
expect_pass audit_asklake_s3_smoke_residue ap-northeast-2 <<'EOF'
fake-bucket	approved/smoke/
EOF
export FAKE_S3_RESIDUE_SCENARIO=residue
expect_fail audit_asklake_s3_smoke_residue ap-northeast-2 <<'EOF'
fake-bucket	approved/smoke/
EOF
unset FAKE_S3_RESIDUE_SCENARIO

source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
source "$ROOT_DIR/scripts/lib/eks-backend-secret-rollback.sh"
source "$ROOT_DIR/scripts/lib/eks-backend-runtime-profile.sh"
expected_backend_keys="$(asklake_backend_runtime_profile "$ROOT_DIR" bounded)"
source_json="$(jq -cn --argjson keys "$expected_backend_keys" 'reduce $keys[] as $key ({}; .[$key] = ("fixture-" + ($key|ascii_downcase)))')"
export FAKE_BACKEND_SOURCE_JSON="$source_json"
expect_pass asklake_backend_runtime_hash "$source_json" "$expected_backend_keys"
expect_fail asklake_backend_runtime_hash "$(jq 'del(.TRINO_AUTH_PASSWORD)' <<<"$source_json")" "$expected_backend_keys"
export FAKE_SECRET_ROLLBACK_SCENARIO=healthy
expect_pass asklake_cleanup_backend_secret_stage asklake-backend-runtime-stage asklake-dev
expect_pass asklake_restore_backend_manual_secret \
  "$ROOT_DIR" asklake-backend-runtime asklake-dev "$source_json" "$expected_backend_keys"
export FAKE_SECRET_ROLLBACK_SCENARIO=delete_failure
expect_fail asklake_cleanup_backend_secret_stage asklake-backend-runtime-stage asklake-dev
expect_fail asklake_restore_backend_manual_secret \
  "$ROOT_DIR" asklake-backend-runtime asklake-dev "$source_json" "$expected_backend_keys"
export FAKE_SECRET_ROLLBACK_SCENARIO=apply_failure
expect_fail asklake_restore_backend_manual_secret \
  "$ROOT_DIR" asklake-backend-runtime asklake-dev "$source_json" "$expected_backend_keys"
export FAKE_SECRET_ROLLBACK_SCENARIO=hash_mismatch
expect_fail asklake_restore_backend_manual_secret \
  "$ROOT_DIR" asklake-backend-runtime asklake-dev "$source_json" "$expected_backend_keys"
export FAKE_SECRET_ROLLBACK_SCENARIO=missing_key
expect_fail asklake_restore_backend_manual_secret \
  "$ROOT_DIR" asklake-backend-runtime asklake-dev "$source_json" "$expected_backend_keys"
export FAKE_SECRET_ROLLBACK_SCENARIO=extra_key
expect_fail asklake_restore_backend_manual_secret \
  "$ROOT_DIR" asklake-backend-runtime asklake-dev "$source_json" "$expected_backend_keys"
export FAKE_SECRET_ROLLBACK_SCENARIO=rollout_failure
expect_fail asklake_restore_backend_manual_secret \
  "$ROOT_DIR" asklake-backend-runtime asklake-dev "$source_json" "$expected_backend_keys"
source_missing_key="$(jq 'del(.TRINO_AUTH_PASSWORD)' <<<"$source_json")"
expect_fail asklake_restore_backend_manual_secret \
  "$ROOT_DIR" asklake-backend-runtime asklake-dev "$source_missing_key" "$expected_backend_keys"
unset FAKE_SECRET_ROLLBACK_SCENARIO FAKE_BACKEND_SOURCE_JSON

grep -Fq 'asklake_backend_runtime_profile "$ROOT_DIR" bounded' \
  "$ROOT_DIR/scripts/migrate-eks-backend-runtime-secret.sh" || \
  fail "Backend handover does not use the bounded runtime profile"
grep -Fq 'asklake_backend_runtime_hash "$stage_decoded" "$EXPECTED_KEYS"' \
  "$ROOT_DIR/scripts/migrate-eks-backend-runtime-secret.sh" || \
  fail "Backend handover does not hash the complete staged profile"
if grep -Eq '\{BOOTSTRAP_ADMIN_PASSWORD,DATABASE_URL\}|\["BOOTSTRAP_ADMIN_PASSWORD", "DATABASE_URL"\]' \
  "$ROOT_DIR/scripts/migrate-eks-backend-runtime-secret.sh" \
  "$ROOT_DIR/scripts/lib/eks-backend-secret-rollback.sh"; then
  fail "Backend handover or rollback still contains a two-key recovery path"
fi

for runner in \
  "$ROOT_DIR/scripts/verify-eks-day15-final-integration.sh" \
  "$ROOT_DIR/scripts/run-eks-day15-backend-rollout-smoke.sh"; do
  grep -Fq 'verify-eks-backend-image-provenance.sh' "$runner" \
    || fail "runner does not require the formal Backend receipt"
  grep -Fq 'verify-eks-external-ec2-instance.sh' "$runner" \
    || fail "runner does not require the exact EC2 instance"
  if grep -Fq 'Name=instance-state-name,Values=running' "$runner"; then
    fail "runner still accepts an unrelated running EC2 instance"
  fi
  if grep -Fq 'expected_tag=' "$runner"; then
    fail "runner still treats an ECR tag as image provenance"
  fi
done
if grep -Fq "printf '000'" "$ROOT_DIR/scripts/run-eks-day15-backend-rollout-smoke.sh"; then
  fail "rollout monitor can still concatenate curl output into 000000"
fi

echo "EKS Day 15 validation hardening tests passed."
