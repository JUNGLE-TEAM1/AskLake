#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

git -C "$TEST_ROOT" init -q
git -C "$TEST_ROOT" config user.email test@example.invalid
git -C "$TEST_ROOT" config user.name Test
mkdir -p "$TEST_ROOT/docs"
printf '%s\n' 'safe <run-redacted> sha256:<redacted> https://<public-host>' >"$TEST_ROOT/docs/safe.md"
git -C "$TEST_ROOT" add docs/safe.md
ASKLAKE_REDACTION_ROOT="$TEST_ROOT" bash "$ROOT_DIR/scripts/verify-tracked-evidence-redaction.sh" >/dev/null

printf '%s\n' \
  'unsafe run_deadbeef1234' \
  'unsafe sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'unsafe i-0123456789abcdef0' >"$TEST_ROOT/docs/unsafe.md"
git -C "$TEST_ROOT" add docs/unsafe.md
if ASKLAKE_REDACTION_ROOT="$TEST_ROOT" bash "$ROOT_DIR/scripts/verify-tracked-evidence-redaction.sh" \
  >"$TEST_ROOT/output.log" 2>&1; then
  echo "redaction verifier accepted raw evidence identifiers" >&2
  exit 1
fi
grep -q 'category=image_digest file=docs/unsafe.md' "$TEST_ROOT/output.log"
grep -q 'category=run_id file=docs/unsafe.md' "$TEST_ROOT/output.log"
grep -q 'category=ec2_instance file=docs/unsafe.md' "$TEST_ROOT/output.log"
if grep -q 'deadbeef1234\|aaaaaaaaaaaaaaaa\|i-0123456789abcdef0' "$TEST_ROOT/output.log"; then
  echo "redaction verifier leaked the matched value" >&2
  exit 1
fi

echo "Tracked evidence redaction tests passed."
