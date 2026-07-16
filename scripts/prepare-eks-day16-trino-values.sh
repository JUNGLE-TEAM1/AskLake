#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${ASKLAKE_TERRAFORM_STATE:-$ROOT_DIR/infra/eks/terraform/terraform.tfstate}"
RECEIPT="${ASKLAKE_IMAGE_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev-8d4414df.image-receipt.json}"
OUTPUT="${ASKLAKE_DAY16_TRINO_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.day16-a.private-values.json}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"

fail() {
  echo "$1" >&2
  exit 1
}

for command in git jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -s "$STATE" && -s "$RECEIPT" ]] || fail "Terraform state or image receipt is missing"
git -C "$ROOT_DIR" check-ignore -q -- "$STATE" || fail "Terraform state must remain ignored by Git"
git -C "$ROOT_DIR" check-ignore -q -- "$RECEIPT" || fail "image receipt must remain ignored by Git"
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$RECEIPT" >/dev/null

if [[ -e "$OUTPUT" ]]; then
  echo "private Trino values already exist; verify instead of overwriting" >&2
  exit 1
fi

runtime_config="$(kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json | jq -c '.data')"
temporary="$(mktemp "$(dirname "$OUTPUT")/.day16-trino-values.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

jq -n \
  --slurpfile state "$STATE" \
  --slurpfile receipt "$RECEIPT" \
  --argjson runtime "$runtime_config" '
  ($state[0].outputs) as $o |
  ($receipt[0].images) as $images |
  def image($name):
    ($images[$name] | split("@")) as $parts |
    if ($parts|length) == 2 then {repository:$parts[0],digest:$parts[1],pullPolicy:"IfNotPresent"}
    else error("invalid immutable image") end;
  if $o.workload_identity_contract.value.mode != "pod_identity" then error("Pod Identity is required") else . end |
  {
    namespace: $o.namespace.value,
    global: {environment:"production",awsRegion:$o.phase1_handoff.value.aws_region},
    frontend: {image:image("frontend"),serviceAccountName:$o.service_account_names.value.frontend},
    backend: {
      image:image("backend"),
      serviceAccountName:$o.service_account_names.value.backend,
      config:{
        bootstrapAdminEmail:$runtime.BOOTSTRAP_ADMIN_EMAIL,
        kafkaBroker:$runtime.ASKLAKE_KAFKA_BROKER,
        kafkaAuthMode:$runtime.ASKLAKE_KAFKA_AUTH_MODE,
        objectStorageProvider:$runtime.ASKLAKE_OBJECT_STORAGE_PROVIDER,
        rawBucket:$o.storage_contract.value.buckets.raw,
        outputBucket:$o.storage_contract.value.buckets.output,
        outputPrefix:$runtime.ASKLAKE_SPARK_OUTPUT_PREFIX,
        allowedBuckets:([
          $o.storage_contract.value.buckets.raw,
          $o.storage_contract.value.buckets.output,
          $o.storage_contract.value.buckets.warehouse,
          $o.storage_contract.value.buckets.query_results
        ]|join(",")),
        sparkRunner:"kubernetes",
        sparkExecutionLeaseSeconds:60,
        airflowApiBaseUrl:"http://airflow-apiserver:8080",
        airflowDagId:$runtime.AIRFLOW_DAG_ID,
        trinoEnabled:true,
        trinoBaseUrl:$o.trino_handoff.value.service.in_cluster_url,
        trinoCatalog:"iceberg",
        trinoSchema:"asklake",
        trinoUser:"asklake-api",
        trinoWarehouseBucket:$o.storage_contract.value.buckets.warehouse,
        trinoWarehousePrefix:$o.storage_contract.value.prefixes.warehouse,
        trinoResultStorageBucket:$o.storage_contract.value.buckets.query_results
      }
    },
    airflow:{image:image("airflow"),serviceAccountName:$o.service_account_names.value.airflow},
    mskSmoke:{serviceAccountName:$o.service_account_names.value.mskSmoke,topic:$o.msk_contract.value.test_topic},
    sparkApplication:{
      image:image("sparkRuntime"),
      serviceAccountName:$o.service_account_names.value.spark,
      kafka:{broker:$o.msk_contract.value.bootstrap_brokers_sasl_iam,topic:$o.msk_contract.value.test_topic},
      output:{bucket:$o.storage_contract.value.buckets.output,prefix:"eks-mvp/output"},
      warehouse:{bucket:$o.storage_contract.value.buckets.warehouse,prefix:$o.storage_contract.value.prefixes.warehouse}
    },
    trino:{
      enabled:true,
      image:image("trino"),
      serviceAccountName:$o.trino_handoff.value.service_account_name,
      service:{name:$o.trino_handoff.value.service.name,port:$o.trino_handoff.value.service.port},
      config:{
        catalogName:"iceberg",
        jdbcCatalogName:"asklake",
        schemaName:"asklake",
        warehouseBucket:$o.storage_contract.value.buckets.warehouse,
        warehousePrefix:$o.storage_contract.value.prefixes.warehouse,
        queryUser:"asklake-api",
        materializerUser:"asklake-materializer"
      }
    }
  }
' >"$temporary"
chmod 600 "$temporary"
mv "$temporary" "$OUTPUT"
chmod 600 "$OUTPUT"
trap - EXIT
echo "private_trino_values=created"
