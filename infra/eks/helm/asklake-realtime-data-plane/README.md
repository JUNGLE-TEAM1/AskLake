# AskLake EKS Realtime Data Plane

This chart is an opt-in, separate Helm release for ClickHouse Realtime V2. It does not extend the stateless `asklake-workloads` release with PVC ownership.

The canonical release name is `asklake-realtime-v2`. Its StatefulSet and Service
names intentionally preserve the first V2 deployment identities:
`clickhouse-keeper-v2`, `clickhouse-v2`, and `kafka-connect-v2`. The claim template
names `keeper-data` and `clickhouse-data` therefore reattach the retained
`keeper-data-clickhouse-keeper-v2-0` and `clickhouse-data-clickhouse-v2-0` PVCs.
Changing any of these names creates a different volume boundary and requires a
separate restore migration; it is not a normal Helm upgrade.

The immutable workload selectors also preserve the first release's
`asklake-workloads` plus `realtime-v2-keeper`, `realtime-v2-clickhouse`, and
`realtime-v2-connect` identities. This is deliberate: changing only the chart
name in a selector makes an in-place StatefulSet/Deployment migration impossible.
The preflight compares every live selector with the candidate before Helm runs.

## Modes

| Mode | Rendered runtime | Canonical owner |
| --- | --- | --- |
| `disabled` | no Kubernetes object | EC2 |
| `shadow` | Keeper, ClickHouse, Kafka Connect, PVCs and NetworkPolicy; no Continuous worker | EC2 |
| `cutover` | shadow resources plus Continuous worker | EKS, only after EC2 quiesce and approved owner transfer |

The checked-in values intentionally contain no sizing. Shadow and cutover require a private values file with every image digest, resource request/limit, storage class/size, termination grace, replica count, Secret reference and network CIDR. The example values are test fixtures, not production recommendations.

The direct StatefulSet topology accepts one Keeper, one ClickHouse server and one Kafka Connect worker. It is a staging/cutover-validation topology and is not HA. Multi-node ClickHouse/Keeper or Kafka Connect failover requires an operator or separately reviewed chart plus load, failure and restore evidence.

## Security and ownership

- ClickHouse TLS/Keeper configuration, six pairwise-distinct account credentials,
  certificate, private key and CA come from ESO-owned Secrets. The StatefulSet
  preserves the image entrypoint's init/re-init contract and stages TLS material into
  a memory-backed volume with the runtime UID; it does not embed password hashes in a
  checked-in `users.xml`.
- Kafka Connect uses the custom digest-pinned image with the ClickHouse sink and AWS MSK IAM auth module.
- `asklake-realtime-v2-connect` preserves the first V2 deployment's dedicated EKS
  Pod Identity and exact topic/group policy. Existing environments set
  `createServiceAccount=false` so Helm does not try to adopt the externally managed
  ServiceAccount; a new environment may set it to `true` with the same stable name.
- Kafka Connect disables the default Kubernetes API token mount. EKS Pod Identity
  supplies its own projected credential token and does not require Kubernetes API access.
- Continuous Worker reuses the Backend image and ServiceAccount identity, but disables
  the Kubernetes API token mount and does not consume its AWS Pod Identity. PostgreSQL
  lease fencing still selects the active loop.
- Continuous Worker consumes the foundation-owned `asklake-runtime` ConfigMap and
  `asklake-backend-runtime` Secret used by the live FastAPI/V1 worker; the data-plane
  release does not create or rename either object.
- NetworkPolicy requires explicit MSK, RDS and Pod Identity agent CIDRs. MSK and the
  Pod Identity agent are reachable only by Kafka Connect; the V2 Continuous SQL worker
  can reach only RDS, ClickHouse, Kafka Connect and DNS.
- `cutover` refuses to render unless the legacy EC2 `all` process is fenced,
  transfer is approved, the Continuous SQL owner is `eks-continuous-worker-v2`,
  and a generation is explicit. Kafka reconciliation remains owned by the
  existing EKS Realtime V1 `kafka` worker, so cutover requires
  `ec2KafkaOwnerReady=false` and `realtimeV1Fenced=false`. A split EC2 Kafka
  worker or a fenced/missing V1 fails closed. The V2 worker is pinned to
  `CONTINUOUS_WORKER_SCOPE=continuous_sql`; raw V2 ingestion remains Kafka
  Connect's responsibility while the V1 worker preserves non-V2
  Kafka reconciliation.

The chart does not update `deploy/control-plane-ownership.json`, stop EC2, create Secrets Manager values, create EBS snapshots or apply itself. Those actions belong to one approved owner-transfer release.

## Local verification

```bash
scripts/verify-eks-realtime-data-plane.sh
scripts/verify-eks-workloads.sh
```

The authorized live procedure is `docs/eks-clickhouse-realtime-gold-runbook.md`.
