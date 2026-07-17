#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

MODE="${1:---preflight}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
STATE="${ASKLAKE_TERRAFORM_STATE:-$ROOT_DIR/infra/eks/terraform/terraform.tfstate}"
HANDOFF="${ASKLAKE_DAY16_HANDOFF:-$ROOT_DIR/infra/eks/delivery/dev.day16-a.handoff.json}"
TRINO_VALUES="${ASKLAKE_DAY16_TRINO_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.day16-a.private-values.json}"
RUNTIME_VALUES="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.runtime-config-values.json}"
TEMP_DIR="$(mktemp -d)"

WEB_CURRENT="$TEMP_DIR/web-current.json"
WEB_CANDIDATE="$TEMP_DIR/web-candidate.json"
AIRFLOW_CURRENT="$TEMP_DIR/airflow-current.json"
AIRFLOW_CANDIDATE="$TEMP_DIR/airflow-candidate.json"
TRINO_CURRENT="$TEMP_DIR/trino-current.json"
TRINO_CANDIDATE="$TEMP_DIR/trino-candidate.json"
RUNTIME_CURRENT="$TEMP_DIR/runtime-current.json"
RUNTIME_CANDIDATE="$TEMP_DIR/runtime-candidate.json"
HANDOFF_CANDIDATE="$TEMP_DIR/handoff-candidate.json"
TRINO_PRIVATE_CANDIDATE="$ROOT_DIR/infra/eks/values/workloads/dev.pair1-candidate.private-values.json"
RESOURCE_BEFORE="$TEMP_DIR/resources-before.json"
RESOURCE_AFTER="$TEMP_DIR/resources-after.json"
HANDOFF_BACKUP="$TEMP_DIR/handoff-backup.json"
TRINO_VALUES_BACKUP="$TEMP_DIR/trino-values-backup.json"
RUNTIME_VALUES_BACKUP="$TEMP_DIR/runtime-values-backup.json"

WEB_REVISION=""
AIRFLOW_REVISION=""
TRINO_REVISION=""
RUNTIME_REVISION=""
APPLY_STARTED=false
APPLY_COMPLETE=false

fail() {
  echo "$1" >&2
  exit 1
}

release_revision() {
  helm list -n "$NAMESPACE" -o json \
    | jq -r --arg release "$1" '.[] | select(.name == $release) | .revision'
}

rollback_on_error() {
  local exit_code=$?
  local failed_line="${1:-unknown}"
  local failed_command="${2:-unknown}"
  trap - ERR
  set +e
  printf 'pair1_image_rollout_error line=%s command=%q\n' "$failed_line" "$failed_command" >&2
  if [[ "$APPLY_STARTED" == true && "$APPLY_COMPLETE" != true ]]; then
    echo "pair1 image rollout failed; restoring previous Helm revisions" >&2
    for release in asklake-runtime-config asklake-trino asklake-airflow asklake-web; do
      case "$release" in
        asklake-runtime-config) revision="$RUNTIME_REVISION" ;;
        asklake-trino) revision="$TRINO_REVISION" ;;
        asklake-airflow) revision="$AIRFLOW_REVISION" ;;
        asklake-web) revision="$WEB_REVISION" ;;
      esac
      [[ "$revision" =~ ^[0-9]+$ ]] || continue
      current="$(release_revision "$release")"
      if [[ "$current" =~ ^[0-9]+$ && "$current" -gt "$revision" ]]; then
        helm rollback "$release" "$revision" -n "$NAMESPACE" --wait --timeout 10m >/dev/null || true
      fi
    done
    kubectl rollout status deployment/frontend deployment/fastapi deployment/trino-result-collector \
      deployment/asklake-airflow-apiserver deployment/asklake-airflow-scheduler \
      deployment/asklake-airflow-dag-processor deployment/asklake-trino \
      -n "$NAMESPACE" --timeout=10m >/dev/null 2>&1 || true
    for pair in \
      "$HANDOFF_BACKUP:$HANDOFF" \
      "$TRINO_VALUES_BACKUP:$TRINO_VALUES" \
      "$RUNTIME_VALUES_BACKUP:$RUNTIME_VALUES"; do
      source_file="${pair%%:*}"
      target_file="${pair#*:}"
      if [[ -s "$source_file" ]]; then
        cp "$source_file" "$target_file"
        chmod 600 "$target_file"
      fi
    done
  fi
  exit "$exit_code"
}

