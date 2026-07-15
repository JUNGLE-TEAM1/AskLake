#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_SOURCE="$ROOT_DIR/infra/eks/smoke/backend_s3_smoke.py"
CLUSTER_NAME="${ASKLAKE_EKS_CLUSTER_NAME:-}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
SERVICE_ACCOUNT="asklake-backend"
POD_NAME="asklake-backend-s3-smoke"
CONFIG_MAP_NAME="asklake-backend-s3-smoke-code"

if [[ -z "$CLUSTER_NAME" ]]; then
  echo "ASKLAKE_EKS_CLUSTER_NAME is required" >&2
  exit 1
fi
if [[ "${ASKLAKE_BACKEND_S3_SMOKE_CONFIRM:-}" != "run-backend-s3-boundary-smoke" ]]; then
  echo "set ASKLAKE_BACKEND_S3_SMOKE_CONFIRM=run-backend-s3-boundary-smoke" >&2
  exit 1
fi

for command in aws jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 1
  }
done
[[ -s "$SMOKE_SOURCE" ]] || { echo "missing Backend S3 smoke source" >&2; exit 1; }

expected_endpoint="$(aws eks describe-cluster \
  --name "$CLUSTER_NAME" \
  --region "$REGION" \
  --query 'cluster.endpoint' \
  --output text)"
current_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
[[ "$current_endpoint" == "$expected_endpoint" ]] || {
  echo "kubectl context does not match ASKLAKE_EKS_CLUSTER_NAME" >&2
  exit 1
}

