# AskLake EKS Realtime Data Plane

This chart is an opt-in, separate Helm release for ClickHouse Realtime V2. It does not extend the stateless `asklake-workloads` release with PVC ownership.

## Modes

| Mode | Rendered runtime | Canonical owner |
| --- | --- | --- |
| `disabled` | no Kubernetes object | EC2 |
| `shadow` | Keeper, ClickHouse, Kafka Connect, PVCs and NetworkPolicy; no Continuous worker | EC2 |
| `cutover` | shadow resources plus Continuous worker | EKS, only after EC2 quiesce and approved owner transfer |

The checked-in values intentionally contain no sizing. Shadow and cutover require a private values file with every image digest, resource request/limit, storage class/size, termination grace, replica count, Secret reference and network CIDR. The example values are test fixtures, not production recommendations.

The direct StatefulSet topology accepts one Keeper, one ClickHouse server and one Kafka Connect worker. It is a staging/cutover-validation topology and is not HA. Multi-node ClickHouse/Keeper or Kafka Connect failover requires an operator or separately reviewed chart plus load, failure and restore evidence.

## Security and ownership

- ClickHouse configuration, six role identities, certificate, private key and CA come from ESO-owned Secrets.
- Kafka Connect uses the custom digest-pinned image with the ClickHouse sink and AWS MSK IAM auth module.
- `asklake-kafka-connect-v2` uses a dedicated EKS Pod Identity with exact topic and group ARNs.
- Continuous Worker reuses the Backend image and `asklake-backend` Pod Identity. PostgreSQL lease fencing still selects the active loop.
- NetworkPolicy requires explicit MSK, RDS, AWS API, Kubernetes API and Pod Identity agent CIDRs.
- `cutover` refuses to render unless the legacy EC2 `all` process and Realtime V1 are fenced, a replacement EC2 `kafka` scope owner is ready, transfer is approved, the Continuous SQL owner is `eks-continuous-worker-v2`, and a generation is explicit. The V2 worker is pinned to `CONTINUOUS_WORKER_SCOPE=continuous_sql`; raw V2 ingestion remains Kafka Connect's responsibility while the split EC2 worker preserves non-V2 Kafka reconciliation.

The chart does not update `deploy/control-plane-ownership.json`, stop EC2, create Secrets Manager values, create EBS snapshots or apply itself. Those actions belong to one approved owner-transfer release.

## Local verification

```bash
scripts/verify-eks-realtime-data-plane.sh
scripts/verify-eks-workloads.sh
```

The authorized live procedure is `docs/eks-clickhouse-realtime-gold-runbook.md`.