cleanup() {
  rm -rf "$TEMP_DIR"
  rm -f "$TRINO_PRIVATE_CANDIDATE"
}

trap 'rollback_on_error "$LINENO" "$BASH_COMMAND"' ERR
trap cleanup EXIT

[[ "$MODE" == "--preflight" || "$MODE" == "--apply" ]] || \
  fail "usage: $0 --preflight|--apply"
for command in aws git helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR")" || fail "current image receipt is invalid"
[[ -s "$STATE" && -s "$HANDOFF" && -s "$TRINO_VALUES" && -s "$RUNTIME_VALUES" ]] || \
  fail "private EKS state or values are missing"
for file in "$STATE" "$HANDOFF" "$TRINO_VALUES" "$RUNTIME_VALUES"; do
  git -C "$ROOT_DIR" check-ignore -q -- "$file" || fail "private EKS input must remain ignored"
done
cp "$HANDOFF" "$HANDOFF_BACKUP"
cp "$TRINO_VALUES" "$TRINO_VALUES_BACKUP"
cp "$RUNTIME_VALUES" "$RUNTIME_VALUES_BACKUP"
chmod 600 "$HANDOFF_BACKUP" "$TRINO_VALUES_BACKUP" "$RUNTIME_VALUES_BACKUP"
[[ ! -e "$TRINO_PRIVATE_CANDIDATE" ]] || fail "stale Trino rollout candidate exists"

export ASKLAKE_EKS_CLUSTER_NAME="${ASKLAKE_EKS_CLUSTER_NAME:-$(jq -r '.outputs.cluster_name.value' "$STATE")}"
verify_asklake_eks_context

receipt_revision="$(jq -r '.gitRevision' "$RECEIPT")"
pair1_revision="$(git -C "$ROOT_DIR" rev-parse origin/pair1)"
expected_revision="${ASKLAKE_EXPECTED_IMAGE_REVISION:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
[[ "$receipt_revision" == "$expected_revision" ]] || fail "image receipt must match the reviewed implementation revision"
git -C "$ROOT_DIR" merge-base --is-ancestor "$pair1_revision" "$receipt_revision" || \
  fail "image receipt revision does not contain current origin/pair1"
git -C "$ROOT_DIR" merge-base --is-ancestor "$receipt_revision" HEAD || \
  fail "current branch does not contain the image receipt revision"

frontend_image="$(jq -r '.images.frontend' "$RECEIPT")"
backend_image="$(jq -r '.images.backend' "$RECEIPT")"
airflow_image="$(jq -r '.images.airflow' "$RECEIPT")"
spark_image="$(jq -r '.images.sparkRuntime' "$RECEIPT")"
trino_image="$(jq -r '.images.trino' "$RECEIPT")"

split_image() {
  local image="$1"
  jq -n --arg image "$image" '
    ($image | split("@")) as $parts
    | if ($parts | length) != 2 then error("immutable image is invalid")
      else {repository:$parts[0],digest:$parts[1],pullPolicy:"IfNotPresent"} end
  '
}

verify_preserved_external_ec2() {
  local instances count
  instances="$(aws ec2 describe-instances --region "$ASKLAKE_VERIFIED_AWS_REGION" \
    --filters Name=instance-state-name,Values=running --output json | jq -r '
      [.Reservations[].Instances[]
        | select(([.Tags[]?.Key] | index("aws:eks:cluster-name")) == null)
        | .InstanceId] | unique[]
    ')"
  count="$(awk 'NF {count += 1} END {print count + 0}' <<<"$instances")"
  [[ "$count" -eq 1 ]] || fail "exactly one preserved external EC2 instance is required"
  ASKLAKE_EXPECTED_EC2_INSTANCE_ID="$instances" \
    bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh" >/dev/null
  unset instances
}

wait_for_alb_steady() {
  local deadline=$((SECONDS + 720))
  while ((SECONDS < deadline)); do
    if bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  fail "ALB did not return to exact steady state"
}

helm get values asklake-web -n "$NAMESPACE" -o json >"$WEB_CURRENT"
helm get values asklake-airflow -n "$NAMESPACE" -o json >"$AIRFLOW_CURRENT"
helm get values asklake-trino -n "$NAMESPACE" -o json >"$TRINO_CURRENT"
helm get values asklake-runtime-config -n "$NAMESPACE" -o json >"$RUNTIME_CURRENT"

