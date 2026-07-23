#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-spark-driver-role-contract.sh"
SOURCE_ROLE="$ROOT_DIR/infra/eks/helm/asklake-foundation/templates/spark-driver-rbac.yaml"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
BASE_ROLE="$TEMP_DIR/base.yaml"

sed \
  -e '/{{- if /d' \
  -e '/{{- end }}/d' \
  -e '/{{- include /d' \
  -e 's/{{ .Values.serviceAccounts.spark.name }}/asklake-spark/g' \
  -e 's/{{ .Values.namespace.name }}/asklake-dev/g' \
  "$SOURCE_ROLE" >"$BASE_ROLE"

verify_asklake_spark_driver_role_contract "$BASE_ROLE"

assert_mutation_rejected() {
  local fixture="$1"
  if verify_asklake_spark_driver_role_contract "$fixture" >/dev/null 2>&1; then
    echo "unsafe Spark RBAC mutation was accepted" >&2
    exit 1
  fi
}

sed 's/resources: \["pods"\]/resources: ["pods", "secrets"]/' "$BASE_ROLE" >"$TEMP_DIR/secrets.yaml"
assert_mutation_rejected "$TEMP_DIR/secrets.yaml"

sed 's/"deletecollection"/"deletecollection", "*"/' "$BASE_ROLE" >"$TEMP_DIR/wildcard.yaml"
assert_mutation_rejected "$TEMP_DIR/wildcard.yaml"

sed 's/"watch", //' "$BASE_ROLE" >"$TEMP_DIR/missing-watch.yaml"
assert_mutation_rejected "$TEMP_DIR/missing-watch.yaml"

sed 's/apiGroups: \[""\]/apiGroups: ["", "apps"]/' "$BASE_ROLE" >"$TEMP_DIR/api-group.yaml"
assert_mutation_rejected "$TEMP_DIR/api-group.yaml"

echo "Spark driver RBAC mutation regression scenarios passed."
