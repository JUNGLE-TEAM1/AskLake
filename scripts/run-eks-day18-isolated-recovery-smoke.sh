#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

CHART="$ROOT_DIR/infra/eks/helm/asklake-day18-recovery-smoke"
RELEASE="asklake-day18-recovery-smoke"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
IMAGE_RECEIPT="${1:-}"
EVIDENCE_FILE="${2:-}"
MONITOR_FILE=""
MONITOR_BODY=""
MONITOR_PID=""
TEMPORARY_DIRECTORY=""
RELEASE_CREATED=false
POOL_LIMIT_CHANGED=false
ORIGINAL_POOL_CPU_LIMIT=""
ORIGINAL_POOL_MEMORY_LIMIT=""

fail() {
  echo "$1" >&2
  exit 1
}

cleanup() {
  if [[ -n "$MONITOR_PID" ]] && kill -0 "$MONITOR_PID" >/dev/null 2>&1; then
    kill "$MONITOR_PID" >/dev/null 2>&1 || true
    wait "$MONITOR_PID" 2>/dev/null || true
  fi
  if [[ "$RELEASE_CREATED" == "true" ]]; then
    helm uninstall "$RELEASE" -n "$NAMESPACE" --wait >/dev/null 2>&1 || true
  fi
  if [[ "$POOL_LIMIT_CHANGED" == "true" && -n "$ORIGINAL_POOL_CPU_LIMIT" && -n "$ORIGINAL_POOL_MEMORY_LIMIT" ]]; then
    kubectl patch nodepool asklake-general --type merge \
      --patch "$(jq -nc --arg cpu "$ORIGINAL_POOL_CPU_LIMIT" --arg memory "$ORIGINAL_POOL_MEMORY_LIMIT" \
        '{spec:{limits:{cpu:$cpu,memory:$memory}}}')" >/dev/null 2>&1 || true
  fi
  [[ -z "$TEMPORARY_DIRECTORY" ]] || rm -rf "$TEMPORARY_DIRECTORY"
}
trap cleanup EXIT

[[ -s "$IMAGE_RECEIPT" && -n "$EVIDENCE_FILE" ]] || \
  fail "usage: $0 <private-image-receipt.json> <ignored-private-evidence.json>"
[[ "${ASKLAKE_DAY18_PHASE4_CONFIRM:-}" == "terminate-isolated-general-nodeclaim" ]] || \
  fail "set ASKLAKE_DAY18_PHASE4_CONFIRM=terminate-isolated-general-nodeclaim"
for command in aws curl git helm jq kubectl node openssl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -n "${ASKLAKE_EKS_CLUSTER_NAME:-}" ]] || fail "ASKLAKE_EKS_CLUSTER_NAME is required"
verify_asklake_eks_context

