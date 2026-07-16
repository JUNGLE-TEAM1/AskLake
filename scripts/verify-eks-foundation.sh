#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-spark-driver-role-contract.sh"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-foundation"
INGRESS_CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-ingress"
VALUES_FILE="$ROOT_DIR/infra/eks/values/dev.example.yaml"
IRSA_VALUES_FILE="$ROOT_DIR/infra/eks/values/identity/irsa.example.yaml"
POD_IDENTITY_VALUES_FILE="$ROOT_DIR/infra/eks/values/identity/pod-identity.example.yaml"
TERRAFORM_DIR="$ROOT_DIR/infra/eks/terraform"
RENDERED_FILE="$(mktemp)"
IRSA_RENDERED_FILE="$(mktemp)"
POD_IDENTITY_RENDERED_FILE="$(mktemp)"
TERRAFORM_DATA_DIR="$(mktemp -d)"
trap 'rm -f "$RENDERED_FILE" "$IRSA_RENDERED_FILE" "$POD_IDENTITY_RENDERED_FILE"; rm -rf "$TERRAFORM_DATA_DIR"' EXIT

required_files=(
  "$ROOT_DIR/infra/eks/README.md"
  "$TERRAFORM_DIR/main.tf"
  "$TERRAFORM_DIR/network-foundation.tf"
  "$TERRAFORM_DIR/network-foundation-variables.tf"
  "$TERRAFORM_DIR/network-foundation-outputs.tf"
  "$TERRAFORM_DIR/auto-mode-node-pools.tf"
  "$TERRAFORM_DIR/auto-mode-node-pools-variables.tf"
  "$TERRAFORM_DIR/auto-mode-node-pools-outputs.tf"
  "$TERRAFORM_DIR/web-workload-outputs.tf"
  "$TERRAFORM_DIR/metrics-server.tf"
  "$TERRAFORM_DIR/outputs.tf"
  "$TERRAFORM_DIR/workload-identity.tf"
  "$TERRAFORM_DIR/workload-identity-outputs.tf"
  "$TERRAFORM_DIR/modules/workload-iam-policies/main.tf"
  "$TERRAFORM_DIR/modules/workload-iam-policies/variables.tf"
  "$TERRAFORM_DIR/modules/workload-iam-policies/outputs.tf"
  "$TERRAFORM_DIR/dev.tfvars.example"
  "$ROOT_DIR/infra/eks/bootstrap/rds/bootstrap-databases.sql"
  "$ROOT_DIR/scripts/bootstrap-eks-rds-databases.sh"
  "$ROOT_DIR/scripts/verify-eks-rds-bootstrap.sh"
  "$CHART_DIR/Chart.yaml"
  "$CHART_DIR/values.schema.json"
  "$CHART_DIR/templates/backend-rbac.yaml"
  "$CHART_DIR/templates/spark-driver-rbac.yaml"
  "$INGRESS_CHART_DIR/Chart.yaml"
  "$INGRESS_CHART_DIR/values.schema.json"
  "$INGRESS_CHART_DIR/templates/ingress-class.yaml"
  "$INGRESS_CHART_DIR/templates/ingress.yaml"
  "$ROOT_DIR/infra/eks/helm/asklake-web/Chart.yaml"
  "$ROOT_DIR/infra/eks/helm/asklake-web/values.schema.json"
  "$ROOT_DIR/infra/eks/helm/asklake-scale-smoke/Chart.yaml"
  "$ROOT_DIR/infra/eks/helm/asklake-scale-smoke/values.schema.json"
  "$VALUES_FILE"
  "$IRSA_VALUES_FILE"
  "$POD_IDENTITY_VALUES_FILE"
  "$ROOT_DIR/docs/eks-msk-mvp-phase-1-handoff.md"
  "$ROOT_DIR/docs/eks-phase-10-auto-mode-foundation.md"
  "$ROOT_DIR/docs/eks-phase-11-network-foundation.md"
  "$ROOT_DIR/docs/eks-phase-12-auto-mode-node-pools.md"
  "$ROOT_DIR/docs/eks-phase-13-auto-mode-alb.md"
  "$ROOT_DIR/docs/eks-phase-14-web-workloads.md"
  "$ROOT_DIR/docs/eks-day15-spark-operator-evidence.md"
  "$ROOT_DIR/docs/eks-day15-backend-s3-runtime-evidence.md"
  "$ROOT_DIR/docs/eks-day16-a-baseline.md"
  "$ROOT_DIR/docs/eks-day16-a-runtime-secret-input.md"
  "$ROOT_DIR/docs/eks-day16-a-runtime-secret-delivery.md"
  "$ROOT_DIR/docs/eks-day16-a-trino-data-plane.md"
  "$ROOT_DIR/docs/eks-day16-a-handoff.md"
  "$ROOT_DIR/docs/eks-day16-final-remediation-review.md"
  "$ROOT_DIR/infra/eks/smoke/backend_s3_smoke.py"
  "$ROOT_DIR/scripts/deploy-eks-auto-mode-ingress.sh"
  "$ROOT_DIR/scripts/destroy-eks-auto-mode-ingress.sh"
  "$ROOT_DIR/scripts/deploy-eks-web-workloads.sh"
  "$ROOT_DIR/scripts/destroy-eks-web-workloads.sh"
  "$ROOT_DIR/scripts/verify-eks-web-workloads.sh"
  "$ROOT_DIR/scripts/verify-eks-metrics-scale.sh"
  "$ROOT_DIR/scripts/verify-eks-spark-operator.sh"
  "$ROOT_DIR/scripts/run-eks-backend-s3-smoke.sh"
  "$ROOT_DIR/scripts/verify-eks-backend-image-provenance.sh"
  "$ROOT_DIR/scripts/preflight-eks-backend-image-rollout.sh"
  "$ROOT_DIR/scripts/rollout-eks-backend-image.sh"
  "$ROOT_DIR/scripts/verify-eks-catalog-rows-error-runtime.sh"
  "$ROOT_DIR/scripts/prepare-eks-physical-read-input.sh"
  "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh"
  "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh"
  "$ROOT_DIR/scripts/capture-eks-day16-a-baseline.sh"
  "$ROOT_DIR/scripts/prepare-eks-day16-runtime-secret-input.sh"
  "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-input.mjs"
  "$ROOT_DIR/scripts/deploy-eks-day16-runtime-secrets.sh"
  "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-delivery.sh"
  "$ROOT_DIR/infra/eks/secrets/spark-runtime-external-secret.yaml"
  "$ROOT_DIR/infra/eks/secrets/trino-runtime-external-secret.yaml"
  "$ROOT_DIR/infra/eks/smoke/trino_data_plane_smoke.py"
  "$ROOT_DIR/scripts/prepare-eks-day16-trino-values.sh"
  "$ROOT_DIR/scripts/verify-eks-day16-trino-values.sh"
  "$ROOT_DIR/scripts/run-eks-day16-trino-data-plane-smoke.sh"
  "$ROOT_DIR/scripts/prepare-eks-day16-a-handoff.sh"
  "$ROOT_DIR/scripts/verify-eks-day16-a-handoff.sh"
  "$ROOT_DIR/scripts/test-eks-day15-validation-hardening.sh"
  "$ROOT_DIR/scripts/run-eks-catalog-physical-read-smoke.sh"
  "$ROOT_DIR/scripts/test-eks-catalog-physical-read-smoke.sh"
  "$ROOT_DIR/scripts/lib/verify-spark-driver-role-contract.sh"
  "$ROOT_DIR/scripts/test-eks-spark-rbac-contract.sh"
  "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
  "$ROOT_DIR/scripts/resolve-eks-backend-runtime-profile.mjs"
  "$ROOT_DIR/scripts/verify-eks-runtime-config-contract.mjs"
  "$ROOT_DIR/scripts/verify-eks-runtime-config-ownership.sh"
  "$ROOT_DIR/scripts/test-eks-image-receipt-input.sh"
  "$ROOT_DIR/scripts/test-eks-runtime-config-contract.mjs"
  "$ROOT_DIR/scripts/test-eks-backend-runtime-profile.mjs"
  "$ROOT_DIR/scripts/verify-tracked-evidence-redaction.sh"
  "$ROOT_DIR/scripts/test-tracked-evidence-redaction.sh"
  "$ROOT_DIR/scripts/verify-eks-day16-bounded-e2e-evidence.sh"
  "$ROOT_DIR/backend/scripts/verify_eks_phase5_bounded_evidence.py"
  "$ROOT_DIR/scripts/lib/audit-eks-s3-smoke-residue.sh"
  "$ROOT_DIR/scripts/lib/eks-backend-secret-rollback.sh"
  "$ROOT_DIR/scripts/deploy-eks-spark-operator.sh"
  "$ROOT_DIR/scripts/destroy-eks-spark-operator.sh"
  "$ROOT_DIR/scripts/run-eks-node-scale-smoke.sh"
  "$ROOT_DIR/scripts/verify-eks-node-scale-in.sh"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "$required_file" ]]; then
    echo "missing required EKS foundation file: $required_file" >&2
    exit 1
  fi
