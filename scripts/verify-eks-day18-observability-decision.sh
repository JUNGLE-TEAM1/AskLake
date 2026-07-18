#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DECISION="$ROOT_DIR/infra/eks/observability/day18-observability-decision.json"

command -v jq >/dev/null 2>&1 || {
  echo "missing required command: jq" >&2
  exit 1
}
[[ -f "$DECISION" ]] || {
  echo "Day 18 observability decision is missing" >&2
  exit 1
}

jq -e '
  .contractVersion == "asklake.eks.day18.observability-decision.v1"
  and .status == "applied-with-runtime-limitations"
  and .selected.delivery == "amazon-cloudwatch-observability-eks-addon"
  and (.selected.addonVersion | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-eksbuild\\.[0-9]+$"))
  and .selected.containerInsights == "otel"
  and .selected.applicationSignals == false
  and .selected.classicContainerInsights == false
  and .selected.containerLogs == false
  and .selected.otelNativeLogs == true
  and .selected.standaloneFluentBit == false
  and .selected.standaloneAdot == false
  and .compatibility.eksAutoMode == true
  and .compatibility.exactVersionMustBeRevalidatedBeforeApply == true
  and .identity.mode == "eks-pod-identity"
  and .identity.serviceAccount == "cloudwatch-agent"
  and .identity.dedicatedRole == true
  and .identity.attachToNodeRole == false
  and .identity.xrayPermissions == false
  and .identity.requiredActionsMustBeVerifiedInPhase2 == true
  and .identity.requiredActionsVerifiedInPhase2 == true
  and .collection.kubernetesEvents.source == "kubernetes-api-read-only"
  and .collection.kubernetesEvents.cloudWatchDelivery == false
  and .collection.dropDebugLogs == false
  and .collection.debugFilterStatus == "deferred-runtime-schema-unsupported"
  and .retentionDays.application == 7
  and .retentionDays.controlPlane == 7
  and .retentionDays.rdsPostgresql == 7
  and .costGuardrails.monthlyCloudWatchBudgetUsd == 75
  and .costGuardrails.dailyLogIngestGiBWarning == 3
  and .costGuardrails.storedLogGiBWarning == 20
  and .costGuardrails.applicationSignalsMayNotBeEnabledImplicitly == true
  and .costGuardrails.dualPublishClassicAndOtel == false
  and .runtime.addonStatus == "ACTIVE"
  and .runtime.allAddonWorkloadsReady == true
  and .runtime.applicationLogDelivered == true
  and .runtime.legacyFluentBitPods == 0
  and .runtime.accessDenied == 0
  and .runtime.clusterScraperNetwork == "pod-network-post-apply-reconcile"
  and .runtime.metricsDelivery == "partial-success-with-http-400-drops"
  and .runtime.metricsLiveGate == "open-follow-up-required"
  and .rollback.removeAddonSoftwareOnRollback == true
  and .rollback.retainLogGroups == true
  and .rollback.retainExistingControlPlaneLogging == true
' "$DECISION" >/dev/null

echo "EKS Day 18 observability decision contract passed."
