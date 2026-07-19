#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-workloads"
VALUES_FILE="$ROOT_DIR/infra/eks/values/workloads/dev.example.yaml"
DEFAULT_RENDER="$(mktemp)"
DISTRIBUTED_RENDER="$(mktemp)"
AIRFLOW_ONLY_RENDER="$(mktemp)"
SINGLE_VALUES_SAMPLE="$(mktemp)"
SINGLE_VALUES_RESULT="$(mktemp)"
trap 'rm -f "$DEFAULT_RENDER" "$DISTRIBUTED_RENDER" "$AIRFLOW_ONLY_RENDER" "$SINGLE_VALUES_SAMPLE" "$SINGLE_VALUES_RESULT"' EXIT

HELM_BIN="${ASKLAKE_HELM_BIN:-}"
if [[ -z "$HELM_BIN" ]] && command -v helm >/dev/null 2>&1; then
  HELM_BIN="$(command -v helm)"
fi
if [[ -z "$HELM_BIN" || ! -x "$HELM_BIN" ]]; then
  echo "helm is required to verify distributed Trino" >&2
  exit 1
fi

# These values exercise the schema only. They are not deployment sizing
# recommendations and never enter the chart defaults or example values.
distributed_args=(
  --set trino.distributed.enabled=true
  --set trino.distributed.workerReplicas=5
  --set trino.distributed.includeCoordinator=false
  --set-string 'trino.distributed.workerNodeSelector.asklake\.io/workload-class=general'
  --set-string 'trino.distributed.workerNodeSelector.kubernetes\.io/arch=amd64'
  --set trino.distributed.workerTerminationGracePeriodSeconds=60
  --set-string trino.distributed.workerResources.requests.cpu=500m
  --set-string trino.distributed.workerResources.requests.memory=1Gi
  --set-string trino.distributed.workerResources.limits.cpu=1
  --set-string trino.distributed.workerResources.limits.memory=2Gi
)

"$HELM_BIN" lint "$CHART_DIR" -f "$VALUES_FILE" >/dev/null
"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" >"$DEFAULT_RENDER"
"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  "${distributed_args[@]}" >"$DISTRIBUTED_RENDER"
"$HELM_BIN" template asklake-airflow "$CHART_DIR" -f "$VALUES_FILE" \
  --set frontend.enabled=false \
  --set backend.enabled=false \
  --set trino.enabled=false >"$AIRFLOW_ONLY_RENDER"

coordinator_block="$(awk 'BEGIN { RS="---" } /kind: Deployment/ && /name: asklake-trino\n/ { print }' "$DISTRIBUTED_RENDER")"
discovery_block="$(awk 'BEGIN { RS="---" } /kind: Service/ && /name: asklake-trino-discovery\n/ { print }' "$DISTRIBUTED_RENDER")"

if grep -q 'name: asklake-trino-worker\|coordinator=false' "$DEFAULT_RENDER"; then
  echo "default render unexpectedly contains a Trino worker" >&2
  exit 1
fi
grep -q 'node-scheduler.include-coordinator=true' "$DEFAULT_RENDER"
grep -q 'discovery.uri=https://127.0.0.1:8443' "$DEFAULT_RENDER"

test "$(grep -c '^  name: asklake-trino-worker$' "$DISTRIBUTED_RENDER")" -eq 1
test "$(grep -c '^  name: asklake-trino-worker-config$' "$DISTRIBUTED_RENDER")" -eq 1
test "$(grep -c '^  name: asklake-trino-discovery$' "$DISTRIBUTED_RENDER")" -eq 1
grep -q '^  replicas: 5$' "$DISTRIBUTED_RENDER"
grep -q '^  strategy:$' <<<"$coordinator_block"
grep -q '^    type: Recreate$' <<<"$coordinator_block"
grep -q 'coordinator=true' "$DISTRIBUTED_RENDER"
grep -q 'node-scheduler.include-coordinator=false' "$DISTRIBUTED_RENDER"
grep -q 'coordinator=false' "$DISTRIBUTED_RENDER"
test "$(grep -c 'discovery.uri=https://asklake-trino-discovery.asklake-dev.svc.cluster.local:8443' "$DISTRIBUTED_RENDER")" -eq 2
if grep -q 'discovery.uri=https://127.0.0.1:8443' "$DISTRIBUTED_RENDER"; then
  echo "distributed render retained localhost discovery" >&2
  exit 1
