#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---audit}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
CAMPAIGN_RECEIPT="${ASKLAKE_DAY17_MULTI_SPARK_RECEIPT:-/private/tmp/asklake-day17-multi-spark-baked-receipt.json}"
RESULTS_RECEIPT="${ASKLAKE_DAY17_MULTI_SPARK_RESULTS:-/private/tmp/asklake-day17-multi-spark-results.json}"
OBSERVER_RECORD="${ASKLAKE_DAY17_MULTI_SPARK_OBSERVER:-/private/tmp/asklake-day17-multi-spark-observer.jsonl}"
OUTPUT="${ASKLAKE_DAY17_CLEANUP_AUDIT:-/private/tmp/asklake-day17-cleanup-audit.json}"

fail() {
  echo "$1" >&2
  exit 1
}

[[ "$MODE" == "--audit" ]] || fail "usage: audit-eks-day17-cleanup.sh [--audit]"
for command in date jq kubectl pgrep stat; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
for file in "$CAMPAIGN_RECEIPT" "$RESULTS_RECEIPT" "$OBSERVER_RECORD"; do
  [[ -s "$file" ]] || fail "Day 17 cleanup audit input is missing"
  case "$file" in
    /private/tmp/asklake-day17-*) ;;
    *) fail "Day 17 cleanup audit input must remain under /private/tmp" ;;
  esac
  [[ "$(stat -f '%Lp' "$file")" == "600" ]] || \
    fail "Day 17 cleanup audit input must use mode 0600"
done
case "$OUTPUT" in
  /private/tmp/asklake-day17-*.json) ;;
  *) fail "Day 17 cleanup audit output must remain under /private/tmp" ;;
esac
[[ ! -e "$OUTPUT" ]] || \
  fail "Day 17 cleanup audit already exists; preserve it and choose a new output path"

audit_dir="$(mktemp -d)"
cleanup() {
  rm -f \
    "$audit_dir/hpa.json" \
    "$audit_dir/deployment.json" \
    "$audit_dir/pods.json" \
    "$audit_dir/jobs.json" \
    "$audit_dir/configmaps.json" \
    "$audit_dir/secrets.json" \
    "$audit_dir/result.json"
  rmdir "$audit_dir"
}
trap cleanup EXIT

kubectl get hpa fastapi -n "$NAMESPACE" -o json >"$audit_dir/hpa.json"
kubectl get deployment fastapi -n "$NAMESPACE" -o json >"$audit_dir/deployment.json"
kubectl get pods -n "$NAMESPACE" -o json >"$audit_dir/pods.json"
kubectl get jobs -n "$NAMESPACE" -o json >"$audit_dir/jobs.json"
kubectl get configmaps -n "$NAMESPACE" -o json >"$audit_dir/configmaps.json"
kubectl get secrets -n "$NAMESPACE" -o json >"$audit_dir/secrets.json"

load_processes="$(
  { pgrep -f '[r]un-eks-day17-api-load|[r]un-eks-day17-api-load.mjs' 2>/dev/null || true; } \
    | wc -l \
    | tr -d ' '
)"
observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

jq -n \
  --arg observedAt "$observed_at" \
  --argjson loadProcesses "$load_processes" \
  --slurpfile hpa "$audit_dir/hpa.json" \
  --slurpfile deployment "$audit_dir/deployment.json" \
  --slurpfile pods "$audit_dir/pods.json" \
  --slurpfile jobs "$audit_dir/jobs.json" \
  --slurpfile configmaps "$audit_dir/configmaps.json" \
  --slurpfile secrets "$audit_dir/secrets.json" \
  --slurpfile campaign "$CAMPAIGN_RECEIPT" \
  --slurpfile results "$RESULTS_RECEIPT" \
  --slurpfile observer "$OBSERVER_RECORD" '
