#!/usr/bin/env bash
set -euo pipefail

environment="${1:-}"
ref_type="${2:-}"
ref_name="${3:-}"
release_profile="${4:-standard}"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

case "$release_profile" in
  standard)
    case "$environment" in
      dev)
        [[ "$ref_type" == "branch" && "$ref_name" == "dev" ]] || \
          fail "standard EKS dev images must be published from the dev branch"
        ;;
      staging)
        [[ -n "$ref_type" && -n "$ref_name" ]] || \
          fail "staging image delivery requires an explicit Git ref"
        ;;
      *)
        fail "unsupported EKS image environment: ${environment:-<empty>}"
        ;;
    esac
    ;;
  ec2-recovery-e6f86eb8)
    [[ "$environment" == "dev" ]] || \
      fail "the EC2 recovery profile is restricted to the dev environment"
    [[ "$ref_type" == "branch" && "$ref_name" == "codex/eks-recovery-e6f86eb8" ]] || \
      fail "the EC2 recovery profile must be published from codex/eks-recovery-e6f86eb8"
    ;;
  *)
    fail "unsupported EKS release profile: ${release_profile:-<empty>}"
    ;;
esac

printf 'EKS image source accepted: environment=%s profile=%s ref=%s/%s\n' \
  "$environment" "$release_profile" "$ref_type" "$ref_name"
