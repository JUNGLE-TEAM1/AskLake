#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$ROOT_DIR/scripts/deploy.sh"
RUNNER="$ROOT_DIR/scripts/verify-eks-day18-ec2-rollback.sh"

bash -n "$DEPLOY"
bash -n "$RUNNER"

rendered="$(ASKLAKE_COMPOSE_PROJECT_NAME=asklake-release bash -c '
  source "$1"
  compose_cmd
' _ "$DEPLOY")"
[[ "$rendered" == *'docker compose --project-name asklake-release'* ]]
[[ "$rendered" == *'--env-file deploy/.env'* ]]
[[ "$rendered" == *'-f deploy/docker-compose.prod.yml'* ]]

if ASKLAKE_COMPOSE_PROJECT_NAME='INVALID PROJECT' bash -c '
  source "$1"
  compose_cmd
' _ "$DEPLOY" >/dev/null 2>&1; then
  echo "deploy script accepted an unsafe Compose project name" >&2
  exit 1
fi

if env -u ASKLAKE_COMPOSE_PROJECT_NAME bash -c '
  source "$1"
  compose_cmd
' _ "$DEPLOY" >/dev/null 2>&1; then
  echo "deploy script silently defaulted the Compose project" >&2
  exit 1
fi

for contract in \
  'ASKLAKE_COMPOSE_PROJECT_NAME must explicitly identify the rollback stack' \
  'runtimeControlPlane == "local"' \
  'verify-eks-continuous-process-boundary.sh' \
  'appUrlTargetsInstance:true' \
  'nonDisruptiveAudit:true' \
  'healthChecksNotApplied' \
  'oneShotNonZero == 0'; do
  grep -Fq "$contract" "$RUNNER" || {
    echo "EC2 rollback runner is missing contract: $contract" >&2
    exit 1
  }
done

echo "EKS Day 18 EC2 rollback contract passed."