done

bash "$ROOT_DIR/scripts/test-eks-spark-rbac-contract.sh"
bash "$ROOT_DIR/scripts/test-eks-image-receipt-input.sh"
node "$ROOT_DIR/scripts/test-eks-runtime-config-contract.mjs"
node "$ROOT_DIR/scripts/test-eks-backend-runtime-profile.mjs"
bash "$ROOT_DIR/scripts/test-tracked-evidence-redaction.sh"
bash "$ROOT_DIR/scripts/verify-tracked-evidence-redaction.sh"
node --check "$ROOT_DIR/scripts/resolve-eks-backend-runtime-profile.mjs"
node --check "$ROOT_DIR/scripts/verify-eks-runtime-config-contract.mjs"
node --check "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs"
python3 -m py_compile "$ROOT_DIR/backend/scripts/verify_eks_phase5_bounded_evidence.py"
bash -n "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-runtime-config-ownership.sh"
bash -n "$ROOT_DIR/scripts/verify-tracked-evidence-redaction.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-day16-bounded-e2e-evidence.sh"

helm lint "$CHART_DIR" -f "$VALUES_FILE"
helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" >"$RENDERED_FILE"
helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" -f "$IRSA_VALUES_FILE" >"$IRSA_RENDERED_FILE"
helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" -f "$POD_IDENTITY_VALUES_FILE" >"$POD_IDENTITY_RENDERED_FILE"

if helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" \
  --set global.kafkaRuntime=redpanda >/dev/null 2>&1; then
  echo "Helm schema accepted a non-MSK deployment broker" >&2
  exit 1
fi

if helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" \
  --set global.trinoRuntime=external >/dev/null 2>&1; then
  echo "Helm schema accepted a non-EKS Trino runtime" >&2
  exit 1
fi

if helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" \
  --set serviceAccounts.replayProducer.create=true >/dev/null 2>&1; then
  echo "Helm schema allowed the excluded Replay Producer workload" >&2
  exit 1
fi

if helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" \
  --set global.workloadIdentityMode=unknown >/dev/null 2>&1; then
  echo "Helm schema accepted an unknown workload identity mode" >&2
  exit 1
fi

if helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" \
  --set serviceAccounts.spark.automountServiceAccountToken=false >/dev/null 2>&1; then
  echo "Helm schema allowed the Spark driver ServiceAccount token to be disabled" >&2
  exit 1
fi

if helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" \
  --set serviceAccounts.frontend.automountServiceAccountToken=true >/dev/null 2>&1; then
  echo "Helm schema allowed a non-Kubernetes-API workload to mount a ServiceAccount token" >&2
  exit 1
fi

service_account_count="$(grep -c '^kind: ServiceAccount$' "$RENDERED_FILE")"
if [[ "$service_account_count" -ne 6 ]]; then
  echo "expected 6 workload service accounts, rendered $service_account_count" >&2
  exit 1
fi

