# AskLake EKS application workloads

This chart renders the Tuesday MVP application layer:

- Frontend and FastAPI: two replicas each with internal `ClusterIP` Services
- Airflow 3 API server, scheduler, DAG processor, migration hook, and internal Service
- Trino coordinator with HTTPS/password auth, JDBC Iceberg catalog, and internal Service; optional explicit distributed workers
- references to foundation-owned least-privilege RBAC for FastAPI `SparkApplication` submission and Spark driver executor management
- opt-in MSK IAM metadata smoke Job and opt-in bounded Kafka-to-S3 `SparkApplication` smoke
- disabled-by-default Realtime V1 worker package with explicit owner-transfer, previous-owner fence, generation, Kafka-only scope, private S3 runtime document and Spark/MSK IAM contracts
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

The static Spark smoke reads a bounded Kafka snapshot (`earliest` through the captured `latest` offsets), filters `raw.fixture_batch_id` to the producer receipt supplied as `sparkApplication.kafka.fixtureBatchId`, and replaces the dedicated `iceberg.asklake.eks_mvp_fixture` table in the configured S3 warehouse. Compare its Trino row count with `sparkApplication.kafka.expectedCount` (default 100). It is a deployment fixture, not a long-running consumer. Kafka Continuous remains EC2-owned until the Realtime V1 transfer gates below pass, and EKS FastAPI rejects Continuous control and read paths.

Issue #1044 selected Spark Structured Streaming for the EKS Realtime MVP. The chart keeps `realtimeV1.enabled=false`. Rendering it requires all three explicit transfer inputs; missing any one fails closed:

```bash
helm template asklake-workloads \
  infra/eks/helm/asklake-workloads \
  --values /path/to/non-secret-values.yaml \
  --set realtimeV1.enabled=true \
  --set realtimeV1.ownerTransfer.approved=true \
  --set realtimeV1.ownerTransfer.previousOwnerFenced=true \
  --set-string realtimeV1.ownerTransfer.generation='<approved-generation>'
```

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

## Realtime backend opt-in

## Trino distributed opt-in

The disabled default remains the proven single Trino process and is the rollback
path. When `trino.distributed.enabled=true`, the private overlay must supply
`includeCoordinator=false`, exactly two worker replicas, complete worker
requests/limits, the approved General node selector, and a worker termination
grace value. SQL requests, the UI, and HPA cannot override this count. Two means
Pod replicas, not two physical servers or a throughput guarantee. Existing General
node CPU sizing is unchanged. No worker
resource sizing or autoscaling value is present in chart defaults or the checked-in
dev example.

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
and `system.runtime.nodes|tasks` table access solely for node/task evidence,
never other system tables, write, or graceful-shutdown access.

```bash
scripts/verify-eks-trino-distributed.sh
node scripts/test-eks-trino-distributed-evidence.mjs
scripts/verify-eks-trino-distributed-live.sh 2
```

Do not add HPA, PDB, topology spread, a worker NodePool, graceful shutdown
credentials, or production sizing until an approved load/failure campaign has
produced evidence. The authorized live and rollback procedure is
`docs/eks-trino-distributed-phase0.md`; normal development and CI never apply it.
The operator first records a healthy single-coordinator `Recreate` revision as
the safe rollback target. Apply also requires the worktree `HEAD`, fetched
`origin/pair1`, and `ASKLAKE_TRINO_DEPLOYMENT_COMMIT` to be the same full SHA.
If creating or querying that single baseline fails, apply restores and verifies
the exact pre-deployment revision before it stops; it never proceeds to two workers.
The apply campaign also holds the namespace-scoped `asklake-trino-deploy-lock`
ConfigMap, rechecks the Helm revision before each mutation, and removes only its
own lock UID. A foreign revision observed during the live gate is never rolled back.
`SIGKILL` or an operator-host loss can leave this cooperative lock behind. Do not
delete it by name. First inspect its `acquiredAt`, `deploymentCommit`,
`observedRevision`, and UID, confirm no campaign is running and Helm is not in a
pending state, then use the UID-precondition break-glass procedure in
`docs/eks-trino-distributed-phase0.md`.
Active registration of both workers plus a non-empty Iceberg read is only the
deployment gate: promotion additionally requires a non-empty Iceberg worker task,
exact-UID replacement, and successful safe rollback evidence bound to the merged
`pair1` commit. The initial two-worker campaign's `2→1→2` observation remains
historical evidence, not a current scaling procedure.
