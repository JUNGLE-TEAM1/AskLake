#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
source "$ROOT_DIR/scripts/lib/audit-eks-s3-smoke-residue.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
RECEIPT="${ASKLAKE_IMAGE_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev-8d4414df.image-receipt.json}"
STATE="${ASKLAKE_TERRAFORM_STATE:-$ROOT_DIR/infra/eks/terraform/terraform.tfstate}"
SMOKE_SOURCE="$ROOT_DIR/infra/eks/smoke/trino_data_plane_smoke.py"
RUN_TOKEN="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
K8S_TOKEN="$(date -u +%s)-$$-${RANDOM}"
JOB="asklake-trino-data-plane-$K8S_TOKEN"
CONFIG_MAP="$JOB"
SERVICE="$JOB"
CLEANUP_TARGETS=""

fail() {
  echo "$1" >&2
  exit 1
}

for command in aws git jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ "${ASKLAKE_TRINO_DATA_PLANE_SMOKE_CONFIRM:-}" == "run-trino-data-plane-smoke" ]] || \
  fail "set ASKLAKE_TRINO_DATA_PLANE_SMOKE_CONFIRM=run-trino-data-plane-smoke"
[[ -s "$RECEIPT" && -s "$STATE" && -s "$SMOKE_SOURCE" ]] || fail "image receipt, Terraform state, or Trino smoke source is missing"
git -C "$ROOT_DIR" check-ignore -q -- "$RECEIPT" || fail "image receipt must be ignored by Git"
git -C "$ROOT_DIR" check-ignore -q -- "$STATE" || fail "Terraform state must be ignored by Git"
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$RECEIPT" >/dev/null
verify_asklake_eks_context
bash "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-delivery.sh" >/dev/null

service_account="asklake-trino"
kubectl get serviceaccount "$service_account" -n "$NAMESPACE" -o json | jq -e '
  .automountServiceAccountToken == false
' >/dev/null || fail "Trino ServiceAccount must disable the application Kubernetes API token"

associations="$(aws eks list-pod-identity-associations --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --region "$REGION" --namespace "$NAMESPACE" --service-account "$service_account" --output json)"
[[ "$(jq '.associations|length' <<<"$associations")" -eq 1 ]] || fail "Trino must have exactly one Pod Identity association"
association_id="$(jq -r '.associations[0].associationId' <<<"$associations")"
role_arn="$(aws eks describe-pod-identity-association --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --region "$REGION" --association-id "$association_id" --query 'association.roleArn' --output text)"
[[ "$role_arn" == "$(jq -r '.outputs.workload_identity_contract.value.roles.trino' "$STATE")" ]] || \
  fail "Trino Pod Identity role differs from Terraform state"
role_name="${role_arn##*/}"
policy_arns="$(aws iam list-attached-role-policies --role-name "$role_name" --query 'AttachedPolicies[].PolicyArn' --output json)"
[[ "$(jq 'length' <<<"$policy_arns")" -eq 1 ]] || fail "Trino role must have exactly one attached policy"
[[ "$(aws iam list-role-policies --role-name "$role_name" --query 'length(PolicyNames)' --output text)" == "0" ]] || \
  fail "Trino role must not have inline policies"
policy_arn="$(jq -r '.[0]' <<<"$policy_arns")"
policy_version="$(aws iam get-policy --policy-arn "$policy_arn" --query 'Policy.DefaultVersionId' --output text)"
policy_json="$(aws iam get-policy-version --policy-arn "$policy_arn" --version-id "$policy_version" \
  --query 'PolicyVersion.Document' --output json)"
jq -e '
  ([.Statement[].Sid]|sort) == (["ListTrinoQueryResultBucket","ListTrinoWarehouseBucket","ReadWriteTrinoObjects"]|sort)
  and all(.Statement[].Effect; . == "Allow")
  and all(.Statement[].Action[]; . != "*" and . != "s3:*")
  and all(.Statement[]|select(.Action == ["s3:ListBucket"]); (.Resource|length) == 1)
  and ([.Statement[]|select(.Sid=="ReadWriteTrinoObjects")|.Resource[]]|length) == 2
' <<<"$policy_json" >/dev/null || fail "Trino IAM policy exceeds or differs from the approved boundary"