for service_account in \
  asklake-frontend \
  asklake-backend \
  asklake-airflow \
  asklake-trino \
  asklake-msk-smoke \
  asklake-spark; do
  if ! grep -q "name: $service_account" "$RENDERED_FILE"; then
    echo "rendered foundation is missing service account: $service_account" >&2
    exit 1
  fi
done

verify_asklake_spark_driver_role_contract "$RENDERED_FILE"

backend_service_account="$({
  awk '
    /^kind: ServiceAccount$/ { block = $0 ORS; capture = 1; next }
    capture { block = block $0 ORS }
    capture && /^---$/ {
      if (block ~ /name: asklake-backend/) {
        printf "%s", block
        exit
      }
      capture = 0
      block = ""
    }
    END {
      if (capture && block ~ /name: asklake-backend/) printf "%s", block
    }
  ' "$RENDERED_FILE"
} || true)"

if ! grep -q '^automountServiceAccountToken: true$' <<<"$backend_service_account"; then
  echo "asklake-backend must mount its ServiceAccount token for SparkApplication API calls" >&2
  exit 1
fi

spark_service_account="$({
  awk '
    /^kind: ServiceAccount$/ { block = $0 ORS; capture = 1; next }
    capture { block = block $0 ORS }
    capture && /^---$/ {
      if (block ~ /name: asklake-spark/) {
        printf "%s", block
        exit
      }
      capture = 0
      block = ""
    }
    END {
      if (capture && block ~ /name: asklake-spark/) printf "%s", block
    }
  ' "$RENDERED_FILE"
} || true)"

if ! grep -q '^automountServiceAccountToken: true$' <<<"$spark_service_account"; then
  echo "asklake-spark must mount its ServiceAccount token for executor Pod lifecycle calls" >&2
  exit 1
fi

role_count="$(grep -c '^kind: Role$' "$RENDERED_FILE")"
role_binding_count="$(grep -c '^kind: RoleBinding$' "$RENDERED_FILE")"
if [[ "$role_count" -ne 2 || "$role_binding_count" -ne 2 ]]; then
  echo "expected backend and Spark namespace Role/RoleBinding pairs" >&2
  exit 1
fi

grep -q 'name: asklake-backend-sparkapplications' "$RENDERED_FILE"
grep -q 'resources: \["sparkapplications"\]' "$RENDERED_FILE"
grep -q 'verbs: \["create", "get", "list", "watch", "delete"\]' "$RENDERED_FILE"
grep -q 'resources: \["pods/log"\]' "$RENDERED_FILE"
grep -q 'name: asklake-spark-driver' "$RENDERED_FILE"

if grep -Eq '^kind: ClusterRole(Binding)?$|resources:.*("secrets"|"nodes"|"namespaces")|verbs:.*("patch"|"update"|"\*")' "$RENDERED_FILE"; then
  echo "rendered Foundation contains out-of-contract Kubernetes permissions" >&2
  exit 1
fi

grep -q 'kafkaRuntime: "msk-serverless"' "$RENDERED_FILE"
grep -q 'kafkaAuth: "iam"' "$RENDERED_FILE"
grep -q 'trinoRuntime: "eks"' "$RENDERED_FILE"
grep -q 'continuousOwner: "ec2-mvp"' "$RENDERED_FILE"
grep -q 'workloadIdentityMode: "disabled"' "$RENDERED_FILE"

irsa_annotation_count="$(grep -c 'eks.amazonaws.com/role-arn:' "$IRSA_RENDERED_FILE")"
if [[ "$irsa_annotation_count" -ne 4 ]]; then
  echo "IRSA render must contain exactly four workload role annotations" >&2
  exit 1
fi

if grep -q 'eks.amazonaws.com/role-arn:' "$POD_IDENTITY_RENDERED_FILE"; then
  echo "Pod Identity render must not contain IRSA annotations" >&2
  exit 1
fi

grep -q 'workloadIdentityMode: "irsa"' "$IRSA_RENDERED_FILE"
grep -q 'workloadIdentityMode: "pod_identity"' "$POD_IDENTITY_RENDERED_FILE"

if grep -q 'asklake-replay-producer' "$RENDERED_FILE"; then
  echo "EKS foundation must not create a Replay Producer service account" >&2
  exit 1
