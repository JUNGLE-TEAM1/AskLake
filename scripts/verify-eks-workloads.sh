#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-workloads"
VALUES_FILE="$ROOT_DIR/infra/eks/values/workloads/dev.example.yaml"
WEB_VALUES_FILE="$ROOT_DIR/infra/eks/values/workloads/dev.web-only.example.yaml"
RENDERED_FILE="$(mktemp)"
WEB_RENDERED_FILE="$(mktemp)"
OPT_IN_RENDERED_FILE="$(mktemp)"
trap 'rm -f "$RENDERED_FILE" "$WEB_RENDERED_FILE" "$OPT_IN_RENDERED_FILE"' EXIT

required_files=(
  "$ROOT_DIR/.github/workflows/eks-b-workload-checks.yml"
  "$ROOT_DIR/airflow/Dockerfile"
  "$ROOT_DIR/backend/scripts/spark-kubernetes-client.mjs"
  "$ROOT_DIR/backend/scripts/spark-kubernetes-client.test.mjs"
  "$ROOT_DIR/backend/scripts/spark_job_run.py"
  "$ROOT_DIR/backend/scripts/verify-msk-iam-metadata.mjs"
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
  "$CHART_DIR/templates/backend-spark-rbac.yaml"
  "$CHART_DIR/templates/frontend-deployment.yaml"
  "$CHART_DIR/templates/frontend-service.yaml"
  "$CHART_DIR/templates/msk-smoke-job.yaml"
  "$CHART_DIR/templates/spark-driver-rbac.yaml"
  "$CHART_DIR/templates/sparkapplication.yaml"
  "$CHART_DIR/templates/trino-configmap.yaml"
  "$CHART_DIR/templates/trino-deployment.yaml"
  "$CHART_DIR/templates/trino-service.yaml"
  "$VALUES_FILE"
  "$WEB_VALUES_FILE"
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

"$HELM_BIN" lint "$CHART_DIR" -f "$VALUES_FILE"
"$HELM_BIN" lint "$CHART_DIR" -f "$WEB_VALUES_FILE"
"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" >"$RENDERED_FILE"
"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$WEB_VALUES_FILE" >"$WEB_RENDERED_FILE"
"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set mskSmoke.create=true \
  --set sparkApplication.create=true \
  --set-string sparkApplication.runId=run-eks-contract-001 \
  --set-string sparkApplication.jobId=job-eks-contract-001 \
  --set-string sparkApplication.kafka.fixtureBatchId=eks-smoke-batch-001 >"$OPT_IN_RENDERED_FILE"

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.config.sparkRunner=rest >/dev/null 2>&1; then
  echo "EKS workload schema accepted a non-Kubernetes Spark runner" >&2
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

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$WEB_VALUES_FILE" \
  --set frontend.replicas=0 >/dev/null 2>&1; then
  echo "EKS workload schema accepted zero Frontend replicas" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$WEB_VALUES_FILE" \
  --set backend.replicas=0 >/dev/null 2>&1; then
  echo "EKS workload schema accepted zero Backend replicas" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$WEB_VALUES_FILE" \
  --set-string backend.config.corsOrigins=http://asklake.example.invalid >/dev/null 2>&1; then
  echo "EKS workload schema accepted an insecure cross-origin CORS endpoint" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$WEB_VALUES_FILE" \
  --set airflow.enabled=true >/dev/null 2>&1; then
  echo "web-only values enabled Airflow without its image, config, and Secret key contract" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$WEB_VALUES_FILE" \
  --set trino.enabled=true >/dev/null 2>&1; then
  echo "web-only values enabled Trino without its image, config, and Secret key contract" >&2
  exit 1
fi

test "$(grep -c '^kind: Deployment$' "$RENDERED_FILE")" -eq 6
test "$(grep -c '^kind: Service$' "$RENDERED_FILE")" -eq 4
test "$(grep -c '^kind: ConfigMap$' "$RENDERED_FILE")" -eq 3
test "$(grep -c '^kind: Role$' "$RENDERED_FILE")" -eq 2
test "$(grep -c '^kind: RoleBinding$' "$RENDERED_FILE")" -eq 2
test "$(grep -c '^kind: Job$' "$RENDERED_FILE")" -eq 1
test "$(grep -c '^kind: SparkApplication$' "$RENDERED_FILE" || true)" -eq 0
test "$(grep -c '^kind: Job$' "$OPT_IN_RENDERED_FILE")" -eq 2
test "$(grep -c '^kind: SparkApplication$' "$OPT_IN_RENDERED_FILE")" -eq 1

test "$(grep -c '^kind: Deployment$' "$WEB_RENDERED_FILE")" -eq 2
test "$(grep -c '^kind: Service$' "$WEB_RENDERED_FILE")" -eq 2
test "$(grep -c '^kind: ConfigMap$' "$WEB_RENDERED_FILE")" -eq 1
test "$(grep -c '^kind: Role$' "$WEB_RENDERED_FILE")" -eq 2
test "$(grep -c '^kind: RoleBinding$' "$WEB_RENDERED_FILE")" -eq 2
test "$(grep -c '^kind: Job$' "$WEB_RENDERED_FILE" || true)" -eq 0
test "$(grep -c '^kind: SparkApplication$' "$WEB_RENDERED_FILE" || true)" -eq 0
test "$(grep -c '^  replicas: 1$' "$WEB_RENDERED_FILE")" -eq 2

for resource_name in asklake-frontend asklake-backend; do
  grep -q "name: $resource_name" "$WEB_RENDERED_FILE"
done

for service_name in frontend fastapi; do
  grep -q "name: $service_name" "$WEB_RENDERED_FILE"
done

if grep -Eq 'asklake-airflow|asklake-trino|asklake-airflow-runtime|asklake-trino-runtime|AIRFLOW_API_TOKEN|AIRFLOW_PASSWORD|AIRFLOW_EXECUTION_API_TOKEN|AIRFLOW_INTERNAL_TOKEN|TRINO_AUTH_USERNAME|TRINO_AUTH_PASSWORD|TRINO_MATERIALIZER_USERNAME|TRINO_MATERIALIZER_PASSWORD|TRINO_RESULT_CURSOR_SECRET|TRINO_QUERY_CONFIRMATION_SECRET|trino-ca\.pem' "$WEB_RENDERED_FILE"; then
  echo "web-only EKS render contains an Airflow/Trino resource or Secret reference" >&2
  exit 1
fi

test "$(grep -c 'kubernetes.io/arch: amd64' "$WEB_RENDERED_FILE")" -eq 2
test "$(grep -c 'path: /api/health' "$WEB_RENDERED_FILE")" -eq 2
test "$(grep -c 'tcpSocket:' "$WEB_RENDERED_FILE")" -eq 1
grep -q 'TRINO_ENABLED: "false"' "$WEB_RENDERED_FILE"
grep -q 'BACKEND_CORS_ORIGINS: ""' "$WEB_RENDERED_FILE"

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

grep -q 'path: /api/health' "$RENDERED_FILE"
grep -q 'path: /api/v2/monitor/health' "$RENDERED_FILE"
grep -q 'path: /v1/info' "$RENDERED_FILE"
grep -q 'ASKLAKE_CONTINUOUS_CONTROL_PLANE: "external_ec2"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_EXECUTION_LEASE_SECONDS: "60"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS: "7200"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_RUNNER: "kubernetes"' "$RENDERED_FILE"
grep -q 'ASKLAKE_KAFKA_AUTH_MODE: "iam"' "$RENDERED_FILE"
grep -q 'TRINO_BASE_URL: "https://asklake-trino.asklake-dev.svc.cluster.local:8443"' "$RENDERED_FILE"
grep -q 'TRINO_TLS_CA_FILE: "/var/run/asklake/secrets/trino-ca.pem"' "$RENDERED_FILE"
grep -q '"helm.sh/hook": pre-install,pre-upgrade' "$RENDERED_FILE"
grep -q 'apiGroups: \["sparkoperator.k8s.io"\]' "$RENDERED_FILE"
grep -q 'verbs: \["create", "get", "list", "watch", "delete"\]' "$RENDERED_FILE"
grep -q 'kind: SparkApplication' "$OPT_IN_RENDERED_FILE"
test "$(grep -c '^    serviceAccount: asklake-spark$' "$OPT_IN_RENDERED_FILE")" -eq 2
grep -q 'mainApplicationFile: "local:///opt/asklake/scripts/spark_job_run.py"' "$OPT_IN_RENDERED_FILE"
grep -q 'software.amazon.msk:aws-msk-iam-auth:2.3.6' "$OPT_IN_RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_SOURCE_FORMAT' "$OPT_IN_RENDERED_FILE"
grep -q 'value: "kafka"' "$OPT_IN_RENDERED_FILE"
grep -q 'ASKLAKE_KAFKA_FIXTURE_BATCH_ID' "$OPT_IN_RENDERED_FILE"
grep -q 'eks-smoke-batch-001' "$OPT_IN_RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_OUTPUT_PATH' "$OPT_IN_RENDERED_FILE"
grep -q 'icebergTarget' "$OPT_IN_RENDERED_FILE"
grep -q 'iceberg://iceberg/asklake/eks_mvp_fixture' "$OPT_IN_RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_ICEBERG_CATALOG_NAME' "$OPT_IN_RENDERED_FILE"
grep -q 'software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider' "$OPT_IN_RENDERED_FILE"

grep -q 'option("startingOffsets", "earliest")' "$ROOT_DIR/backend/scripts/spark_job_run.py"
grep -q 'option("endingOffsets", "latest")' "$ROOT_DIR/backend/scripts/spark_job_run.py"
grep -q 'software.amazon.msk.auth.iam.IAMClientCallbackHandler' "$ROOT_DIR/backend/scripts/spark_job_run.py"
grep -q 'Kafka fixture batch filter requires raw.fixture_batch_id' "$ROOT_DIR/backend/scripts/spark_job_run.py"
grep -q 'platforms: linux/amd64' "$ROOT_DIR/.github/workflows/eks-b-workload-checks.yml"
grep -q 'npm run test:spark-kubernetes' "$ROOT_DIR/.github/workflows/eks-b-workload-checks.yml"

for secret_name in asklake-backend-runtime asklake-airflow-runtime asklake-spark-runtime asklake-trino-runtime; do
  grep -q "name: $secret_name\|secretName: $secret_name" "$OPT_IN_RENDERED_FILE"
done

for required_key in \
  DATABASE_URL BOOTSTRAP_ADMIN_PASSWORD AI_GATEWAY_SERVICE_TOKEN AI_MCP_SERVICE_TOKEN \
  AI_CONTEXT_SIGNING_SECRET OPENAI_API_KEY AIRFLOW_API_TOKEN AIRFLOW_PASSWORD \
  AIRFLOW_EXECUTION_API_TOKEN AIRFLOW_INTERNAL_TOKEN TRINO_AUTH_USERNAME TRINO_AUTH_PASSWORD \
  TRINO_MATERIALIZER_USERNAME TRINO_MATERIALIZER_PASSWORD TRINO_RESULT_CURSOR_SECRET \
  TRINO_QUERY_CONFIRMATION_SECRET trino-ca.pem AIRFLOW__DATABASE__SQL_ALCHEMY_CONN \
  AIRFLOW__CORE__FERNET_KEY AIRFLOW__API_AUTH__JWT_SECRET ASKLAKE_SPARK_ICEBERG_JDBC_URL \
  ASKLAKE_SPARK_ICEBERG_JDBC_USER ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD \
  TRINO_ICEBERG_JDBC_URL TRINO_ICEBERG_JDBC_USER TRINO_ICEBERG_JDBC_PASSWORD \
  TRINO_TLS_KEYSTORE_PASSWORD TRINO_INTERNAL_SHARED_SECRET trino-keystore.jks trino-password.db; do
  grep -q "$required_key" "$OPT_IN_RENDERED_FILE"
done

image_count="$(grep -c '^ *image: ".*"$' "$OPT_IN_RENDERED_FILE")"
digest_image_count="$(grep -Ec '^ *image: ".+@sha256:[0-9a-f]{64}"$' "$OPT_IN_RENDERED_FILE")"
test "$image_count" -eq "$digest_image_count"

if grep -Eq '^kind: (Secret|StatefulSet)$|type: LoadBalancer|asklake-replay-producer|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|image: ".+:latest"' "$OPT_IN_RENDERED_FILE"; then
  echo "rendered EKS workload contains an excluded resource, mutable image, or credential field" >&2
  exit 1
fi

if grep -Eq 'resources: \["secrets"\]|resources: \["jobs"\]' "$RENDERED_FILE"; then
  echo "application RBAC grants forbidden Secret or batch Job access" >&2
  exit 1
fi

bash -n "$ROOT_DIR/scripts/verify-eks-workloads.sh"
node "$ROOT_DIR/backend/scripts/verify-msk-iam-metadata.mjs" --contract-only
echo "EKS workload contract verification passed."
