#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---preflight}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
FIXTURE="${ASKLAKE_DAY17_FIXTURE_RECEIPT:-/private/tmp/asklake-day17-fixture-receipt.json}"
OUTPUT="${ASKLAKE_DAY17_RACE_RECEIPT:-/private/tmp/asklake-day17-hpa-race-receipt.json}"
SOURCE="$ROOT_DIR/backend/scripts/run_eks_day17_hpa_race.py"
EXPECTED_REPLICAS=6
NAME="asklake-day17-race-$(date -u +%H%M%S)-$RANDOM"
MANIFEST="$(mktemp)"
RAW="$(mktemp)"

fail() { echo "$1" >&2; exit 1; }
cleanup() {
  kubectl delete job "$NAME" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  rm -f "$MANIFEST" "$RAW"
}
wait_for_job() {
  local timeout_seconds="$1"
  local deadline job_json succeeded failed
  deadline=$(($(date +%s) + timeout_seconds))
  while (( $(date +%s) < deadline )); do
    job_json="$(kubectl get job "$NAME" -n "$NAMESPACE" -o json 2>/dev/null || true)"
    succeeded="$(jq -r '.status.succeeded // 0' <<<"$job_json" 2>/dev/null || echo 0)"
    failed="$(jq -r '.status.failed // 0' <<<"$job_json" 2>/dev/null || echo 0)"
    if [[ "$succeeded" =~ ^[0-9]+$ ]] && (( succeeded >= 1 )); then
      return 0
    fi
    if [[ "$failed" =~ ^[0-9]+$ ]] && (( failed >= 1 )); then
      kubectl logs "job/$NAME" -n "$NAMESPACE" >"$RAW" 2>&1 || true
      fail "Day 17 race Job failed"
    fi
    sleep 2
  done
  kubectl logs "job/$NAME" -n "$NAMESPACE" >"$RAW" 2>&1 || true
  fail "Day 17 race Job timed out"
}
trap cleanup EXIT

[[ "$MODE" == "--preflight" || "$MODE" == "--prepare-reuse" || "$MODE" == "--status" || "$MODE" == "--clear-dry-run" || "$MODE" == "--clear-failed" || "$MODE" == "--sync-recovered" || "$MODE" == "--recover" || "$MODE" == "--run" ]] || \
  fail "usage: run-eks-day17-hpa-race.sh [--preflight|--prepare-reuse|--status|--clear-dry-run|--clear-failed|--sync-recovered|--recover|--run]"
for command in jq kubectl; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
[[ -s "$SOURCE" ]] || fail "Day 17 race source is missing"
if [[ "$MODE" == "--run" ]]; then
  [[ "${ASKLAKE_DAY17_RACE_CONFIRM:-}" == "run-one-day17-hpa-race" ]] || \
    fail "set ASKLAKE_DAY17_RACE_CONFIRM=run-one-day17-hpa-race"
  [[ -s "$FIXTURE" && "$(stat -f '%Lp' "$FIXTURE")" == "600" ]] || \
    fail "private fixture receipt is missing or not mode 0600"
  [[ ! -e "$OUTPUT" ]] || fail "private race receipt already exists"
fi
if [[ "$MODE" == "--prepare-reuse" ]]; then
  [[ "${ASKLAKE_DAY17_REUSE_CONFIRM:-}" == "reuse-persisted-bounded-fixture" ]] || \
    fail "set ASKLAKE_DAY17_REUSE_CONFIRM=reuse-persisted-bounded-fixture"
  [[ ! -e "$FIXTURE" ]] || fail "private fixture receipt already exists"
fi
if [[ "$MODE" == "--recover" || "$MODE" == "--status" || "$MODE" == "--clear-dry-run" || "$MODE" == "--clear-failed" || "$MODE" == "--sync-recovered" ]]; then
  [[ -s "$FIXTURE" && "$(stat -f '%Lp' "$FIXTURE")" == "600" ]] || \
    fail "private fixture reuse receipt is missing or not mode 0600"
fi
if [[ "$MODE" == "--recover" ]]; then
  [[ ! -e "$OUTPUT" ]] || fail "private race receipt already exists"
fi

