#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
SMOKE_SOURCE="$ROOT_DIR/infra/eks/smoke/backend_s3_smoke.py"
CLUSTER_NAME="${ASKLAKE_EKS_CLUSTER_NAME:-}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
SERVICE_ACCOUNT="asklake-backend"
RUN_TOKEN="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
K8S_RUN_TOKEN="$(date -u +%s)-$$-${RANDOM}"
POD_NAME="asklake-backend-s3-${K8S_RUN_TOKEN}"
CONFIG_MAP_NAME="asklake-backend-s3-${K8S_RUN_TOKEN}"
CLEANUP_TARGETS=""

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

verify_asklake_eks_context

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

parse_bucket_arn() {
  local resource="$1"
  [[ "$resource" == arn:aws:s3:::* && "$resource" != */* ]] || return 1
  PARSED_BUCKET="${resource#arn:aws:s3:::}"
  [[ -n "$PARSED_BUCKET" ]]
}

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

statement_bucket() {
  local sid="$1"
  local resource
  resource="$(jq -r --arg sid "$sid" '[.Statement[] | select(.Sid == $sid)][0].Resource[0]' <<<"$policy_json")"
  parse_bucket_arn "$resource"
  printf '%s' "$PARSED_BUCKET"
}

statement_prefix() {
  local sid="$1"
  jq -r --arg sid "$sid" '[.Statement[] | select(.Sid == $sid)][0].Condition.StringLike["s3:prefix"][0]' <<<"$policy_json"
}

object_boundary() {
  local suffix="$1"
  local resource
  resource="$(jq -r --arg suffix "$suffix" '[.Statement[] | select(.Sid == "WriteBackendResultsAndEvidence") | .Resource[] | select(endswith($suffix))][0]' <<<"$policy_json")"
  parse_object_arn "$resource"
}

raw_bucket="$(statement_bucket ListBackendRawBucket)"
output_bucket="$(statement_bucket ListBackendOutputBucket)"
warehouse_bucket="$(statement_bucket ListBackendWarehouseBucket)"
warehouse_prefix="$(statement_prefix ListBackendWarehouseBucket)"
query_bucket="$(statement_bucket ListBackendQueryResultBucket)"
query_prefix="$(statement_prefix ListBackendQueryResultBucket)"
object_boundary "/evidence/*"; evidence_bucket="$PARSED_BUCKET"; evidence_prefix="$PARSED_PREFIX"
object_boundary "/query-results/*"; query_write_bucket="$PARSED_BUCKET"; query_write_prefix="$PARSED_PREFIX"
[[ "$query_bucket" == "$query_write_bucket" && "$query_prefix" == "$query_write_prefix" ]] || {
  echo "Backend query result list/object boundaries do not match" >&2
  exit 1
}

raw_key="__asklake_smoke/backend-read-raw/${RUN_TOKEN}.txt"
output_key="__asklake_smoke/backend-read-output/${RUN_TOKEN}.txt"
warehouse_key="${warehouse_prefix%/}/__asklake_smoke/backend-read/${RUN_TOKEN}.txt"
query_key="${query_prefix%/}/__asklake_smoke/backend-write/${RUN_TOKEN}.txt"
evidence_key="${evidence_prefix%/}/__asklake_smoke/backend-write/${RUN_TOKEN}.txt"
warehouse_denied_prefix="${warehouse_prefix%/}-denied/__asklake_smoke/${RUN_TOKEN}"
warehouse_denied_key="${warehouse_denied_prefix}/probe.txt"
query_denied_prefix="${query_prefix%/}-denied/__asklake_smoke/${RUN_TOKEN}"
query_denied_key="${query_denied_prefix}/probe.txt"

append_cleanup_target() {
  CLEANUP_TARGETS+="$1"$'\t'"$2"$'\n'
}

for target in \
  "$raw_bucket"$'\t'"$raw_key" \
  "$output_bucket"$'\t'"$output_key" \
  "$warehouse_bucket"$'\t'"$warehouse_key" \
  "$query_bucket"$'\t'"$query_key" \
  "$evidence_bucket"$'\t'"$evidence_key" \
  "$warehouse_bucket"$'\t'"$warehouse_denied_key" \
  "$query_bucket"$'\t'"$query_denied_key"; do
  append_cleanup_target "${target%%$'\t'*}" "${target#*$'\t'}"
done

purge_exact_key_versions() {
  local bucket="$1"
  local key="$2"
  local versions_json objects request remaining
  for _ in 1 2 3; do
    versions_json="$(aws s3api list-object-versions \
      --region "$REGION" \
      --bucket "$bucket" \
      --prefix "$key" \
      --output json)"
    objects="$(jq -c --arg key "$key" '[((.Versions // []) + (.DeleteMarkers // []))[] | select(.Key == $key) | {Key,VersionId}]' <<<"$versions_json")"
    remaining="$(jq 'length' <<<"$objects")"
    if [[ "$remaining" -eq 0 ]]; then return 0; fi
    request="$(jq -cn --argjson objects "$objects" '{Objects:$objects,Quiet:true}')"
    printf '%s' "$request" \
      | aws s3api delete-objects \
          --region "$REGION" \
          --bucket "$bucket" \
          --delete file:///dev/stdin >/dev/null
  done
  versions_json="$(aws s3api list-object-versions --region "$REGION" --bucket "$bucket" --prefix "$key" --output json)"
  [[ "$(jq --arg key "$key" '[((.Versions // []) + (.DeleteMarkers // []))[] | select(.Key == $key)] | length' <<<"$versions_json")" -eq 0 ]]
}

cleanup_resources() {
  local cleanup_failed=false
  kubectl delete pod "$POD_NAME" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || cleanup_failed=true
  kubectl delete configmap "$CONFIG_MAP_NAME" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=true
  while IFS=$'\t' read -r bucket key; do
    [[ -n "$bucket" && -n "$key" ]] || continue
    purge_exact_key_versions "$bucket" "$key" || cleanup_failed=true
  done <<<"$CLEANUP_TARGETS"
  [[ "$cleanup_failed" == "false" ]]
}

cleanup_on_exit() {
  local status=$?
  trap - EXIT
  if ! cleanup_resources; then
    echo "Backend S3 smoke cleanup failed" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT

create_operator_sentinel() {
  local bucket="$1"
  local key="$2"
  printf 'asklake-backend-s3-smoke-v2' \
    | aws s3 cp - "s3://${bucket}/${key}" --region "$REGION" --only-show-errors
}

create_operator_sentinel "$raw_bucket" "$raw_key"
create_operator_sentinel "$output_bucket" "$output_key"
create_operator_sentinel "$warehouse_bucket" "$warehouse_key"
create_operator_sentinel "$warehouse_bucket" "$warehouse_denied_key"
create_operator_sentinel "$query_bucket" "$query_denied_key"

contract_json="$(jq -cn \
  --arg raw_bucket "$raw_bucket" --arg raw_key "$raw_key" \
  --arg output_bucket "$output_bucket" --arg output_key "$output_key" \
  --arg warehouse_bucket "$warehouse_bucket" --arg warehouse_key "$warehouse_key" \
  --arg query_bucket "$query_bucket" --arg query_key "$query_key" \
  --arg evidence_bucket "$evidence_bucket" --arg evidence_key "$evidence_key" \
  --arg warehouse_denied_key "$warehouse_denied_key" --arg warehouse_denied_prefix "$warehouse_denied_prefix" \
  --arg query_denied_key "$query_denied_key" --arg query_denied_prefix "$query_denied_prefix" '
  {
    readOnlyBoundaries: [
      {label:"raw",bucket:$raw_bucket,key:$raw_key},
      {label:"output",bucket:$output_bucket,key:$output_key},
      {label:"warehouse",bucket:$warehouse_bucket,key:$warehouse_key}
    ],
    writeBoundaries: [
      {label:"query_result",bucket:$query_bucket,key:$query_key},
      {label:"evidence",bucket:$evidence_bucket,key:$evidence_key}
    ],
    deniedBoundaries: [
      {label:"warehouse_outside_prefix",bucket:$warehouse_bucket,key:$warehouse_denied_key,prefix:$warehouse_denied_prefix},
      {label:"query_result_outside_prefix",bucket:$query_bucket,key:$query_denied_key,prefix:$query_denied_prefix}
    ],
    metadataProbeBucket:$query_bucket
  }
')"

kubectl create configmap "$CONFIG_MAP_NAME" \
  -n "$NAMESPACE" \
  --from-file=backend_s3_smoke.py="$SMOKE_SOURCE" \
  --dry-run=client \
  -o json \
  | jq '.metadata.labels = {"app.kubernetes.io/name":"asklake-backend-s3-smoke"}' \
  | kubectl apply -f - >/dev/null

jq -n \
  --arg namespace "$NAMESPACE" \
  --arg pod "$POD_NAME" \
  --arg config_map "$CONFIG_MAP_NAME" \
  --arg image "$image" \
  --arg service_account "$SERVICE_ACCOUNT" \
  --arg region "$REGION" \
  --arg role_name "$role_name" \
  --arg contract "$contract_json" '
  {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: $pod,
      namespace: $namespace,
      labels: {"app.kubernetes.io/name":"asklake-backend-s3-smoke"}
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: $service_account,
      nodeSelector: {
        "kubernetes.io/arch":"amd64",
        "asklake.io/workload-class":"general"
      },
      containers: [{
        name:"smoke",
        image:$image,
        imagePullPolicy:"IfNotPresent",
        command:["python","/opt/asklake/smoke/backend_s3_smoke.py"],
        env:[
          {name:"AWS_REGION",value:$region},
          {name:"EXPECTED_ROLE_NAME",value:$role_name},
          {name:"SMOKE_CONTRACT_JSON",value:$contract}
        ],
        resources:{requests:{cpu:"100m",memory:"128Mi"},limits:{cpu:"500m",memory:"512Mi"}},
        volumeMounts:[{name:"smoke-code",mountPath:"/opt/asklake/smoke",readOnly:true}]
      }],
      volumes:[{name:"smoke-code",configMap:{name:$config_map,defaultMode:365}}]
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
  "raw_get=true" "raw_put=denied" \
  "output_get=true" "output_put=denied" \
  "warehouse_get=true" "warehouse_put=denied" \
  "query_result_put_get_delete=true" \
  "evidence_put_get_delete=true" \
  "warehouse_outside_prefix_get=denied" \
  "warehouse_outside_prefix_list=denied" \
  "query_result_outside_prefix_get=denied" \
  "query_result_outside_prefix_list=denied" \
  "bucket_location=denied" \
  "backend_s3_boundary_smoke=passed"; do
  grep -Fxq "$expected" <<<"$logs" || {
    echo "Backend S3 smoke is missing expected result: $expected" >&2
    exit 1
  }
done

trap - EXIT
cleanup_resources

printf '%s\n' \
  "pod_identity=expected_backend_role" \
  "read_only_boundaries=3/3" \
  "write_boundaries=2/2" \
  "outside_prefix_boundaries=2/2" \
  "bucket_location=denied" \
  "temporary_resources_cleaned=true" \
  "backend_s3_boundary_smoke=passed"