jq --arg frontend "$frontend_image" --arg backend "$backend_image" --arg revision "$receipt_revision" '
  .frontend.image=$frontend
  | .backend.image=$backend
  | .backend.runtimeConfigRevision=$revision
  | .collector=(.collector // {
      enabled:true,replicaCount:1,serviceAccountName:"asklake-backend",
      resources:{
        requests:{cpu:"100m",memory:"256Mi"},
        limits:{cpu:"500m",memory:"512Mi"}
      }
    })
' "$WEB_CURRENT" >"$WEB_CANDIDATE"
airflow_image_object="$(split_image "$airflow_image")"
jq --argjson image "$airflow_image_object" '.airflow.image=$image' \
  "$AIRFLOW_CURRENT" >"$AIRFLOW_CANDIDATE"
trino_image_object="$(split_image "$trino_image")"
jq --argjson image "$trino_image_object" '.trino.image=$image' \
  "$TRINO_CURRENT" >"$TRINO_CANDIDATE"
jq --arg image "$spark_image" '.configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE=$image' \
  "$RUNTIME_CURRENT" >"$RUNTIME_CANDIDATE"
jq --slurpfile receipt "$RECEIPT" '.images=$receipt[0].images' \
  "$HANDOFF" >"$HANDOFF_CANDIDATE"

jq -e --slurp '
  (.[0] | del(.frontend.image,.backend.image,.backend.runtimeConfigRevision,.collector))
  == (.[1] | del(.frontend.image,.backend.image,.backend.runtimeConfigRevision,.collector))
  and .[1].collector == (
    .[0].collector // {
      enabled:true,replicaCount:1,serviceAccountName:"asklake-backend",
      resources:{
        requests:{cpu:"100m",memory:"256Mi"},
        limits:{cpu:"500m",memory:"512Mi"}
      }
    }
  )
' "$WEB_CURRENT" "$WEB_CANDIDATE" >/dev/null || fail "web candidate changed non-image values"
jq -e --slurp '(.[0] | del(.airflow.image)) == (.[1] | del(.airflow.image))' \
  "$AIRFLOW_CURRENT" "$AIRFLOW_CANDIDATE" >/dev/null || fail "Airflow candidate changed non-image values"
jq -e --slurp '(.[0] | del(.trino.image)) == (.[1] | del(.trino.image))' \
  "$TRINO_CURRENT" "$TRINO_CANDIDATE" >/dev/null || fail "Trino candidate changed non-image values"
jq -e --slurp '
  (.[0] | del(.configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE))
  == (.[1] | del(.configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE))
' "$RUNTIME_CURRENT" "$RUNTIME_CANDIDATE" >/dev/null || fail "runtime candidate changed non-image values"
jq -e --slurp '(.[0] | del(.images)) == (.[1] | del(.images))' \
  "$HANDOFF" "$HANDOFF_CANDIDATE" >/dev/null || fail "handoff candidate changed non-image values"

for pair in \
  "asklake-web:$ROOT_DIR/infra/eks/helm/asklake-web:$WEB_CANDIDATE" \
  "asklake-airflow:$ROOT_DIR/infra/eks/helm/asklake-workloads:$AIRFLOW_CANDIDATE" \
  "asklake-trino:$ROOT_DIR/infra/eks/helm/asklake-workloads:$TRINO_CANDIDATE" \
  "asklake-runtime-config:$ROOT_DIR/infra/eks/helm/asklake-runtime-config:$RUNTIME_CANDIDATE"; do
  IFS=: read -r release chart values <<<"$pair"
  helm lint "$chart" -f "$values"
done

kubectl get deployment,service,configmap,job -n "$NAMESPACE" -o json \
  | jq -S -c '[.items[]|{
      kind,name:.metadata.name,uid:.metadata.uid,generation:(.metadata.generation//null),
      spec:(.spec//null),data:(.data//null)
    }]|sort_by(.kind,.name)' \
  >"$RESOURCE_BEFORE"
helm upgrade --install asklake-web "$ROOT_DIR/infra/eks/helm/asklake-web" \
  -n "$NAMESPACE" -f "$WEB_CANDIDATE" --dry-run=server >/dev/null
helm upgrade --install asklake-airflow "$ROOT_DIR/infra/eks/helm/asklake-workloads" \
  -n "$NAMESPACE" -f "$AIRFLOW_CANDIDATE" --dry-run=server >/dev/null