fi

if grep -q '^kind: StatefulSet$' "$RENDERED_FILE"; then
  echo "EKS foundation must not deploy a Kafka/Redpanda StatefulSet" >&2
  exit 1
fi

if grep -Eiq '(AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' \
  "$TERRAFORM_DIR"/*.tf \
  "$TERRAFORM_DIR"/modules/workload-iam-policies/*.tf \
  "$TERRAFORM_DIR/dev.tfvars.example" \
  "$ROOT_DIR/infra/eks/bootstrap/rds/bootstrap-databases.sql" \
  "$ROOT_DIR/scripts/bootstrap-eks-rds-databases.sh" \
  "$ROOT_DIR/scripts/verify-eks-rds-bootstrap.sh" \
  "$IRSA_VALUES_FILE" \
  "$POD_IDENTITY_VALUES_FILE" \
  "$VALUES_FILE"; then
  echo "credential-like value found in EKS foundation examples" >&2
  exit 1
fi

grep -q 'workload_identity_mode = "disabled"' "$TERRAFORM_DIR/dev.tfvars.example"
grep -q 'pod_identity_agent_ready = false' "$TERRAFORM_DIR/dev.tfvars.example"
grep -q 'existing_auto_mode_enabled       = false' "$TERRAFORM_DIR/dev.tfvars.example"
grep -q 'cluster_admin_principal_arn = null' "$TERRAFORM_DIR/dev.tfvars.example"
grep -q 'network_mode               = "external"' "$TERRAFORM_DIR/dev.tfvars.example"
grep -q 'private_egress_mode             = "undecided"' "$TERRAFORM_DIR/dev.tfvars.example"
grep -q 'eks.amazonaws.com/pod-readiness-gate-inject: enabled' "$VALUES_FILE"
grep -q 'ASKLAKE_RDS_BOOTSTRAP_CONFIRM=create-three-isolated-databases' \
  "$ROOT_DIR/scripts/bootstrap-eks-rds-databases.sh"

for auto_mode_contract in \
  'compute_config {' \
  'elastic_load_balancing {' \
  'block_storage {' \
  'bootstrap_cluster_creator_admin_permissions = false' \
  'resource "aws_eks_access_entry" "cluster_admin"' \
  'AmazonEKSComputePolicy' \
  'AmazonEKSBlockStoragePolicy' \
  'AmazonEKSLoadBalancingPolicy' \
  'AmazonEKSNetworkingPolicy' \
  'AmazonEKSWorkerNodeMinimalPolicy'; do
  if ! grep -Fq "$auto_mode_contract" "$TERRAFORM_DIR/main.tf"; then
    echo "EKS Auto Mode foundation is missing contract: $auto_mode_contract" >&2
    exit 1
  fi
done

if grep -R -Eq 'resource[[:space:]]+"aws_eks_node_group"|create_managed_node_group|managed_node_group_name|node_instance_types|node_capacity_type|node_(min|desired|max)_size' \
  "$TERRAFORM_DIR"/*.tf \
  "$TERRAFORM_DIR/dev.tfvars.example"; then
  echo "legacy managed node group contract remains in EKS Auto Mode Terraform" >&2
  exit 1
fi

for network_contract in \
  'resource "aws_vpc" "mvp"' \
  'resource "aws_subnet" "public"' \
  'resource "aws_subnet" "private"' \
  'resource "aws_nat_gateway" "private"' \
  'resource "aws_vpc_endpoint" "interface"' \
  'resource "aws_vpc_endpoint" "s3"' \
  'resource "aws_vpc_security_group_ingress_rule" "msk_from_eks"' \
  'resource "aws_vpc_security_group_ingress_rule" "rds_from_eks"'; do
  if ! grep -Fq "$network_contract" "$TERRAFORM_DIR/network-foundation.tf"; then
    echo "EKS Phase 11 network foundation is missing contract: $network_contract" >&2
    exit 1
  fi
done

grep -Fq '"kubernetes.io/role/elb" = "1"' "$TERRAFORM_DIR/network-foundation.tf"
grep -Fq '"kubernetes.io/role/internal-elb" = "1"' "$TERRAFORM_DIR/network-foundation.tf"
grep -Fq 'map_public_ip_on_launch = false' "$TERRAFORM_DIR/network-foundation.tf"
grep -Fq 'from_port                    = 9098' "$TERRAFORM_DIR/network-foundation.tf"
grep -Fq 'from_port                    = 5432' "$TERRAFORM_DIR/network-foundation.tf"

if grep -Eq 'cidr_ipv4[[:space:]]*=[[:space:]]*"0\.0\.0\.0/0"' "$TERRAFORM_DIR/network-foundation.tf"; then
  echo "EKS Phase 11 network foundation contains public security-group ingress" >&2
  exit 1
fi

for database in asklake_app airflow_metadata iceberg_catalog; do
  if ! grep -q "CREATE DATABASE $database" "$ROOT_DIR/infra/eks/bootstrap/rds/bootstrap-databases.sql"; then
    echo "RDS bootstrap is missing logical database: $database" >&2
    exit 1
  fi
done

bash -n "$ROOT_DIR/scripts/bootstrap-eks-rds-databases.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-rds-bootstrap.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-auto-mode-node-pools.sh"
bash -n "$ROOT_DIR/scripts/preflight-eks-backend-image-rollout.sh"
bash -n "$ROOT_DIR/scripts/rollout-eks-backend-image.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-catalog-rows-error-runtime.sh"
bash -n "$ROOT_DIR/scripts/prepare-eks-physical-read-input.sh"
bash -n "$ROOT_DIR/scripts/capture-eks-day16-a-baseline.sh"
bash -n "$ROOT_DIR/scripts/prepare-eks-day16-runtime-secret-input.sh"
node --check "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-input.mjs"
node --check "$ROOT_DIR/scripts/lib/validate-trino-password-db.mjs"
node "$ROOT_DIR/scripts/test-trino-password-db.mjs"
bash -n "$ROOT_DIR/scripts/deploy-eks-day16-runtime-secrets.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-delivery.sh"
bash -n "$ROOT_DIR/scripts/prepare-eks-day16-trino-values.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-day16-trino-values.sh"
bash -n "$ROOT_DIR/scripts/run-eks-day16-trino-data-plane-smoke.sh"
python3 -m py_compile "$ROOT_DIR/infra/eks/smoke/trino_data_plane_smoke.py"
bash -n "$ROOT_DIR/scripts/prepare-eks-day16-a-handoff.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-day16-a-handoff.sh"
bash "$ROOT_DIR/scripts/verify-eks-auto-mode-node-pools.sh"
bash "$ROOT_DIR/scripts/verify-eks-network-ingress.sh"
bash "$ROOT_DIR/scripts/verify-eks-web-workloads.sh"
bash "$ROOT_DIR/scripts/verify-eks-metrics-scale.sh"
bash "$ROOT_DIR/scripts/test-eks-day15-validation-hardening.sh"

TERRAFORM_BIN="${ASKLAKE_TERRAFORM_BIN:-}"
if [[ -z "$TERRAFORM_BIN" ]] && command -v terraform >/dev/null 2>&1; then
  TERRAFORM_BIN="$(command -v terraform)"
fi

if [[ -n "$TERRAFORM_BIN" ]]; then
  TF_DATA_DIR="$TERRAFORM_DATA_DIR" "$TERRAFORM_BIN" -chdir="$TERRAFORM_DIR" fmt -check -recursive
  TF_DATA_DIR="$TERRAFORM_DATA_DIR" "$TERRAFORM_BIN" -chdir="$TERRAFORM_DIR" init -backend=false -input=false >/dev/null
  TF_DATA_DIR="$TERRAFORM_DATA_DIR" "$TERRAFORM_BIN" -chdir="$TERRAFORM_DIR" validate
  TF_DATA_DIR="$TERRAFORM_DATA_DIR" "$TERRAFORM_BIN" -chdir="$TERRAFORM_DIR" test
else
  echo "SKIP: terraform CLI is not installed; run the documented Docker validation before commit."
fi

echo "EKS foundation contract verification passed."