fi
grep -q '^  clusterIP: None$' <<<"$discovery_block"
grep -q '^  publishNotReadyAddresses: true$' <<<"$discovery_block"
grep -q 'app.kubernetes.io/component: "trino"' <<<"$discovery_block"
test "$(grep -c '^      serviceAccountName: asklake-trino$' "$DISTRIBUTED_RENDER")" -eq 2
test "$(grep -c 'name: asklake-trino-runtime' "$DISTRIBUTED_RENDER")" -ge 10
test "$(grep -c 'asklake.io/trino-role: worker' "$DISTRIBUTED_RENDER")" -eq 1
test "$(grep -c 'app.kubernetes.io/component: "trino"' "$DISTRIBUTED_RENDER")" -ge 3
test "$(grep -c 'app.kubernetes.io/component: "trino-worker"' "$DISTRIBUTED_RENDER")" -ge 2
grep -q 'terminationGracePeriodSeconds: 60' "$DISTRIBUTED_RENDER"
grep -q 'system_information' "$DISTRIBUTED_RENDER"
grep -q '"user": "asklake-materializer", "allow": \["read"\]' "$DISTRIBUTED_RENDER"
grep -q '"user": "asklake-materializer", "catalog": "system", "allow": "read-only"' "$DISTRIBUTED_RENDER"
grep -q '"user": "asklake-materializer", "catalog": "system", "schema": "runtime", "table": "nodes|tasks", "privileges": \["SELECT"\]' "$DISTRIBUTED_RENDER"
if grep -q 'system_information' "$DEFAULT_RENDER"; then
  echo "single-node render changed the proven system-information ACL" >&2
  exit 1
fi
if grep -q '"catalog": "system"' "$DEFAULT_RENDER"; then
  echo "single-node render unexpectedly grants system catalog access" >&2
  exit 1
fi

coordinator_image="$(grep '^          image: ".*/trino@sha256:' "$DISTRIBUTED_RENDER" | head -n 1)"
test -n "$coordinator_image"
test "$(grep -Fxc "$coordinator_image" "$DISTRIBUTED_RENDER")" -eq 2

for shared_key in \
  TRINO_ICEBERG_JDBC_URL TRINO_ICEBERG_JDBC_USER TRINO_ICEBERG_JDBC_PASSWORD \
  TRINO_TLS_KEYSTORE_PASSWORD TRINO_INTERNAL_SHARED_SECRET \
  trino-keystore.jks trino-password.db; do
  test "$(grep -c "$shared_key" "$DISTRIBUTED_RENDER")" -ge 2
done

if grep -Eq '^kind: (HorizontalPodAutoscaler|PodDisruptionBudget|StatefulSet|PersistentVolumeClaim|Secret|Role|RoleBinding)$|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|image: ".+:latest"' "$DISTRIBUTED_RENDER"; then
  echo "distributed render added an unapproved scaling, persistence, credential, or foundation resource" >&2
  exit 1
fi
if grep -q 'asklake-trino-worker\|asklake-trino-config' "$AIRFLOW_ONLY_RENDER"; then
  echo "Airflow-only render unexpectedly contains Trino resources" >&2
  exit 1
fi

expect_rejected() {
  local description="$1"
  shift
  if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" "$@" >/dev/null 2>&1; then
    echo "schema accepted invalid distributed Trino input: $description" >&2
    exit 1
  fi
}

common_worker_args=(
  --set trino.distributed.enabled=true
  --set trino.distributed.includeCoordinator=false
  --set trino.distributed.workerReplicas=5
  --set-string 'trino.distributed.workerNodeSelector.asklake\.io/workload-class=general'
  --set-string 'trino.distributed.workerNodeSelector.kubernetes\.io/arch=amd64'
  --set trino.distributed.workerTerminationGracePeriodSeconds=60
  --set-string trino.distributed.workerResources.requests.cpu=500m
  --set-string trino.distributed.workerResources.requests.memory=1Gi
  --set-string trino.distributed.workerResources.limits.cpu=1
  --set-string trino.distributed.workerResources.limits.memory=2Gi
)