parse_bucket() {
  local sid="$1" resource
  resource="$(jq -r --arg sid "$sid" '[.Statement[]|select(.Sid==$sid)][0].Resource[0]' <<<"$policy_json")"
  [[ "$resource" == arn:aws:s3:::* && "$resource" != */* ]] || fail "invalid Trino bucket ARN"
  PARSED_BUCKET="${resource#arn:aws:s3:::}"
  PARSED_PREFIX="$(jq -r --arg sid "$sid" '[.Statement[]|select(.Sid==$sid)][0].Condition.StringLike["s3:prefix"][0]' <<<"$policy_json")"
  [[ -n "$PARSED_BUCKET" && -n "$PARSED_PREFIX" ]] || fail "invalid Trino bucket prefix"
}
parse_bucket ListTrinoWarehouseBucket; warehouse_bucket="$PARSED_BUCKET"; warehouse_prefix="$PARSED_PREFIX"
parse_bucket ListTrinoQueryResultBucket; query_bucket="$PARSED_BUCKET"; query_prefix="$PARSED_PREFIX"
jq -e --arg warehouseBucket "$warehouse_bucket" --arg warehousePrefix "$warehouse_prefix" \
  --arg queryBucket "$query_bucket" --arg queryPrefix "$query_prefix" '
    .outputs.storage_contract.value.buckets.warehouse == $warehouseBucket
    and .outputs.storage_contract.value.prefixes.warehouse == $warehousePrefix
    and .outputs.storage_contract.value.buckets.query_results == $queryBucket
    and .outputs.storage_contract.value.prefixes.query_results == $queryPrefix
  ' "$STATE" >/dev/null || fail "Trino IAM S3 boundary differs from Terraform state"

warehouse_key="${warehouse_prefix%/}/__asklake_smoke/trino-data-plane/${RUN_TOKEN}.txt"
query_key="${query_prefix%/}/__asklake_smoke/trino-data-plane/${RUN_TOKEN}.txt"
warehouse_denied_prefix="${warehouse_prefix%/}-denied/__asklake_smoke/trino-data-plane/$RUN_TOKEN"
query_denied_prefix="${query_prefix%/}-denied/__asklake_smoke/trino-data-plane/$RUN_TOKEN"
CLEANUP_TARGETS="$warehouse_bucket"$'\t'"$warehouse_key"$'\n'"$query_bucket"$'\t'"$query_key"$'\n'

purge_exact_key_versions() {
  local bucket="$1" key="$2" versions objects request
  for _ in 1 2 3; do
    versions="$(aws s3api list-object-versions --region "$REGION" --bucket "$bucket" --prefix "$key" --output json)"
    objects="$(jq -c --arg key "$key" '[((.Versions//[])+(.DeleteMarkers//[]))[]|select(.Key==$key)|{Key,VersionId}]' <<<"$versions")"
    [[ "$(jq 'length' <<<"$objects")" -eq 0 ]] && return 0
    request="$(jq -cn --argjson objects "$objects" '{Objects:$objects,Quiet:true}')"
    printf '%s' "$request" | aws s3api delete-objects --region "$REGION" --bucket "$bucket" --delete file:///dev/stdin >/dev/null
  done
  return 1
}

audit_residue() {
  audit_asklake_s3_smoke_residue "$REGION" <<EOF
$warehouse_bucket	${warehouse_prefix%/}/__asklake_smoke/trino-data-plane/
$query_bucket	${query_prefix%/}/__asklake_smoke/trino-data-plane/
EOF
}

cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT
  kubectl delete job "$JOB" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || cleanup_failed=1
  kubectl delete configmap "$CONFIG_MAP" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
  kubectl delete service "$SERVICE" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
  while IFS=$'\t' read -r bucket key; do
    [[ -n "$bucket" && -n "$key" ]] || continue
    purge_exact_key_versions "$bucket" "$key" || cleanup_failed=1
  done <<<"$CLEANUP_TARGETS"
  audit_residue >/dev/null || cleanup_failed=1
  [[ "$cleanup_failed" -eq 0 ]] || status=1
  exit "$status"
}
trap cleanup EXIT

audit_residue >/dev/null
kubectl create service clusterip "$SERVICE" -n "$NAMESPACE" --tcp=8443:8443 >/dev/null
kubectl create configmap "$CONFIG_MAP" -n "$NAMESPACE" --from-file=trino_data_plane_smoke.py="$SMOKE_SOURCE" >/dev/null
image="$(jq -r '.images.backend' "$RECEIPT")"

manifest="$(jq -n \
  --arg namespace "$NAMESPACE" --arg job "$JOB" --arg image "$image" --arg service "$SERVICE" \
  --arg role "$role_arn" --arg region "$REGION" \
  --arg warehouseBucket "$warehouse_bucket" --arg warehouseKey "$warehouse_key" \
  --arg warehouseDenied "$warehouse_denied_prefix" --arg queryBucket "$query_bucket" \
  --arg queryKey "$query_key" --arg queryDenied "$query_denied_prefix" '
  {
    apiVersion:"batch/v1",kind:"Job",metadata:{name:$job,namespace:$namespace,labels:{"asklake.io/smoke":"trino-data-plane"}},
    spec:{backoffLimit:0,ttlSecondsAfterFinished:600,template:{metadata:{labels:{"asklake.io/smoke":"trino-data-plane"}},spec:{
      restartPolicy:"Never",serviceAccountName:"asklake-trino",automountServiceAccountToken:false,
      nodeSelector:{"kubernetes.io/arch":"amd64","asklake.io/workload-class":"general"},
      containers:[{name:"smoke",image:$image,imagePullPolicy:"IfNotPresent",command:["python","/opt/asklake-smoke/trino_data_plane_smoke.py"],
        env:[
          {name:"AWS_REGION",value:$region},{name:"EXPECTED_ROLE_ARN",value:$role},
          {name:"WAREHOUSE_BUCKET",value:$warehouseBucket},{name:"WAREHOUSE_KEY",value:$warehouseKey},
          {name:"WAREHOUSE_DENIED_PREFIX",value:$warehouseDenied},{name:"QUERY_BUCKET",value:$queryBucket},
          {name:"QUERY_KEY",value:$queryKey},{name:"QUERY_DENIED_PREFIX",value:$queryDenied},
          {name:"SMOKE_SERVICE_DNS",value:($service+"."+$namespace+".svc")},
          {name:"TRINO_ICEBERG_JDBC_URL",valueFrom:{secretKeyRef:{name:"asklake-trino-runtime",key:"TRINO_ICEBERG_JDBC_URL"}}},
          {name:"TRINO_ICEBERG_JDBC_USER",valueFrom:{secretKeyRef:{name:"asklake-trino-runtime",key:"TRINO_ICEBERG_JDBC_USER"}}},
          {name:"TRINO_ICEBERG_JDBC_PASSWORD",valueFrom:{secretKeyRef:{name:"asklake-trino-runtime",key:"TRINO_ICEBERG_JDBC_PASSWORD"}}}
        ],volumeMounts:[{name:"source",mountPath:"/opt/asklake-smoke",readOnly:true}],
        resources:{requests:{cpu:"100m",memory:"256Mi"},limits:{cpu:"500m",memory:"512Mi"}}}],
      volumes:[{name:"source",configMap:{name:$job,defaultMode:292}}]
    }}}}
')"
printf '%s' "$manifest" | kubectl apply --dry-run=server -f - >/dev/null
printf '%s' "$manifest" | kubectl apply -f - >/dev/null
kubectl wait --for=condition=Complete "job/$JOB" -n "$NAMESPACE" --timeout=5m >/dev/null || {
  kubectl logs "job/$JOB" -n "$NAMESPACE" --tail=1 2>/dev/null | jq -e '.status=="failed" and (.reason|type=="string")' >/dev/null || true
  fail "Trino data-plane smoke Job failed"
}
result="$(kubectl logs "job/$JOB" -n "$NAMESPACE" --tail=1)"
jq -e '. == {status:"passed",identity:true,rds:true,s3:true,dns:true,negativeBoundary:true}' <<<"$result" >/dev/null || \
  fail "Trino data-plane smoke result is invalid"

status=0
answer="$(kubectl auth can-i get secrets -n "$NAMESPACE" --as="system:serviceaccount:$NAMESPACE:asklake-trino" 2>/dev/null)" || status=$?
[[ "$status" -eq 1 && "$answer" == "no" ]] || fail "Trino ServiceAccount Secret read denial is invalid"

echo "Trino data-plane smoke passed: identity=true rds=true s3=true dns=true negative=true"
