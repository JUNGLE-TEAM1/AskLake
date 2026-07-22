#!/usr/bin/env bash
set -Eeuo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECEIPT_PATH="${1:?usage: rollout-eks-recovery-release.sh <0600 image receipt>}"
NAMESPACE="asklake-dev"
WEB_RELEASE="asklake-web"
AIRFLOW_RELEASE="asklake-airflow"
TRINO_RELEASE="asklake-trino"
REALTIME_RELEASE="asklake-realtime-v1"
WEB_CHART="$ROOT_DIR/infra/eks/helm/asklake-web"
WORKLOAD_CHART="$ROOT_DIR/infra/eks/helm/asklake-workloads"
EXPECTED_EC2_REVISION="e6d6b7f868d2bb2b1f376aa6a5174608fefe6249"
EXPECTED_SCHEMA_HEAD="0026_continuous_sql_refresh_state"
AWS_PROFILE_NAME="${AWS_PROFILE:-asklake}"
AWS_REGION_NAME="${AWS_REGION:-ap-northeast-2}"
EC2_INSTANCE_ID_VALUE="${ASKLAKE_EC2_INSTANCE_ID:-}"
DEPLOY_CONFIRM="${ASKLAKE_EKS_RECOVERY_CONFIRM:-}"
BATCH_LIMIT_CONFIRM="${ASKLAKE_ACCEPT_E6F_BATCH_RUNNER_LIMITATION:-}"

umask 077
TEMP_DIR="$(mktemp -d)"
WEB_BEFORE="$TEMP_DIR/web-before.json"
WEB_AFTER="$TEMP_DIR/web-after.json"
AIRFLOW_BEFORE="$TEMP_DIR/airflow-before.json"
AIRFLOW_AFTER="$TEMP_DIR/airflow-after.json"
TRINO_BEFORE="$TEMP_DIR/trino-before.json"
TRINO_AFTER="$TEMP_DIR/trino-after.json"
REALTIME_BEFORE="$TEMP_DIR/realtime-before.json"
REALTIME_AFTER="$TEMP_DIR/realtime-after.json"
MUTATED_WEB=false
MUTATED_AIRFLOW=false
MUTATED_TRINO=false
MUTATED_REALTIME=false
DEPLOY_COMPLETE=false

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

release_revision() {
  helm list -n "$NAMESPACE" --filter "^$1$" -o json | jq -er '.[0].revision'
}

