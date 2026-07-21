#!/usr/bin/env bash
set -euo pipefail

environment="${1:-}"
ref_type="${2:-}"
ref_name="${3:-}"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

case "$environment" in
  dev)
    [[ "$ref_type" == "branch" && "$ref_name" == "dev" ]] || \
      fail "EKS dev images must be published from the dev branch"
    ;;
  staging)
    [[ -n "$ref_type" && -n "$ref_name" ]] || \
      fail "staging image delivery requires an explicit Git ref"
    ;;
  *)
    fail "unsupported EKS image environment: ${environment:-<empty>}"
    ;;
esac

printf 'EKS image source accepted: environment=%s ref=%s/%s\n' \
  "$environment" "$ref_type" "$ref_name"
