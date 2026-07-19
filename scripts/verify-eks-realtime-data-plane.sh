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
  "$ROOT_DIR/infra/eks/terraform/realtime-workload-identity.tf"
  "$ROOT_DIR/deploy/kafka-connect/Dockerfile"
  "$ROOT_DIR/docs/eks-clickhouse-realtime-gold-runbook.md"
  "$ROOT_DIR/scripts/test-eks-realtime-data-plane.sh"
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

jq empty "$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane/values.schema.json"
jq empty "$ROOT_DIR/infra/eks/secrets/realtime-secret-contract.example.json"

grep -q 'aws-msk-iam-auth-2.3.6-all.jar' "$ROOT_DIR/deploy/kafka-connect/Dockerfile"
grep -q 'sha256:de63517a6275b4f112c0375f9246b2a78e8ad1a8fe88b1d096244bfc11981c083' \
  "$ROOT_DIR/deploy/kafka-connect/Dockerfile"
grep -q 'kafka-cluster:Connect' "$ROOT_DIR/infra/eks/terraform/realtime-workload-identity.tf"
grep -q 'aws_eks_pod_identity_association' "$ROOT_DIR/infra/eks/terraform/realtime-workload-identity.tf"
grep -q 'without wildcards' "$ROOT_DIR/infra/eks/terraform/realtime-workload-identity.tf"

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
else
  echo "SKIP: terraform CLI is unavailable; run fmt/validate in CI before apply." >&2
fi

bash "$ROOT_DIR/scripts/test-eks-realtime-data-plane.sh"

echo "EKS realtime data-plane static verification passed."
