#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"

BASE_VALUES="${ASKLAKE_RUNTIME_CONFIG_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.runtime-config-values.json}"
OUTPUT="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.day17-multi-spark.runtime-config-values.json}"

fail() {
  echo "$1" >&2
  exit 1
}

for command in git jq node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR")" || \
  fail "current image receipt is invalid"
[[ -s "$BASE_VALUES" ]] || fail "captured live runtime values are missing"
for values in "$BASE_VALUES" "$OUTPUT"; do
  git -C "$ROOT_DIR" check-ignore -q -- "$values" || \
    fail "runtime ConfigMap values must remain ignored"
done
[[ "$(stat -f '%Lp' "$BASE_VALUES")" == "600" ]] || \
  fail "captured live runtime values must use mode 0600"

spark_image="$(jq -er '.images.sparkRuntime' "$RECEIPT")"
temporary="$(mktemp)"
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT

jq -e --arg spark_image "$spark_image" '
  .configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE = $spark_image
  | .configMap.data.ASKLAKE_SPARK_KAFKA_PACKAGE = "none"
  | .configMap.data.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE = "none"
  | .configMap.data.ASKLAKE_SPARK_ICEBERG_PACKAGE = "none"
  | .configMap.data.ASKLAKE_SPARK_POSTGRES_PACKAGE = "none"
  | select(
      .namespace == "asklake-dev"
      and .configMap.name == "asklake-runtime"
      and (
        .configMap.data.ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON
        | fromjson
      ) == [
        {
          consumerGroup: "asklake-eks-mvp-spark-v1",
          table: "eks_mvp_fixture"
        },
        {
          consumerGroup: "asklake-eks-mvp-spark-scale17-01",
          table: "eks_mvp_scale_17_01"
        },
        {
          consumerGroup: "asklake-eks-mvp-spark-scale17-02",
          table: "eks_mvp_scale_17_02"
        },
        {
          consumerGroup: "asklake-eks-mvp-spark-scale17-03",
          table: "eks_mvp_scale_17_03"
        }
      ]
    )
' "$BASE_VALUES" >"$temporary" || \
  fail "captured live runtime values do not preserve the exact Day 17 slot contract"

jq -e --slurp '
  .[0] as $base
  | .[1] as $candidate
  | (
      [
        (
          ($base.configMap.data | keys)
          + ($candidate.configMap.data | keys)
        )
        | unique[]
        | select($base.configMap.data[.] != $candidate.configMap.data[.])
      ]
      | sort
    ) == [
      "ASKLAKE_SPARK_HADOOP_AWS_PACKAGE",
      "ASKLAKE_SPARK_ICEBERG_PACKAGE",
      "ASKLAKE_SPARK_KAFKA_PACKAGE",
      "ASKLAKE_SPARK_KUBERNETES_IMAGE",
      "ASKLAKE_SPARK_POSTGRES_PACKAGE"
    ]
' "$BASE_VALUES" "$temporary" >/dev/null || \
  fail "baked Spark runtime candidate differs from the approved five-key delta"

mv "$temporary" "$OUTPUT"
chmod 600 "$OUTPUT"
trap - EXIT
printf 'day17_baked_runtime_values=prepared key_count=%s delta_keys=5\n' \
  "$(jq '.configMap.data | length' "$OUTPUT")"
