#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
STATE="${ASKLAKE_TERRAFORM_STATE:-$ROOT_DIR/infra/eks/terraform/terraform.tfstate}"
EXAMPLE="$ROOT_DIR/infra/eks/delivery/dev.handoff.example.json"
RUNTIME_EXAMPLE="$ROOT_DIR/infra/eks/secrets/runtime-secret-contract.example.json"
HANDOFF="${ASKLAKE_DAY16_HANDOFF:-$ROOT_DIR/infra/eks/delivery/dev.day16-a.handoff.json}"
RUNTIME="${ASKLAKE_DAY16_RUNTIME_CONTRACT:-$ROOT_DIR/infra/eks/secrets/dev.day16-a.runtime-secret-contract.json}"

fail() { echo "$1" >&2; exit 1; }
for command in git jq node; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR")" || fail "current image receipt is invalid"
for file in "$STATE" "$RECEIPT" "$EXAMPLE" "$RUNTIME_EXAMPLE"; do [[ -s "$file" ]] || fail "handoff source input is missing"; done
git -C "$ROOT_DIR" check-ignore -q -- "$STATE" || fail "Terraform state must be ignored"
[[ ! -e "$HANDOFF" && ! -e "$RUNTIME" ]] || fail "private handoff already exists; verify instead of overwriting"

temporary_handoff="$(mktemp "$(dirname "$HANDOFF")/.day16-handoff.XXXXXX")"
temporary_runtime="$(mktemp "$(dirname "$RUNTIME")/.day16-runtime-contract.XXXXXX")"
cleanup() { rm -f "$temporary_handoff" "$temporary_runtime"; }
trap cleanup EXIT

jq -n --slurpfile state "$STATE" --slurpfile receipt "$RECEIPT" --slurpfile example "$EXAMPLE" '
  ($state[0].outputs) as $o | ($receipt[0].images) as $images | ($example[0]) as $e |
  {
    contractVersion:"1.1",environment:"dev",readiness:"planning",
    runtimeBoundary:$e.runtimeBoundary,
    kubernetes:{clusterName:$o.cluster_name.value,namespace:$o.namespace.value,nodeArchitecture:"linux/amd64",serviceAccounts:$o.service_account_names.value},
    images:$images,
    configReferences:$e.configReferences,
    dataPlaneReferences:{
      mskClusterArn:$o.msk_contract.value.cluster_arn,
      mskBootstrapBrokersSaslIam:$o.msk_contract.value.bootstrap_brokers_sasl_iam,
      rdsEndpoint:$o.rds_contract.value.endpoint,
      storageBuckets:$o.storage_contract.value.buckets,
      trinoServiceUrl:$o.trino_handoff.value.service.in_cluster_url,
      workloadIdentityMode:$o.workload_identity_contract.value.mode
    },
    isolatedFixture:{
      topic:$o.msk_contract.value.test_topic,
      consumerGroup:$o.msk_contract.value.test_consumer_group,
      outputPrefix:"eks-mvp/output/",
      checkpointPrefix:($o.storage_contract.value.prefixes.checkpoint+"/eks-mvp/")
    },
    networkFlows:$e.networkFlows,
    decisions:{
      clusterReuseOrCreate:{status:"selected",selected:"new-eks-auto-mode"},
      workloadIdentity:{status:"selected",selected:"pod_identity"},
      secretDelivery:{status:"selected",selected:"external_secrets"},
      ingressExposure:{status:"selected",selected:"internet-facing-http-alb"},
      domainAndCertificate:{status:"deferred",selected:null},
      privateEgress:{status:"selected",selected:"single-nat-plus-vpc-endpoints"},
      continuousReadPath:{status:"deferred",selected:null}
    }
  }
' >"$temporary_handoff"

jq '
  .delivery={
    mode:"external_secrets",controllerReady:true,controllerOwner:"pair-a",
    rotationOwner:"pair-a",sourcePrefix:"asklake/dev"
  }
' "$RUNTIME_EXAMPLE" >"$temporary_runtime"
chmod 600 "$temporary_handoff" "$temporary_runtime"
node "$ROOT_DIR/scripts/verify-eks-delivery-handoff.mjs" "$temporary_handoff" >/dev/null
node "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs" --ready "$temporary_runtime" >/dev/null
mv "$temporary_handoff" "$HANDOFF"
mv "$temporary_runtime" "$RUNTIME"
chmod 600 "$HANDOFF" "$RUNTIME"
trap - EXIT
echo "day16_a_private_handoff=created"
