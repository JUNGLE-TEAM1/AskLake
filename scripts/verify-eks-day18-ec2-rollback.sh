#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
source "$ROOT_DIR/scripts/deploy.sh"

EVIDENCE_FILE="${1:-}"
TEMPORARY_DIRECTORY=""

fail() {
  echo "$1" >&2
  exit 1
}

cleanup() {
  [[ -z "$TEMPORARY_DIRECTORY" ]] || rm -rf "$TEMPORARY_DIRECTORY"
}
trap cleanup EXIT

[[ -n "$EVIDENCE_FILE" ]] || fail "usage: $0 <ignored-private-evidence.json>"
for command in aws curl jq kubectl python3 ssh; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -n "${ASKLAKE_EKS_CLUSTER_NAME:-}" ]] || fail "ASKLAKE_EKS_CLUSTER_NAME is required"
[[ "$EC2_INSTANCE_ID" =~ ^i-[0-9a-f]{8,17}$ ]] || fail "ASKLAKE_EC2_INSTANCE_ID is required"
[[ "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || \
  fail "ASKLAKE_COMPOSE_PROJECT_NAME must explicitly identify the rollback stack"
[[ -r "$SSH_KEY" ]] || fail "rollback SSH key is not readable"
verify_asklake_eks_context

evidence_directory="$(cd "$(dirname "$EVIDENCE_FILE")" 2>/dev/null && pwd || true)"
[[ -n "$evidence_directory" ]] || fail "evidence directory must already exist"
evidence_absolute="$evidence_directory/$(basename "$EVIDENCE_FILE")"
[[ ! -e "$evidence_absolute" ]] || fail "refusing to overwrite existing rollback evidence"
case "$evidence_absolute" in
  "$ROOT_DIR"/*)
    git -C "$ROOT_DIR" check-ignore -q "$evidence_absolute" || \
      fail "repository-local evidence must be Git-ignored"
    ;;
esac

export ASKLAKE_EXPECTED_EC2_INSTANCE_ID="$EC2_INSTANCE_ID"
bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh" >/dev/null

TEMPORARY_DIRECTORY="$(mktemp -d)"
chmod 700 "$TEMPORARY_DIRECTORY"
compose_config="$TEMPORARY_DIRECTORY/compose-config.json"
compose_ps="$TEMPORARY_DIRECTORY/compose-ps.jsonl"
preflight_log="$TEMPORARY_DIRECTORY/preflight.log"
health_log="$TEMPORARY_DIRECTORY/health.log"

# Prevent repeated SSH calls from consuming this runner's stdin.
SSH_OPTS=(-n "${SSH_OPTS[@]}")
ssh_run 'true' >/dev/null

ec2_public_ip="$(instance_field 'Reservations[0].Instances[0].PublicIpAddress')"
app_host="$(python3 - "$APP_URL" <<'PY'
import sys
import urllib.parse

print(urllib.parse.urlparse(sys.argv[1]).hostname or "")
PY
)"
[[ -n "$app_host" ]] || fail "ASKLAKE_APP_URL must contain a hostname"
app_targets_ec2="$(python3 - "$app_host" "$ec2_public_ip" <<'PY'
import socket
import sys

try:
    addresses = {entry[4][0] for entry in socket.getaddrinfo(sys.argv[1], None)}
except OSError:
    addresses = set()
print("true" if sys.argv[2] in addresses else "false")
PY
)"
[[ "$app_targets_ec2" == "true" ]] || fail "rollback application URL does not resolve to the preserved EC2"

remote_compose 'config --format json' >"$compose_config"
remote_compose 'ps --all --format json' >"$compose_ps"
chmod 600 "$compose_config" "$compose_ps"

jq -e --arg project "$COMPOSE_PROJECT_NAME" '
  .name == $project
  and ((.services.backend.environment.ASKLAKE_CONTINUOUS_CONTROL_PLANE // "local") == "local")
  and (.services.backend.environment.ASKLAKE_SPARK_CONTINUOUS_SCRIPT | type == "string" and length > 0)
  and (.services.backend.environment.ASKLAKE_SPARK_CONTINUOUS_MAINTENANCE_SCRIPT | type == "string" and length > 0)
' "$compose_config" >/dev/null || fail "rollback Compose project or Continuous ownership contract drifted"

ps_summary="$(jq -s --slurpfile config "$compose_config" '
  (if length == 1 and (.[0] | type) == "array" then .[0] else . end) as $ps
  | ($config[0].services | to_entries) as $services
  | ($services | map(select((.value.restart // "no") != "no") | .key)) as $longRunning
  | ($services | map(select(.value.healthcheck != null and (.value.restart // "no") != "no") | .key)) as $healthChecked
  | {
      configuredServices: ($services | length),
      containers: ($ps | length),
      longRunningServices: ($longRunning | length),
      longRunningReady: ([$longRunning[] as $name |
        select(any($ps[]; .Service == $name and (((.State // "") | ascii_downcase) == "running")))] | length),
      healthCheckedServices: ($healthChecked | length),
      healthCheckedHealthy: ([$healthChecked[] as $name |
        select(any($ps[]; .Service == $name and (((.Health // "") | ascii_downcase) == "healthy")))] | length),
      healthChecksNotApplied: ([$healthChecked[] as $name |
        select(any($ps[]; .Service == $name and (((.State // "") | ascii_downcase) == "running") and (.Health // "") == ""))] | length),
      unhealthy: ([$ps[] | select((((.Health // "") | ascii_downcase) == "unhealthy"))] | length),
      restarting: ([$ps[] | select((((.State // "") | ascii_downcase) == "restarting"))] | length),
      oneShotNonZero: ([$services[] | select((.value.restart // "no") == "no") | .key as $name |
        $ps[] | select(.Service == $name and (((.State // "") | ascii_downcase) == "exited") and (.ExitCode // 0) != 0)] | length)
    }
' "$compose_ps")"
jq -e '
  .longRunningServices == .longRunningReady
  and .healthCheckedServices == (.healthCheckedHealthy + .healthChecksNotApplied)
  and .unhealthy == 0
  and .restarting == 0
  and .oneShotNonZero == 0
' <<<"$ps_summary" >/dev/null || fail "rollback Compose services are not recovery-ready"

remote_state="$(ssh_run "cd '$DEPLOY_PATH' && \
  branch=\$(git branch --show-current) && \
  dirty=\$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ') && \
  test \"\$branch\" = '$DEPLOY_BRANCH' && \
  test \"\$dirty\" = 0 && \
  printf 'branchMatch=true trackedClean=true\\n'")"
[[ "$remote_state" == "branchMatch=true trackedClean=true" ]] || fail "rollback Git branch or tracked worktree drifted"

worker_script="$(jq -er '.services.backend.environment.ASKLAKE_SPARK_CONTINUOUS_SCRIPT' "$compose_config")"
maintenance_script="$(jq -er '.services.backend.environment.ASKLAKE_SPARK_CONTINUOUS_MAINTENANCE_SCRIPT' "$compose_config")"
[[ "$worker_script" == "/opt/asklake/scripts/kafka_continuous_stream.py" ]] || \
  fail "rollback Continuous worker path drifted"
[[ "$maintenance_script" == "/opt/asklake/scripts/kafka_continuous_maintenance.py" ]] || \
  fail "rollback Continuous maintenance path drifted"

backend_control="$(remote_compose 'exec -T backend python -c '\''import json,os; from app.core.config import settings; explicit=hasattr(settings,"asklake_continuous_control_plane"); print(json.dumps({"runtimeControlPlane":getattr(settings,"asklake_continuous_control_plane","local"),"controlPlaneContract":"explicit" if explicit else "legacy-local-default","controlPlaneExplicit":"ASKLAKE_CONTINUOUS_CONTROL_PLANE" in os.environ}))'\''')"
spark_runtime="$(remote_compose "exec -T spark-worker python3 -c 'import glob,json,os,sys; worker=sys.argv[1]; maintenance=sys.argv[2]; args=[]; [args.extend([part.decode(\"utf-8\",\"ignore\") for part in open(path,\"rb\").read().split(b\"\\\\0\") if part]) for path in glob.glob(\"/proc/[0-9]*/cmdline\") if os.path.isfile(path)]; print(json.dumps({\"workerScriptReadable\":os.path.isfile(worker) and os.access(worker,os.R_OK),\"maintenanceScriptReadable\":os.path.isfile(maintenance) and os.access(maintenance,os.R_OK),\"activeWorkers\":sum(arg==worker for arg in args),\"activeMaintenance\":sum(arg==maintenance for arg in args)}))' '$worker_script' '$maintenance_script'")"
remote_compose "exec -T spark-master test -r '$worker_script'" >/dev/null
remote_compose "exec -T spark-master test -r '$maintenance_script'" >/dev/null
continuous="$(jq -n --argjson backend "$backend_control" --argjson spark "$spark_runtime" '$backend + $spark')"
jq -e '.runtimeControlPlane == "local"
  and .workerScriptReadable == true and .maintenanceScriptReadable == true
  and .activeWorkers >= 0 and .activeMaintenance >= 0' <<<"$continuous" >/dev/null || \
  fail "rollback Continuous scripts are not readable runtime inputs"

remote_deploy_preflight >"$preflight_log" 2>&1
health_check >"$health_log" 2>&1
grep -Fq 'Backend health is deployment-ready.' "$health_log" || fail "rollback Backend health did not pass"
grep -Fq 'AI gateway health is deployment-ready.' "$health_log" || fail "rollback AI health did not pass"

eks_boundary="$(bash "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" | awk -F= '
  { values[$1] = $2 }
  END { printf "{\"controlPlane\":\"%s\",\"processes\":%d}",
    values["eks_continuous_control_plane"], values["eks_continuous_processes"] }
')"
jq -e '.controlPlane == "external_ec2" and .processes == 0' <<<"$eks_boundary" >/dev/null || \
  fail "EKS can still own or execute the EC2 Continuous runtime"

receipt="$(jq -n \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson compose "$ps_summary" --argjson continuous "$continuous" \
  --argjson eks "$eks_boundary" '
  {
    contract: "asklake.eks.day18.phase5.ec2-rollback.v1",
    capturedAt: $capturedAt,
    instance: {exactIdentityChecked:true,running:true,statusChecksOk:true,sshReady:true,appUrlTargetsInstance:true},
    repository: {branchMatch:true,trackedWorktreeClean:true},
    compose: ($compose + {explicitProjectMatch:true,preflightPassed:true}),
    continuous: {
      ec2ControlPlane:"local",
      ec2ControlPlaneContract:$continuous.controlPlaneContract,
      controlPlaneExplicit:$continuous.controlPlaneExplicit,
      workerScriptReadable:$continuous.workerScriptReadable,
      maintenanceScriptReadable:$continuous.maintenanceScriptReadable,
      activeWorkers:$continuous.activeWorkers,
      activeMaintenance:$continuous.activeMaintenance,
      eksControlPlane:$eks.controlPlane,
      eksProcesses:$eks.processes
    },
    service: {frontendReady:true,backendDatabaseReady:true,aiGatewayReady:true},
    recoveryCommands:{status:true,start:true,health:true,logs:true,nonDisruptiveAudit:true},
    gates:{instance:true,compose:true,service:true,continuousOwnership:true,recoveryCommandInputs:true}
  }
')"
printf '%s\n' "$receipt" >"$evidence_absolute"
chmod 600 "$evidence_absolute"
jq -e '
  .gates == {instance:true,compose:true,service:true,continuousOwnership:true,recoveryCommandInputs:true}
  and .compose.longRunningServices == .compose.longRunningReady
  and .compose.healthCheckedServices == (.compose.healthCheckedHealthy + .compose.healthChecksNotApplied)
  and .compose.unhealthy == 0
  and .compose.restarting == 0
  and .compose.oneShotNonZero == 0
  and .continuous.eksControlPlane == "external_ec2"
  and .continuous.eksProcesses == 0
' "$evidence_absolute" >/dev/null || fail "EC2 rollback receipt validation failed"

echo "Day 18 EC2 Compose/Continuous rollback source and recovery command inputs verified."
