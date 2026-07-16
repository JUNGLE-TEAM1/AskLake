#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HANDOFF="${ASKLAKE_DAY16_HANDOFF:-$ROOT_DIR/infra/eks/delivery/dev.day16-a.handoff.json}"

fail() { echo "$1" >&2; exit 1; }
[[ "${ASKLAKE_DAY16_PROMOTE_CONFIRM:-}" == "promote-ready-for-deploy" ]] || \
  fail "set ASKLAKE_DAY16_PROMOTE_CONFIRM=promote-ready-for-deploy"
[[ -s "$HANDOFF" ]] || fail "private handoff is missing"
git -C "$ROOT_DIR" check-ignore -q -- "$HANDOFF" || fail "private handoff must remain ignored"

candidate="$(dirname "$HANDOFF")/dev.day16-a.promote-candidate.handoff.json"
[[ ! -e "$candidate" ]] || fail "promotion candidate already exists"
cleanup() { rm -f "$candidate"; }
trap cleanup EXIT
jq '.readiness="ready-for-deploy"' "$HANDOFF" >"$candidate"
chmod 600 "$candidate"
ASKLAKE_DAY16_HANDOFF="$candidate" bash "$ROOT_DIR/scripts/verify-eks-day16-a-handoff.sh" --ready >/dev/null
mv "$candidate" "$HANDOFF"
chmod 600 "$HANDOFF"
trap - EXIT
echo "day16_a_handoff=ready-for-deploy"
