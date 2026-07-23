#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

OUTPUT="${ASKLAKE_DAY18_PHASE3_OUTPUT:-/private/tmp/asklake-day18-phase3-cost-cleanup.json}"
SCALE_EVIDENCE="${ASKLAKE_DAY18_SCALE_EVIDENCE:-}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
DECISION="$ROOT_DIR/infra/eks/observability/day18-observability-decision.json"

fail() {
  echo "$1" >&2
  exit 1
}

[[ "${1:---capture}" == "--capture" ]] || fail "usage: $0 --capture"
[[ ! -e "$OUTPUT" ]] || fail "refusing to overwrite existing Phase 3 receipt: $OUTPUT"
[[ -s "$SCALE_EVIDENCE" ]] || fail "ASKLAKE_DAY18_SCALE_EVIDENCE must reference prior private scale-out/in evidence"
for command in aws git helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

if [[ -z "${ASKLAKE_EKS_CLUSTER_NAME:-}" ]]; then
  ASKLAKE_EKS_CLUSTER_NAME="$(jq -er '.outputs.cluster_name.value' \
    "$ROOT_DIR/infra/eks/terraform/terraform.tfstate")"
  export ASKLAKE_EKS_CLUSTER_NAME
fi
verify_asklake_eks_context

collector_runtime="$(kubectl get daemonset -n amazon-cloudwatch fluent-bit -o json | jq '{
  desired:(.status.desiredNumberScheduled // 0),
  ready:(.status.numberReady // 0),
  unavailable:(.status.numberUnavailable // 0)
}')"
collector_config="$(kubectl get configmap -n amazon-cloudwatch fluent-bit-config -o json | jq --arg namespace "$NAMESPACE" '{
  namespacePath:([.data[] | select(type == "string") |
    contains("/var/log/containers/*_" + $namespace + "_*.log")] | any),
  clusterWidePath:([.data[] | select(type == "string") |
    contains("Path                /var/log/containers/*.log")] | any),
  podAssociationOff:([.data[] | select(type == "string") |
    contains("Use_Pod_Association Off")] | any),
  dataPlaneInput:([.data[] | select(type == "string") | contains("dataplane.systemd")] | any),
  hostInput:([.data[] | select(type == "string") | contains("host.dmesg")] | any)
}')"
jq -e --argjson runtime "$collector_runtime" --argjson config "$collector_config" '
  $runtime.desired > 0
  and $runtime.ready == $runtime.desired
  and $runtime.unavailable == 0
  and $config.namespacePath == true
  and $config.clusterWidePath == false
  and $config.podAssociationOff == true
  and $config.dataPlaneInput == false
  and $config.hostInput == false
' <<<"{}" >/dev/null || fail "managed Fluent Bit scope or readiness gate failed"

case "$(cd "$(dirname "$SCALE_EVIDENCE")" && pwd)/$(basename "$SCALE_EVIDENCE")" in
  "$ROOT_DIR"/*)
    git -C "$ROOT_DIR" check-ignore -q "$SCALE_EVIDENCE" || \
      fail "repository-local scale evidence must be Git-ignored"
    ;;
esac

scale_proof="$(jq -e '
  . as $e |
  ($e.scope == "isolated"
    and ([$e.snapshots[].phase] == ["baseline", "sample", "final"])
    and $e.snapshots[1].capacity.general.nodes > $e.snapshots[0].capacity.general.nodes
    and $e.snapshots[1].capacity.spark.nodes > $e.snapshots[0].capacity.spark.nodes
    and $e.snapshots[2].capacity.general.nodes <= $e.snapshots[0].capacity.general.nodes
    and $e.snapshots[2].capacity.spark.nodes <= $e.snapshots[0].capacity.spark.nodes) as $valid |
  select($valid) |
    {
      valid: $valid,
      baseline: {
        general: $e.snapshots[0].capacity.general.nodes,
        spark: $e.snapshots[0].capacity.spark.nodes
      },
      peak: {
        general: $e.snapshots[1].capacity.general.nodes,
        spark: $e.snapshots[1].capacity.spark.nodes
      },
      final: {
        general: $e.snapshots[2].capacity.general.nodes,
        spark: $e.snapshots[2].capacity.spark.nodes
      }
    }
' "$SCALE_EVIDENCE")" || fail "prior scale evidence does not prove isolated scale-out and scale-in"

current_nodes="$(kubectl get nodes -o json | jq '{
  general: ([.items[] | select(.metadata.labels["karpenter.sh/nodepool"] == "asklake-general")] | length),
  spark: ([.items[] | select(.metadata.labels["karpenter.sh/nodepool"] == "asklake-spark")] | length),
  ready: ([.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length),
  total: (.items | length)
}')"

current_scale_in_state="$(jq -r --argjson current "$current_nodes" '
  $current.ready == $current.total
  and $current.general <= .final.general
  and $current.spark <= .final.spark
' <<<"$scale_proof")"
[[ "$current_scale_in_state" == "true" || "$current_scale_in_state" == "false" ]] || \
  fail "could not classify current NodePool state"

suspicious_releases="$(helm list -A -o json | jq '[.[] | select(
  .name | test("scale-smoke|nodepool-smoke|load-test|fixture-producer"; "i")
)] | length')"
runtime="$(kubectl get deployments,statefulsets,jobs,pods -n "$NAMESPACE" -o json | jq '{
  deployments: ([.items[] | select(.kind == "Deployment")] | length),
  deploymentsSteady: ([.items[] | select(.kind == "Deployment" and
    (.status.readyReplicas // 0) == (.spec.replicas // 0) and
    (.status.unavailableReplicas // 0) == 0)] | length),
  statefulSets: ([.items[] | select(.kind == "StatefulSet")] | length),
  statefulSetsSteady: ([.items[] | select(.kind == "StatefulSet" and
    (.status.readyReplicas // 0) == (.spec.replicas // 0))] | length),
  activeJobs: ([.items[] | select(.kind == "Job" and (.status.active // 0) > 0)] | length),
  pendingPods: ([.items[] | select(.kind == "Pod" and .status.phase == "Pending")] | length),
  notReadyPods: ([.items[] | select(.kind == "Pod" and .status.phase == "Running" and
    any(.status.containerStatuses[]?; .ready != true))] | length),
  terminatingPods: ([.items[] | select(.kind == "Pod" and .metadata.deletionTimestamp != null)] | length),
  completedPods: ([.items[] | select(.kind == "Pod" and .status.phase == "Succeeded")] | length),
  suspiciousTemporaryResources: ([.items[] | select(
    (.metadata.name // "") | test("scale-smoke|nodepool-smoke|load-test|fixture-producer"; "i")
  )] | length)
}')"
spark="$(kubectl get sparkapplications.sparkoperator.k8s.io -n "$NAMESPACE" -o json | jq '{
  active: ([.items[] | select((.status.applicationState.state // "") |
    IN("SUBMITTED", "RUNNING", "PENDING"))] | length),
  completed: ([.items[] | select((.status.applicationState.state // "") == "COMPLETED")] | length),
  boundedTerminalCleanup: ([.items[] | select(
    (.status.applicationState.state // "") == "COMPLETED"
    and (.spec.timeToLiveSeconds // 0) > 0
    and (.spec.timeToLiveSeconds // 0) <= 3600
    and (now - (.metadata.creationTimestamp | fromdateiso8601)) < .spec.timeToLiveSeconds
  )] | length),
  retainedEvidence: ([.items[] | select(
    (.status.applicationState.state // "") == "COMPLETED"
    and (.spec.timeToLiveSeconds // 0) > 3600
  )] | length)
}')"

bounded_cleanup_pending="false"
if [[ "$current_scale_in_state" == "false" ]]; then
  bounded_cleanup_pending="$(jq -r --argjson current "$current_nodes" --argjson proof "$scale_proof" '
    .active == 0
    and .boundedTerminalCleanup > 0
    and $current.ready == $current.total
    and $current.general <= $proof.final.general
    and $current.spark > $proof.final.spark
  ' <<<"$spark")"
  [[ "$bounded_cleanup_pending" == "true" ]] || \
    fail "current NodePool state exceeds the proven baseline without bounded terminal cleanup"
fi

jq -e --argjson releases "$suspicious_releases" --argjson runtime "$runtime" --argjson spark "$spark" '
  $releases == 0
  and $runtime.deployments == $runtime.deploymentsSteady
  and $runtime.statefulSets == $runtime.statefulSetsSteady
  and $runtime.activeJobs == 0
  and $runtime.pendingPods == 0
  and $runtime.notReadyPods == 0
  and $runtime.terminatingPods == 0
  and $runtime.suspiciousTemporaryResources == 0
  and $spark.active == 0
' <<<"{}" >/dev/null || fail "temporary-resource cleanup or steady workload gate failed"

application_group="/aws/otel/containerinsights/${ASKLAKE_EKS_CLUSTER_NAME}/application"
control_plane_group="/aws/eks/${ASKLAKE_EKS_CLUSTER_NAME}/cluster"
rds_groups="$(aws logs describe-log-groups --region "$REGION" \
  --log-group-name-prefix "/aws/rds/instance/${ASKLAKE_EKS_CLUSTER_NAME}" --output json | jq \
  '[.logGroups[] | select(.logGroupName | endswith("/postgresql")) | .logGroupName]')"
[[ "$(jq 'length' <<<"$rds_groups")" == 1 ]] || fail "expected exactly one managed RDS PostgreSQL log group"
rds_group="$(jq -r '.[0]' <<<"$rds_groups")"

log_groups="$(jq -n --arg application "$application_group" --arg control "$control_plane_group" --arg rds "$rds_group" '
  [{kind:"application",name:$application},{kind:"controlPlane",name:$control},{kind:"rdsPostgresql",name:$rds}]
')"
inventory="$(aws logs describe-log-groups --region "$REGION" --output json)"
managed_inventory="$(jq -n --argjson requested "$log_groups" --argjson inventory "$inventory" '
  [$requested[] as $request | $inventory.logGroups[] |
    select(.logGroupName == $request.name) |
    {kind:$request.kind,storedBytes:(.storedBytes // 0),retentionDays:(.retentionInDays // null),createdAt:(.creationTime // 0)}]
')"
[[ "$(jq 'length' <<<"$managed_inventory")" == 3 ]] || fail "managed log-group inventory is incomplete"
jq -e 'all(.[]; .retentionDays == 7)' <<<"$managed_inventory" >/dev/null || fail "managed log retention drift detected"

end_time="$(node -e 'process.stdout.write(new Date().toISOString())')"
start_time="$(node -e 'process.stdout.write(new Date(Date.now()-86400000).toISOString())')"
collector_start_epoch="$(kubectl get pods -n amazon-cloudwatch -l k8s-app=fluent-bit -o json | jq -er '
  [.items[] | select(all(.status.containerStatuses[]?; .ready == true)) |
    (.status.startTime | fromdateiso8601)] | min
')" || fail "ready managed Fluent Bit collector start time is unavailable"
observation_seconds="$(( $(date +%s) - collector_start_epoch ))"
(( observation_seconds >= 300 )) || fail "managed Fluent Bit cost observation window is shorter than five minutes"
(( observation_seconds <= 86400 )) || observation_seconds=86400
collector_start_time="$(node -e 'process.stdout.write(new Date(Number(process.argv[1]) * 1000).toISOString())' "$collector_start_epoch")"
incoming='[]'
while IFS=$'\t' read -r kind group; do
  bytes="$(aws cloudwatch get-metric-statistics --region "$REGION" \
    --namespace AWS/Logs --metric-name IncomingBytes \
    --dimensions "Name=LogGroupName,Value=$group" \
    --start-time "$start_time" --end-time "$end_time" --period 3600 \
    --statistics Sum --output json | jq '[.Datapoints[].Sum // 0] | add // 0')"
  current_bytes=0
  if [[ "$kind" == "application" ]]; then
    current_bytes="$(aws cloudwatch get-metric-statistics --region "$REGION" \
      --namespace AWS/Logs --metric-name IncomingBytes \
      --dimensions "Name=LogGroupName,Value=$group" \
      --start-time "$collector_start_time" --end-time "$end_time" --period 60 \
      --statistics Sum --output json | jq '[.Datapoints[].Sum // 0] | add // 0')"
  fi
  incoming="$(jq --arg kind "$kind" --argjson bytes "$bytes" --argjson current "$current_bytes" \
    '. + [{kind:$kind,incomingBytes24h:$bytes,currentCollectorBytes:$current}]' <<<"$incoming")"
done < <(jq -r '.[] | [.kind,.name] | @tsv' <<<"$log_groups")

thresholds="$(jq '{dailyIngestGiB:.costGuardrails.dailyLogIngestGiBWarning,
  storedGiB:.costGuardrails.storedLogGiBWarning,
  monthlyUsd:.costGuardrails.monthlyCloudWatchBudgetUsd}' "$DECISION")"
cost="$(jq -n --argjson incoming "$incoming" --argjson inventory "$managed_inventory" \
  --argjson thresholds "$thresholds" --argjson observationSeconds "$observation_seconds" '
  ($incoming | map(.incomingBytes24h) | add // 0) as $incomingBytes |
  ($incoming[] | select(.kind == "application") | .currentCollectorBytes) as $currentApplicationBytes |
  ($incoming | map(select(.kind != "application") | .incomingBytes24h) | add // 0) as $nonApplicationBytes |
  (($currentApplicationBytes * 86400) / $observationSeconds) as $projectedApplicationBytes |
  ($projectedApplicationBytes + $nonApplicationBytes) as $projectedManagedBytes |
  ($inventory | map(.storedBytes) | add // 0) as $storedBytes |
  {
    incomingBytes24h:$incomingBytes,
    incomingGiB24h:($incomingBytes / 1073741824),
    incomingByKind:($incoming | map({
      kind,
      incomingGiB24h:(.incomingBytes24h / 1073741824),
      currentCollectorGiB:(.currentCollectorBytes / 1073741824)
    })),
    currentCollectorObservationHours:($observationSeconds / 3600),
    currentCollectorApplicationBytes:$currentApplicationBytes,
    projectedApplicationGiBPerDay:($projectedApplicationBytes / 1073741824),
    projectedManagedGiBPerDay:($projectedManagedBytes / 1073741824),
    storedBytes:$storedBytes,
    storedGiB:($storedBytes / 1073741824),
    estimatedMonthlyIngestUsd:(($projectedManagedBytes / 1000000000) * 30 * 0.76),
    fullApplication24hWindow:($observationSeconds >= 86400),
    thresholds:$thresholds,
    withinCurrentBoundaries:(
      $projectedManagedBytes <= ($thresholds.dailyIngestGiB * 1073741824)
      and $storedBytes <= ($thresholds.storedGiB * 1073741824)
      and (($projectedManagedBytes / 1000000000) * 30 * 0.76) <= $thresholds.monthlyUsd
    )
  }
')"
jq -e '.withinCurrentBoundaries == true' <<<"$cost" >/dev/null || fail "current CloudWatch log cost boundary is exceeded"

alarms="$(aws cloudwatch describe-alarms --region "$REGION" \
  --alarm-name-prefix "${ASKLAKE_EKS_CLUSTER_NAME}-" --output json | jq '[.MetricAlarms[] |
    select(.AlarmName | test("(daily-log-ingest|stored-log)-warning$")) |
    {state:.StateValue,actionsEnabled:.ActionsEnabled,actionCount:((.AlarmActions // []) | length)}]
')"
jq -e 'length == 2 and all(.[]; .actionsEnabled == false and .actionCount == 0)' \
  <<<"$alarms" >/dev/null || fail "cost alarm ownership/action gate failed"

receipt="$(jq -n \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson cost "$cost" --argjson alarms "$alarms" --argjson scale "$scale_proof" \
  --argjson currentNodes "$current_nodes" --argjson releases "$suspicious_releases" \
  --argjson runtime "$runtime" --argjson spark "$spark" \
  --argjson collectorRuntime "$collector_runtime" --argjson collectorConfig "$collector_config" \
  --argjson currentScaleInState "$current_scale_in_state" \
  --argjson boundedCleanupPending "$bounded_cleanup_pending" '
  {
    contract:"asklake.eks.day18.phase3.cost-cleanup.v1",
    capturedAt:$capturedAt,
    cost:$cost,
    alarms:{count:($alarms|length),states:($alarms|map(.state)|sort),actionsEnabled:false},
    scaling:{priorProof:$scale,currentNodes:$currentNodes},
    cleanup:{suspiciousHelmReleases:$releases,runtime:$runtime,spark:$spark},
    collector:{runtime:$collectorRuntime,config:$collectorConfig},
    gates:{
      currentCostBoundary:true,
      full24HourCostWindow:$cost.fullApplication24hWindow,
      scaleOutInProof:true,
      currentScaleInState:$currentScaleInState,
      boundedAutomaticCleanupPending:$boundedCleanupPending,
      temporaryCleanup:true,
      notificationTargetConfigured:false
    }
  }
')"

mkdir -p "$(dirname "$OUTPUT")"
printf '%s\n' "$receipt" >"$OUTPUT"
chmod 600 "$OUTPUT"

jq -e '
  .contract == "asklake.eks.day18.phase3.cost-cleanup.v1"
  and .gates.currentCostBoundary == true
  and .gates.scaleOutInProof == true
  and (.gates.currentScaleInState == true or .gates.boundedAutomaticCleanupPending == true)
  and .gates.temporaryCleanup == true
  and .alarms.count == 2
' "$OUTPUT" >/dev/null || fail "Phase 3 receipt validation failed"

if [[ "$current_scale_in_state" == "true" ]]; then
  echo "Day 18 Phase 3 cost and cleanup evidence captured (scale-in complete, sanitized, mode 0600)."
else
  echo "Day 18 Phase 3 cost and cleanup evidence captured (bounded TTL cleanup pending, sanitized, mode 0600)."
fi