expect_rejected "missing worker replicas" \
  "${common_worker_args[@]:0:4}" "${common_worker_args[@]:6}"
expect_rejected "worker replicas below the fixed live policy" "${common_worker_args[@]}" \
  --set trino.distributed.workerReplicas=4
expect_rejected "worker replicas above the fixed live policy" "${common_worker_args[@]}" \
  --set trino.distributed.workerReplicas=6
expect_rejected "coordinator task scheduling enabled" "${common_worker_args[@]}" \
  --set trino.distributed.includeCoordinator=true
expect_rejected "missing worker node selector" \
  --set trino.distributed.enabled=true \
  --set trino.distributed.includeCoordinator=false \
  --set trino.distributed.workerReplicas=5 \
  --set trino.distributed.workerTerminationGracePeriodSeconds=60 \
  --set-string trino.distributed.workerResources.requests.cpu=500m \
  --set-string trino.distributed.workerResources.requests.memory=1Gi \
  --set-string trino.distributed.workerResources.limits.cpu=1 \
  --set-string trino.distributed.workerResources.limits.memory=2Gi
expect_rejected "invalid worker placement" "${common_worker_args[@]}" \
  --set-string 'trino.distributed.workerNodeSelector.asklake\.io/workload-class=spark'
expect_rejected "zero termination grace" "${common_worker_args[@]}" \
  --set trino.distributed.workerTerminationGracePeriodSeconds=0
expect_rejected "invalid worker CPU quantity" "${common_worker_args[@]}" \
  --set-string trino.distributed.workerResources.requests.cpu=banana
expect_rejected "invalid worker memory quantity" "${common_worker_args[@]}" \
  --set-string trino.distributed.workerResources.requests.memory=wat
expect_rejected "missing worker resource limit" \
  --set trino.distributed.enabled=true \
  --set trino.distributed.includeCoordinator=false \
  --set trino.distributed.workerReplicas=5 \
  --set-string 'trino.distributed.workerNodeSelector.asklake\.io/workload-class=general' \
  --set-string 'trino.distributed.workerNodeSelector.kubernetes\.io/arch=amd64' \
  --set trino.distributed.workerTerminationGracePeriodSeconds=60 \
  --set-string trino.distributed.workerResources.requests.cpu=500m \
  --set-string trino.distributed.workerResources.requests.memory=1Gi \
  --set-string trino.distributed.workerResources.limits.cpu=1
expect_rejected "worker inputs while distributed mode is disabled" \
  --set trino.distributed.workerReplicas=5
expect_rejected "Trino Service name drift" \
  --set trino.service.name=another-trino
expect_rejected "Trino Service port drift" \
  --set trino.service.port=9443

bash -n "$ROOT_DIR/scripts/verify-eks-trino-distributed.sh"
bash -n "$ROOT_DIR/scripts/deploy-eks-trino-distributed.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-trino-distributed-live.sh"
python3 -m py_compile "$ROOT_DIR/scripts/lib/verify_eks_trino_active_workers.py"

deploy_script="$ROOT_DIR/scripts/deploy-eks-trino-distributed.sh"
grep -Fq "jq -eS '.trino.distributed = {enabled:false}' \"\$live_values\" >\"\$single_values\"" "$deploy_script"
test "$(grep -Fc -- '-f "$BASE_VALUES" -f "$single_values"' "$deploy_script")" -eq 4
grep -Fq 'safe single-coordinator candidate contains distributed resources' "$deploy_script"
jq -n '{sentinel:"preserved",trino:{distributed:{enabled:true,workerReplicas:5,includeCoordinator:false}}}' >"$SINGLE_VALUES_SAMPLE"
jq -eS '.trino.distributed = {enabled:false}' "$SINGLE_VALUES_SAMPLE" >"$SINGLE_VALUES_RESULT"
jq -e '.sentinel == "preserved" and .trino.distributed == {enabled:false}' "$SINGLE_VALUES_RESULT" >/dev/null
echo "EKS distributed Trino static verification passed."
