#!/usr/bin/env bash

# Source this file after enabling `set -euo pipefail`.
# The check deliberately emits no cluster endpoint, ARN, account ID, or context name.
verify_asklake_eks_context() {
  local cluster_name="${ASKLAKE_EKS_CLUSTER_NAME:-}"
  local namespace="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
  local region="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
  local expected_endpoint current_endpoint

  [[ -n "$cluster_name" ]] || {
    echo "ASKLAKE_EKS_CLUSTER_NAME is required" >&2
    return 1
  }
  command -v aws >/dev/null 2>&1 || {
    echo "missing required command: aws" >&2
    return 1
  }
  command -v kubectl >/dev/null 2>&1 || {
    echo "missing required command: kubectl" >&2
    return 1
  }

  if ! expected_endpoint="$(aws eks describe-cluster \
    --name "$cluster_name" \
    --region "$region" \
    --query 'cluster.endpoint' \
    --output text 2>/dev/null)"; then
    echo "unable to verify the configured EKS cluster" >&2
    return 1
  fi
  current_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
  [[ -n "$expected_endpoint" && "$current_endpoint" == "$expected_endpoint" ]] || {
    echo "kubectl context does not match ASKLAKE_EKS_CLUSTER_NAME" >&2
    return 1
  }
  kubectl get namespace "$namespace" >/dev/null

  export ASKLAKE_VERIFIED_EKS_NAMESPACE="$namespace"
  export ASKLAKE_VERIFIED_AWS_REGION="$region"
}

asklake_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    echo "missing required SHA-256 command: sha256sum or shasum" >&2
    return 1
  fi
}
