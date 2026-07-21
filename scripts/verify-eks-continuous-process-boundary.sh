#!/usr/bin/env bash

set -euo pipefail
set +x

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"

for command in helm jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

web_values="$(helm get values asklake-web -n "$NAMESPACE" -o json)"
deployment_profile="$(jq -r '.deploymentProfile // "standard"' <<<"$web_values")"
expected_control_plane=""
owner_generation=""
case "$deployment_profile" in
  standard)
    expected_control_plane="external_ec2"
    ;;
  realtime-v1-only)
    jq -e '
      .deploymentProfile == "realtime-v1-only"
      and .backend.realtime.enabled == false
      and .backend.realtime.apiControlPlane == "local"
      and .backend.realtime.v1ApiEnabled == true
      and ((.backend.realtime.v1OwnerGeneration // "") | length > 0)
    ' <<<"$web_values" >/dev/null || {
      echo "realtime-v1-only Web values do not preserve the approved V1 control boundary" >&2
      exit 1
    }
    expected_control_plane="local"
    owner_generation="$(jq -r '.backend.realtime.v1OwnerGeneration' <<<"$web_values")"
    ;;
  *)
    echo "unsupported asklake-web deployment profile: $deployment_profile" >&2
    exit 1
    ;;
esac

pods="$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json)"
[[ "$(jq '.items | length' <<<"$pods")" -eq 2 ]] || {
  echo "exactly two Backend Pods are required for the Continuous boundary check" >&2
  exit 1
}

continuous_processes=0
while IFS= read -r pod; do
  [[ "$(kubectl exec -n "$NAMESPACE" "$pod" -c fastapi -- printenv ASKLAKE_CONTINUOUS_CONTROL_PLANE)" == "$expected_control_plane" ]] || {
    echo "a FastAPI Pod does not preserve the $deployment_profile Continuous control boundary" >&2
    exit 1
  }
  if [[ "$deployment_profile" == "realtime-v1-only" ]]; then
    [[ "$(kubectl exec -n "$NAMESPACE" "$pod" -c fastapi -- printenv KAFKA_CONTINUOUS_V1_API_ENABLED)" == "true" ]] || {
      echo "a FastAPI Pod does not expose the approved V1-only API boundary" >&2
      exit 1
    }
    [[ "$(kubectl exec -n "$NAMESPACE" "$pod" -c fastapi -- printenv KAFKA_CONTINUOUS_V1_OWNER_GENERATION)" == "$owner_generation" ]] || {
      echo "a FastAPI Pod has a different V1 owner generation" >&2
      exit 1
    }
  fi
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

if [[ "$deployment_profile" == "realtime-v1-only" ]]; then
  worker="$(kubectl get deployment asklake-realtime-v1-worker -n "$NAMESPACE" -o json)"
  jq -e --arg generation "$owner_generation" '
    (.spec.replicas // 0) == 1
    and (.status.readyReplicas // 0) == 1
    and (.status.updatedReplicas // 0) == 1
    and (.status.availableReplicas // 0) == 1
    and (.status.unavailableReplicas // 0) == 0
    and .metadata.annotations["asklake.io/owner-generation"] == $generation
    and .metadata.annotations["asklake.io/previous-owner-fenced"] == "true"
    and any(.spec.template.spec.containers[]?;
      .name == "realtime-v1-worker"
      and ([.env[]? | select(.name == "CONTINUOUS_CONTROL_PLANE") | .value] == ["worker"])
      and ([.env[]? | select(.name == "CONTINUOUS_WORKER_SCOPE") | .value] == ["all"])
      and ([.env[]? | select(.name == "CONTINUOUS_WORKER_OWNER") | .value] == ["eks-continuous-worker-v1"])
      and ([.env[]? | select(.name == "CONTINUOUS_WORKER_GENERATION") | .value] == [$generation])
    )
  ' <<<"$worker" >/dev/null || {
    echo "the realtime V1 worker does not preserve its Ready owner generation" >&2
    exit 1
  }
  echo "eks_continuous_control_plane=realtime_v1_only"
  echo "eks_realtime_v1_worker=1_of_1"
else
  echo "eks_continuous_control_plane=external_ec2"
fi
printf 'eks_continuous_processes=%d\n' "$continuous_processes"