mode="preflight"
targets='[]'
batch=""
count="100"
[[ "$MODE" == "--prepare-reuse" ]] && mode="fixture-reuse"
source_run=""
conflicts="${ASKLAKE_DAY17_RECOVERED_CONFLICT_COUNT:-3}"
if [[ "$MODE" == "--recover" ]]; then
  mode="recover"
  source_run="$(jq -r '.sourceRunId // empty' "$FIXTURE")"
  [[ -n "$source_run" && "$conflicts" =~ ^[1-9][0-9]*$ ]] || \
    fail "recovery source receipt or conflict count is invalid"
fi
if [[ "$MODE" == "--status" ]]; then
  mode="status"
  source_run="$(jq -r '.sourceRunId // empty' "$FIXTURE")"
  [[ -n "$source_run" ]] || fail "status source receipt is invalid"
fi
if [[ "$MODE" == "--clear-dry-run" || "$MODE" == "--clear-failed" ]]; then
  mode="${MODE#--}"
  source_run="$(jq -r '.sourceRunId // empty' "$FIXTURE")"
  [[ -n "$source_run" ]] || fail "Airflow recovery source receipt is invalid"
fi
if [[ "$MODE" == "--sync-recovered" ]]; then
  mode="sync-recovered"
  source_run="$(jq -r '.sourceRunId // empty' "$FIXTURE")"
  [[ -n "$source_run" ]] || fail "supported sync source receipt is invalid"
fi
clear_confirm=""
if [[ "$MODE" == "--clear-failed" ]]; then
  [[ "${ASKLAKE_DAY17_CLEAR_CONFIRM:-}" == "clear-same-run-failed-tasks" ]] || \
    fail "set ASKLAKE_DAY17_CLEAR_CONFIRM=clear-same-run-failed-tasks"
  clear_confirm="$ASKLAKE_DAY17_CLEAR_CONFIRM"
fi
if [[ "$MODE" == "--run" ]]; then
  current="$(kubectl get hpa fastapi -n "$NAMESPACE" -o jsonpath='{.status.currentReplicas}')"
  desired="$(kubectl get hpa fastapi -n "$NAMESPACE" -o jsonpath='{.status.desiredReplicas}')"
  ready="$(kubectl get deployment fastapi -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}')"
  [[ "$current" == "$EXPECTED_REPLICAS" && "$desired" == "$EXPECTED_REPLICAS" && "$ready" == "$EXPECTED_REPLICAS" ]] || \
    fail "HPA and FastAPI must be stable at 6 replicas before the race"
  selector="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json | jq -c '.spec.selector.matchLabels')"
  targets="$(kubectl get pods -n "$NAMESPACE" -o json | jq -c --argjson selector "$selector" '
    [.items[]
      | . as $pod
      | select(all($selector | to_entries[]; $pod.metadata.labels[.key] == .value))
      | select(.metadata.deletionTimestamp==null)
      | select(any(.status.conditions[]?; .type=="Ready" and .status=="True"))
      | "http://" + .status.podIP + ":8080"
    ] | unique
  ')"
  [[ "$(jq 'length' <<<"$targets")" == "$EXPECTED_REPLICAS" ]] || \
    fail "exactly six distinct ready FastAPI Pod targets are required"
  batch="$(jq -r '.batchId // empty' "$FIXTURE")"
  count="$(jq -r '.expectedCount // empty' "$FIXTURE")"
  [[ -n "$batch" && "$count" == "100" ]] || fail "fixture receipt contract is invalid"
  mode="run"
fi

