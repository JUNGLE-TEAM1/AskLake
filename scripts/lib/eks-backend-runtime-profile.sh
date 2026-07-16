#!/usr/bin/env bash

asklake_backend_runtime_contract() {
  local root_dir="$1"
  printf '%s\n' "${ASKLAKE_RUNTIME_SECRET_STATIC_CONTRACT:-$root_dir/infra/eks/secrets/runtime-secret-contract.example.json}"
}

asklake_backend_runtime_profile() {
  local root_dir="$1" scope="${2:-bounded}" contract
  contract="$(asklake_backend_runtime_contract "$root_dir")" || return 1
  [[ -s "$contract" ]] || return 1
  case "$scope" in
    bounded)
      jq -c '.runtimeProfiles.backend.boundedKeys | sort' "$contract"
      ;;
    full-service)
      jq -c '.secrets.backend.keys | sort' "$contract"
      ;;
    *)
      return 2
      ;;
  esac
}

asklake_backend_runtime_hash() {
  local json="$1" expected_keys="$2" normalized
  normalized="$(jq -e -S -c --argjson keys "$expected_keys" '
    select((keys | sort) == $keys)
  ' <<<"$json")" || return 1
  [[ -n "$normalized" ]] || return 1
  asklake_sha256 <<<"$normalized"
}
