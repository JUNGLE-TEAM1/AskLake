# AskLake EKS application workloads

This chart renders the Tuesday MVP application layer:

- Frontend and FastAPI: two replicas each with internal `ClusterIP` Services
- Airflow 3 API server, scheduler, DAG processor, migration hook, and internal Service
- Trino coordinator with HTTPS/password auth, JDBC Iceberg catalog, and internal Service
- references to foundation-owned least-privilege RBAC for FastAPI `SparkApplication` submission and Spark driver executor management
- opt-in MSK IAM metadata smoke Job and opt-in bounded Kafka-to-S3 `SparkApplication` smoke
- shared non-secret settings in ConfigMaps and exact references to contract-defined runtime Secrets
- every workload image pinned by `repository@sha256:digest`

The chart does not create a namespace, ServiceAccount/workload identity, Role/RoleBinding, ALB/Ingress, Secret, RDS, MSK, Spark operator, ECR repository, or replay producer. The EKS foundation must provide the `asklake-dev` namespace, all referenced ServiceAccounts/EKS Pod Identity bindings and RBAC, Spark operator, AWS resources, runtime Secrets, and image digests first. The ESO controller and namespaced store alone do not mean that the four runtime Secrets exist.

Use `infra/eks/values/workloads/dev.example.yaml` only as a shape example. Replace placeholder repositories, digests, buckets, and endpoints in the deployment system; do not commit real credentials. Create the Secret objects before installing this chart.

```bash
scripts/verify-eks-workloads.sh

helm upgrade --install asklake-workloads \
  infra/eks/helm/asklake-workloads \
  --namespace asklake-dev \
  --values /path/to/non-secret-values.yaml
```

The application Services are `frontend:80` and `fastapi:8080`, matching the foundation handoff and Ingress defaults. Pod selectors use `app.kubernetes.io/name=asklake-workloads` plus the Helm release identity. Do not install an A-owned temporary `asklake-web` release and this chart as competing owners of the same Service names or frontend/backend workload scope.

The normal install leaves both smoke resources disabled. Enable them only after A has supplied the real MSK endpoint, fixture topic, buckets, Pod Identity permissions, runtime Secret values, and image digests:

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

The foundation ServiceAccount contract sets `asklake-backend` and `asklake-spark` to `automountServiceAccountToken: true`. FastAPI needs the token to manage `SparkApplication` objects; the Spark driver needs it to create and monitor executor Pods. The 15-day MVP keeps driver and executor on the same `asklake-spark` ServiceAccount, so executor Pods inherit the driver token/RBAC as a documented residual risk; split them before production. Frontend, Airflow, MSK smoke, and Trino keep the Kubernetes API token disabled. FastAPI startup/readiness use the DB-aware `/api/health` endpoint, while liveness uses a TCP socket so an RDS outage removes Pods from Service endpoints without causing restart loops.

Airflow uses `LocalExecutor` with the DAG baked into its image and RDS metadata. The chart creates no EFS/PVC or shared DAG/log volume, so Pod-local logs are not durable across restarts. The complete A/B contract review is in `docs/eks-day15-b-workload-contract-review.md`.
