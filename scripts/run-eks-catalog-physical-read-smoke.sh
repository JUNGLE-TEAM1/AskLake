#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

MODE="${1:---live}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
RECEIPT_PATH="${ASKLAKE_IMAGE_RECEIPT:-}"
INPUT_PATH="${ASKLAKE_PHYSICAL_READ_INPUT:-}"
TIMEOUT_SECONDS="${ASKLAKE_PHYSICAL_READ_TIMEOUT_SECONDS:-900}"
POLL_SECONDS="${ASKLAKE_PHYSICAL_READ_POLL_SECONDS:-2}"
ROW_LIMIT="${ASKLAKE_PHYSICAL_READ_ROW_LIMIT:-5}"
RUN_SUFFIX="$(date +%s)-$$"
RUN_LABEL="physical-read-${RUN_SUFFIX}"
APP_NAME="asklake-physical-read-${RUN_SUFFIX}"
MANIFEST_FILE="$(mktemp)"
DRIVER_LOG_FILE="$(mktemp)"
KUBECTL_ERROR_FILE="$(mktemp)"
RESOURCES_CREATED=false
CLEANUP_COMPLETE=false

fail() {
  echo "$1" >&2
  exit 1
}

cleanup_resources() {
  [[ "$RESOURCES_CREATED" == "true" && "$CLEANUP_COMPLETE" != "true" ]] || return 0
  local cleanup_failed=0

  kubectl delete sparkapplication.sparkoperator.k8s.io "$APP_NAME" \
    -n "$NAMESPACE" --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || cleanup_failed=1
  for resource in pods services configmaps persistentvolumeclaims; do
    kubectl delete "$resource" -n "$NAMESPACE" \
      -l "asklake.io/physical-read-run=$RUN_LABEL" \
      --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || cleanup_failed=1
  done

  local prefix_resources
  for resource in sparkapplications.sparkoperator.k8s.io pods services configmaps persistentvolumeclaims; do
    if ! prefix_resources="$(kubectl get "$resource" -n "$NAMESPACE" -o name 2>"$KUBECTL_ERROR_FILE")"; then
      cleanup_failed=1
      continue
    fi
    while IFS= read -r resource_name; do
      [[ -n "$resource_name" ]] || continue
      if ! kubectl delete "$resource_name" -n "$NAMESPACE" \
        --ignore-not-found --wait=true --timeout=120s >/dev/null 2>"$KUBECTL_ERROR_FILE"; then
        cleanup_failed=1
      fi
    done < <(awk -F/ -v prefix="$APP_NAME" '$2 == prefix || index($2, prefix "-") == 1' <<<"$prefix_resources")
  done

  [[ "$cleanup_failed" -eq 0 ]] || return 1
  CLEANUP_COMPLETE=true
}

