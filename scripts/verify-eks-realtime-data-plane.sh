#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

required_files=(
  "$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane/Chart.yaml"
  "$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane/values.yaml"
  "$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane/values.schema.json"
  "$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane/templates/statefulsets.yaml"
  "$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane/templates/deployments.yaml"
  "$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane/templates/networkpolicies.yaml"
  "$ROOT_DIR/infra/eks/values/workloads/realtime-data-plane.test.example.yaml"
  "$ROOT_DIR/infra/eks/secrets/realtime-runtime-externalsecrets.example.yaml"
  "$ROOT_DIR/infra/eks/secrets/realtime-secret-contract.example.json"
  "$ROOT_DIR/infra/eks/delivery/realtime-v2-image-receipt.example.json"
  "$ROOT_DIR/infra/eks/delivery/realtime-v2-live-evidence.example.json"
  "$ROOT_DIR/infra/eks/terraform/realtime-workload-identity.tf"
  "$ROOT_DIR/deploy/kafka-connect/Dockerfile"
  "$ROOT_DIR/docs/eks-clickhouse-realtime-gold-runbook.md"
  "$ROOT_DIR/scripts/test-eks-realtime-data-plane.sh"
  "$ROOT_DIR/scripts/verify-eks-realtime-v2-secrets.sh"
  "$ROOT_DIR/scripts/test-eks-realtime-v2-secrets.sh"
  "$ROOT_DIR/scripts/test-clickhouse-v2-local-redeploy.sh"
  "$ROOT_DIR/scripts/verify-eks-realtime-v2-image-receipt.mjs"
  "$ROOT_DIR/scripts/test-eks-realtime-v2-image-receipt.mjs"
  "$ROOT_DIR/scripts/verify-eks-realtime-v2-kafka-contract.mjs"
  "$ROOT_DIR/scripts/test-eks-realtime-v2-kafka-contract.mjs"
  "$ROOT_DIR/scripts/audit-eks-realtime-v2-kafka-live.sh"
  "$ROOT_DIR/scripts/verify-eks-realtime-v2-live-evidence.mjs"
  "$ROOT_DIR/scripts/test-eks-realtime-v2-live-evidence.mjs"
  "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "$required_file" ]]; then
    echo "missing EKS realtime contract file: $required_file" >&2
    exit 1
  fi
done

command -v helm >/dev/null 2>&1 || {
  echo "helm is required" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "node is required" >&2
  exit 1
}

jq empty "$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane/values.schema.json"
jq empty "$ROOT_DIR/infra/eks/secrets/realtime-secret-contract.example.json"
node "$ROOT_DIR/scripts/verify-eks-realtime-v2-image-receipt.mjs" \
  "$ROOT_DIR/infra/eks/delivery/realtime-v2-image-receipt.example.json"
node --test "$ROOT_DIR/scripts/test-eks-realtime-v2-image-receipt.mjs"
node --test "$ROOT_DIR/scripts/test-eks-realtime-v2-kafka-contract.mjs"
node --test "$ROOT_DIR/scripts/test-eks-realtime-v2-live-evidence.mjs"
node "$ROOT_DIR/scripts/verify-eks-realtime-v2-live-evidence.mjs" \
  "$ROOT_DIR/infra/eks/delivery/realtime-v2-live-evidence.example.json" --allow-example
bash "$ROOT_DIR/scripts/test-eks-realtime-v2-secrets.sh"

grep -q 'aws-msk-iam-auth-2.3.6-all.jar' "$ROOT_DIR/deploy/kafka-connect/Dockerfile"
grep -q 'sha256:de63517a6275b4f112c0375f9246b2a78e8ad1a8fe88b1d096244bfc11981c083' \
  "$ROOT_DIR/deploy/kafka-connect/Dockerfile"
grep -q 'kafka-cluster:Connect' "$ROOT_DIR/infra/eks/terraform/realtime-workload-identity.tf"
grep -q 'kafka-cluster:WriteDataIdempotently' "$ROOT_DIR/infra/eks/terraform/realtime-workload-identity.tf"
grep -q 'kafka-cluster:CreateTopic' "$ROOT_DIR/infra/eks/terraform/realtime-workload-identity.tf"
grep -q 'aws_eks_pod_identity_association' "$ROOT_DIR/infra/eks/terraform/realtime-workload-identity.tf"
grep -q 'without wildcards' "$ROOT_DIR/infra/eks/terraform/realtime-workload-identity.tf"
grep -q 'deploy-reviewed-realtime-v2' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q 'ec2-control-loop-zero' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q 'verify-eks-realtime-v2-secrets.sh' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q 'verify-eks-realtime-v2-kafka-contract.mjs' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q -- '--e2e' "$ROOT_DIR/scripts/audit-eks-realtime-v2-kafka-live.sh"
grep -q 'ClickHouse V2 account passwords must be non-placeholder length and pairwise distinct' \
  "$ROOT_DIR/scripts/verify-eks-realtime-v2-secrets.sh"
grep -q 'CLICKHOUSE_V2_TLS_STAGING_REQUIRED' \
  "$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane/templates/statefulsets.yaml"
grep -q 'list-pod-identity-associations' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q 'describe-pod-identity-association' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q 'list-attached-role-policies' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q 'kafka-cluster:AlterGroup' "$ROOT_DIR/scripts/verify-eks-realtime-v2-kafka-contract.mjs"
grep -q 'asklake-realtime-v2-connect' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q 'exactly one desired Kafka/all-scope loop' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q 'candidate selector differs from the live legacy identity' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q 'clickhouse-data-clickhouse-v2-0' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"
grep -q 'keeper-data-clickhouse-keeper-v2-0' "$ROOT_DIR/scripts/deploy-eks-realtime-v2.sh"

for runbook_marker in \
  '## 3. 로컬 및 CI 사전 검증' \
  '## 5. Shadow render와 승인 전 점검' \
  '## 7. Owner 전환' \
  '## 9. Kafka → ClickHouse → GOLD → Dashboard E2E' \
  '## 10. 승인된 장애 검증' \
  '## 11. Rollback' \
  '구형 EC2 `all` worker process/container 0' \
  'VolumeSnapshotClass'; do
  grep -q "$runbook_marker" "$ROOT_DIR/docs/eks-clickhouse-realtime-gold-runbook.md"
done

if command -v terraform >/dev/null 2>&1; then
  terraform -chdir="$ROOT_DIR/infra/eks/terraform" fmt -check -recursive
  terraform -chdir="$ROOT_DIR/infra/eks/terraform" init -backend=false
  terraform -chdir="$ROOT_DIR/infra/eks/terraform" validate
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker run --rm --entrypoint sh \
    -v "$ROOT_DIR/infra/eks:/src:ro" \
    hashicorp/terraform:1.9.8 \
    -lc 'cp -R /src /tmp/eks && cd /tmp/eks/terraform && terraform fmt -check -recursive && terraform init -backend=false -input=false >/dev/null && terraform validate'
else
  echo "SKIP: Terraform CLI and Docker fallback are unavailable; run fmt/validate in CI before apply." >&2
fi

bash "$ROOT_DIR/scripts/test-eks-realtime-data-plane.sh"

echo "EKS realtime data-plane static verification passed."
