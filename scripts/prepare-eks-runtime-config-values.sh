#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
OUTPUT="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.runtime-config-values.json}"

for command in git jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || { echo "missing required command: $command" >&2; exit 1; }
done
git -C "$ROOT_DIR" check-ignore -q -- "$OUTPUT" || {
  echo "runtime ConfigMap values must remain ignored" >&2
  exit 1
}

temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT
kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json | jq -e '{
  namespace: .metadata.namespace,
  configMap: {name: .metadata.name, data: .data}
} | select(.namespace=="asklake-dev" and .configMap.name=="asklake-runtime" and (.configMap.data|length)>0)' >"$temporary"
mv "$temporary" "$OUTPUT"
chmod 600 "$OUTPUT"
trap - EXIT
printf 'runtime_config_values=prepared key_count=%s\n' "$(jq '.configMap.data|length' "$OUTPUT")"
