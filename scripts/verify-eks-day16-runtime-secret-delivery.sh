#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
INPUT="${ASKLAKE_DAY16_SECRET_INPUT:-$ROOT_DIR/infra/eks/secrets/dev.runtime-secret-input.json}"

fail() {
  echo "$1" >&2
  exit 1
}

for command in aws jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -f "$INPUT" ]] || fail "private runtime Secret input is missing"
git -C "$ROOT_DIR" check-ignore -q -- "$INPUT" || fail "private runtime Secret input must be ignored by Git"
if git -C "$ROOT_DIR" ls-files --error-unmatch -- "$INPUT" >/dev/null 2>&1; then
  fail "private runtime Secret input must not be tracked by Git"
fi

verify_asklake_eks_context
node "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-input.mjs" "$INPUT" >/dev/null

expected_mapping() {
  local component="$1"
  case "$component" in
    spark)
      jq -n '[
        "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD",
        "ASKLAKE_SPARK_ICEBERG_JDBC_URL",
        "ASKLAKE_SPARK_ICEBERG_JDBC_USER"
      ]'
      ;;
    trino)
      jq -n '[
        "TRINO_ICEBERG_JDBC_PASSWORD",
        "TRINO_ICEBERG_JDBC_URL",
        "TRINO_ICEBERG_JDBC_USER",
        "TRINO_INTERNAL_SHARED_SECRET",
        "TRINO_TLS_KEYSTORE_PASSWORD",
        "trino-keystore.jks",
        "trino-password.db"
      ]'
      ;;
  esac
}

verify_component() {
  local component="$1" name="asklake-$1-runtime" source="asklake/dev/$1/runtime"
  local expected_keys external_secret target_secret source_json desired_json expected_data
  expected_keys="$(expected_mapping "$component")"
  external_secret="$(kubectl get externalsecret "$name" -n "$NAMESPACE" -o json)"
  target_secret="$(kubectl get secret "$name" -n "$NAMESPACE" -o json)"
  source_json="$(aws secretsmanager get-secret-value \
    --region "$REGION" --secret-id "$source" --query SecretString --output text)"
  desired_json="$(jq -c --arg component "$component" '.sources[$component]' "$INPUT")"

  jq -e --arg namespace "$NAMESPACE" --arg name "$name" --arg source "$source" \
    --argjson keys "$expected_keys" --arg component "$component" '
      .apiVersion == "external-secrets.io/v1"
      and .metadata.namespace == $namespace
      and .metadata.name == $name
      and .spec.secretStoreRef == {kind: "SecretStore", name: "asklake-secrets-manager"}
      and .spec.target.name == $name
      and .spec.target.creationPolicy == "Owner"
      and .spec.target.deletionPolicy == "Retain"
      and ([.spec.data[].secretKey] | sort) == $keys
      and all(.spec.data[];
        .remoteRef.key == $source
        and .remoteRef.property == .secretKey
        and (
          if $component == "trino" and (.secretKey == "trino-keystore.jks" or .secretKey == "trino-password.db")
          then .remoteRef.decodingStrategy == "Base64"
          else (.remoteRef.decodingStrategy // "None") == "None"
          end
        )
      )
      and any(.status.conditions[]?; .type == "Ready" and .status == "True")
    ' <<<"$external_secret" >/dev/null || fail "$component ExternalSecret mapping or Ready condition is invalid"

  jq -e --arg name "$name" --argjson keys "$expected_keys" '
    .type == "Opaque"
    and (.data | keys | sort) == $keys
    and any(.metadata.ownerReferences[]?;
      .apiVersion == "external-secrets.io/v1"
      and .kind == "ExternalSecret"
      and .name == $name
      and .controller == true
    )
  ' <<<"$target_secret" >/dev/null || fail "$component target Secret owner or key set is invalid"

  jq -e --argjson keys "$expected_keys" '(keys | sort) == $keys and all(.[]; type == "string" and length > 0)' \
    <<<"$source_json" >/dev/null || fail "$component Secrets Manager source key set is invalid"
  [[ "$(jq -S -c . <<<"$source_json" | asklake_sha256)" == \
     "$(jq -S -c . <<<"$desired_json" | asklake_sha256)" ]] || fail "$component source differs from the approved private input"

  if [[ "$component" == "trino" ]]; then
    expected_data="$(jq -S -c 'with_entries(
      if .key == "trino-keystore.jks" or .key == "trino-password.db"
      then . else .value |= @base64 end
    )' <<<"$source_json")"
  else
    expected_data="$(jq -S -c 'with_entries(.value |= @base64)' <<<"$source_json")"
  fi
  [[ "$(jq -S -c . <<<"$expected_data" | asklake_sha256)" == \
     "$(jq -S -c '.data' <<<"$target_secret" | asklake_sha256)" ]] || fail "$component source and decoded target hashes differ"

  unset expected_keys external_secret target_secret source_json desired_json expected_data
}