evidence_directory="$(cd "$(dirname "$EVIDENCE_FILE")" 2>/dev/null && pwd || true)"
[[ -n "$evidence_directory" ]] || fail "evidence directory must already exist"
evidence_absolute="$evidence_directory/$(basename "$EVIDENCE_FILE")"
[[ ! -e "$evidence_absolute" ]] || fail "refusing to overwrite existing recovery evidence"
case "$evidence_absolute" in
  "$ROOT_DIR"/*)
    git -C "$ROOT_DIR" check-ignore -q "$evidence_absolute" || \
      fail "repository-local evidence must be Git-ignored"
    ;;
esac
helm status "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1 && \
  fail "recovery smoke release already exists; do not adopt another run"

node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$IMAGE_RECEIPT" >/dev/null
backend_image="$(jq -er '.images.backend' "$IMAGE_RECEIPT")"
live_backend_image="$(kubectl get deployment fastapi -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}')"
[[ "$backend_image" == "$live_backend_image" ]] || \
  fail "image receipt does not match the live immutable Backend image"

runtime="$(kubectl get deployments,statefulsets,jobs,pods -n "$NAMESPACE" -o json | jq '{
  deployments:([.items[] | select(.kind == "Deployment")] | length),
  deploymentsSteady:([.items[] | select(.kind == "Deployment" and
    (.status.readyReplicas // 0) == (.spec.replicas // 0) and
    (.status.unavailableReplicas // 0) == 0)] | length),
  statefulSets:([.items[] | select(.kind == "StatefulSet")] | length),
  statefulSetsSteady:([.items[] | select(.kind == "StatefulSet" and
    (.status.readyReplicas // 0) == (.spec.replicas // 0))] | length),
  activeJobs:([.items[] | select(.kind == "Job" and (.status.active // 0) > 0)] | length),
  pendingPods:([.items[] | select(.kind == "Pod" and .status.phase == "Pending")] | length),
  terminatingPods:([.items[] | select(.kind == "Pod" and .metadata.deletionTimestamp != null)] | length),
  notReadyPods:([.items[] | select(.kind == "Pod" and .status.phase == "Running" and
    any(.status.containerStatuses[]?; .ready != true))] | length)
}')"
spark_active="$(kubectl get sparkapplications.sparkoperator.k8s.io -n "$NAMESPACE" -o json | jq '[.items[] |
  select((.status.applicationState.state // "") | IN("SUBMITTED", "RUNNING", "PENDING"))] | length')"
jq -e --argjson runtime "$runtime" --argjson spark "$spark_active" '
  $runtime.deployments == $runtime.deploymentsSteady
  and $runtime.statefulSets == $runtime.statefulSetsSteady
  and $runtime.activeJobs == 0
  and $runtime.pendingPods == 0
  and $runtime.terminatingPods == 0
  and $runtime.notReadyPods == 0
  and $spark == 0
' <<<"{}" >/dev/null || fail "live workload is not exclusive and steady"

pool="$(kubectl get nodepool asklake-general -o json)"
jq -e 'any(.status.conditions[]?; .type == "Ready" and .status == "True")
  and .spec.disruption.consolidationPolicy == "WhenEmptyOrUnderutilized"' \
  <<<"$pool" >/dev/null || fail "General NodePool is not ready for recovery verification"
ORIGINAL_POOL_CPU_LIMIT="$(jq -er '.spec.limits.cpu' <<<"$pool")"
ORIGINAL_POOL_MEMORY_LIMIT="$(jq -er '.spec.limits.memory' <<<"$pool")"
[[ "$ORIGINAL_POOL_CPU_LIMIT" =~ ^[0-9]+$ ]] || fail "General NodePool CPU limit must be an integer"
[[ "$ORIGINAL_POOL_MEMORY_LIMIT" =~ ^([0-9]+)Gi$ ]] || fail "General NodePool memory limit must use integer Gi"
temporary_pool_cpu_limit="$((ORIGINAL_POOL_CPU_LIMIT + 8))"
temporary_pool_memory_limit="$((BASH_REMATCH[1] + 16))Gi"
kubectl auth can-i delete nodeclaims.karpenter.sh 2>/dev/null | grep -Fxq yes || \
  fail "operator cannot delete the isolated NodeClaim"

hpa_before="$(kubectl get hpa fastapi -n "$NAMESPACE" -o json | jq '{
  min:.spec.minReplicas,max:.spec.maxReplicas,
  current:(.status.currentReplicas // 0),desired:(.status.desiredReplicas // 0)
}')"
jq -e '.min == 2 and .max == 6 and .current == 2 and .desired == 2' \
  <<<"$hpa_before" >/dev/null || fail "FastAPI HPA is not at the reviewed baseline"
alb_before="$(bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady)"
jq -e '.frontendHttpStatus == 200 and .backendHttpStatus == 200 and .backendDatabaseOk == true
  and .drainingTargets == 0' <<<"$alb_before" >/dev/null || fail "ALB/RDS baseline is not steady"

ingresses="$(kubectl get ingress asklake-backend asklake-frontend -n "$NAMESPACE" -o json)"
backend_host="$(jq -r '[.items[] | select(.metadata.name == "asklake-backend") |
  .status.loadBalancer.ingress[0].hostname][0] // ""' <<<"$ingresses")"
frontend_host="$(jq -r '[.items[] | select(.metadata.name == "asklake-frontend") |
  .status.loadBalancer.ingress[0].hostname][0] // ""' <<<"$ingresses")"
[[ -n "$backend_host" && "$backend_host" == "$frontend_host" ]] || \
  fail "Frontend and Backend do not share one ready ALB"
unset ingresses frontend_host

TEMPORARY_DIRECTORY="$(mktemp -d)"
chmod 700 "$TEMPORARY_DIRECTORY"
MONITOR_FILE="$TEMPORARY_DIRECTORY/monitor.tsv"
MONITOR_BODY="$TEMPORARY_DIRECTORY/backend-body.json"
baseline_nodes_file="$TEMPORARY_DIRECTORY/baseline-general-nodes"
values_file="$TEMPORARY_DIRECTORY/values.json"
kubectl get nodes -l karpenter.sh/nodepool=asklake-general \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' >"$baseline_nodes_file"
chmod 600 "$baseline_nodes_file"
baseline_general="$(grep -c . "$baseline_nodes_file" || true)"
(( baseline_general > 0 )) || fail "General NodePool baseline is empty"

run_token="$(openssl rand -hex 32)"
run_fingerprint="$(printf '%s' "$run_token" | asklake_sha256 | cut -c1-16)"
IMAGE="$backend_image" RUN="$run_fingerprint" NAMESPACE="$NAMESPACE" node - "$values_file" <<'NODE'
const fs = require("fs");
fs.writeFileSync(process.argv[2], `${JSON.stringify({
  enabled: true,
  namespace: process.env.NAMESPACE,
  runFingerprint: process.env.RUN,
  image: process.env.IMAGE,
  resources: {
    requests: {cpu: "1500m", memory: "512Mi"},
    limits: {cpu: "1500m", memory: "512Mi"},
  },
})}\n`, {mode: 0o600});
NODE

helm lint "$CHART" -f "$values_file" >/dev/null
helm template "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$values_file" | \
  kubectl apply --dry-run=server -f - >/dev/null
kubectl patch nodepool asklake-general --type merge \
  --patch "$(jq -nc --arg cpu "$temporary_pool_cpu_limit" --arg memory "$temporary_pool_memory_limit" \
    '{spec:{limits:{cpu:$cpu,memory:$memory}}}')" >/dev/null
POOL_LIMIT_CHANGED=true

monitor_health() {
  local backend_code frontend_code database_ok current desired general_nodes
  while true; do
    backend_code="$(curl -sS -o "$MONITOR_BODY" -w '%{http_code}' --connect-timeout 3 --max-time 10 \
      "http://$backend_host/api/health" 2>/dev/null || printf '000')"
    database_ok="$(jq -r '.database.ok == true' "$MONITOR_BODY" 2>/dev/null || printf 'false')"
    frontend_code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 \
      "http://$backend_host/" 2>/dev/null || printf '000')"
    read -r current desired < <(kubectl get hpa fastapi -n "$NAMESPACE" -o json 2>/dev/null | \
      jq -r '[(.status.currentReplicas // -1),(.status.desiredReplicas // -1)] | @tsv' || printf '%s\t%s\n' -1 -1)
    general_nodes="$(kubectl get nodes -l karpenter.sh/nodepool=asklake-general --no-headers 2>/dev/null | wc -l | tr -d ' ')"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$backend_code" "$frontend_code" "$database_ok" "$current" "$desired" "$general_nodes" >>"$MONITOR_FILE"
    sleep 1
  done
}

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_at_ms="$(node -e 'process.stdout.write(String(Date.parse(process.argv[1])))' "$started_at")"
monitor_health &
MONITOR_PID=$!
sleep 2

RELEASE_CREATED=true
helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$values_file" --wait=hookOnly >/dev/null

old_pod=""
pending_observed=false
deadline=$((SECONDS + 1200))
while (( SECONDS < deadline )); do
  old_pod="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=asklake-day18-recovery-smoke \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -n "$old_pod" ]]; then
    pod_json="$(kubectl get pod "$old_pod" -n "$NAMESPACE" -o json)"
    phase="$(jq -r '.status.phase // ""' <<<"$pod_json")"
    node_name="$(jq -r '.spec.nodeName // ""' <<<"$pod_json")"
    [[ "$phase" == "Pending" && -z "$node_name" ]] && pending_observed=true
    old_ready="$(jq -r 'any(.status.conditions[]?; .type == "Ready" and .status == "True")' <<<"$pod_json")"
    [[ "$old_ready" == "true" ]] && break
  fi
  sleep 5
done
[[ -n "$old_pod" && "${old_ready:-false}" == "true" ]] || fail "isolated recovery Pod did not become Ready"
old_uid="$(jq -r '.metadata.uid' <<<"$pod_json")"
old_node="$(jq -r '.spec.nodeName' <<<"$pod_json")"
! grep -Fxq -- "$old_node" "$baseline_nodes_file" || fail "isolated workload did not create a new General Node"
[[ "$(kubectl get node "$old_node" -o jsonpath='{.metadata.labels.karpenter\.sh/nodepool}')" == "asklake-general" ]] || \
  fail "isolated workload used the wrong NodePool"
peak_general="$(kubectl get nodes -l karpenter.sh/nodepool=asklake-general --no-headers | wc -l | tr -d ' ')"
(( peak_general > baseline_general )) || fail "General NodePool did not scale out"

non_daemon="$(kubectl get pods -A --field-selector "spec.nodeName=$old_node" -o json | jq --arg uid "$old_uid" '[.items[] |
  select(any(.metadata.ownerReferences[]?; .kind == "DaemonSet") | not) |
  {uid:.metadata.uid,controlled:(.metadata.uid == $uid)}]')"
jq -e 'length == 1 and .[0].controlled == true' <<<"$non_daemon" >/dev/null || \
  fail "new General Node contains a non-owned workload"

nodeclaim="$(kubectl get node "$old_node" -o json | jq -r '[.metadata.ownerReferences[]? |
  select(.apiVersion == "karpenter.sh/v1" and .kind == "NodeClaim") | .name][0] // ""')"
[[ -n "$nodeclaim" ]] || fail "isolated General Node has no owning NodeClaim"
kubectl get nodeclaim "$nodeclaim" -o json | jq -e '
  .metadata.labels["karpenter.sh/nodepool"] == "asklake-general"
  and any(.status.conditions[]?; .type == "Ready" and .status == "True")
' >/dev/null || fail "isolated NodeClaim ownership or readiness drifted"

fault_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
kubectl delete nodeclaim "$nodeclaim" --wait=false >/dev/null

replacement_observed=false
replacement_pending=false
replacement_node=""
deadline=$((SECONDS + 1200))
while (( SECONDS < deadline )); do
  pods_json="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=asklake-day18-recovery-smoke -o json)"
  candidate="$(jq -c --arg old "$old_uid" '[.items[] | select(.metadata.uid != $old)] | sort_by(.metadata.creationTimestamp) | last // empty' <<<"$pods_json")"
  if [[ -n "$candidate" ]]; then
    candidate_phase="$(jq -r '.status.phase // ""' <<<"$candidate")"
    candidate_node="$(jq -r '.spec.nodeName // ""' <<<"$candidate")"
    [[ "$candidate_phase" == "Pending" && -z "$candidate_node" ]] && replacement_pending=true
    candidate_ready="$(jq -r 'any(.status.conditions[]?; .type == "Ready" and .status == "True")' <<<"$candidate")"
    if [[ "$candidate_ready" == "true" ]]; then
      replacement_node="$candidate_node"
      replacement_observed=true
      break
    fi
  fi
  sleep 5
done
[[ "$replacement_observed" == "true" && -n "$replacement_node" ]] || \
  fail "Deployment did not replace the Pod after isolated NodeClaim termination"
[[ "$replacement_node" != "$old_node" ]] || fail "replacement Pod remained on the terminated Node"
! grep -Fxq -- "$replacement_node" "$baseline_nodes_file" || \
  fail "replacement Pod did not prove a replacement General Node"
[[ "$(kubectl get node "$replacement_node" -o jsonpath='{.metadata.labels.karpenter\.sh/nodepool}')" == "asklake-general" ]] || \
  fail "replacement Pod used the wrong NodePool"

deadline=$((SECONDS + 300))
while (( SECONDS < deadline )); do
  kubectl get node "$old_node" >/dev/null 2>&1 || break
  sleep 5
done
kubectl get node "$old_node" >/dev/null 2>&1 && fail "terminated General Node still exists"

alb_after_recovery="$(bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady)"
jq -e '.frontendHttpStatus == 200 and .backendHttpStatus == 200 and .backendDatabaseOk == true
  and .drainingTargets == 0' <<<"$alb_after_recovery" >/dev/null || \
  fail "ALB/RDS did not remain steady after isolated Node replacement"

cloudwatch_markers=0
application_group="/aws/otel/containerinsights/${ASKLAKE_EKS_CLUSTER_NAME}/application"
deadline=$((SECONDS + 300))
while (( SECONDS < deadline )); do
  cloudwatch_markers="$(aws logs filter-log-events --region "$REGION" --log-group-name "$application_group" \
    --start-time "$started_at_ms" --filter-pattern '"asklake-day18-recovery-smoke-started"' --output json | \
    jq '[.events[] | select(.message | contains("asklake-day18-recovery-smoke-started"))] | length')"
  (( cloudwatch_markers >= 2 )) && break
  sleep 10
done
(( cloudwatch_markers >= 2 )) || fail "CloudWatch did not correlate both isolated Pod starts"

events="$(kubectl get events -A -o json | jq --arg started "$started_at" '[.items[] |
  select((.lastTimestamp // .eventTime // .metadata.creationTimestamp // "") >= $started) |
  {type:(.type // "Unknown"),reason:(.reason // "Unknown"),kind:(.involvedObject.kind // "Unknown")}]
  | group_by([.type,.reason,.kind])
  | map({type:.[0].type,reason:.[0].reason,kind:.[0].kind,count:length})
  | sort_by(.type,.reason,.kind)')"

helm uninstall "$RELEASE" -n "$NAMESPACE" --wait >/dev/null
RELEASE_CREATED=false
kubectl patch nodepool asklake-general --type merge \
  --patch "$(jq -nc --arg cpu "$ORIGINAL_POOL_CPU_LIMIT" --arg memory "$ORIGINAL_POOL_MEMORY_LIMIT" \
    '{spec:{limits:{cpu:$cpu,memory:$memory}}}')" >/dev/null
POOL_LIMIT_CHANGED=false

final_general=-1
deadline=$((SECONDS + 1800))
while (( SECONDS < deadline )); do
  final_general="$(kubectl get nodes -l karpenter.sh/nodepool=asklake-general --no-headers | wc -l | tr -d ' ')"
  (( final_general <= baseline_general )) && break
  sleep 30
done
(( final_general <= baseline_general )) || fail "General NodePool did not scale back to baseline"

bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null
hpa_after="$(kubectl get hpa fastapi -n "$NAMESPACE" -o json | jq '{
  current:(.status.currentReplicas // 0),desired:(.status.desiredReplicas // 0)
}')"
jq -e '.current == 2 and .desired == 2' <<<"$hpa_after" >/dev/null || \
  fail "FastAPI HPA did not remain at baseline"
[[ "$(kubectl get deployment -n "$NAMESPACE" -l app.kubernetes.io/name=asklake-day18-recovery-smoke -o json | jq '.items|length')" == 0 ]] || \
  fail "recovery Deployment cleanup failed"

kill "$MONITOR_PID" >/dev/null 2>&1 || true
wait "$MONITOR_PID" 2>/dev/null || true
MONITOR_PID=""
sample_count="$(wc -l <"$MONITOR_FILE" | tr -d ' ')"
health_failures="$(awk '$1 != "200" || $2 != "200" || $3 != "true" {count++} END {print count+0}' "$MONITOR_FILE")"
max_consecutive_health_failures="$(awk '
  $1 != "200" || $2 != "200" || $3 != "true" {run++; if (run > max) max=run; next}
  {run=0}
  END {print max+0}' "$MONITOR_FILE")"
hpa_baseline_changes="$(awk '$4 != 2 || $5 != 2 {count++} END {print count+0}' "$MONITOR_FILE")"
hpa_out_of_bounds="$(awk '$4 < 2 || $4 > 6 || $5 < 2 || $5 > 6 {count++} END {print count+0}' "$MONITOR_FILE")"
min_nodes="$(awk 'NR==1 || $6<min {min=$6} END {print min+0}' "$MONITOR_FILE")"
max_nodes="$(awk 'NR==1 || $6>max {max=$6} END {print max+0}' "$MONITOR_FILE")"
health_failure_budget="$(( (sample_count + 99) / 100 ))"
(( health_failure_budget >= 2 )) || health_failure_budget=2
(( sample_count >= 10
  && health_failures <= health_failure_budget
  && max_consecutive_health_failures <= 2
  && hpa_out_of_bounds == 0 )) || {
  printf 'recovery monitor rejected: samples=%s healthFailures=%s maxConsecutiveHealthFailures=%s hpaOutOfBounds=%s\n' \
    "$sample_count" "$health_failures" "$max_consecutive_health_failures" "$hpa_out_of_bounds" >&2
  fail "external continuity or HPA safety bounds failed during isolated recovery"
}

receipt="$(jq -n \
  --arg contract "asklake.eks.day18.phase4.isolated-recovery.v1" \
  --arg startedAt "$started_at" --arg faultAt "$fault_at" \
  --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson baseline "$baseline_general" --argjson peak "$peak_general" \
  --argjson final "$final_general" --argjson samples "$sample_count" \
  --argjson healthFailures "$health_failures" \
  --argjson maxConsecutiveHealthFailures "$max_consecutive_health_failures" \
  --argjson healthFailureBudget "$health_failure_budget" \
  --argjson hpaBaselineChanges "$hpa_baseline_changes" --argjson hpaOutOfBounds "$hpa_out_of_bounds" \
  --argjson minNodes "$min_nodes" --argjson maxNodes "$max_nodes" \
  --argjson markers "$cloudwatch_markers" --argjson events "$events" \
  --argjson pending "$pending_observed" --argjson replacementPending "$replacement_pending" '
  {
    contract:$contract,
    startedAt:$startedAt,
    faultAt:$faultAt,
    completedAt:$completedAt,
    fault:{scope:"isolated-general-nodeclaim",nonOwnedWorkloadsOnNode:0},
    recovery:{
      initialPendingObserved:$pending,
      replacementPendingObserved:$replacementPending,
      podUidChanged:true,
      nodeChanged:true,
      replacementReady:true
    },
    scaling:{baselineGeneralNodes:$baseline,peakGeneralNodes:$peak,finalGeneralNodes:$final,
      observedMinGeneralNodes:$minNodes,observedMaxGeneralNodes:$maxNodes},
    service:{samples:$samples,httpOrDatabaseFailures:$healthFailures,
      maxConsecutiveHttpOrDatabaseFailures:$maxConsecutiveHealthFailures,
      httpOrDatabaseFailureBudget:$healthFailureBudget,
      hpaBaselineChanges:$hpaBaselineChanges,hpaOutOfBounds:$hpaOutOfBounds,
      albSteadyAfterRecovery:true,rdsHealthyAfterRecovery:true},
    observability:{cloudWatchStartMarkers:$markers,eventSummary:$events},
    cleanup:{helmRelease:0,deployment:0,extraGeneralNodes:0,nodePoolCpuLimitRestored:true},
    gates:{isolatedOwnership:true,podRecovery:true,nodeRecovery:true,externalContinuity:true,
      hpaContinuity:true,cloudWatchCorrelation:true,cleanup:true}
  }
')"
printf '%s\n' "$receipt" >"$evidence_absolute"
chmod 600 "$evidence_absolute"
jq -e '
  .gates == {
    isolatedOwnership:true,podRecovery:true,nodeRecovery:true,externalContinuity:true,
    hpaContinuity:true,cloudWatchCorrelation:true,cleanup:true
  }
  and .scaling.peakGeneralNodes > .scaling.baselineGeneralNodes
  and .scaling.finalGeneralNodes <= .scaling.baselineGeneralNodes
  and .service.httpOrDatabaseFailures <= .service.httpOrDatabaseFailureBudget
  and .service.maxConsecutiveHttpOrDatabaseFailures <= 2
  and .service.hpaOutOfBounds == 0
' "$evidence_absolute" >/dev/null || fail "recovery receipt validation failed"

echo "Day 18 isolated Pod/Node recovery, ALB/RDS/HPA continuity, CloudWatch correlation and cleanup verified."
