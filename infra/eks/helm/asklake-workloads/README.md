# AskLake EKS application workloads

This chart renders the Tuesday MVP application layer:

- Frontend and FastAPI: two replicas each with internal `ClusterIP` Services
- Airflow 3 API server, scheduler, DAG processor, migration hook, and internal Service
- Trino coordinator with HTTPS/password auth, JDBC Iceberg catalog, and internal Service; optional explicit distributed workers
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

When the A-owned `asklake-web` release already owns Frontend/FastAPI, deploy Airflow as a component-scoped release. The disabled components render no Kubernetes objects, so this release cannot take ownership of `frontend`, `fastapi`, or Trino resources:

```bash
helm upgrade --install asklake-airflow \
  infra/eks/helm/asklake-workloads \
  --namespace asklake-dev \
  --values /path/to/non-secret-values.yaml \
  --set frontend.enabled=false \
  --set backend.enabled=false \
  --set trino.enabled=false
```

The `asklake-airflow-runtime` Secret, `asklake-rds-ca` ConfigMap, and immutable Airflow digest must exist before this command. In dev, `infra/eks/secrets/runtime-externalsecrets.dev.yaml` maps the Backend/Airflow AWS sources into ESO-owned target Secrets without storing values in Git. Removing or rolling back the component-scoped release does not reverse or drop an already applied RDS Airflow metadata migration.

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

Airflow uses `LocalExecutor` with the DAG baked into its custom image and RDS metadata over `verify-full` TLS. Do not mirror the upstream Airflow base image as the application image: the delivery workflow must build `airflow/Dockerfile`, or `/opt/airflow/dags` will be empty. The migration hook explicitly enables FAB AuthManager, migrates the database, creates the API user when absent, and always resets its Secret-backed password. The chart creates no EFS/PVC or shared DAG/log volume, so Pod-local logs are not durable across restarts. The complete A/B contract review is in `docs/eks-day15-b-workload-contract-review.md`, and the dev deployment receipt is in `docs/eks-day16-b-airflow-live-evidence.md`.

Airflow API server, scheduler, DAG processor, migration Job, and Trino coordinator
are General workloads. Their values must keep both
`asklake.io/workload-class=general` and `kubernetes.io/arch=amd64`; the schema
rejects Spark/ARM64 overrides, and `scripts/verify-eks-workloads.sh` checks every
rendered Pod template. A chart change does not mutate the live release by itself:
use a server-side dry-run and verify actual Pod placement during the next
authorized Helm upgrade.

## Trino distributed opt-in

The default remains the proven single Trino process: one coordinator that also
runs tasks. `trino.distributed.enabled=true` is accepted only when the private
overlay also supplies `includeCoordinator=false`, a worker replica count from 1 to 5,
complete worker requests/limits, the approved General node selector, and
a worker termination grace value. No worker sizing or autoscaling value is
present in chart defaults or the checked-in dev example. The first live
candidate uses two workers in a Git-ignored private overlay; two is an initial
validation value, while five is only the input/cost ceiling.

An accepted opt-in renders `asklake-trino-worker` separately. The existing
`asklake-trino` Service selects only the coordinator role, while both roles use
the same digest-pinned image, `asklake-trino` ServiceAccount/Pod Identity,
`asklake-trino-runtime` Secret files and JDBC Iceberg/S3 settings. HTTPS
discovery uses the coordinator-only headless `asklake-trino-discovery` Service.
Trino resolves that DNS name to the real coordinator Pod IP before its automatic
internal TLS hostname conversion; the virtual client Service ClusterIP is never
used for discovery. The coordinator Deployment uses `Recreate` so two
coordinators cannot overlap during rollout. The Iceberg data ACL is unchanged;
distributed mode grants the internal materializer read-only system information
access solely for node/task evidence, never write or graceful-shutdown access.

```bash
scripts/verify-eks-trino-distributed.sh
node scripts/test-eks-trino-distributed-evidence.mjs
scripts/verify-eks-trino-distributed-live.sh <expected-workers>
```

Do not add HPA, PDB, topology spread, a worker NodePool, graceful shutdown
credentials, or production sizing until an approved load/failure campaign has
produced evidence. The authorized live and rollback procedure is
`docs/eks-trino-distributed-phase0.md`; normal development and CI never apply it.
The operator first records a healthy single-coordinator `Recreate` revision as
the safe rollback target. Apply also requires the worktree `HEAD`, fetched
`origin/pair1`, and `ASKLAKE_TRINO_DEPLOYMENT_COMMIT` to be the same full SHA.
Active worker registration plus a non-empty Iceberg read is only the deployment
gate: promotion additionally requires a non-empty Iceberg worker task, exact-UID
replacement, a `2→1→2` scale observation, and successful safe rollback evidence
bound to the merged `pair1` commit.
