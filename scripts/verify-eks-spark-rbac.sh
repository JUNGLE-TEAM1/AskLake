#!/usr/bin/env bash
set -euo pipefail

JOB_NAMESPACE="${ASKLAKE_EKS_JOB_NAMESPACE:-asklake-dev}"
BACKEND_USER="system:serviceaccount:$JOB_NAMESPACE:asklake-backend"
SPARK_USER="system:serviceaccount:$JOB_NAMESPACE:asklake-spark"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "required command is missing: kubectl" >&2
  exit 1
fi

expect_allowed() {
  local verb="$1" resource="$2" user="$3" namespace="$4"
  local args=(auth can-i "$verb" "$resource" --as="$user")
  if [[ -n "$namespace" ]]; then args+=(--namespace="$namespace"); else args+=(--all-namespaces); fi
  if [[ "$(kubectl "${args[@]}")" != "yes" ]]; then
    echo "expected allow: $user $verb $resource in $namespace" >&2
    exit 1
  fi
}

expect_denied() {
  local verb="$1" resource="$2" user="$3" namespace="$4"
  local args=(auth can-i "$verb" "$resource" --as="$user")
  if [[ -n "$namespace" ]]; then args+=(--namespace="$namespace"); else args+=(--all-namespaces); fi
  if [[ "$(kubectl "${args[@]}")" != "no" ]]; then
    echo "expected deny: $user $verb $resource in $namespace" >&2
    exit 1
  fi
}

for verb in create get list watch delete deletecollection; do
  expect_allowed "$verb" pods "$SPARK_USER" "$JOB_NAMESPACE"
done
for resource in services configmaps; do
  for verb in create get list delete deletecollection; do
    expect_allowed "$verb" "$resource" "$SPARK_USER" "$JOB_NAMESPACE"
  done
done
for verb in get list delete deletecollection; do
  expect_allowed "$verb" persistentvolumeclaims "$SPARK_USER" "$JOB_NAMESPACE"
done

expect_allowed create sparkapplications.sparkoperator.k8s.io "$BACKEND_USER" "$JOB_NAMESPACE"
expect_allowed get sparkapplications.sparkoperator.k8s.io "$BACKEND_USER" "$JOB_NAMESPACE"
expect_allowed delete sparkapplications.sparkoperator.k8s.io "$BACKEND_USER" "$JOB_NAMESPACE"

for verb in get list watch; do
  expect_denied "$verb" secrets "$SPARK_USER" "$JOB_NAMESPACE"
done
for verb in get list watch; do
  for resource in nodes namespaces clusterroles.rbac.authorization.k8s.io; do
    expect_denied "$verb" "$resource" "$SPARK_USER" ""
  done
done
expect_denied '*' '*' "$SPARK_USER" "$JOB_NAMESPACE"
expect_denied '*' '*' "$SPARK_USER" ""
expect_denied get '*' "$SPARK_USER" "$JOB_NAMESPACE"
expect_denied create pods "$SPARK_USER" default
for verb in create update patch; do
  expect_denied "$verb" persistentvolumeclaims "$SPARK_USER" "$JOB_NAMESPACE"
done
for resource in pods services configmaps; do
  for verb in update patch; do
    expect_denied "$verb" "$resource" "$SPARK_USER" "$JOB_NAMESPACE"
  done
done

echo "Spark runtime RBAC allow/deny matrix passed for $JOB_NAMESPACE."
