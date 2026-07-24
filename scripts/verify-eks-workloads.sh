#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-workloads"
RUNTIME_CONFIG_CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-runtime-config"
VALUES_FILE="$ROOT_DIR/infra/eks/values/workloads/dev.example.yaml"
RENDERED_FILE="$(mktemp)"
OPT_IN_RENDERED_FILE="$(mktemp)"
AIRFLOW_ONLY_RENDERED_FILE="$(mktemp)"
GATEWAY_RENDERED_FILE="$(mktemp)"
AIRFLOW_TOKEN_RENDERED_FILE="$(mktemp)"
REALTIME_V1_RENDERED_FILE="$(mktemp)"
trap 'rm -f "$RENDERED_FILE" "$OPT_IN_RENDERED_FILE" "$AIRFLOW_ONLY_RENDERED_FILE" "$GATEWAY_RENDERED_FILE" "$AIRFLOW_TOKEN_RENDERED_FILE" "$REALTIME_V1_RENDERED_FILE"' EXIT

required_files=(
  "$ROOT_DIR/.github/workflows/eks-b-workload-checks.yml"
  "$ROOT_DIR/airflow/Dockerfile"
  "$ROOT_DIR/backend/scripts/spark-kubernetes-client.mjs"
  "$ROOT_DIR/backend/scripts/spark-kubernetes-client.test.mjs"
  "$ROOT_DIR/backend/spark-msk-iam-shaded/pom.xml"
  "$ROOT_DIR/backend/scripts/kafka_fixture_boundary.py"
  "$ROOT_DIR/backend/scripts/spark_job_run.py"
  "$ROOT_DIR/backend/scripts/runtime/kafka_source.py"
  "$ROOT_DIR/backend/scripts/runtime/spark_job_runtime.py"
  "$ROOT_DIR/backend/scripts/verify-msk-iam-metadata.mjs"
  "$ROOT_DIR/backend/tests/test_kafka_fixture_boundary.py"
  "$ROOT_DIR/backend/tests/test_continuous_worker_scope.py"
  "$ROOT_DIR/deploy/profiles/realtime-v1-only.yaml"
  "$ROOT_DIR/scripts/build-eks-spark-resource-planner-off-values.mjs"
  "$ROOT_DIR/scripts/build-eks-spark-resource-planner-off-web-values.mjs"
  "$ROOT_DIR/scripts/build-eks-spark-resource-planner-shadow-values.mjs"
  "$ROOT_DIR/scripts/build-eks-spark-resource-planner-shadow-web-values.mjs"
  "$ROOT_DIR/scripts/build-eks-spark-resource-planner-enforce-values.mjs"
  "$ROOT_DIR/scripts/build-eks-spark-resource-planner-enforce-web-values.mjs"
  "$ROOT_DIR/scripts/build-eks-spark-hybrid-activation-values.mjs"
  "$ROOT_DIR/scripts/deploy-eks-spark-hybrid-activation.sh"
  "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-off-values.sh"
  "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-off-web-values.sh"
  "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-shadow-values.sh"
  "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-shadow-web-values.sh"
  "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-enforce-values.sh"
  "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-enforce-web-values.sh"
  "$ROOT_DIR/scripts/prepare-eks-spark-hybrid-activation-values.sh"
  "$ROOT_DIR/scripts/preflight-eks-spark-resource-planner-shadow.sh"
  "$ROOT_DIR/scripts/test-eks-spark-resource-planner-off-values.mjs"
  "$ROOT_DIR/scripts/test-eks-spark-resource-planner-enforce-values.mjs"
  "$ROOT_DIR/scripts/verify-eks-spark-resource-planner-shadow-evidence.mjs"
  "$ROOT_DIR/scripts/test-eks-spark-resource-planner-shadow-values.mjs"
  "$ROOT_DIR/scripts/test-eks-spark-resource-planner-shadow-web-values.mjs"
  "$ROOT_DIR/scripts/test-eks-spark-resource-planner-shadow-evidence.mjs"
  "$ROOT_DIR/scripts/test-eks-spark-hybrid-activation-values.mjs"
  "$CHART_DIR/Chart.yaml"
  "$CHART_DIR/values.yaml"
  "$CHART_DIR/values.schema.json"
  "$CHART_DIR/templates/airflow-configmap.yaml"
  "$CHART_DIR/templates/airflow-deployments.yaml"
  "$CHART_DIR/templates/airflow-migration-job.yaml"
  "$CHART_DIR/templates/airflow-service.yaml"
  "$CHART_DIR/templates/backend-configmap.yaml"
  "$CHART_DIR/templates/backend-deployment.yaml"
  "$CHART_DIR/templates/backend-service.yaml"
  "$CHART_DIR/templates/frontend-deployment.yaml"
  "$CHART_DIR/templates/frontend-service.yaml"
  "$CHART_DIR/templates/msk-smoke-job.yaml"
  "$CHART_DIR/templates/realtime-v1-worker.yaml"
  "$CHART_DIR/templates/sparkapplication.yaml"
  "$CHART_DIR/templates/trino-configmap.yaml"
  "$CHART_DIR/templates/trino-deployment.yaml"
  "$CHART_DIR/templates/trino-discovery-service.yaml"
  "$CHART_DIR/templates/trino-service.yaml"
  "$CHART_DIR/templates/trino-worker-deployment.yaml"
  "$ROOT_DIR/scripts/deploy-eks-trino-distributed.sh"
  "$ROOT_DIR/scripts/lib/verify_eks_trino_active_workers.py"
  "$ROOT_DIR/scripts/verify-eks-trino-distributed-live.sh"
  "$ROOT_DIR/scripts/verify-eks-realtime-v1-only-profile.sh"
  "$VALUES_FILE"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "$required_file" ]]; then
    echo "missing required EKS workload file: $required_file" >&2
    exit 1
  fi