def activeSparkPods:
  ((.pods.totals.driver.Pending//0)
   +(.pods.totals.driver.Running//0)
   +(.pods.totals.executor.Pending//0)
   +(.pods.totals.executor.Running//0));
def allRunsSuccess:
  (((.runs.entries//[])|length)==3)
  and ((.runs.entries//[])|all(.rds=="success" and .airflow=="success" and .spark=="success" and .catalog=="success"));
def day17Temporary:
  (((.metadata.labels["asklake.io/temporary"]//"")=="true")
   and (
     ((.metadata.name//"")|startswith("asklake-day17-"))
     or ((.metadata.labels["app.kubernetes.io/name"]//"")|startswith("asklake-day17-"))
   ));
def backendPod:
  (.metadata.labels["app.kubernetes.io/name"]//"")=="asklake"
  and (.metadata.labels["app.kubernetes.io/component"]//"")=="backend";

($campaign[0].redactedRuns|map(.run)|sort) as $expectedRuns |
($observer
 | map(select(
     .observedAt >= $campaign[0].createdAt
     and ((.runs.entries//[])|map(.runHash)|sort)==$expectedRuns
   ))) as $campaignRecords |
($campaignRecords|map(select(allRunsSuccess))|first) as $allSuccess |
($campaignRecords
 | map(select(
     allRunsSuccess
     and activeSparkPods==0
     and (.nodeScale.sparkNodes//-1)==(.nodeScale.baselineSparkNodes//-2)
   ))
 | first) as $baseline |
($campaignRecords
 | map(.events.items[]?
       | select(.reason=="RemovingNode" or .reason=="Drained" or .reason=="DisruptionTerminating")
       | [.observedAt,.reason,.kind])
 | unique
 | length) as $removalSignals |
{
  contractVersion:"1.0",
  mode:"read-only",
  observedAt:$observedAt,
  hpa:{
    current:($hpa[0].status.currentReplicas//0),
    desired:($hpa[0].status.desiredReplicas//0),
    min:($hpa[0].spec.minReplicas//0),
    max:($hpa[0].spec.maxReplicas//0)
  },
  fastapi:{
    deployment:{
      replicas:($deployment[0].status.replicas//0),
      updated:($deployment[0].status.updatedReplicas//0),
      ready:($deployment[0].status.readyReplicas//0),
      available:($deployment[0].status.availableReplicas//0),
      unavailable:($deployment[0].status.unavailableReplicas//0)
    },
    pods:{
      total:([$pods[0].items[]|select(backendPod)]|length),
      ready:([$pods[0].items[]|select(backendPod and any(.status.conditions[]?;.type=="Ready" and .status=="True"))]|length),
      terminating:([$pods[0].items[]|select(backendPod and .metadata.deletionTimestamp!=null)]|length)
    }
  },
  campaign:{
    runs:($results[0].counts.runs//0),
    peakSparkNodes:($campaignRecords|map(.nodeScale.sparkNodes//0)|max//0),
    allRunsSuccessAt:($allSuccess.observedAt//null),
    activeSparkPodsAtSuccess:(if $allSuccess==null then -1 else ($allSuccess|activeSparkPods) end),
    baselineSparkNodes:($baseline.nodeScale.baselineSparkNodes//null),
    recoveredSparkNodes:($baseline.nodeScale.sparkNodes//null),
    baselineRecoveredAt:($baseline.observedAt//null),
    removalSignals:$removalSignals
  },
  temporary:{
    jobs:([$jobs[0].items[]|select(day17Temporary)]|length),
    pods:([$pods[0].items[]|select(day17Temporary)]|length),
    configMaps:([$configmaps[0].items[]|select(day17Temporary)]|length),
    secrets:([$secrets[0].items[]|select(day17Temporary)]|length),
    localLoadProcesses:$loadProcesses
  },
  preserved:{
    resultStatus:($results[0].status//"unavailable"),
    durableRuns:($results[0].counts.runs//0),
    snapshots:($results[0].counts.snapshots//0),
    materializations:($results[0].counts.materializations//0)
  }
}
| .checks={
    hpaAtMinimum:(.hpa.current==2 and .hpa.desired==2 and .hpa.min==2),
    fastApiStable:(.fastapi.deployment=={replicas:2,updated:2,ready:2,available:2,unavailable:0}),
    fastApiPodsStable:(.fastapi.pods=={total:2,ready:2,terminating:0}),
    campaignRunsTerminal:(.campaign.runs==3 and .campaign.activeSparkPodsAtSuccess==0),
    sparkNodesReturnedToBaseline:(.campaign.peakSparkNodes>=2 and .campaign.baselineSparkNodes==0 and .campaign.recoveredSparkNodes==0 and .campaign.baselineRecoveredAt!=null),
    nodeRemovalSignalsObserved:(.campaign.removalSignals>0),
    temporaryResourcesZero:(.temporary.jobs==0 and .temporary.pods==0 and .temporary.configMaps==0 and .temporary.secrets==0),
    loadGeneratorStopped:(.temporary.localLoadProcesses==0),
    durableEvidencePreserved:(.preserved.resultStatus=="passed" and .preserved.durableRuns==3 and .preserved.snapshots==3 and .preserved.materializations==3)
  }
| .status=(if ([.checks[]]|all) then "passed" else "blocked" end)
' >"$audit_dir/result.json"

jq -e '
  .status=="passed"
  and .mode=="read-only"
  and ([.checks[]]|all)
  and (has("privateIdentity")|not)
' "$audit_dir/result.json" >/dev/null || fail "Day 17 cleanup audit did not pass"
mv "$audit_dir/result.json" "$OUTPUT"
chmod 600 "$OUTPUT"
trap - EXIT
cleanup

jq -r '
  "day17_cleanup="+.status
  +" hpa="+(.hpa.current|tostring)+"/"+(.hpa.desired|tostring)
  +" fastapi="+(.fastapi.deployment.ready|tostring)
  +" spark_nodes="+(.campaign.peakSparkNodes|tostring)+"->"+(.campaign.recoveredSparkNodes|tostring)
  +" temporary="+((.temporary.jobs+.temporary.pods+.temporary.configMaps+.temporary.secrets)|tostring)
' "$OUTPUT"