verify_component spark
verify_component trino

for existing in backend airflow; do
  source_json="$(aws secretsmanager get-secret-value --region "$REGION" \
    --secret-id "asklake/dev/$existing/runtime" --query SecretString --output text)"
  target_json="$(kubectl get secret "asklake-$existing-runtime" -n "$NAMESPACE" -o json)"
  [[ "$(jq -S -c . <<<"$source_json" | asklake_sha256)" == \
     "$(jq -S -c '.data | with_entries(.value |= @base64d)' <<<"$target_json" | asklake_sha256)" ]] || \
    fail "$existing existing source/target hash drifted"
  unset source_json target_json
done

airflow_keys="$(kubectl get secret asklake-airflow-runtime -n "$NAMESPACE" -o json | jq -c '.data | keys | sort')"
jq -e '. == [
  "AIRFLOW_EXECUTION_API_TOKEN",
  "AIRFLOW_INTERNAL_TOKEN",
  "AIRFLOW_PASSWORD",
  "AIRFLOW__API_AUTH__JWT_SECRET",
  "AIRFLOW__CORE__FERNET_KEY",
  "AIRFLOW__DATABASE__SQL_ALCHEMY_CONN"
]' <<<"$airflow_keys" >/dev/null || fail "Airflow preserved key set drifted"

backend_keys="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json | jq -c '.data | keys | sort')"
jq -e '. == [
  "AIRFLOW_EXECUTION_API_TOKEN",
  "AIRFLOW_INTERNAL_TOKEN",
  "AIRFLOW_PASSWORD",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "DATABASE_URL"
]' <<<"$backend_keys" >/dev/null || fail "Backend preserved key set drifted"

for service_account in asklake-frontend asklake-backend asklake-airflow asklake-msk-smoke asklake-spark asklake-trino; do
  status=0
  answer="$(kubectl auth can-i get secrets -n "$NAMESPACE" \
    --as="system:serviceaccount:$NAMESPACE:$service_account" 2>/dev/null)" || status=$?
  [[ "$status" -eq 1 && "$answer" == "no" ]] || fail "$service_account Secret read denial is invalid"
done

kubectl get deployment frontend fastapi -n "$NAMESPACE" -o json | jq -e '
  (.items | length) == 2
  and all(.items[];
    (.spec.replicas // 0) == 2
    and (.status.readyReplicas // 0) == 2
    and (.status.availableReplicas // 0) == 2
    and (.status.unavailableReplicas // 0) == 0
  )
' >/dev/null || fail "Web workload baseline is not steady"

kubectl get deployment asklake-airflow-apiserver asklake-airflow-scheduler asklake-airflow-dag-processor \
  -n "$NAMESPACE" -o json | jq -e '
    (.items | length) == 3
    and all(.items[];
      (.spec.replicas // 0) == 1
      and (.status.readyReplicas // 0) == 1
      and (.status.availableReplicas // 0) == 1
      and (.status.unavailableReplicas // 0) == 0
    )
  ' >/dev/null || fail "Airflow workload baseline is not steady"

bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null
echo "EKS Day 16 runtime Secret delivery verification passed."
