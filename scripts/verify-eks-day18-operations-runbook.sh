#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNBOOK="${ASKLAKE_DAY18_RUNBOOK_PATH:-$ROOT_DIR/docs/eks-day18-operations-runbook.md}"

fail() {
  echo "$1" >&2
  exit 1
}

[[ -s "$RUNBOOK" ]] || fail "Day 18 operations runbook is missing"

for heading in \
  '## 사전 조건과 비공개 입력' \
  '## 1. 읽기 전용 초기 분류' \
  '## 2. kubectl, ALB와 RDS 장애 분류' \
  '## 3. CloudWatch와 Kubernetes Event 확인' \
  '## 4. Pod와 Node 복구' \
  '## 5. immutable digest rollout과 rollback' \
  '## 6. 보존 EC2 fallback' \
  '## 7. ALB 기반 수동 인수' \
  '## 8. 비용과 cleanup' \
  '## 9. 완료와 인계 기준'; do
  grep -Fqx "$heading" "$RUNBOOK" || fail "runbook heading is missing: $heading"
done

required_scripts=(
  capture-eks-day18-a-baseline.sh
  verify-eks-day15-alb-runtime.sh
  verify-eks-continuous-process-boundary.sh
  capture-eks-day18-events.sh
  reconcile-eks-day18-observability-runtime.sh
  verify-eks-day18-recovery-smoke.sh
  run-eks-day18-isolated-recovery-smoke.sh
  preflight-eks-backend-image-rollout.sh
  rollout-eks-backend-image.sh
  run-eks-day18-backend-rollout-round-trip.sh
  verify-eks-day18-ec2-rollback-contract.sh
  verify-eks-day18-ec2-rollback.sh
  deploy.sh
  capture-eks-day18-cost-cleanup-evidence.sh
)

for script in "${required_scripts[@]}"; do
  [[ -s "$ROOT_DIR/scripts/$script" ]] || fail "referenced runbook script is missing: $script"
  [[ -x "$ROOT_DIR/scripts/$script" ]] || fail "referenced runbook script is not executable: $script"
  grep -Fq "scripts/$script" "$RUNBOOK" || fail "runbook does not reference required script: $script"
done

for contract in \
  'ASKLAKE_DAY18_PHASE4_CONFIRM=terminate-isolated-general-nodeclaim' \
  'ASKLAKE_BACKEND_IMAGE_ROLLOUT_CONFIRM=deploy-new-immutable-backend' \
  'export ASKLAKE_EXPECTED_EC2_INSTANCE_ID="${ASKLAKE_EC2_INSTANCE_ID:?}"' \
  'infra/eks/delivery/<private>.image-receipt.json' \
  'git check-ignore -q -- "$ASKLAKE_IMAGE_RECEIPT"' \
  'deploy/ec2.env must use mode 0600' \
  'backend_rollout_rollback=completed_and_steady' \
  'ASKLAKE_DAY18_BACKEND_ROUND_TRIP_CONFIRM=promote-rollback-repromote-immutable-backend' \
  'backend_round_trip_additional_mutation=stopped' \
  '추가 mutation을 중단한다' \
  'start` 성공은 cutover가 아니다' \
  '관측 불완전' \
  'S3 object, Catalog' \
  'external_ec2' \
  'mode `0600`' \
  'Phase 7' \
  'Phase 8'; do
  grep -Fq "$contract" "$RUNBOOK" || fail "runbook contract is missing: $contract"
done

command_blocks="$(awk '
  /^```bash[[:space:]]*$/ { inside=1; next }
  /^```[[:space:]]*$/ && inside { inside=0; next }
  inside { print }
' "$RUNBOOK")"

if grep -Eq '(^|[;&|][[:space:]]*)kubectl[[:space:]]+delete[[:space:]]+(namespace|ns)([[:space:]]|$)' \
  <<<"$command_blocks"; then
  fail "runbook contains an executable broad namespace deletion"
fi
if grep -Eq '(^|[;&|][[:space:]]*)terraform([^#;|&]*)[[:space:]]destroy([[:space:]]|$)' \
  <<<"$command_blocks"; then
  fail "runbook contains an executable Terraform destroy"
fi
if grep -Eq '(^|[;&|][[:space:]]*)docker[[:space:]]+compose([^#;|&]*)[[:space:]]down([^#;|&]*)(--volumes|-v)([[:space:]]|$)' \
  <<<"$command_blocks"; then
  fail "runbook contains an executable Compose volume deletion"
fi
if grep -Eq '(^|[;&|][[:space:]]*)kubectl[[:space:]]+set[[:space:]]+image([[:space:]]|$)' \
  <<<"$command_blocks"; then
  fail "runbook contains an executable mutable kubectl image update"
fi
if grep -Eq "(^|[=[:space:]])[^[:space:]]+:(latest|dev|main)([[:space:]\"']|$)" \
  <<<"$command_blocks"; then
  fail "runbook contains a mutable image tag in an executable block"
fi

bash -n "$ROOT_DIR/scripts/run-eks-day18-isolated-recovery-smoke.sh"
bash -n "$ROOT_DIR/scripts/rollout-eks-backend-image.sh"
bash -n "$ROOT_DIR/scripts/run-eks-day18-backend-rollout-round-trip.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-day18-ec2-rollback.sh"

echo "EKS Day 18 operations runbook contract passed."