done

HELM_BIN="${ASKLAKE_HELM_BIN:-}"
if [[ -z "$HELM_BIN" ]] && command -v helm >/dev/null 2>&1; then
  HELM_BIN="$(command -v helm)"
fi
if [[ -z "$HELM_BIN" || ! -x "$HELM_BIN" ]]; then
  echo "helm is required to verify the EKS workload chart" >&2
  exit 1
fi

PYTHON_BIN="${ASKLAKE_FASTAPI_PYTHON:-}"
if [[ -z "$PYTHON_BIN" && -x "$ROOT_DIR/backend/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT_DIR/backend/.venv/bin/python"
fi
PYTHON_BIN="${PYTHON_BIN:-python3}"

"$HELM_BIN" lint "$CHART_DIR" -f "$VALUES_FILE"
"$HELM_BIN" template asklake-runtime-config "$RUNTIME_CONFIG_CHART_DIR" \
  --set-string configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE=off \
  --set-string configMap.data.ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES=134217728 \
  --set-string configMap.data.ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR=384 \
  --set-string configMap.data.ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS=1 \
  --set-string configMap.data.ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS=4 \
  --set-string configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES=1 >/dev/null
"$HELM_BIN" template asklake-runtime-config "$RUNTIME_CONFIG_CHART_DIR" \
  --set-string configMap.data.ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES=10737418240 >/dev/null
if "$HELM_BIN" template asklake-runtime-config "$RUNTIME_CONFIG_CHART_DIR" \
  --set-string configMap.data.ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES=10737418241 >/dev/null 2>&1; then
  echo "runtime ConfigMap schema accepted an unvalidated direct-cache threshold" >&2
  exit 1
fi
if "$HELM_BIN" template asklake-runtime-config "$RUNTIME_CONFIG_CHART_DIR" \
  --set-string configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE=invalid >/dev/null 2>&1; then
  echo "runtime ConfigMap schema accepted an invalid Spark Resource Planner mode" >&2
  exit 1
fi
if "$HELM_BIN" template asklake-runtime-config "$RUNTIME_CONFIG_CHART_DIR" \
  --set-string configMap.data.ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS=5 >/dev/null 2>&1; then
  echo "runtime ConfigMap schema accepted a Spark Resource Planner maximum above four" >&2
  exit 1
fi
if "$HELM_BIN" template asklake-runtime-config "$RUNTIME_CONFIG_CHART_DIR" \
  --set-string configMap.data.ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR=96 >/dev/null 2>&1; then
  echo "runtime ConfigMap schema accepted a non-balanced-v1 partition budget" >&2
  exit 1
fi
"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" >"$RENDERED_FILE"
"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set mskSmoke.create=true \
  --set sparkApplication.create=true \
  --set-string sparkApplication.runId=run-eks-contract-001 \
  --set-string sparkApplication.jobId=job-eks-contract-001 \
  --set-string sparkApplication.kafka.fixtureBatchId=eks-smoke-batch-001 >"$OPT_IN_RENDERED_FILE"
"$HELM_BIN" template asklake-airflow "$CHART_DIR" -f "$VALUES_FILE" \
  --set frontend.enabled=false \
  --set backend.enabled=false \
  --set trino.enabled=false >"$AIRFLOW_ONLY_RENDERED_FILE"
"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set realtimeV1.enabled=true \
  --set realtimeV1.ownerTransfer.approved=true \
  --set realtimeV1.ownerTransfer.previousOwnerFenced=true \
  --set-string realtimeV1.ownerTransfer.generation=eks-v1-contract-g1 >"$REALTIME_V1_RENDERED_FILE"

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set realtimeV1.enabled=true >/dev/null 2>&1; then
  echo "Realtime V1 rendered without owner-transfer approval and EC2 fence" >&2
  exit 1
fi

if ! "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set realtimeV1.enabled=true \
  --set realtimeV1.ownerTransfer.approved=true \
  --set realtimeV1.ownerTransfer.previousOwnerFenced=true \
  --set-string realtimeV1.ownerTransfer.generation=eks-v1-contract-g1 \
  --set backend.enabled=false >/dev/null 2>&1; then
  echo "Realtime V1 could not render as an independent release with the foundation runtime ConfigMap" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set realtimeV1.enabled=true \
  --set realtimeV1.ownerTransfer.approved=true >/dev/null 2>&1; then
  echo "Realtime V1 rendered without proof that the previous EC2 owner is fenced" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set realtimeV1.enabled=true \
  --set realtimeV1.ownerTransfer.approved=true \
  --set realtimeV1.ownerTransfer.previousOwnerFenced=true >/dev/null 2>&1; then
  echo "Realtime V1 rendered without an owner generation" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.config.sparkRunner=rest >/dev/null 2>&1; then
  echo "EKS workload schema accepted a non-Kubernetes Spark runner" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.config.sparkResourcePlannerMode=invalid >/dev/null 2>&1; then
  echo "EKS workload schema accepted an invalid Spark Resource Planner mode" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.config.sparkResourceMaxExecutors=5 >/dev/null 2>&1; then
  echo "EKS workload schema accepted a Spark Resource Planner maximum above four" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.config.sparkResourceTargetPartitionsPerExecutor=96 >/dev/null 2>&1; then
  echo "EKS workload schema accepted a non-balanced-v1 partition budget" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.config.trinoBaseUrl=http://trino:8080 >/dev/null 2>&1; then
  echo "EKS workload schema accepted a non-HTTPS Trino endpoint" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set frontend.image.digest=latest >/dev/null 2>&1; then
  echo "EKS workload schema accepted a mutable image reference" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set-string 'frontend.nodeSelector.kubernetes\.io/arch=arm64' >/dev/null 2>&1; then
  echo "EKS workload schema accepted an ARM64 Frontend node selector" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set-string 'backend.nodeSelector.kubernetes\.io/arch=arm64' >/dev/null 2>&1; then
  echo "EKS workload schema accepted an ARM64 Backend node selector" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set-string 'airflow.nodeSelector.asklake\.io/workload-class=spark' >/dev/null 2>&1; then
  echo "EKS workload schema accepted a non-General Airflow node selector" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set-string 'trino.nodeSelector.asklake\.io/workload-class=spark' >/dev/null 2>&1; then
  echo "EKS workload schema accepted a non-General Trino node selector" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set-string 'sparkApplication.nodeSelector.asklake\.io/workload-class=general' >/dev/null 2>&1; then
  echo "EKS workload schema accepted a non-Spark SparkApplication node selector" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set-string 'sparkApplication.nodeSelector.kubernetes\.io/arch=arm64' >/dev/null 2>&1; then
  echo "EKS workload schema accepted an ARM64 SparkApplication node selector" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set-string 'sparkApplication.tolerations[0].effect=PreferNoSchedule' >/dev/null 2>&1; then
  echo "EKS workload schema accepted a non-NoSchedule Spark toleration" >&2
  exit 1
fi

if ! "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set sparkApplication.executor.instances=4 >/dev/null 2>&1; then
  echo "EKS workload schema rejected the bounded four-executor experiment" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set sparkApplication.executor.instances=5 >/dev/null 2>&1; then
  echo "EKS workload schema accepted more than four Spark executors" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set frontend.service.name=asklake-frontend >/dev/null 2>&1; then
  echo "EKS workload schema accepted a frontend Service name that drifts from the foundation handoff" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.service.name=asklake-backend >/dev/null 2>&1; then
  echo "EKS workload schema accepted a backend Service name that drifts from the foundation handoff" >&2
  exit 1
fi

test "$(grep -c '^kind: Deployment$' "$RENDERED_FILE")" -eq 6
test "$(grep -c '^kind: Service$' "$RENDERED_FILE")" -eq 4
test "$(grep -c '^kind: ConfigMap$' "$RENDERED_FILE")" -eq 3
test "$(grep -c '^kind: Role$' "$RENDERED_FILE" || true)" -eq 0
test "$(grep -c '^kind: RoleBinding$' "$RENDERED_FILE" || true)" -eq 0
test "$(grep -c '^kind: Job$' "$RENDERED_FILE")" -eq 1
test "$(grep -c '^kind: SparkApplication$' "$RENDERED_FILE" || true)" -eq 0
test "$(grep -c '^kind: Job$' "$OPT_IN_RENDERED_FILE")" -eq 2
test "$(grep -c '^kind: SparkApplication$' "$OPT_IN_RENDERED_FILE")" -eq 1
test "$(grep -c '^kind: Deployment$' "$AIRFLOW_ONLY_RENDERED_FILE")" -eq 3
test "$(grep -c '^kind: Service$' "$AIRFLOW_ONLY_RENDERED_FILE")" -eq 1
test "$(grep -c '^kind: ConfigMap$' "$AIRFLOW_ONLY_RENDERED_FILE")" -eq 1
test "$(grep -c '^kind: Job$' "$AIRFLOW_ONLY_RENDERED_FILE")" -eq 1
test "$(grep -c '^kind: SparkApplication$' "$AIRFLOW_ONLY_RENDERED_FILE" || true)" -eq 0
test "$(grep -c '^kind: Deployment$' "$REALTIME_V1_RENDERED_FILE")" -eq 7
test "$(grep -c '^kind: StatefulSet$' "$REALTIME_V1_RENDERED_FILE" || true)" -eq 0
test "$(grep -c '^kind: PersistentVolumeClaim$' "$REALTIME_V1_RENDERED_FILE" || true)" -eq 0
test "$(grep -c 'name: asklake-realtime-v1-worker$' "$REALTIME_V1_RENDERED_FILE")" -eq 1

for resource_name in asklake-frontend asklake-backend asklake-trino frontend fastapi asklake-trino; do
  if grep -q "name: $resource_name" "$AIRFLOW_ONLY_RENDERED_FILE"; then
    echo "Airflow-only render unexpectedly contains $resource_name" >&2
    exit 1
  fi
done

for resource_name in \
  asklake-airflow-apiserver asklake-airflow-scheduler asklake-airflow-dag-processor \
  asklake-airflow-db-migrate airflow-apiserver; do
  grep -q "name: $resource_name" "$AIRFLOW_ONLY_RENDERED_FILE"
done

for resource_name in \
  asklake-frontend asklake-backend \
  asklake-airflow-apiserver asklake-airflow-scheduler asklake-airflow-dag-processor \
  asklake-airflow-db-migrate asklake-trino; do
  grep -q "name: $resource_name" "$RENDERED_FILE"
done

for service_name in frontend fastapi airflow-apiserver asklake-trino; do
  grep -q "name: $service_name" "$RENDERED_FILE"
done

for service_account in \
  asklake-frontend asklake-backend asklake-airflow asklake-msk-smoke asklake-spark asklake-trino; do
  grep -q "serviceAccountName: $service_account\|name: $service_account" "$OPT_IN_RENDERED_FILE"
done

test "$(grep -c 'path: /api/health' "$RENDERED_FILE")" -eq 2
test "$(grep -c 'kubernetes.io/arch: amd64' "$RENDERED_FILE")" -eq 7
test "$(grep -c 'asklake.io/workload-class: general' "$RENDERED_FILE")" -eq 5
test "$(grep -c 'kubernetes.io/arch: amd64' "$AIRFLOW_ONLY_RENDERED_FILE")" -eq 4
test "$(grep -c 'asklake.io/workload-class: general' "$AIRFLOW_ONLY_RENDERED_FILE")" -eq 4
grep -q 'tcpSocket:' "$RENDERED_FILE"
grep -q 'app.kubernetes.io/name: asklake-workloads' "$RENDERED_FILE"
grep -q 'app.kubernetes.io/instance: "asklake-workloads"' "$RENDERED_FILE"
grep -q 'path: /api/v2/monitor/health' "$RENDERED_FILE"
grep -q 'name: asklake-rds-ca' "$AIRFLOW_ONLY_RENDERED_FILE"
grep -q 'key: ap-northeast-2-bundle.pem' "$AIRFLOW_ONLY_RENDERED_FILE"
grep -q 'mountPath: "/var/run/asklake/rds-ca"' "$AIRFLOW_ONLY_RENDERED_FILE"
grep -q 'key: AIRFLOW_PASSWORD' "$AIRFLOW_ONLY_RENDERED_FILE"
grep -q 'airflow users create' "$AIRFLOW_ONLY_RENDERED_FILE"
grep -q 'airflow users reset-password' "$AIRFLOW_ONLY_RENDERED_FILE"
grep -q 'name: AIRFLOW__CORE__AUTH_MANAGER' "$AIRFLOW_ONLY_RENDERED_FILE"
grep -q 'value: "airflow.providers.fab.auth_manager.fab_auth_manager.FabAuthManager"' "$AIRFLOW_ONLY_RENDERED_FILE"
grep -q 'path: /v1/info' "$RENDERED_FILE"
grep -q 'ASKLAKE_CONTINUOUS_CONTROL_PLANE: "external_ec2"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_EXECUTION_LEASE_SECONDS: "60"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "off"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES: "134217728"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR: "384"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS: "1"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS: "4"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS: "7200"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_RUNNER: "kubernetes"' "$RENDERED_FILE"
grep -q 'ASKLAKE_KAFKA_AUTH_MODE: "iam"' "$RENDERED_FILE"
grep -q 'TRINO_BASE_URL: "https://asklake-trino.asklake-dev.svc.cluster.local:8443"' "$RENDERED_FILE"
grep -q 'TRINO_TLS_CA_FILE: "/var/run/asklake/secrets/trino-ca.pem"' "$RENDERED_FILE"
grep -q 'discovery.uri=https://127.0.0.1:8443' "$RENDERED_FILE"
grep -q '"helm.sh/hook": pre-install,pre-upgrade' "$RENDERED_FILE"
grep -q 'kind: SparkApplication' "$OPT_IN_RENDERED_FILE"
test "$(grep -c '^    serviceAccount: asklake-spark$' "$OPT_IN_RENDERED_FILE")" -eq 2
test "$(grep -c '^      asklake.io/workload-class: spark$' "$OPT_IN_RENDERED_FILE")" -eq 2
test "$(grep -c '^      kubernetes.io/arch: amd64$' "$OPT_IN_RENDERED_FILE")" -eq 2
test "$(grep -c '^        value: spark$' "$OPT_IN_RENDERED_FILE")" -eq 2
test "$(grep -c '^      - effect: NoSchedule$' "$OPT_IN_RENDERED_FILE")" -eq 2
grep -q 'mainApplicationFile: "local:///opt/asklake/scripts/spark_job_run.py"' "$OPT_IN_RENDERED_FILE"
grep -q 'local:///opt/asklake/jars/aws-msk-iam-auth-2.3.6-asklake-shaded.jar' "$OPT_IN_RENDERED_FILE"
if grep -q 'software.amazon.msk:aws-msk-iam-auth' "$OPT_IN_RENDERED_FILE"; then
  echo "SparkApplication rendered the unshaded MSK IAM Maven package" >&2
  exit 1
fi
grep -q 'ASKLAKE_SPARK_MSK_IAM_AUTH_JAR' "$RENDERED_FILE"
grep -q 'option("kafka.sasl.mechanism", "AWS_MSK_IAM")' "$ROOT_DIR/backend/scripts/runtime/kafka_source.py"
grep -q 'software.amazon.msk.auth.iam.IAMClientCallbackHandler' "$ROOT_DIR/backend/scripts/runtime/kafka_source.py"
grep -q '<pattern>software.amazon.awssdk</pattern>' "$ROOT_DIR/backend/spark-msk-iam-shaded/pom.xml"
grep -q '<shadedPattern>com.asklake.spark.msk.shadow.software.amazon.awssdk</shadedPattern>' \
  "$ROOT_DIR/backend/spark-msk-iam-shaded/pom.xml"
grep -q '<pattern>io.netty</pattern>' "$ROOT_DIR/backend/spark-msk-iam-shaded/pom.xml"
grep -q '<shadedPattern>com.asklake.spark.msk.shadow.io.netty</shadedPattern>' \
  "$ROOT_DIR/backend/spark-msk-iam-shaded/pom.xml"
grep -q '"spark.jars.ivy": "/tmp/.ivy2"' "$OPT_IN_RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_SOURCE_FORMAT' "$OPT_IN_RENDERED_FILE"
grep -q 'value: "kafka"' "$OPT_IN_RENDERED_FILE"
grep -q 'ASKLAKE_KAFKA_FIXTURE_BATCH_ID' "$OPT_IN_RENDERED_FILE"
grep -q 'eks-smoke-batch-001' "$OPT_IN_RENDERED_FILE"
grep -q 'ASKLAKE_KAFKA_EXPECTED_COUNT' "$OPT_IN_RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_OUTPUT_PATH' "$OPT_IN_RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_CHECKPOINT_PATH' "$OPT_IN_RENDERED_FILE"
grep -q 'eks-mvp/checkpoints/run-eks-contract-001' "$OPT_IN_RENDERED_FILE"
grep -q 'consumerGroup' "$OPT_IN_RENDERED_FILE"
grep -q 'expectedCount' "$OPT_IN_RENDERED_FILE"
grep -q 'coreRequest: "1"' "$OPT_IN_RENDERED_FILE"
grep -q 'coreLimit: "2"' "$OPT_IN_RENDERED_FILE"
grep -q 'memoryOverhead: "512m"' "$OPT_IN_RENDERED_FILE"
grep -q 'coreRequest: "2"' "$OPT_IN_RENDERED_FILE"
grep -q 'coreLimit: "3"' "$OPT_IN_RENDERED_FILE"
grep -q 'memoryOverhead: "1g"' "$OPT_IN_RENDERED_FILE"
grep -q 'icebergTarget' "$OPT_IN_RENDERED_FILE"
grep -q 'iceberg://iceberg/asklake/eks_mvp_fixture' "$OPT_IN_RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_ICEBERG_CATALOG_NAME' "$OPT_IN_RENDERED_FILE"
grep -q 'software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider' "$OPT_IN_RENDERED_FILE"
grep -q 'asklake.io/selected-path: v1-spark-structured-streaming' "$REALTIME_V1_RENDERED_FILE"
grep -q 'asklake.io/owner-generation: "eks-v1-contract-g1"' "$REALTIME_V1_RENDERED_FILE"
grep -q 'asklake.io/previous-owner-fenced: "true"' "$REALTIME_V1_RENDERED_FILE"
grep -q 'asklake.io/topic-prefix: "asklake.eks-realtime.fixture"' "$REALTIME_V1_RENDERED_FILE"
grep -q 'asklake.io/consumer-group-prefix: "asklake-eks-realtime-v1"' "$REALTIME_V1_RENDERED_FILE"
grep -q 'name: CONTINUOUS_WORKER_SCOPE' "$REALTIME_V1_RENDERED_FILE"
grep -q 'value: "all"' "$REALTIME_V1_RENDERED_FILE"
grep -q 'name: CONTINUOUS_WORKER_OWNER' "$REALTIME_V1_RENDERED_FILE"
grep -q 'value: "eks-continuous-worker-v1"' "$REALTIME_V1_RENDERED_FILE"
grep -q 'name: CONTINUOUS_WORKER_GENERATION' "$REALTIME_V1_RENDERED_FILE"
grep -q 'name: ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX' "$REALTIME_V1_RENDERED_FILE"
grep -q 's3a://asklake-dev-output-example/continuous-runtime' "$REALTIME_V1_RENDERED_FILE"
grep -q 'serviceAccountName: asklake-realtime-v1-worker' "$REALTIME_V1_RENDERED_FILE"
grep -q 'name: asklake-runtime' "$REALTIME_V1_RENDERED_FILE"
grep -q 'value: "asklake-realtime-v1-spark"' "$REALTIME_V1_RENDERED_FILE"
for jdbc_alias in TRINO_ICEBERG_JDBC_URL TRINO_ICEBERG_JDBC_USER TRINO_ICEBERG_JDBC_PASSWORD; do
  grep -A5 "name: $jdbc_alias" "$REALTIME_V1_RENDERED_FILE" | grep -q 'name: asklake-spark-runtime'
done
grep -A5 'name: TRINO_ICEBERG_JDBC_URL' "$REALTIME_V1_RENDERED_FILE" | grep -q 'key: ASKLAKE_SPARK_ICEBERG_JDBC_URL'
grep -A5 'name: TRINO_ICEBERG_JDBC_USER' "$REALTIME_V1_RENDERED_FILE" | grep -q 'key: ASKLAKE_SPARK_ICEBERG_JDBC_USER'
grep -A5 'name: TRINO_ICEBERG_JDBC_PASSWORD' "$REALTIME_V1_RENDERED_FILE" | grep -q 'key: ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD'
grep -q 'name: ASKLAKE_KAFKA_AUTH_MODE' "$REALTIME_V1_RENDERED_FILE"
grep -q 'value: "local:///opt/asklake/scripts/kafka_continuous_stream.py"' "$REALTIME_V1_RENDERED_FILE"
grep -q 'local:///opt/asklake/jars/aws-msk-iam-auth-2.3.6-asklake-shaded.jar' "$REALTIME_V1_RENDERED_FILE"
if grep -Eq '^kind: (StatefulSet|PersistentVolumeClaim)$' "$REALTIME_V1_RENDERED_FILE"; then
  echo "selected V1 render unexpectedly contains a stateful data-plane workload" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set sparkApplication.create=true \
  --set-string sparkApplication.runId=run-eks-contract-001 \
  --set-string sparkApplication.jobId=job-eks-contract-001 \
  --set-string sparkApplication.kafka.fixtureBatchId=eks-smoke-batch-001 \
  --set-string sparkApplication.output.prefix=continuous/output >/dev/null 2>&1; then
  echo "EKS workload schema accepted an output prefix outside the bounded fixture contract" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set sparkApplication.create=true \
  --set-string sparkApplication.runId=run-eks-contract-001 \
  --set-string sparkApplication.jobId=job-eks-contract-001 \
  --set-string sparkApplication.kafka.fixtureBatchId=eks-smoke-batch-001 \
  --set-string sparkApplication.checkpoint.prefix=continuous/checkpoints >/dev/null 2>&1; then
  echo "EKS workload schema accepted a checkpoint prefix outside the bounded fixture contract" >&2
  exit 1
fi

grep -q 'option("startingOffsets", "earliest")' "$ROOT_DIR/backend/scripts/runtime/spark_job_runtime.py"
grep -q 'option("endingOffsets", "latest")' "$ROOT_DIR/backend/scripts/runtime/spark_job_runtime.py"
grep -q 'software.amazon.msk.auth.iam.IAMClientCallbackHandler' "$ROOT_DIR/backend/scripts/runtime/spark_job_runtime.py"
grep -q 'Kafka fixture batch filter requires raw.fixture_batch_id' "$ROOT_DIR/backend/scripts/runtime/spark_job_runtime.py"
grep -q 'validate_kafka_fixture_row_count' "$ROOT_DIR/backend/scripts/runtime/spark_job_runtime.py"
grep -q 'platforms: linux/amd64' "$ROOT_DIR/.github/workflows/eks-b-workload-checks.yml"
grep -q 'npm run test:spark-kubernetes' "$ROOT_DIR/.github/workflows/eks-b-workload-checks.yml"

for secret_name in asklake-backend-runtime asklake-airflow-runtime asklake-spark-runtime asklake-trino-runtime; do
  grep -q "name: $secret_name\|secretName: $secret_name" "$OPT_IN_RENDERED_FILE"
done

for required_key in \
  DATABASE_URL BOOTSTRAP_ADMIN_PASSWORD OPENAI_API_KEY AIRFLOW_PASSWORD \
  AIRFLOW_EXECUTION_API_TOKEN AIRFLOW_INTERNAL_TOKEN TRINO_AUTH_USERNAME TRINO_AUTH_PASSWORD \
  TRINO_MATERIALIZER_USERNAME TRINO_MATERIALIZER_PASSWORD TRINO_RESULT_CURSOR_SECRET \
  TRINO_QUERY_CONFIRMATION_SECRET trino-ca.pem AIRFLOW__DATABASE__SQL_ALCHEMY_CONN \
  AIRFLOW__CORE__FERNET_KEY AIRFLOW__API_AUTH__JWT_SECRET ASKLAKE_SPARK_ICEBERG_JDBC_URL \
  ASKLAKE_SPARK_ICEBERG_JDBC_USER ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD \
  TRINO_ICEBERG_JDBC_URL TRINO_ICEBERG_JDBC_USER TRINO_ICEBERG_JDBC_PASSWORD \
  TRINO_TLS_KEYSTORE_PASSWORD TRINO_INTERNAL_SHARED_SECRET trino-keystore.jks trino-password.db; do
  grep -q "$required_key" "$OPT_IN_RENDERED_FILE"
done

if grep -Eq 'AI_GATEWAY_SERVICE_TOKEN|AI_MCP_SERVICE_TOKEN|AI_CONTEXT_SIGNING_SECRET|name: AIRFLOW_API_TOKEN' \
  "$OPT_IN_RENDERED_FILE"; then
  echo "default direct/username-password Backend render references an unselected Secret key" >&2
  exit 1
fi

"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.config.aiQueryProvider=gateway >"$GATEWAY_RENDERED_FILE"
for gateway_key in AI_GATEWAY_SERVICE_TOKEN AI_MCP_SERVICE_TOKEN AI_CONTEXT_SIGNING_SECRET OPENAI_API_KEY; do
  grep -q "$gateway_key" "$GATEWAY_RENDERED_FILE"
done
grep -q 'name: AIRFLOW_PASSWORD' "$GATEWAY_RENDERED_FILE"
if grep -q 'name: AIRFLOW_API_TOKEN' "$GATEWAY_RENDERED_FILE"; then
  echo "gateway selection changed the independent Airflow auth profile" >&2
  exit 1
fi

"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.config.airflowApiAuthMode=api_token >"$AIRFLOW_TOKEN_RENDERED_FILE"
grep -q 'name: AIRFLOW_API_TOKEN' "$AIRFLOW_TOKEN_RENDERED_FILE"
if grep -q 'name: AIRFLOW_PASSWORD' "$AIRFLOW_TOKEN_RENDERED_FILE"; then
  echo "Airflow API token profile retained the Backend password-only key" >&2
  exit 1
fi

image_count="$(grep -c '^ *image: ".*"$' "$OPT_IN_RENDERED_FILE")"
digest_image_count="$(grep -Ec '^ *image: ".+@sha256:[0-9a-f]{64}"$' "$OPT_IN_RENDERED_FILE")"
test "$image_count" -eq "$digest_image_count"

if grep -Eq '^kind: (Role|RoleBinding|Secret|StatefulSet|PersistentVolumeClaim)$|efs\.csi\.aws\.com|type: LoadBalancer|asklake-replay-producer|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|image: ".+:latest"' "$OPT_IN_RENDERED_FILE"; then
  echo "rendered EKS workload contains foundation-owned RBAC, excluded persistent/external resources, a mutable image, or a credential field" >&2
  exit 1
fi

if grep -Eq 'resources: \["secrets"\]|resources: \["jobs"\]' "$RENDERED_FILE"; then
  echo "application RBAC grants forbidden Secret or batch Job access" >&2
  exit 1
fi

bash -n "$ROOT_DIR/scripts/verify-eks-workloads.sh"
bash -n "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-off-values.sh"
bash -n "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-off-web-values.sh"
bash -n "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-shadow-values.sh"
bash -n "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-shadow-web-values.sh"
bash -n "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-enforce-values.sh"
bash -n "$ROOT_DIR/scripts/prepare-eks-spark-resource-planner-enforce-web-values.sh"
bash -n "$ROOT_DIR/scripts/prepare-eks-spark-hybrid-activation-values.sh"
bash -n "$ROOT_DIR/scripts/deploy-eks-spark-hybrid-activation.sh"
grep -q 'wait_for_alb_steady' "$ROOT_DIR/scripts/deploy-eks-spark-hybrid-activation.sh"
grep -q 'ASKLAKE_ALB_STEADY_TIMEOUT_SECONDS:-600' "$ROOT_DIR/scripts/deploy-eks-spark-hybrid-activation.sh"
grep -q 'ALB_STEADY_REQUIRED_SUCCESSES=3' "$ROOT_DIR/scripts/deploy-eks-spark-hybrid-activation.sh"
bash -n "$ROOT_DIR/scripts/preflight-eks-spark-resource-planner-shadow.sh"
node --check "$ROOT_DIR/scripts/build-eks-spark-hybrid-activation-values.mjs"
node --check "$ROOT_DIR/scripts/build-eks-spark-resource-planner-off-values.mjs"
node --check "$ROOT_DIR/scripts/build-eks-spark-resource-planner-off-web-values.mjs"
node --check "$ROOT_DIR/scripts/build-eks-spark-resource-planner-shadow-values.mjs"
node --check "$ROOT_DIR/scripts/build-eks-spark-resource-planner-shadow-web-values.mjs"
node --check "$ROOT_DIR/scripts/build-eks-spark-resource-planner-enforce-values.mjs"
node --check "$ROOT_DIR/scripts/build-eks-spark-resource-planner-enforce-web-values.mjs"
node --check "$ROOT_DIR/scripts/verify-eks-spark-resource-planner-shadow-evidence.mjs"
node --test \
  "$ROOT_DIR/scripts/test-eks-spark-hybrid-activation-values.mjs" \
  "$ROOT_DIR/scripts/test-eks-spark-resource-planner-off-values.mjs" \
  "$ROOT_DIR/scripts/test-eks-spark-resource-planner-enforce-values.mjs" \
  "$ROOT_DIR/scripts/test-eks-spark-resource-planner-shadow-values.mjs" \
  "$ROOT_DIR/scripts/test-eks-spark-resource-planner-shadow-web-values.mjs" \
  "$ROOT_DIR/scripts/test-eks-spark-resource-planner-shadow-evidence.mjs"
node "$ROOT_DIR/backend/scripts/verify-msk-iam-metadata.mjs" --contract-only
PYTHONPATH="$ROOT_DIR/backend" "$PYTHON_BIN" -m unittest tests.test_kafka_fixture_boundary
PYTHONPATH="$ROOT_DIR/backend" "$PYTHON_BIN" -m unittest tests.test_continuous_worker_scope
"$ROOT_DIR/scripts/verify-eks-trino-distributed.sh"
"$ROOT_DIR/scripts/verify-eks-realtime-v1-only-profile.sh"
echo "EKS workload contract verification passed."
