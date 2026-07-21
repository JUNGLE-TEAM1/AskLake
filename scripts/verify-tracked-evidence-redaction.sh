#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="${ASKLAKE_REDACTION_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
failures=0

categories=(
  image_digest
  uuid
  run_id
  spark_application
  fixture_batch
  ec2_instance
  public_ip_endpoint
  aws_arn
  aws_private_endpoint
  credential
)
patterns=(
  'sha256:[0-9a-f]{64}'
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  '\brun_[A-Za-z0-9-]{8,}\b'
  '\basklake-run-[A-Za-z0-9-]{8,}\b'
  '\beks-mvp-[0-9]{14}-[0-9a-f]{8}\b'
  '\bi-[0-9a-f]{17}\b'
  'https://[0-9]{1,3}(-[0-9]{1,3}){3}\.sslip\.io'
  'arn:aws:[^:[:space:]]+:[^:[:space:]]*:[0-9]{12}:'
  '[A-Za-z0-9.-]+\.(rds|kafka-serverless)\.[A-Za-z0-9-]+\.amazonaws\.com'
  'AKIA[0-9A-Z]{16}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----'
)

while IFS= read -r -d '' file; do
  [[ -f "$ROOT_DIR/$file" ]] || continue
  for index in "${!patterns[@]}"; do
    if rg -q "${patterns[$index]}" "$ROOT_DIR/$file"; then
      printf 'tracked_evidence_redaction=failed category=%s file=%s\n' "${categories[$index]}" "$file" >&2
      failures=$((failures+1))
    fi
  done
done < <(git -C "$ROOT_DIR" ls-files -z -- 'docs/*.md')

[[ "$failures" -eq 0 ]] || exit 1
echo "Tracked evidence redaction verification passed."
