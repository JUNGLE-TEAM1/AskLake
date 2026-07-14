# AskLake EKS application workloads

This chart renders the Tuesday MVP application layer only:

- Frontend: two replicas and an internal `frontend` ClusterIP Service
- FastAPI: two replicas and an internal `fastapi` ClusterIP Service
- shared non-secret backend settings in a ConfigMap
- references to existing runtime and Trino TLS Secrets
- ECR images pinned by `repository@sha256:digest`

The chart does not create a namespace, ServiceAccount/IRSA, ALB/Ingress, Secret, RDS, MSK, Trino, Spark operator, or replay producer. The EKS foundation must provide the `asklake-dev` namespace and the `asklake-frontend` and `asklake-backend` ServiceAccounts first.

Use `infra/eks/values/workloads/dev.example.yaml` only as a shape example. Replace placeholder repositories, digests, buckets, and endpoints in the deployment system; do not commit real credentials. Create the Secret objects before installing this chart.

```bash
scripts/verify-eks-workloads.sh

helm upgrade --install asklake-workloads \
  infra/eks/helm/asklake-workloads \
  --namespace asklake-dev \
  --values /path/to/non-secret-values.yaml
```

Kafka Continuous remains EC2-owned in this MVP. The EKS backend hides or rejects Continuous operations. Kubernetes Spark execution is also fail-closed until the `SparkApplication` provider and run identity recovery are implemented; chart rendering success does not mean ETL execution is ready.