helm upgrade --install asklake-trino "$ROOT_DIR/infra/eks/helm/asklake-workloads" \
  -n "$NAMESPACE" -f "$TRINO_CANDIDATE" --dry-run=server >/dev/null
helm upgrade --install asklake-runtime-config "$ROOT_DIR/infra/eks/helm/asklake-runtime-config" \
  -n "$NAMESPACE" -f "$RUNTIME_CANDIDATE" --dry-run=server >/dev/null
kubectl get deployment,service,configmap,job -n "$NAMESPACE" -o json \
  | jq -S -c '[.items[]|{
      kind,name:.metadata.name,uid:.metadata.uid,generation:(.metadata.generation//null),
      spec:(.spec//null),data:(.data//null)
    }]|sort_by(.kind,.name)' \
  >"$RESOURCE_AFTER"
cmp -s "$RESOURCE_BEFORE" "$RESOURCE_AFTER" || fail "server dry-run changed live resources"

ASKLAKE_DAY16_TRINO_VALUES="$TRINO_PRIVATE_CANDIDATE" \
  ASKLAKE_IMAGE_RECEIPT="$RECEIPT" \
  bash "$ROOT_DIR/scripts/prepare-eks-day16-trino-values.sh" >/dev/null
ASKLAKE_DAY16_TRINO_VALUES="$TRINO_PRIVATE_CANDIDATE" \
  ASKLAKE_IMAGE_RECEIPT="$RECEIPT" \
  bash "$ROOT_DIR/scripts/verify-eks-day16-trino-values.sh" >/dev/null
node "$ROOT_DIR/scripts/verify-eks-delivery-handoff.mjs" --ready "$HANDOFF_CANDIDATE" >/dev/null

wait_for_alb_steady
bash "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" >/dev/null
verify_preserved_external_ec2
jq -e '(.items|length)==4 and all(.items[]; any(.status.conditions[]?; .type=="Ready" and .status=="True"))' \
  < <(kubectl get externalsecrets.external-secrets.io -n "$NAMESPACE" -o json) >/dev/null \
  || fail "runtime ExternalSecrets are not all Ready"

echo "pair1_image_preflight=passed dry_run_mutation=zero components=5 collector_contract=preserved_or_restored"
[[ "$MODE" == "--preflight" ]] && exit 0

[[ "${ASKLAKE_PAIR1_IMAGE_ROLLOUT_CONFIRM:-}" == "deploy-exact-pair1-receipt" ]] || \
  fail "set ASKLAKE_PAIR1_IMAGE_ROLLOUT_CONFIRM=deploy-exact-pair1-receipt"

WEB_REVISION="$(release_revision asklake-web)"
AIRFLOW_REVISION="$(release_revision asklake-airflow)"
TRINO_REVISION="$(release_revision asklake-trino)"
RUNTIME_REVISION="$(release_revision asklake-runtime-config)"
for revision in "$WEB_REVISION" "$AIRFLOW_REVISION" "$TRINO_REVISION" "$RUNTIME_REVISION"; do
  [[ "$revision" =~ ^[0-9]+$ ]] || fail "a Helm revision is unavailable"
done

APPLY_STARTED=true
helm upgrade --install asklake-runtime-config "$ROOT_DIR/infra/eks/helm/asklake-runtime-config" \
  -n "$NAMESPACE" -f "$RUNTIME_CANDIDATE" --server-side=true --force-conflicts \
  --rollback-on-failure --wait --timeout 10m >/dev/null
helm upgrade --install asklake-web "$ROOT_DIR/infra/eks/helm/asklake-web" \
  -n "$NAMESPACE" -f "$WEB_CANDIDATE" --rollback-on-failure --wait --timeout 10m >/dev/null
helm upgrade --install asklake-airflow "$ROOT_DIR/infra/eks/helm/asklake-workloads" \
  -n "$NAMESPACE" -f "$AIRFLOW_CANDIDATE" --rollback-on-failure --wait --timeout 10m >/dev/null
helm upgrade --install asklake-trino "$ROOT_DIR/infra/eks/helm/asklake-workloads" \
  -n "$NAMESPACE" -f "$TRINO_CANDIDATE" --rollback-on-failure --wait --timeout 10m >/dev/null

