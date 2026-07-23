#!/usr/bin/env bash
set -euo pipefail

RELEASE_NAME="asklake-spark-operator"
OPERATOR_NAMESPACE="spark-operator"
CHART_VERSION="2.5.1"
OWNER="pair-a"
CRDS=(
  sparkapplications.sparkoperator.k8s.io
  scheduledsparkapplications.sparkoperator.k8s.io
  sparkconnects.sparkoperator.k8s.io
)

verify_crd_ownership() {
  local crd crd_owner crd_cluster crd_release crd_version
  for crd in "${CRDS[@]}"; do
    crd_owner="$(kubectl get crd "$crd" -o jsonpath='{.metadata.annotations.asklake\.io/owner}')"
    crd_cluster="$(kubectl get crd "$crd" -o jsonpath='{.metadata.annotations.asklake\.io/cluster}')"
    crd_release="$(kubectl get crd "$crd" -o jsonpath='{.metadata.annotations.asklake\.io/release}')"
    crd_version="$(kubectl get crd "$crd" -o jsonpath='{.metadata.annotations.asklake\.io/chart-version}')"
    if [[ "$crd_owner" != "$OWNER" || "$crd_cluster" != "$ASKLAKE_EKS_CLUSTER_NAME" || \
          "$crd_release" != "$RELEASE_NAME" || "$crd_version" != "$CHART_VERSION" ]]; then
      echo "$crd does not have the exact AskLake ownership tuple; preserving all CRDs" >&2
      return 1
    fi
  done
}

: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
PREFLIGHT_ONLY="${ASKLAKE_SPARK_OPERATOR_DESTROY_PREFLIGHT_ONLY:-false}"
if [[ "$PREFLIGHT_ONLY" != "true" && "${ASKLAKE_SPARK_OPERATOR_DESTROY_CONFIRM:-}" != "uninstall-spark-operator-after-empty-check" ]]; then
  echo "set ASKLAKE_SPARK_OPERATOR_DESTROY_CONFIRM=uninstall-spark-operator-after-empty-check to remove only the verified release" >&2
  exit 1
fi

for command in aws kubectl helm python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

expected_endpoint="$(aws eks describe-cluster --name "$ASKLAKE_EKS_CLUSTER_NAME" --query 'cluster.endpoint' --output text)"
current_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
if [[ "$expected_endpoint" != "$current_endpoint" ]]; then
  echo "kubectl context does not match ASKLAKE_EKS_CLUSTER_NAME" >&2
  exit 1
fi

release_metadata="$(helm get metadata "$RELEASE_NAME" -n "$OPERATOR_NAMESPACE" -o json 2>/dev/null)"
release_chart="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["chart"])' <<<"$release_metadata")"
release_version="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' <<<"$release_metadata")"
if [[ "$release_chart" != "spark-operator" || "$release_version" != "$CHART_VERSION" ]]; then
  echo "expected release $RELEASE_NAME with chart spark-operator/$CHART_VERSION, got ${release_chart:-missing}/${release_version:-missing}" >&2
  exit 1
fi

spark_operator_releases="$(helm list -A -o json | python3 -c 'import json,sys; print(sum(1 for release in json.load(sys.stdin) if release.get("chart", "").startswith("spark-operator-")))')"
if [[ "$spark_operator_releases" -ne 1 ]]; then
  echo "another Spark Operator Helm release exists; review shared CRD ownership before uninstall" >&2
  exit 1
fi

namespace_release_count="$(helm list -n "$OPERATOR_NAMESPACE" -o json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
if [[ "$namespace_release_count" -ne 1 ]]; then
  echo "operator namespace contains another Helm release; refusing to delete the namespace" >&2
  exit 1
fi

namespace_owner="$(kubectl get namespace "$OPERATOR_NAMESPACE" -o jsonpath='{.metadata.annotations.asklake\.io/owner}')"
namespace_release="$(kubectl get namespace "$OPERATOR_NAMESPACE" -o jsonpath='{.metadata.annotations.asklake\.io/release}')"
if [[ "$namespace_owner" != "$OWNER" || "$namespace_release" != "$RELEASE_NAME" ]]; then
  echo "operator namespace ownership does not match $OWNER/$RELEASE_NAME" >&2
  exit 1
fi

for resource in deployment statefulset daemonset job cronjob service serviceaccount configmap secret role rolebinding networkpolicy; do
  while IFS='|' read -r name instance; do
    [[ -z "$name" ]] && continue
    if [[ "$instance" == "$RELEASE_NAME" || "$name" == "default" || "$name" == "kube-root-ca.crt" || \
          "$name" == "$RELEASE_NAME-webhook-certs" || \
          "$name" == sh.helm.release.v1."$RELEASE_NAME".* ]]; then
      continue
    fi
    echo "operator namespace has a non-release resource: $resource/$name" >&2
    exit 1
  done < <(kubectl get "$resource" -n "$OPERATOR_NAMESPACE" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.metadata.labels.app\.kubernetes\.io/instance}{"\n"}{end}' 2>/dev/null || true)
done

for resource in sparkapplications scheduledsparkapplications sparkconnects; do
  count="$(kubectl get "$resource" -A --no-headers 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$count" -ne 0 ]]; then
    echo "$resource objects still exist; preserve or remove them before uninstalling the operator" >&2
    exit 1
  fi
done

if [[ "${ASKLAKE_SPARK_OPERATOR_CRD_DESTROY_CONFIRM:-}" == "delete-owned-empty-spark-operator-crds" ]]; then
  verify_crd_ownership
fi

if [[ "$PREFLIGHT_ONLY" == "true" ]]; then
  echo "Spark Operator destroy preflight passed. Nothing was deleted."
  exit 0
fi

helm uninstall "$RELEASE_NAME" -n "$OPERATOR_NAMESPACE" --wait --timeout 5m
kubectl delete namespace "$OPERATOR_NAMESPACE" --ignore-not-found --wait=true --timeout=5m

if [[ "${ASKLAKE_SPARK_OPERATOR_CRD_DESTROY_CONFIRM:-}" != "delete-owned-empty-spark-operator-crds" ]]; then
  echo "Spark Operator release and owned namespace were removed. CRDs were preserved by default."
  exit 0
fi

verify_crd_ownership

kubectl delete crd "${CRDS[@]}" --wait=true --timeout=5m
echo "Owned, globally empty Spark Operator CRDs were removed after the second confirmation."