deployment_json="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
image="$(jq -r '.spec.template.spec.containers[0].image' <<<"$deployment_json")"
[[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || {
  echo "FastAPI image is not pinned by immutable digest" >&2
  exit 1
}
jq -e \
  --arg service_account "$SERVICE_ACCOUNT" '
    .spec.template.spec.serviceAccountName == $service_account
    and (.spec.replicas // 0) == 2
    and (.status.readyReplicas // 0) == 2
    and (.status.unavailableReplicas // 0) == 0
    and .spec.template.spec.nodeSelector["kubernetes.io/arch"] == "amd64"
    and .spec.template.spec.nodeSelector["asklake.io/workload-class"] == "general"
  ' <<<"$deployment_json" >/dev/null

associations="$(aws eks list-pod-identity-associations \
  --cluster-name "$CLUSTER_NAME" \
  --region "$REGION" \
  --namespace "$NAMESPACE" \
  --service-account "$SERVICE_ACCOUNT" \
  --output json)"
[[ "$(jq '.associations | length' <<<"$associations")" == "1" ]] || {
  echo "Backend ServiceAccount must have exactly one Pod Identity association" >&2
  exit 1
}
association_id="$(jq -r '.associations[0].associationId' <<<"$associations")"
role_arn="$(aws eks describe-pod-identity-association \
  --cluster-name "$CLUSTER_NAME" \
  --region "$REGION" \
  --association-id "$association_id" \
  --query 'association.roleArn' \
  --output text)"
role_name="${role_arn##*/}"

policy_arns="$(aws iam list-attached-role-policies \
  --role-name "$role_name" \
  --query 'AttachedPolicies[].PolicyArn' \
  --output json)"
[[ "$(jq 'length' <<<"$policy_arns")" == "1" ]] || {
  echo "Backend Pod Identity role must have exactly one attached managed policy" >&2
  exit 1
}
inline_policy_count="$(aws iam list-role-policies \
  --role-name "$role_name" \
  --query 'length(PolicyNames)' \
  --output text)"
[[ "$inline_policy_count" == "0" ]] || {
  echo "Backend Pod Identity role must not have an additional inline policy" >&2
  exit 1
}

policy_arn="$(jq -r '.[0]' <<<"$policy_arns")"
policy_version="$(aws iam get-policy \
  --policy-arn "$policy_arn" \
  --query 'Policy.DefaultVersionId' \
  --output text)"
policy_json="$(aws iam get-policy-version \
  --policy-arn "$policy_arn" \
  --version-id "$policy_version" \
  --query 'PolicyVersion.Document' \
  --output json)"

jq -e '
  ([.Statement[].Sid] | sort) == ([
    "ListBackendOutputBucket",
    "ListBackendQueryResultBucket",
    "ListBackendRawBucket",
    "ListBackendWarehouseBucket",
    "ReadBackendObjects",
    "WriteBackendResultsAndEvidence"
  ] | sort)
  and all(.Statement[].Effect; . == "Allow")
  and all(.Statement[].Action[]; . != "*" and . != "s3:*")
  and all(.Statement[] | select(.Action == ["s3:ListBucket"]); (.Resource | length) == 1)
  and ([.Statement[] | select(.Sid == "WriteBackendResultsAndEvidence") | .Resource[]] | length) == 2
  and ([.Statement[] | select(.Sid == "ReadBackendObjects") | .Resource[]] | length) == 5
' <<<"$policy_json" >/dev/null

read_resources="$(jq -r '.Statement[] | select(.Sid == "ReadBackendObjects") | .Resource[]' <<<"$policy_json")"
write_resources="$(jq -r '.Statement[] | select(.Sid == "WriteBackendResultsAndEvidence") | .Resource[]' <<<"$policy_json")"
write_resource=""
while IFS= read -r candidate; do
  candidate_value="${candidate#arn:aws:s3:::}"
  candidate_bucket="${candidate_value%%/*}"
  if ! grep -Fxq "arn:aws:s3:::${candidate_bucket}/*" <<<"$read_resources"; then
    write_resource="$candidate"
    break
  fi
done <<<"$write_resources"
[[ -n "$write_resource" ]] || write_resource="$(head -n 1 <<<"$write_resources")"
readonly_resource="$(jq -r '
  ([.Statement[] | select(.Sid == "ReadBackendObjects") | .Resource[]]
    - [.Statement[] | select(.Sid == "WriteBackendResultsAndEvidence") | .Resource[]])[0]
' <<<"$policy_json")"

parse_object_arn() {
  local resource="$1"
  local value
  [[ "$resource" == arn:aws:s3:::*/* ]] || return 1
  value="${resource#arn:aws:s3:::}"
  PARSED_BUCKET="${value%%/*}"
  PARSED_PREFIX="${value#*/}"
  PARSED_PREFIX="${PARSED_PREFIX%/\*}"
  [[ -n "$PARSED_BUCKET" && -n "$PARSED_PREFIX" ]]
}

parse_object_arn "$write_resource" || { echo "invalid Backend write resource" >&2; exit 1; }
positive_bucket="$PARSED_BUCKET"
positive_prefix="$PARSED_PREFIX"
parse_object_arn "$readonly_resource" || { echo "invalid Backend read-only resource" >&2; exit 1; }
readonly_bucket="$PARSED_BUCKET"
readonly_prefix="$PARSED_PREFIX"

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
positive_key="${positive_prefix%/}/__asklake_smoke/backend-s3/${run_id}.txt"
readonly_key="${readonly_prefix%/}/__asklake_smoke/backend-s3/${run_id}.txt"
denied_prefix="__asklake_denied/backend-s3/${run_id}"
denied_key="${denied_prefix}/probe.txt"

cleanup() {
  kubectl delete pod "$POD_NAME" -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl delete configmap "$CONFIG_MAP_NAME" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  aws s3api delete-object --region "$REGION" --bucket "$positive_bucket" --key "$positive_key" >/dev/null 2>&1 || true
  aws s3api delete-object --region "$REGION" --bucket "$readonly_bucket" --key "$readonly_key" >/dev/null 2>&1 || true
  aws s3api delete-object --region "$REGION" --bucket "$positive_bucket" --key "$denied_key" >/dev/null 2>&1 || true
}
trap cleanup EXIT

kubectl delete pod "$POD_NAME" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null
kubectl delete configmap "$CONFIG_MAP_NAME" -n "$NAMESPACE" --ignore-not-found >/dev/null
printf 'asklake-backend-s3-denied-sentinel-v1' \
  | aws s3 cp - "s3://${positive_bucket}/${denied_key}" \
      --region "$REGION" \
      --only-show-errors
kubectl create configmap "$CONFIG_MAP_NAME" \
  -n "$NAMESPACE" \
  --from-file=backend_s3_smoke.py="$SMOKE_SOURCE" \
  --dry-run=client \
  -o yaml \
  | kubectl apply -f - >/dev/null

jq -n \
  --arg namespace "$NAMESPACE" \
  --arg pod "$POD_NAME" \
  --arg config_map "$CONFIG_MAP_NAME" \
  --arg image "$image" \
  --arg service_account "$SERVICE_ACCOUNT" \
  --arg region "$REGION" \
  --arg role_name "$role_name" \
  --arg positive_bucket "$positive_bucket" \
  --arg positive_key "$positive_key" \
  --arg readonly_bucket "$readonly_bucket" \
  --arg readonly_key "$readonly_key" \
  --arg denied_key "$denied_key" \
  --arg denied_prefix "$denied_prefix" '
  {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: $pod,
      namespace: $namespace,
      labels: {"app.kubernetes.io/name": "asklake-backend-s3-smoke"}
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: $service_account,
      nodeSelector: {
        "kubernetes.io/arch": "amd64",
        "asklake.io/workload-class": "general"
      },
      containers: [{
        name: "smoke",
        image: $image,
        imagePullPolicy: "IfNotPresent",
        command: ["python", "/opt/asklake/smoke/backend_s3_smoke.py"],
        env: [
          {name: "AWS_REGION", value: $region},
          {name: "EXPECTED_ROLE_NAME", value: $role_name},
          {name: "POSITIVE_BUCKET", value: $positive_bucket},
          {name: "POSITIVE_KEY", value: $positive_key},
          {name: "READONLY_BUCKET", value: $readonly_bucket},
          {name: "READONLY_KEY", value: $readonly_key},
          {name: "DENIED_READ_BUCKET", value: $positive_bucket},
          {name: "DENIED_READ_KEY", value: $denied_key},
          {name: "DENIED_LIST_PREFIX", value: $denied_prefix}
        ],
        resources: {
          requests: {cpu: "100m", memory: "128Mi"},
          limits: {cpu: "500m", memory: "512Mi"}
        },
        volumeMounts: [{
          name: "smoke-code",
          mountPath: "/opt/asklake/smoke",
          readOnly: true
        }]
      }],
      volumes: [{
        name: "smoke-code",
        configMap: {name: $config_map, defaultMode: 365}
      }]
    }
  }
' | kubectl apply -f - >/dev/null

deadline=$((SECONDS + 300))
phase=""
while (( SECONDS < deadline )); do
  phase="$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.phase}')"
  if [[ "$phase" == "Succeeded" || "$phase" == "Failed" ]]; then break; fi
  sleep 5
done

logs="$(kubectl logs "$POD_NAME" -n "$NAMESPACE" 2>/dev/null || true)"
if [[ "$phase" != "Succeeded" ]]; then
  echo "Backend S3 smoke Pod failed with phase ${phase:-unknown}" >&2
  printf '%s\n' "$logs" >&2
  exit 1
fi

for expected in \
  "pod_identity=expected_backend_role" \
  "positive_put_get_delete=true" \
  "readonly_prefix_put=denied" \
  "outside_prefix_get=denied" \
  "outside_prefix_list=denied" \
  "bucket_location=denied" \
  "backend_s3_boundary_smoke=passed"; do
  grep -Fxq "$expected" <<<"$logs" || {
    echo "Backend S3 smoke is missing expected result: $expected" >&2
    exit 1
  }
done

cleanup
trap - EXIT

printf '%s\n' \
  "pod_identity=expected_backend_role" \
  "positive_put_get_delete=true" \
  "readonly_prefix_put=denied" \
  "outside_prefix_get=denied" \
  "outside_prefix_list=denied" \
  "bucket_location=denied" \
  "temporary_resources_cleaned=true" \
  "backend_s3_boundary_smoke=passed"
