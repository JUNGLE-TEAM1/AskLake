#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TERRAFORM_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TERRAFORM_BIN=${TERRAFORM_BIN:-terraform}

if ! command -v "$TERRAFORM_BIN" >/dev/null 2>&1 && [ ! -x "$TERRAFORM_BIN" ]; then
  echo "Terraform CLI not found. Set TERRAFORM_BIN to Terraform 1.7+ or install terraform." >&2
  exit 1
fi

export TF_IN_AUTOMATION=1
export TF_INPUT=0

"$TERRAFORM_BIN" fmt -check -recursive "$TERRAFORM_ROOT"

"$TERRAFORM_BIN" -chdir="$TERRAFORM_ROOT/bootstrap" init -backend=false -input=false
"$TERRAFORM_BIN" -chdir="$TERRAFORM_ROOT/bootstrap" validate
"$TERRAFORM_BIN" -chdir="$TERRAFORM_ROOT/bootstrap" test -no-color

"$TERRAFORM_BIN" -chdir="$TERRAFORM_ROOT/environments/staging" init -backend=false -input=false
"$TERRAFORM_BIN" -chdir="$TERRAFORM_ROOT/environments/staging" validate
"$TERRAFORM_BIN" -chdir="$TERRAFORM_ROOT/environments/staging" test -no-color

echo "AWS staging Terraform Phase 1 verified without AWS credentials."