on_exit() {
  local exit_code=$?
  trap - EXIT
  if ! cleanup_resources; then
    echo "physical read cleanup failed" >&2
    [[ "$exit_code" -ne 0 ]] || exit_code=1
  fi
  rm -f "$MANIFEST_FILE" "$DRIVER_LOG_FILE" "$KUBECTL_ERROR_FILE"
  exit "$exit_code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

[[ "$MODE" == "--validate-only" || "$MODE" == "--live" ]] || \
  fail "usage: $0 --validate-only|--live"

for command in git jq node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

[[ -n "$RECEIPT_PATH" && -f "$RECEIPT_PATH" ]] || fail "ASKLAKE_IMAGE_RECEIPT must reference a private receipt file"
[[ -n "$INPUT_PATH" && -f "$INPUT_PATH" ]] || fail "ASKLAKE_PHYSICAL_READ_INPUT must reference a private input file"

for private_file in "$RECEIPT_PATH" "$INPUT_PATH"; do
  if git -C "$ROOT_DIR" ls-files --error-unmatch -- "$private_file" >/dev/null 2>&1; then
    fail "physical read private input must not be tracked by Git"
  fi
  git -C "$ROOT_DIR" check-ignore -q -- "$private_file" || \
    fail "physical read private input must be covered by .gitignore"
done

node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$RECEIPT_PATH" >/dev/null 2>&1 || \
  fail "physical read image receipt validation failed"

jq -e '
  type == "object"
  and (keys | sort) == ["datasetId", "materializationRoot", "objectUri"]
  and (.datasetId | type == "string" and length > 0 and length <= 256 and (explode | all(. >= 32)))
  and (.materializationRoot | type == "string" and length > 0 and length <= 2048 and (explode | all(. >= 32)))
  and (.objectUri | type == "string" and length > 0 and length <= 2048 and (explode | all(. >= 32)))
' "$INPUT_PATH" >/dev/null || fail "physical read input contract is invalid"

materialization_root="$(jq -r '.materializationRoot' "$INPUT_PATH")"
object_uri="$(jq -r '.objectUri' "$INPUT_PATH")"
spark_image="$(jq -r '.images.sparkRuntime' "$RECEIPT_PATH")"
normalized_root="${materialization_root%/}"

[[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || fail "EKS namespace is invalid"
[[ "$REGION" =~ ^[a-z]{2}(-[a-z0-9]+)+-[0-9]+$ ]] || fail "AWS region is invalid"
[[ "$normalized_root" =~ ^s3a://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^[:space:]?#\\]+$ ]] || \
  fail "materialization root must be an exact s3a prefix"
[[ "$object_uri" =~ ^s3a://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^[:space:]?#\\]+[.]parquet$ ]] || \
  fail "physical read object must be one exact s3a Parquet object"
root_path="${normalized_root#s3a://}"
object_path="${object_uri#s3a://}"
[[ "$root_path" != *"//"* && "$root_path" != *"/../"* && "$root_path" != *"/./"* && \
   "$root_path" != *"/.." && "$root_path" != *"/." ]] || \
  fail "materialization root contains a non-canonical path"
[[ "$object_path" != *"//"* && "$object_path" != *"/../"* && "$object_path" != *"/./"* ]] || \
  fail "physical read object contains a non-canonical path"
[[ "$object_uri" == "$normalized_root/"* ]] || fail "physical read object is outside the materialization root"
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ && "$TIMEOUT_SECONDS" -le 3600 ]] || \
  fail "physical read timeout must be between 1 and 3600 seconds"
[[ "$POLL_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "physical read poll interval is invalid"
awk -v value="$POLL_SECONDS" 'BEGIN { exit !(value >= 0.1 && value <= 30) }' || \
  fail "physical read poll interval must be between 0.1 and 30 seconds"
[[ "$ROW_LIMIT" =~ ^[1-9][0-9]*$ && "$ROW_LIMIT" -le 100 ]] || fail "physical read row limit must be between 1 and 100"

spark_image_json="$(jq -Rn --arg value "$spark_image" '$value')"
object_uri_json="$(jq -Rn --arg value "$object_uri" '$value')"

cat >"$MANIFEST_FILE" <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${APP_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/part-of: asklake
    asklake.io/physical-read-run: ${RUN_LABEL}
data:
  smoke.py: |
    import json
    import os
    from pyspark.sql import SparkSession

    spark = SparkSession.builder.appName("asklake-bounded-physical-read").getOrCreate()
    try:
        frame = spark.read.parquet(os.environ["ASKLAKE_PHYSICAL_READ_OBJECT_URI"])
        column_count = len(frame.columns)
        rows = frame.limit(int(os.environ.get("ASKLAKE_PHYSICAL_READ_ROW_LIMIT", "5"))).collect()
        row_width_matched = all(len(row) == column_count for row in rows)
        result = {
            "columnCount": column_count,
            "returnedRows": len(rows),
            "rowWidthMatched": row_width_matched,
        }
        print("ASKLAKE_PHYSICAL_READ_RESULT=" + json.dumps(result, sort_keys=True), flush=True)
        if column_count <= 0 or not rows or not row_width_matched:
            raise RuntimeError("bounded physical read validation failed")
    finally:
        spark.stop()
---
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: ${APP_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: asklake-physical-read
    app.kubernetes.io/part-of: asklake
    asklake.io/physical-read-run: ${RUN_LABEL}
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  sparkVersion: "4.0.1"
  image: ${spark_image_json}
  imagePullPolicy: IfNotPresent
  mainApplicationFile: local:///opt/asklake/physical-read/smoke.py
  timeToLiveSeconds: 600
  restartPolicy:
    type: Never
  volumes:
    - name: physical-read-script
      configMap:
        name: ${APP_NAME}
  sparkConf:
    "spark.jars.packages": "org.apache.hadoop:hadoop-aws:3.4.1"
    "spark.jars.ivy": "/tmp/.ivy2"
    "spark.driver.extraJavaOptions": "-Djava.io.tmpdir=/tmp"
    "spark.executor.extraJavaOptions": "-Djava.io.tmpdir=/tmp"
  hadoopConf:
    "fs.s3a.aws.credentials.provider": "software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider"
    "fs.s3a.endpoint.region": "${REGION}"
    "fs.s3a.path.style.access": "false"
  driver:
    serviceAccount: asklake-spark
    cores: 1
    memory: 2g
    coreRequest: "1"
    coreLimit: "2"
    memoryOverhead: 512m
    labels:
      asklake.io/physical-read-run: ${RUN_LABEL}
    env:
      - name: AWS_REGION
        value: "${REGION}"
      - name: ASKLAKE_PHYSICAL_READ_OBJECT_URI
        value: ${object_uri_json}
      - name: ASKLAKE_PHYSICAL_READ_ROW_LIMIT
        value: "${ROW_LIMIT}"
    nodeSelector:
      kubernetes.io/arch: amd64
      asklake.io/workload-class: spark
    tolerations:
      - key: asklake.io/workload-class
        operator: Equal
        value: spark
        effect: NoSchedule
    volumeMounts:
      - name: physical-read-script
        mountPath: /opt/asklake/physical-read
        readOnly: true
  executor:
    serviceAccount: asklake-spark
    instances: 1
    cores: 1
    memory: 2g
    coreRequest: "1"
    coreLimit: "2"
    memoryOverhead: 512m
    labels:
      asklake.io/physical-read-run: ${RUN_LABEL}
    env:
      - name: AWS_REGION
        value: "${REGION}"
    nodeSelector:
      kubernetes.io/arch: amd64
      asklake.io/workload-class: spark
    tolerations:
      - key: asklake.io/workload-class
        operator: Equal
        value: spark
        effect: NoSchedule
EOF

grep -q '^kind: ConfigMap$' "$MANIFEST_FILE"
grep -q '^kind: SparkApplication$' "$MANIFEST_FILE"
grep -q 'serviceAccount: asklake-spark' "$MANIFEST_FILE"
grep -q 'spark.jars.ivy.*\/tmp\/.ivy2' "$MANIFEST_FILE"
grep -q 'asklake.io/workload-class: spark' "$MANIFEST_FILE"
grep -q 'readOnly: true' "$MANIFEST_FILE"

if [[ "$MODE" == "--validate-only" ]]; then
  jq -n '{manifestValidated: true, mode: "validate-only", evidenceScope: "bounded-s3-parquet-object"}'
  exit 0
fi

for command in aws kubectl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ "${ASKLAKE_PHYSICAL_READ_CONFIRM:-}" == "run-bounded-physical-read" ]] || \
  fail "ASKLAKE_PHYSICAL_READ_CONFIRM is required for live execution"

verify_asklake_eks_context
crd_json="$(kubectl get crd sparkapplications.sparkoperator.k8s.io -o json 2>"$KUBECTL_ERROR_FILE")" || \
  fail "SparkApplication CRD preflight failed"
jq -e 'any(.status.conditions[]?; .type == "Established" and .status == "True")' <<<"$crd_json" >/dev/null || \
  fail "SparkApplication CRD is not Established"

for component in controller webhook; do
  deployment_json="$(kubectl get deployments -n spark-operator \
    -l "app.kubernetes.io/component=$component" -o json 2>"$KUBECTL_ERROR_FILE")" || \
    fail "Spark Operator readiness preflight failed"
  jq -e '.items | length == 1 and .[0].status.availableReplicas >= 1 and .[0].status.unavailableReplicas == null' \
    <<<"$deployment_json" >/dev/null || fail "Spark Operator component is not Ready"
done

kubectl get serviceaccount asklake-spark -n "$NAMESPACE" >/dev/null 2>"$KUBECTL_ERROR_FILE" || \
  fail "Spark ServiceAccount preflight failed"
for resource in nodepool/asklake-spark nodeclass/asklake-spark; do
  resource_json="$(kubectl get "$resource" -o json 2>"$KUBECTL_ERROR_FILE")" || \
    fail "Spark Auto Mode capacity preflight failed"
  jq -e 'any(.status.conditions[]?; .type == "Ready" and .status == "True")' <<<"$resource_json" >/dev/null || \
    fail "Spark Auto Mode capacity is not Ready"
  if [[ "$resource" == nodepool/* ]]; then
    jq -e 'any(.spec.template.spec.requirements[]?; .key == "kubernetes.io/arch" and (.values | index("amd64")))' \
      <<<"$resource_json" >/dev/null || fail "Spark NodePool does not require amd64"
  fi
done

association_json="$(aws eks list-pod-identity-associations \
  --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" --namespace "$NAMESPACE" \
  --service-account asklake-spark --region "$REGION" --output json 2>"$KUBECTL_ERROR_FILE")" || \
  fail "Spark Pod Identity preflight failed"
jq -e '.associations | length == 1' <<<"$association_json" >/dev/null || \
  fail "Spark Pod Identity association is missing or ambiguous"

kubectl apply --dry-run=server -f "$MANIFEST_FILE" >/dev/null 2>"$KUBECTL_ERROR_FILE" || \
  fail "physical read server-side admission failed"

RESOURCES_CREATED=true
kubectl apply -f "$MANIFEST_FILE" >/dev/null 2>"$KUBECTL_ERROR_FILE" || \
  fail "physical read resource creation failed"

deadline=$((SECONDS + TIMEOUT_SECONDS))
terminal_state=""
driver_pod=""
while (( SECONDS < deadline )); do
  application_json="$(kubectl get sparkapplication.sparkoperator.k8s.io "$APP_NAME" -n "$NAMESPACE" -o json 2>/dev/null || true)"
  terminal_state="$(jq -r '.status.applicationState.state // ""' <<<"$application_json" 2>/dev/null || true)"
  driver_pod="$(jq -r '.status.driverInfo.podName // ""' <<<"$application_json" 2>/dev/null || true)"
  case "$terminal_state" in
    COMPLETED) break ;;
    FAILED|FAILING|INVALID|SUBMISSION_FAILED|UNKNOWN) fail "physical read SparkApplication failed" ;;
  esac
  sleep "$POLL_SECONDS"
done
[[ "$terminal_state" == "COMPLETED" ]] || fail "physical read SparkApplication timed out"
[[ -n "$driver_pod" ]] || fail "physical read driver Pod was not reported"

kubectl logs "$driver_pod" -n "$NAMESPACE" >"$DRIVER_LOG_FILE" 2>/dev/null || \
  fail "physical read driver result could not be collected"
result_line="$(grep '^ASKLAKE_PHYSICAL_READ_RESULT=' "$DRIVER_LOG_FILE" | tail -n 1 || true)"
[[ -n "$result_line" ]] || fail "physical read driver did not emit a result marker"
result_json="${result_line#ASKLAKE_PHYSICAL_READ_RESULT=}"
jq -e '
  type == "object"
  and (keys | sort) == ["columnCount", "returnedRows", "rowWidthMatched"]
  and (.columnCount | type == "number" and . > 0)
  and (.returnedRows | type == "number" and . > 0)
  and .rowWidthMatched == true
' <<<"$result_json" >/dev/null || fail "physical read result contract failed"

cleanup_resources || fail "physical read cleanup failed"

label_residue="$(kubectl get sparkapplications.sparkoperator.k8s.io,pods,services,configmaps,persistentvolumeclaims \
  -n "$NAMESPACE" -l "asklake.io/physical-read-run=$RUN_LABEL" -o name 2>"$KUBECTL_ERROR_FILE")" || \
  fail "physical read label residue audit failed"
prefix_residue="$(kubectl get sparkapplications.sparkoperator.k8s.io,pods,services,configmaps,persistentvolumeclaims \
  -n "$NAMESPACE" -o name 2>"$KUBECTL_ERROR_FILE")" || fail "physical read prefix residue audit failed"
prefix_residue="$(awk -F/ -v prefix="$APP_NAME" '$2 == prefix || index($2, prefix "-") == 1' <<<"$prefix_residue")"
[[ -z "$label_residue" && -z "$prefix_residue" ]] || fail "physical read resource residue remains"

secret_access_status=0
secret_access="$(kubectl auth can-i get secrets -n "$NAMESPACE" \
  --as="system:serviceaccount:$NAMESPACE:asklake-spark" 2>"$KUBECTL_ERROR_FILE")" || \
  secret_access_status=$?
[[ "$secret_access_status" -eq 1 && "$secret_access" == "no" ]] || \
  fail "Spark ServiceAccount Secret access check failed or unexpectedly allowed access"

jq -n \
  --arg terminalState "$terminal_state" \
  --argjson columnCount "$(jq '.columnCount' <<<"$result_json")" \
  --argjson returnedRows "$(jq '.returnedRows' <<<"$result_json")" \
  --argjson rowWidthMatched "$(jq '.rowWidthMatched' <<<"$result_json")" \
  '{
    evidenceScope: "bounded-s3-parquet-object",
    terminalState: $terminalState,
    columnCount: $columnCount,
    returnedRows: $returnedRows,
    rowWidthMatched: $rowWidthMatched,
    residueCount: 0
  }'
