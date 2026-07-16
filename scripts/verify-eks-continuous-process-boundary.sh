#!/usr/bin/env bash

set -euo pipefail
set +x

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"

for command in jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

pods="$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json)"
[[ "$(jq '.items | length' <<<"$pods")" -eq 2 ]] || {
  echo "exactly two Backend Pods are required for the Continuous boundary check" >&2
  exit 1
}

continuous_processes=0
while IFS= read -r pod; do
  [[ "$(kubectl exec -n "$NAMESPACE" "$pod" -c fastapi -- printenv ASKLAKE_CONTINUOUS_CONTROL_PLANE)" == "external_ec2" ]] || {
    echo "a FastAPI Pod does not preserve external EC2 Continuous ownership" >&2
    exit 1
  }
  process_count="$(kubectl exec -n "$NAMESPACE" "$pod" -c fastapi -- python -c '
import os

current = os.getpid()
needles = (
    "kafka_continuous_stream.py",
    "manage-kafka-continuous.mjs",
    "kafka_continuous_maintenance.py",
    "manage-kafka-continuous-maintenance.mjs",
)
count = 0
for entry in os.listdir("/proc"):
    if not entry.isdigit() or int(entry) == current:
        continue
    try:
        command = open(f"/proc/{entry}/cmdline", "rb").read().replace(b"\x00", b" ").decode("utf-8", "ignore")
    except OSError:
        continue
    if any(needle in command for needle in needles):
        count += 1
print(count)
')"
  [[ "$process_count" =~ ^[0-9]+$ ]] || {
    echo "unable to count Continuous processes in a FastAPI Pod" >&2
    exit 1
  }
  continuous_processes=$((continuous_processes + process_count))
done < <(jq -r '.items[].metadata.name' <<<"$pods")

[[ "$continuous_processes" -eq 0 ]] || {
  echo "EKS FastAPI started an EC2-owned Continuous process" >&2
  exit 1
}

echo "eks_continuous_control_plane=external_ec2"
printf 'eks_continuous_processes=%d\n' "$continuous_processes"
