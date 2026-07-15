# AskLake EKS application workloads

This chart renders the Tuesday MVP application layer:

- Frontend and FastAPI: two replicas each with internal `ClusterIP` Services
- Airflow 3 API server, scheduler, DAG processor, migration hook, and internal Service
- Trino coordinator with HTTPS/password auth, JDBC Iceberg catalog, and internal Service
- least-privilege RBAC for FastAPI `SparkApplication` submission and Spark driver executor management
- opt-in MSK IAM metadata smoke Job and opt-in bounded Kafka-to-S3 `SparkApplication` smoke
- shared non-secret settings in ConfigMaps and exact references to pre-created runtime Secrets
- every workload image pinned by `repository@sha256:digest`

The chart does not create a namespace, ServiceAccount/IRSA, ALB/Ingress, Secret, RDS, MSK, Spark operator, ECR repository, or replay producer. The EKS foundation must provide the `asklake-dev` namespace, all referenced ServiceAccounts/IRSA bindings, Spark operator, AWS resources, runtime Secrets, and image digests first.

Use `infra/eks/values/workloads/dev.example.yaml` only as a shape example. Replace placeholder repositories, digests, buckets, and endpoints in the deployment system; do not commit real credentials. Create the Secret objects before installing this chart.

```bash
scripts/verify-eks-workloads.sh

helm upgrade --install asklake-workloads \
  infra/eks/helm/asklake-workloads \
  --namespace asklake-dev \
  --values /path/to/non-secret-values.yaml
```

The normal install leaves both smoke resources disabled. Enable them only after A has supplied the real MSK endpoint, fixture topic, buckets, IRSA permissions, runtime Secret values, and image digests:

```bash
helm upgrade --install asklake-workloads \
  infra/eks/helm/asklake-workloads \
  --namespace asklake-dev \
  --values /path/to/non-secret-values.yaml \
  --set mskSmoke.create=true \
  --set sparkApplication.create=true \
  --set-string sparkApplication.runId=run-eks-smoke-001 \
  --set-string sparkApplication.jobId=job-eks-smoke-001 \
  --set-string sparkApplication.kafka.fixtureBatchId=eks-smoke-batch-001
```

The static Spark smoke reads a bounded Kafka snapshot (`earliest` through the captured `latest` offsets), filters `raw.fixture_batch_id` to the producer receipt supplied as `sparkApplication.kafka.fixtureBatchId`, and replaces the dedicated `iceberg.asklake.eks_mvp_fixture` table in the configured S3 warehouse. Compare its Trino row count with `sparkApplication.kafka.expectedCount` (default 100). It is a deployment fixture, not a long-running consumer. Kafka Continuous remains EC2-owned in this MVP, and EKS FastAPI rejects Continuous control and read paths.

FastAPI's normal batch path uses the in-cluster Kubernetes API to create a deterministic `SparkApplication` per `runId`, recover the same object after a duplicate create or lost response, poll terminal state, read the driver result marker, and delete a timed-out application. Chart rendering and unit tests verify that contract; the final live proof still requires A's AWS resources.

The foundation ServiceAccount contract must set `asklake-backend` and `asklake-spark` to `automountServiceAccountToken: true`. FastAPI needs the token to manage `SparkApplication` objects; the Spark driver needs it to create and monitor executor Pods. Frontend, Airflow, MSK smoke, and Trino keep the Kubernetes API token disabled.
