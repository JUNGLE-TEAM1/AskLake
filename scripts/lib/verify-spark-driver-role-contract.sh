#!/usr/bin/env bash

# This file is sourced by verifiers. It does not enable shell options itself.

extract_asklake_spark_driver_role() {
  local rendered_file="$1"
  awk '
    /^kind: Role$/ { block = $0 ORS; capture = 1; next }
    capture { block = block $0 ORS }
    capture && /^---$/ {
      if (block ~ /name: asklake-spark-driver/) {
        printf "%s", block
        capture = 0
        block = ""
        exit
      }
      capture = 0
      block = ""
    }
    END {
      if (capture && block ~ /name: asklake-spark-driver/) printf "%s", block
    }
  ' "$rendered_file"
}

verify_asklake_spark_driver_role_contract() {
  local rendered_file="$1" role
  role="$(extract_asklake_spark_driver_role "$rendered_file")"
  [[ -n "$role" ]] || {
    echo "rendered Foundation is missing the Spark driver Role" >&2
    return 1
  }

  [[ "$(grep -Fc 'resources: ["pods"]' <<<"$role")" -eq 1 ]] || return 1
  [[ "$(grep -Fc 'verbs: ["create", "get", "list", "watch", "delete", "deletecollection"]' <<<"$role")" -eq 1 ]] || return 1
  [[ "$(grep -Fc 'resources: ["services", "configmaps"]' <<<"$role")" -eq 1 ]] || return 1
  [[ "$(grep -Fc 'verbs: ["create", "get", "list", "delete", "deletecollection"]' <<<"$role")" -eq 1 ]] || return 1
  [[ "$(grep -Fc 'resources: ["persistentvolumeclaims"]' <<<"$role")" -eq 1 ]] || return 1
  [[ "$(grep -Fc 'verbs: ["get", "list", "delete", "deletecollection"]' <<<"$role")" -eq 1 ]] || return 1
  [[ "$(grep -c 'apiGroups:' <<<"$role")" -eq 3 ]] || return 1
  [[ "$(grep -c '^[[:space:]]*resources:' <<<"$role")" -eq 3 ]] || return 1
  [[ "$(grep -c '^[[:space:]]*verbs:' <<<"$role")" -eq 3 ]] || return 1
  [[ "$(grep -Fc 'apiGroups: [""]' <<<"$role")" -eq 3 ]] || return 1

  if grep -Eq 'resources:.*("secrets"|"nodes"|"namespaces"|"\*")|verbs:.*("update"|"patch"|"\*")' <<<"$role"; then
    echo "rendered Spark driver Role contains out-of-contract permissions" >&2
    return 1
  fi
}
