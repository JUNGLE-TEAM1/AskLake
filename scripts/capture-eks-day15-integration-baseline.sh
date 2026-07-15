#!/usr/bin/env bash
set -euo pipefail

MODE="${1:---capture}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"

usage() {
  echo "usage: $0 --capture|--expect-pre-change" >&2
}

if [[ "$MODE" != "--capture" && "$MODE" != "--expect-pre-change" ]]; then
  usage
  exit 2
fi

for command in kubectl helm jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

namespace_json="$(kubectl get namespace "$NAMESPACE" -o json)"
deployments_json="$(kubectl get deployment frontend fastapi -n "$NAMESPACE" -o json | jq '
  [.items[] | {
    name: .metadata.name,
    desired: (.spec.replicas // 0),
    ready: (.status.readyReplicas // 0),
    available: (.status.availableReplicas // 0),
    generation: .metadata.generation,
    imagePinned: (.spec.template.spec.containers[0].image | test("@sha256:[0-9a-f]{64}$")),
    serviceAccount: .spec.template.spec.serviceAccountName
  }] | sort_by(.name)
')"
services_json="$(kubectl get service frontend fastapi -n "$NAMESPACE" -o json | jq '
  [.items[] | {
    name: .metadata.name,
    type: .spec.type,
    ports: [.spec.ports[] | {port, targetPort}]
  }] | sort_by(.name)
')"
frontend_endpoints="$(kubectl get endpointslice -n "$NAMESPACE" -l kubernetes.io/service-name=frontend -o json | jq '[.items[].endpoints[]? | select(.conditions.ready == true)] | length')"
backend_endpoints="$(kubectl get endpointslice -n "$NAMESPACE" -l kubernetes.io/service-name=fastapi -o json | jq '[.items[].endpoints[]? | select(.conditions.ready == true)] | length')"
ingress_json="$(kubectl get ingress -n "$NAMESPACE" -o json | jq '{
  count: (.items | length),
  loadBalancerAddressReady: ([.items[].status.loadBalancer.ingress[]?] | length > 0)
}')"
external_secrets_json="$(kubectl get externalsecret -n "$NAMESPACE" -o json | jq '{
  count: (.items | length),
  items: [.items[] | {
    name: .metadata.name,
    ready: ([.status.conditions[]? | select(.type == "Ready") | .status][0] // "Unknown")
  }] | sort_by(.name)
}
')"
runtime_secret_json="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json | jq '{
  name: .metadata.name,
  keys: (.data | keys | sort),
  managedByExternalSecret: ((.metadata.ownerReferences // []) | any(.kind == "ExternalSecret"))
}
')"
secret_store_json="$(kubectl get secretstore -n "$NAMESPACE" -o json | jq '{
  count: (.items | length),
  items: [.items[] | {
    name: .metadata.name,
    provider: (if .spec.provider.aws then "aws" else "other" end),
    ready: ([.status.conditions[]? | select(.type == "Ready") | .status][0] // "Unknown")
  }] | sort_by(.name)
}
')"
general_nodes_json="$(kubectl get nodes -l karpenter.sh/nodepool=asklake-general -o json | jq '{
  count: (.items | length),
  amd64: ([.items[] | select(.status.nodeInfo.architecture == "amd64")] | length),
  ready: ([.items[] | select(any(.status.conditions[]; .type == "Ready" and .status == "True"))] | length)
}
')"
health_json="$(kubectl exec -n "$NAMESPACE" deployment/frontend -- sh -c 'wget -qO- http://fastapi:8080/api/health')"
releases_json="$(
  {
    helm list -n "$NAMESPACE" -o json
    helm list -n external-secrets -o json
  } | jq -s '
    add
    | [.[] | select(
        .name == "asklake-foundation"
        or .name == "asklake-ingress"
        or .name == "asklake-web"
        or .name == "external-secrets"
      ) | {name, revision, status, chart}]
    | sort_by(.name)
  '
)"

baseline_json="$(jq -n \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg namespace "$NAMESPACE" \
  --arg ingressAccess "$(jq -r '.metadata.labels["asklake.io/ingress-access"] // ""' <<<"$namespace_json")" \
  --argjson deployments "$deployments_json" \
  --argjson services "$services_json" \
  --argjson frontendEndpoints "$frontend_endpoints" \
  --argjson backendEndpoints "$backend_endpoints" \
  --argjson ingress "$ingress_json" \
  --argjson externalSecrets "$external_secrets_json" \
  --argjson runtimeSecret "$runtime_secret_json" \
  --argjson secretStore "$secret_store_json" \
  --argjson generalNodes "$general_nodes_json" \
  --argjson databaseOk "$(jq '.database.ok == true' <<<"$health_json")" \
  --argjson releases "$releases_json" \
  '{
    capturedAt: $capturedAt,
    namespace: {name: $namespace, ingressAccess: $ingressAccess},
    workloads: $deployments,
    services: $services,
    readyEndpoints: {frontend: $frontendEndpoints, fastapi: $backendEndpoints},
    backendHealth: {databaseOk: $databaseOk},
    ingress: $ingress,
    secretDelivery: {
      externalSecrets: $externalSecrets,
      runtimeSecret: $runtimeSecret,
      secretStore: $secretStore
    },
    generalNodes: $generalNodes,
    helmReleases: $releases
  }'
)"

if [[ "$MODE" == "--expect-pre-change" ]]; then
  jq -e '
    .namespace.name == "asklake-dev"
    and .namespace.ingressAccess == "asklake-dev"
    and ([.workloads[] | select(
      .desired == 2
      and .ready == 2
      and .available == 2
      and .imagePinned == true
    )] | length == 2)
    and ([.workloads[] | .serviceAccount] | sort == ["asklake-backend", "asklake-frontend"])
    and ([.services[] | select(.type == "ClusterIP")] | length == 2)
    and .readyEndpoints.frontend == 2
    and .readyEndpoints.fastapi == 2
    and .backendHealth.databaseOk == true
    and .ingress.count == 0
    and .ingress.loadBalancerAddressReady == false
    and .secretDelivery.externalSecrets.count == 0
    and .secretDelivery.runtimeSecret.keys == ["BOOTSTRAP_ADMIN_PASSWORD", "DATABASE_URL"]
    and .secretDelivery.runtimeSecret.managedByExternalSecret == false
    and ([.secretDelivery.secretStore.items[] | select(.provider == "aws" and .ready == "True")] | length == 1)
    and .generalNodes.count >= 1
    and .generalNodes.ready == .generalNodes.count
    and .generalNodes.amd64 == .generalNodes.count
  ' <<<"$baseline_json" >/dev/null
  echo "EKS day15 integration pre-change baseline passed." >&2
fi

printf '%s\n' "$baseline_json"
