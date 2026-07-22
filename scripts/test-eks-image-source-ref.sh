#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFIER="$ROOT_DIR/scripts/verify-eks-image-source-ref.sh"
passed=0

expect_success() {
  "$VERIFIER" "$@" >/dev/null
  passed=$((passed + 1))
}

expect_failure() {
  if "$VERIFIER" "$@" >/dev/null 2>&1; then
    printf 'expected source-ref rejection: %s\n' "$*" >&2
    exit 1
  fi
  passed=$((passed + 1))
}

expect_success dev branch dev
expect_failure dev branch pair1
expect_failure dev tag dev
expect_failure dev branch feature/dev-deploy-unification
expect_success staging branch dev
expect_failure unknown branch dev
expect_success dev branch codex/eks-recovery-e6f86eb8 ec2-recovery-e6f86eb8
expect_failure staging branch codex/eks-recovery-e6f86eb8 ec2-recovery-e6f86eb8
expect_failure dev branch dev ec2-recovery-e6f86eb8
expect_failure dev tag codex/eks-recovery-e6f86eb8 ec2-recovery-e6f86eb8
expect_failure dev branch codex/eks-recovery-e6f86eb8 unknown-profile

printf 'EKS image source-ref contract: %s passed\n' "$passed"