rollback_on_exit() {
  local exit_code=$?
  trap - EXIT
  set +e
  if [[ "$exit_code" -ne 0 && "$DEPLOY_COMPLETE" != "true" ]]; then
    printf 'recovery_rollout_failed=restoring_previous_helm_revisions\n' >&2
    if [[ "$MUTATED_WEB" == "true" ]]; then
      helm rollback "$WEB_RELEASE" "$WEB_REVISION_BEFORE" -n "$NAMESPACE" --wait --timeout 10m >/dev/null
    fi
    if [[ "$MUTATED_REALTIME" == "true" ]]; then
      helm rollback "$REALTIME_RELEASE" "$REALTIME_REVISION_BEFORE" -n "$NAMESPACE" --wait --timeout 10m >/dev/null
    fi
    if [[ "$MUTATED_TRINO" == "true" ]]; then
      helm rollback "$TRINO_RELEASE" "$TRINO_REVISION_BEFORE" -n "$NAMESPACE" --wait --timeout 10m >/dev/null
    fi
    if [[ "$MUTATED_AIRFLOW" == "true" ]]; then
      helm rollback "$AIRFLOW_RELEASE" "$AIRFLOW_REVISION_BEFORE" -n "$NAMESPACE" --no-hooks --wait --timeout 10m >/dev/null
    fi
    printf 'recovery_rollout_rollback=attempted\n' >&2
  fi
  [[ "$TEMP_DIR" == /tmp/* || "$TEMP_DIR" == /private/tmp/* || "$TEMP_DIR" == "${TMPDIR:-/tmp}"/* ]] && rm -rf "$TEMP_DIR"
  exit "$exit_code"
}
trap rollback_on_exit EXIT

for command in aws curl git helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

[[ "$DEPLOY_CONFIRM" == "deploy-reviewed-e6f86eb8-recovery" ]] || fail "set ASKLAKE_EKS_RECOVERY_CONFIRM=deploy-reviewed-e6f86eb8-recovery"
[[ "$BATCH_LIMIT_CONFIRM" == "accepted-no-new-batch-until-followup" ]] || fail "e6f86eb8 cannot submit general batch jobs to the Spark Operator; set ASKLAKE_ACCEPT_E6F_BATCH_RUNNER_LIMITATION=accepted-no-new-batch-until-followup only after accepting that temporary limitation"
[[ -n "$EC2_INSTANCE_ID_VALUE" ]] || fail "ASKLAKE_EC2_INSTANCE_ID is required for live owner-fence verification"
[[ "$(kubectl config current-context)" == "asklake-observe" ]] || fail "unexpected kubectl context; expected asklake-observe"
[[ -s "$RECEIPT_PATH" ]] || fail "image receipt is missing"

receipt_mode="$(stat -f '%Lp' "$RECEIPT_PATH" 2>/dev/null || stat -c '%a' "$RECEIPT_PATH")"
[[ "$receipt_mode" == "600" ]] || fail "image receipt must use mode 0600"

node "$ROOT_DIR/scripts/verify-eks-recovery-release.mjs" >/dev/null
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" --require-ai-gateway --require-recovery-profile "$RECEIPT_PATH" >/dev/null
[[ "$(jq -r '.environment' "$RECEIPT_PATH")" == "dev" ]] || fail "receipt environment must be dev"
RELEASE_SHA="$(jq -er '.gitRevision' "$RECEIPT_PATH")"
[[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" == "$RELEASE_SHA" ]] || fail "local checkout does not match the receipt revision"

FRONTEND_IMAGE="$(jq -er '.images.frontend' "$RECEIPT_PATH")"
BACKEND_IMAGE="$(jq -er '.images.backend' "$RECEIPT_PATH")"
AI_IMAGE="$(jq -er '.images.aiGateway' "$RECEIPT_PATH")"
AIRFLOW_IMAGE="$(jq -er '.images.airflow' "$RECEIPT_PATH")"
SPARK_IMAGE="$(jq -er '.images.sparkRuntime' "$RECEIPT_PATH")"
TRINO_IMAGE="$(jq -er '.images.trino' "$RECEIPT_PATH")"

split_image() {
  local reference="$1"
  local repository_var="$2"
  local digest_var="$3"
  [[ "$reference" =~ ^[^@]+@sha256:[a-f0-9]{64}$ ]] || fail "image is not digest-pinned"
  printf -v "$repository_var" '%s' "${reference%@*}"
  printf -v "$digest_var" '%s' "${reference##*@}"
}
split_image "$BACKEND_IMAGE" BACKEND_REPOSITORY BACKEND_DIGEST
split_image "$AIRFLOW_IMAGE" AIRFLOW_REPOSITORY AIRFLOW_DIGEST
split_image "$SPARK_IMAGE" SPARK_REPOSITORY SPARK_DIGEST
split_image "$TRINO_IMAGE" TRINO_REPOSITORY TRINO_DIGEST

audit_ec2_boundary() {
  local ec2_command parameters command_id invocation output
  read -r -d '' ec2_command <<'EC2_COMMAND' || true
set -eu
backend_ids="$(sudo docker ps --filter label=com.docker.compose.service=backend --format '{{.ID}}')"
backend_count="$(printf '%s\n' "$backend_ids" | sed '/^$/d' | wc -l | tr -d ' ')"
test "$backend_count" = "1"
backend_id="$(printf '%s\n' "$backend_ids" | head -n 1)"
release_dir="$(sudo docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$backend_id")"
test -n "$release_dir"
release_head="$(git -c safe.directory="$release_dir" -C "$release_dir" rev-parse HEAD)"
worker_count="$(sudo docker ps --filter label=com.docker.compose.service=continuous-worker --format '{{.ID}}' | sed '/^$/d' | wc -l | tr -d ' ')"
printf 'release_head=%s\n' "$release_head"
printf 'running_continuous_workers=%s\n' "$worker_count"
EC2_COMMAND
  parameters="$(jq -cn --arg command "$ec2_command" '{commands: [$command]}')"
  command_id="$(aws --profile "$AWS_PROFILE_NAME" --region "$AWS_REGION_NAME" ssm send-command \
    --instance-ids "$EC2_INSTANCE_ID_VALUE" \
    --document-name AWS-RunShellScript \
    --comment asklake-eks-recovery-read-only-boundary \
    --parameters "$parameters" \
    --query 'Command.CommandId' --output text)"
  aws --profile "$AWS_PROFILE_NAME" --region "$AWS_REGION_NAME" ssm wait command-executed \
    --command-id "$command_id" --instance-id "$EC2_INSTANCE_ID_VALUE"
  invocation="$(aws --profile "$AWS_PROFILE_NAME" --region "$AWS_REGION_NAME" ssm get-command-invocation \
    --command-id "$command_id" --instance-id "$EC2_INSTANCE_ID_VALUE" --output json)"
  [[ "$(jq -r '.Status' <<<"$invocation")" == "Success" ]] || fail "EC2 boundary audit failed"
  output="$(jq -r '.StandardOutputContent' <<<"$invocation")"
  [[ "$(awk -F= '$1=="release_head"{print $2}' <<<"$output")" == "$EXPECTED_EC2_REVISION" ]] || fail "EC2 active release changed since the approved audit"
  [[ "$(awk -F= '$1=="running_continuous_workers"{print $2}' <<<"$output")" == "0" ]] || fail "EC2 continuous worker is not fenced"
}

audit_ec2_boundary

kubectl get deployment asklake-realtime-v1-worker -n "$NAMESPACE" -o json | jq -e '
  .spec.replicas == 1
  and (.status.readyReplicas // 0) == 1
  and .metadata.annotations["asklake.io/previous-owner-fenced"] == "true"
  and any(.spec.template.spec.containers[].env[];
    .name == "CONTINUOUS_CONTROL_PLANE" and .value == "worker")
  and any(.spec.template.spec.containers[].env[];
    .name == "CONTINUOUS_WORKER_OWNER" and .value == "eks-continuous-worker-v1")
  and any(.spec.template.spec.containers[].env[];
    .name == "ASKLAKE_CONTINUOUS_SPARK_RUNNER" and .value == "kubernetes")
' >/dev/null || fail "EKS continuous ownership boundary is not steady"

schema_state="$(kubectl exec -n "$NAMESPACE" deployment/fastapi -- python -m alembic current)"
grep -q "^$EXPECTED_SCHEMA_HEAD (head)$" <<<"$schema_state" || fail "database schema is not at the approved 0026 head"

general_runner="$(kubectl get configmap asklake-runtime -n "$NAMESPACE" -o jsonpath='{.data.ASKLAKE_SPARK_RUNNER}')"
[[ "$general_runner" == "kubernetes" ]] || fail "unexpected EKS general Spark runner"

airflow_running="$(kubectl exec -n "$NAMESPACE" deployment/asklake-airflow-scheduler -- airflow dags list-runs asklake_etl_job --state running -o json | tail -n 1)"
airflow_queued="$(kubectl exec -n "$NAMESPACE" deployment/asklake-airflow-scheduler -- airflow dags list-runs asklake_etl_job --state queued -o json | tail -n 1)"
[[ "$airflow_running" == "[]" && "$airflow_queued" == "[]" ]] || fail "an active or queued Airflow DAG run prevents a recovery rollout"

if kubectl get sparkapplications.sparkoperator.k8s.io -n "$NAMESPACE" -o json >"$TEMP_DIR/spark-applications.json" 2>/dev/null; then
  jq -e '[.items[] | select(
    ((.status.applicationState.state // "") | ascii_upcase) as $state
    | $state == "SUBMITTED" or $state == "PENDING" or $state == "RUNNING"
  )] | length == 0' "$TEMP_DIR/spark-applications.json" >/dev/null || fail "an active SparkApplication prevents a recovery rollout"
else
  fail "SparkApplication API is unavailable"
fi

WEB_REVISION_BEFORE="$(release_revision "$WEB_RELEASE")"
AIRFLOW_REVISION_BEFORE="$(release_revision "$AIRFLOW_RELEASE")"
TRINO_REVISION_BEFORE="$(release_revision "$TRINO_RELEASE")"
REALTIME_REVISION_BEFORE="$(release_revision "$REALTIME_RELEASE")"

helm get values "$WEB_RELEASE" -n "$NAMESPACE" --all -o json >"$WEB_BEFORE"
jq --arg frontend "$FRONTEND_IMAGE" --arg backend "$BACKEND_IMAGE" --arg ai "$AI_IMAGE" '
  .frontend.image = $frontend
  | .backend.image = $backend
  | .aiGateway.image = $ai
' "$WEB_BEFORE" >"$WEB_AFTER"
jq -e -s '
  (.[0] | del(.frontend.image, .backend.image, .aiGateway.image)) ==
    (.[1] | del(.frontend.image, .backend.image, .aiGateway.image))
' "$WEB_BEFORE" "$WEB_AFTER" >/dev/null || fail "web values changed outside approved image fields"

helm get values "$AIRFLOW_RELEASE" -n "$NAMESPACE" --all -o json >"$AIRFLOW_BEFORE"
jq --arg repository "$AIRFLOW_REPOSITORY" --arg digest "$AIRFLOW_DIGEST" '
  .airflow.image.repository = $repository
  | .airflow.image.digest = $digest
' "$AIRFLOW_BEFORE" >"$AIRFLOW_AFTER"
jq -e -s '
  (.[0] | del(.airflow.image.repository, .airflow.image.digest)) ==
    (.[1] | del(.airflow.image.repository, .airflow.image.digest))
' "$AIRFLOW_BEFORE" "$AIRFLOW_AFTER" >/dev/null || fail "Airflow values changed outside approved image fields"

helm get values "$TRINO_RELEASE" -n "$NAMESPACE" --all -o json >"$TRINO_BEFORE"
jq --arg repository "$TRINO_REPOSITORY" --arg digest "$TRINO_DIGEST" '
  .trino.image.repository = $repository
  | .trino.image.digest = $digest
' "$TRINO_BEFORE" >"$TRINO_AFTER"
jq -e -s '
  (.[0] | del(.trino.image.repository, .trino.image.digest)) ==
    (.[1] | del(.trino.image.repository, .trino.image.digest))
' "$TRINO_BEFORE" "$TRINO_AFTER" >/dev/null || fail "Trino values changed outside approved image fields"

helm get values "$REALTIME_RELEASE" -n "$NAMESPACE" --all -o json >"$REALTIME_BEFORE"
jq \
  --arg backendRepository "$BACKEND_REPOSITORY" \
  --arg backendDigest "$BACKEND_DIGEST" \
  --arg sparkRepository "$SPARK_REPOSITORY" \
  --arg sparkDigest "$SPARK_DIGEST" '
  .backend.image.repository = $backendRepository
  | .backend.image.digest = $backendDigest
  | .sparkApplication.image.repository = $sparkRepository
  | .sparkApplication.image.digest = $sparkDigest
' "$REALTIME_BEFORE" >"$REALTIME_AFTER"
jq -e -s '
  (.[0] | del(
    .backend.image.repository,
    .backend.image.digest,
    .sparkApplication.image.repository,
    .sparkApplication.image.digest
  )) ==
  (.[1] | del(
    .backend.image.repository,
    .backend.image.digest,
    .sparkApplication.image.repository,
    .sparkApplication.image.digest
  ))
  and .[1].realtimeV1.ownerTransfer.approved == true
  and .[1].realtimeV1.ownerTransfer.previousOwnerFenced == true
' "$REALTIME_BEFORE" "$REALTIME_AFTER" >/dev/null || fail "realtime values changed outside approved image fields"

for values in "$AIRFLOW_AFTER" "$TRINO_AFTER" "$REALTIME_AFTER"; do
  helm lint "$WORKLOAD_CHART" -f "$values" >/dev/null
done
helm lint "$WEB_CHART" -f "$WEB_AFTER" >/dev/null
helm upgrade --install "$AIRFLOW_RELEASE" "$WORKLOAD_CHART" -n "$NAMESPACE" -f "$AIRFLOW_AFTER" --no-hooks --dry-run=server >"$TEMP_DIR/airflow-dry-run.txt"
helm upgrade --install "$TRINO_RELEASE" "$WORKLOAD_CHART" -n "$NAMESPACE" -f "$TRINO_AFTER" --dry-run=server >"$TEMP_DIR/trino-dry-run.txt"
helm upgrade --install "$REALTIME_RELEASE" "$WORKLOAD_CHART" -n "$NAMESPACE" -f "$REALTIME_AFTER" --dry-run=server >"$TEMP_DIR/realtime-dry-run.txt"
helm upgrade --install "$WEB_RELEASE" "$WEB_CHART" -n "$NAMESPACE" -f "$WEB_AFTER" --dry-run=server >"$TEMP_DIR/web-dry-run.txt"

MUTATED_AIRFLOW=true
helm upgrade --install "$AIRFLOW_RELEASE" "$WORKLOAD_CHART" -n "$NAMESPACE" \
  -f "$AIRFLOW_AFTER" --no-hooks --atomic --wait --timeout 15m >/dev/null
kubectl rollout status -n "$NAMESPACE" \
  deployment/asklake-airflow-apiserver \
  deployment/asklake-airflow-scheduler \
  deployment/asklake-airflow-dag-processor --timeout=10m >/dev/null

MUTATED_TRINO=true
helm upgrade --install "$TRINO_RELEASE" "$WORKLOAD_CHART" -n "$NAMESPACE" \
  -f "$TRINO_AFTER" --atomic --wait --timeout 15m >/dev/null
kubectl rollout status -n "$NAMESPACE" deployment/asklake-trino --timeout=10m >/dev/null

MUTATED_REALTIME=true
helm upgrade --install "$REALTIME_RELEASE" "$WORKLOAD_CHART" -n "$NAMESPACE" \
  -f "$REALTIME_AFTER" --atomic --wait --timeout 15m >/dev/null
kubectl rollout status -n "$NAMESPACE" deployment/asklake-realtime-v1-worker --timeout=10m >/dev/null

MUTATED_WEB=true
helm upgrade --install "$WEB_RELEASE" "$WEB_CHART" -n "$NAMESPACE" \
  -f "$WEB_AFTER" --atomic --wait --timeout 15m >/dev/null
kubectl rollout status -n "$NAMESPACE" \
  deployment/frontend deployment/fastapi deployment/trino-result-collector --timeout=10m >/dev/null
if jq -e '.aiGateway.enabled == true' "$WEB_AFTER" >/dev/null; then
  kubectl rollout status -n "$NAMESPACE" deployment/ai-gateway --timeout=10m >/dev/null
fi

kubectl get deployment frontend fastapi trino-result-collector asklake-realtime-v1-worker \
  asklake-airflow-apiserver asklake-airflow-scheduler asklake-airflow-dag-processor asklake-trino \
  -n "$NAMESPACE" -o json | jq -e \
  --arg frontend "$FRONTEND_IMAGE" \
  --arg backend "$BACKEND_IMAGE" \
  --arg airflow "$AIRFLOW_IMAGE" \
  --arg trino "$TRINO_IMAGE" '
  def steady:
    (.spec.replicas // 0) > 0
    and (.status.readyReplicas // 0) == .spec.replicas
    and (.status.updatedReplicas // 0) == .spec.replicas
    and (.status.availableReplicas // 0) == .spec.replicas
    and (.status.unavailableReplicas // 0) == 0;
  all(.items[]; steady)
  and (.items[] | select(.metadata.name == "frontend")
    | any(.spec.template.spec.containers[]; .name == "frontend" and .image == $frontend))
  and (all(.items[] | select(.metadata.name == "fastapi" or .metadata.name == "trino-result-collector" or .metadata.name == "asklake-realtime-v1-worker");
    any(.spec.template.spec.containers[]; .image == $backend)))
  and (all(.items[] | select(.metadata.name | startswith("asklake-airflow-"));
    any(.spec.template.spec.containers[]; .image == $airflow)))
  and (.items[] | select(.metadata.name == "asklake-trino")
    | any(.spec.template.spec.containers[]; .image == $trino))
' >/dev/null || fail "one or more deployments did not converge on the receipt images"

worker_spark_image="$(kubectl get deployment asklake-realtime-v1-worker -n "$NAMESPACE" -o json | jq -er '
  .spec.template.spec.containers[]
  | select(.name == "realtime-v1-worker")
  | .env[]
  | select(.name == "ASKLAKE_SPARK_KUBERNETES_IMAGE")
  | .value
')"
[[ "$worker_spark_image" == "$SPARK_IMAGE" ]] || fail "continuous worker did not receive the recovery Spark image"

if jq -e '.aiGateway.enabled == true' "$WEB_AFTER" >/dev/null; then
  [[ "$(kubectl get deployment ai-gateway -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[?(@.name=="ai-gateway")].image}')" == "$AI_IMAGE" ]] || fail "AI gateway did not converge on the receipt image"
fi

audit_ec2_boundary
schema_state="$(kubectl exec -n "$NAMESPACE" deployment/fastapi -- python -m alembic current)"
grep -q "^$EXPECTED_SCHEMA_HEAD (head)$" <<<"$schema_state" || fail "schema drifted during rollout"

BACKEND_HOST="$(kubectl get ingress asklake-backend -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')"
FRONTEND_HOST="$(kubectl get ingress asklake-frontend -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')"
[[ -n "$BACKEND_HOST" && "$BACKEND_HOST" == "$FRONTEND_HOST" ]] || fail "shared ALB hostname is unavailable"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 20 "http://$BACKEND_HOST/api/health")" == "200" ]] || fail "external backend health is not 200"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 20 "http://$FRONTEND_HOST/")" == "200" ]] || fail "external frontend health is not 200"

WEB_REVISION_AFTER="$(release_revision "$WEB_RELEASE")"
AIRFLOW_REVISION_AFTER="$(release_revision "$AIRFLOW_RELEASE")"
TRINO_REVISION_AFTER="$(release_revision "$TRINO_RELEASE")"
REALTIME_REVISION_AFTER="$(release_revision "$REALTIME_RELEASE")"
AUDIT_PATH="/private/tmp/asklake-eks-recovery-${RELEASE_SHA}.json"
jq -n \
  --arg sourceSha "$RELEASE_SHA" \
  --arg deployedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg schemaHead "$EXPECTED_SCHEMA_HEAD" \
  --arg webBefore "$WEB_REVISION_BEFORE" --arg webAfter "$WEB_REVISION_AFTER" \
  --arg airflowBefore "$AIRFLOW_REVISION_BEFORE" --arg airflowAfter "$AIRFLOW_REVISION_AFTER" \
  --arg trinoBefore "$TRINO_REVISION_BEFORE" --arg trinoAfter "$TRINO_REVISION_AFTER" \
  --arg realtimeBefore "$REALTIME_REVISION_BEFORE" --arg realtimeAfter "$REALTIME_REVISION_AFTER" '
  {
    profile: "ec2-recovery-e6f86eb8",
    sourceSha: $sourceSha,
    deployedAt: $deployedAt,
    schemaHead: $schemaHead,
    continuousOwner: "eks-continuous-worker-v1",
    ec2ContinuousWorkerReplicas: 0,
    eksContinuousWorkerReplicas: 1,
    helmRevisions: {
      web: {before: $webBefore, after: $webAfter},
      airflow: {before: $airflowBefore, after: $airflowAfter},
      trino: {before: $trinoBefore, after: $trinoAfter},
      realtime: {before: $realtimeBefore, after: $realtimeAfter}
    }
  }
' >"$AUDIT_PATH"
chmod 600 "$AUDIT_PATH"

DEPLOY_COMPLETE=true
printf 'EKS_RECOVERY_OK source_sha=%s schema=%s continuous_owner=eks audit=%s\n' \
  "$RELEASE_SHA" "$EXPECTED_SCHEMA_HEAD" "$AUDIT_PATH"
