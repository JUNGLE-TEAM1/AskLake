#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFIER="$ROOT_DIR/scripts/verify-eks-day18-operations-runbook.sh"
SOURCE="$ROOT_DIR/docs/eks-day18-operations-runbook.md"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

pass_count=0

expect_pass() {
  local name="$1" file="$2"
  if ! ASKLAKE_DAY18_RUNBOOK_PATH="$file" bash "$VERIFIER" >/dev/null; then
    echo "not ok - $name" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
  echo "ok - $name"
}

expect_fail() {
  local name="$1" file="$2"
  if ASKLAKE_DAY18_RUNBOOK_PATH="$file" bash "$VERIFIER" >/dev/null 2>&1; then
    echo "not ok - $name" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
  echo "ok - $name"
}

valid="$TEMP_DIR/valid.md"
cp "$SOURCE" "$valid"
expect_pass "current runbook passes" "$valid"

missing_instance="$TEMP_DIR/missing-instance.md"
sed '/export ASKLAKE_EXPECTED_EC2_INSTANCE_ID=/d' "$SOURCE" >"$missing_instance"
expect_fail "missing exact preserved EC2 export is rejected" "$missing_instance"

missing_receipt="$TEMP_DIR/missing-receipt.md"
sed 's#infra/eks/delivery/<private>\.image-receipt\.json#/private/tmp/image-receipt.json#g' \
  "$SOURCE" >"$missing_receipt"
expect_fail "non-contract image receipt location is rejected" "$missing_receipt"

missing_round_trip="$TEMP_DIR/missing-round-trip.md"
sed 's/ASKLAKE_DAY18_BACKEND_ROUND_TRIP_CONFIRM=promote-rollback-repromote-immutable-backend/ASKLAKE_DAY18_BACKEND_ROUND_TRIP_CONFIRM=unsafe/' \
  "$SOURCE" >"$missing_round_trip"
expect_fail "intentional rollback confirmation drift is rejected" "$missing_round_trip"

unsafe_namespace="$TEMP_DIR/unsafe-namespace.md"
cp "$SOURCE" "$unsafe_namespace"
printf '\n```bash\nkubectl delete ns asklake-dev\n```\n' >>"$unsafe_namespace"
expect_fail "broad namespace deletion is rejected" "$unsafe_namespace"

unsafe_terraform="$TEMP_DIR/unsafe-terraform.md"
cp "$SOURCE" "$unsafe_terraform"
printf '\n```bash\nterraform -chdir=infra/eks/terraform destroy -auto-approve\n```\n' >>"$unsafe_terraform"
expect_fail "Terraform destroy is rejected" "$unsafe_terraform"

unsafe_volume="$TEMP_DIR/unsafe-volume.md"
cp "$SOURCE" "$unsafe_volume"
printf '\n```bash\ndocker compose down --volumes\n```\n' >>"$unsafe_volume"
expect_fail "Compose volume deletion is rejected" "$unsafe_volume"

unsafe_image="$TEMP_DIR/unsafe-image.md"
cp "$SOURCE" "$unsafe_image"
printf '\n```bash\nkubectl set image deployment/fastapi fastapi=example/backend:latest\n```\n' >>"$unsafe_image"
expect_fail "mutable kubectl image update is rejected" "$unsafe_image"

printf 'Day 18 operations runbook regression summary: %d passed.\n' "$pass_count"