kubectl rollout status deployment/frontend deployment/fastapi deployment/trino-result-collector \
  deployment/asklake-airflow-apiserver deployment/asklake-airflow-scheduler \
  deployment/asklake-airflow-dag-processor deployment/asklake-trino \
  -n "$NAMESPACE" --timeout=10m >/dev/null

kubectl get deployment frontend fastapi trino-result-collector asklake-airflow-apiserver \
  asklake-airflow-scheduler asklake-airflow-dag-processor asklake-trino \
  -n "$NAMESPACE" -o json | jq -e \
  --arg frontend "$frontend_image" --arg backend "$backend_image" \
  --arg airflow "$airflow_image" --arg trino "$trino_image" '
    def steady:
      (.spec.replicas // 0) == (.status.readyReplicas // 0)
      and (.spec.replicas // 0) == (.status.updatedReplicas // 0)
      and (.spec.replicas // 0) == (.status.availableReplicas // 0)
      and (.status.unavailableReplicas // 0) == 0;
    all(.items[]; steady)
    and ([.items[]|select(.metadata.name=="frontend")|.spec.template.spec.containers[0].image] == [$frontend])
    and ([.items[]|select(.metadata.name=="fastapi")|.spec.template.spec.containers[0].image] == [$backend])
    and ([.items[]|select(.metadata.name=="trino-result-collector")|.spec.template.spec.containers[0].image] == [$backend])
    and all(.items[]|select(.metadata.name|startswith("asklake-airflow-")); .spec.template.spec.containers[0].image==$airflow)
    and ([.items[]|select(.metadata.name=="asklake-trino")|.spec.template.spec.containers[0].image] == [$trino])
  ' >/dev/null || fail "application Deployments did not converge on the receipt"

[[ "$(kubectl get configmap asklake-runtime -n "$NAMESPACE" -o jsonpath='{.data.ASKLAKE_SPARK_KUBERNETES_IMAGE}')" == "$spark_image" ]] \
  || fail "runtime ConfigMap did not converge on the Spark receipt image"
backend_pods="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json | jq -r '
  [.items[]
    | select(.metadata.deletionTimestamp == null)
    | select(.status.phase == "Running")
    | select(any(.status.containerStatuses[]?; .name == "fastapi" and .ready == true))
    | .metadata.name
  ] | .[]
')"
[[ "$(awk 'NF {count += 1} END {print count + 0}' <<<"$backend_pods")" -eq 2 ]] \
  || fail "exactly two active Ready Backend Pods are required after rollout"
while IFS= read -r pod; do
  [[ "$(kubectl exec -n "$NAMESPACE" "$pod" -c fastapi -- printenv ASKLAKE_SPARK_KUBERNETES_IMAGE)" == "$spark_image" ]] \
    || fail "a Backend Pod did not reload the Spark receipt image from runtime ConfigMap"
done <<<"$backend_pods"
wait_for_alb_steady
bash "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" >/dev/null
verify_preserved_external_ec2

mv "$HANDOFF_CANDIDATE" "$HANDOFF"
mv "$TRINO_PRIVATE_CANDIDATE" "$TRINO_VALUES"
chmod 600 "$HANDOFF" "$TRINO_VALUES"
ASKLAKE_RUNTIME_CONFIG_VALUES="$RUNTIME_VALUES" \
  bash "$ROOT_DIR/scripts/prepare-eks-runtime-config-values.sh" >/dev/null
ASKLAKE_IMAGE_RECEIPT="$RECEIPT" \
  ASKLAKE_RUNTIME_CONFIG_VALUES="$RUNTIME_VALUES" \
  bash "$ROOT_DIR/scripts/verify-eks-runtime-config-release.sh" --owned >/dev/null
kubectl rollout status deployment/frontend deployment/fastapi deployment/trino-result-collector \
  deployment/asklake-airflow-apiserver deployment/asklake-airflow-scheduler \
  deployment/asklake-airflow-dag-processor deployment/asklake-trino \
  -n "$NAMESPACE" --timeout=3m >/dev/null
ASKLAKE_IMAGE_RECEIPT="$RECEIPT" \
  ASKLAKE_DAY16_HANDOFF="$HANDOFF" \
  ASKLAKE_DAY16_TRINO_VALUES="$TRINO_VALUES" \
  bash "$ROOT_DIR/scripts/verify-eks-day16-a-handoff.sh" --ready

APPLY_COMPLETE=true
echo "pair1_image_rollout=passed components=5 rollback_guard=armed private_handoff=refreshed"
