#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

MODE="${1:---once}"
WINDOW_MINUTES="${ASKLAKE_DAY18_EVENT_WINDOW_MINUTES:-15}"
OUTPUT="${ASKLAKE_DAY18_EVENT_OUTPUT:-/private/tmp/asklake-day18-events.json}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"

fail() {
  echo "$1" >&2
  exit 1
}

[[ "$MODE" == "--once" ]] || fail "usage: $0 --once"
[[ "$WINDOW_MINUTES" =~ ^[0-9]+$ ]] || fail "event window must be an integer"
(( WINDOW_MINUTES >= 1 && WINDOW_MINUTES <= 120 )) || fail "event window must be between 1 and 120 minutes"
[[ ! -e "$OUTPUT" ]] || fail "refusing to overwrite existing event receipt: $OUTPUT"
for command in aws jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

if [[ -z "${ASKLAKE_EKS_CLUSTER_NAME:-}" ]]; then
  ASKLAKE_EKS_CLUSTER_NAME="$(jq -er '.outputs.cluster_name.value' \
    "$ROOT_DIR/infra/eks/terraform/terraform.tfstate")"
  export ASKLAKE_EKS_CLUSTER_NAME
fi
verify_asklake_eks_context

cutoff_epoch="$(($(date +%s) - WINDOW_MINUTES * 60))"
events="$(kubectl get events -A -o json | jq --arg namespace "$NAMESPACE" --argjson cutoff "$cutoff_epoch" '
  def event_epoch:
    (.eventTime // .series.lastObservedTime // .lastTimestamp // .metadata.creationTimestamp // "")
    | sub("\\.[0-9]+Z$"; "Z")
    | fromdateiso8601? // 0;
  def namespace_class:
    if .metadata.namespace == $namespace then "asklake"
    elif .metadata.namespace == "kube-system" or .metadata.namespace == "amazon-cloudwatch" then "system"
    else "other" end;
  [.items[]
    | select(event_epoch >= $cutoff)
    | {
        type: (.type // "Unknown"),
        reason: (.reason // "Unknown"),
        objectKind: (.regarding.kind // .involvedObject.kind // "Unknown"),
        namespaceClass: namespace_class,
        observedAt: (.eventTime // .series.lastObservedTime // .lastTimestamp // .metadata.creationTimestamp),
        count: (.series.count // .count // 1)
      }
  ] | sort_by(.observedAt, .type, .reason, .objectKind, .namespaceClass)
')"

receipt="$(jq -n \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson windowMinutes "$WINDOW_MINUTES" --argjson events "$events" '
  {
    contract: "asklake.eks.day18.events.v1",
    capturedAt: $capturedAt,
    windowMinutes: $windowMinutes,
    eventCount: ($events | length),
    warningCount: ([$events[] | select(.type == "Warning")] | length),
    events: $events
  }
')"

mkdir -p "$(dirname "$OUTPUT")"
printf '%s\n' "$receipt" >"$OUTPUT"
chmod 600 "$OUTPUT"

jq -e '
  .contract == "asklake.eks.day18.events.v1"
  and .windowMinutes >= 1 and .windowMinutes <= 120
  and .eventCount == (.events | length)
  and all(.events[];
    (.type | type == "string") and
    (.reason | type == "string") and
    (.objectKind | type == "string") and
    (.namespaceClass | IN("asklake", "system", "other")) and
    (.observedAt | type == "string") and
    (.count | type == "number")
  )
' "$OUTPUT" >/dev/null || fail "sanitized event receipt validation failed"

echo "Day 18 EKS event receipt captured (sanitized, mode 0600)."