code="$(sed -n '1,$p' "$SOURCE")"
kubectl get deployment fastapi -n "$NAMESPACE" -o json | jq \
  --arg name "$NAME" --arg code "$code" --arg mode "$mode" \
  --arg targets "$targets" --arg batch "$batch" --arg count "$count" \
  --arg replicas "$EXPECTED_REPLICAS" --arg sourceRun "$source_run" \
  --arg conflicts "$conflicts" --arg clearConfirm "$clear_confirm" '
  {
    apiVersion:"batch/v1",
    kind:"Job",
    metadata:{
      name:$name,
      namespace:.metadata.namespace,
      labels:{
        "app.kubernetes.io/name":"asklake-day17-hpa-race",
        "asklake.io/temporary":"true"
      }
    },
    spec:{
      backoffLimit:0,
      activeDeadlineSeconds:9600,
      template:{
        metadata:{labels:{
          "app.kubernetes.io/name":"asklake-day17-hpa-race",
          "asklake.io/temporary":"true"
        }},
        spec:.spec.template.spec
      }
    }
  }
  | .spec.template.spec.restartPolicy="Never"
  | .spec.template.spec.containers=(.spec.template.spec.containers|map(select(.name=="fastapi")))
  | .spec.template.spec.containers[0].name="race"
  | .spec.template.spec.containers[0].command=["python","-c",$code]
  | .spec.template.spec.containers[0].args=[]
  | .spec.template.spec.containers[0].env=((.spec.template.spec.containers[0].env//[])+[
      {name:"DAY17_RACE_MODE",value:$mode},
      {name:"TARGET_URLS_JSON",value:$targets},
      {name:"EXPECTED_REPLICAS",value:$replicas},
      {name:"FIXTURE_BATCH_ID",value:$batch},
      {name:"EXPECTED_COUNT",value:$count},
      {name:"SOURCE_RUN_ID",value:$sourceRun},
      {name:"RECOVERED_CONFLICT_COUNT",value:$conflicts},
      {name:"CLEAR_FAILED_CONFIRM",value:$clearConfirm}
    ])
  | del(
      .spec.template.spec.containers[0].livenessProbe,
      .spec.template.spec.containers[0].readinessProbe,
      .spec.template.spec.containers[0].startupProbe,
      .spec.template.spec.containers[0].ports
    )
' >"$MANIFEST"
chmod 600 "$MANIFEST" "$RAW"
kubectl apply -f "$MANIFEST" >/dev/null
timeout_seconds=600
[[ "$MODE" == "--run" ]] && timeout_seconds=9600
wait_for_job "$timeout_seconds"
kubectl logs "job/$NAME" -n "$NAMESPACE" >"$RAW"
if [[ "$MODE" != "--prepare-reuse" ]]; then
  jq -e '.status=="passed" and ([.checks[]]|all)' "$RAW" >/dev/null || \
    fail "Day 17 race verification did not pass"
fi

if [[ "$MODE" == "--preflight" ]]; then
  jq -r '"day17_race_preflight="+.status+" candidate_jobs="+(.counts.candidateJobs|tostring)+" active_fixture_runs="+(.counts.activeFixtureRuns|tostring)' "$RAW"
elif [[ "$MODE" == "--status" ]]; then
  jq -c '{status,runStatus,airflowState,airflowApiState,sparkStatus,catalogStatus,executionGeneration,ownerPresent,taskStateCounts}' "$RAW"
elif [[ "$MODE" == "--clear-dry-run" ]]; then
  jq -c '{status,dryRun,selectedTaskCount,selectedTasks,checks}' "$RAW"
elif [[ "$MODE" == "--clear-failed" ]]; then
  jq -c '{status,dryRun,airflowState,runStatus,catalogStatus,executionGeneration,checks}' "$RAW"
elif [[ "$MODE" == "--sync-recovered" ]]; then
  jq -c '{status,runStatus,airflowState,catalogStatus,executionGeneration,checks}' "$RAW"
elif [[ "$MODE" == "--prepare-reuse" ]]; then
  jq -e '
    .contractVersion=="1.0"
    and .reusedFromPersistedSuccess==true
    and .expectedCount==100
    and .producedCount==100
    and (.batchId|length)>0
  ' "$RAW" >/dev/null || fail "persisted fixture reuse receipt is invalid"
  mv "$RAW" "$FIXTURE"
  chmod 600 "$FIXTURE"
  printf 'day17_fixture=reused persisted_success=true expected_count=100\n'
else
  mv "$RAW" "$OUTPUT"
  chmod 600 "$OUTPUT"
  jq -r '"day17_race="+.status+" replicas="+(.counts.raceTargets|tostring)+" conflicts="+((.counts.http409AlreadyExecuting//.counts.recoveredHttp409AlreadyExecuting)|tostring)+" external_executions="+(.counts.externalExecutions|tostring)+" spark_apps="+(.counts.sparkApplications|tostring)+" snapshots="+(.counts.newIcebergSnapshots|tostring)+" materializations="+(.counts.catalogMaterializations|tostring)' "$OUTPUT"
fi

kubectl delete job "$NAME" -n "$NAMESPACE" --wait=true >/dev/null
trap - EXIT
rm -f "$MANIFEST" "$RAW"
