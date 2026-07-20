# EKS Realtime Kafka V2 live deployment attempt

Issue #1084, branch `feat-#1084`, revision `f2694e4c1843faa54f3f2fd551f4579f9dc78346`.

## AWS discovery

- AWS credentials and EKS access were verified read-only.
- Target cluster/context: `asklake-dev` in `ap-northeast-2`.
- Target namespace: `asklake-dev`.
- Before this attempt, V2 workload replicas were zero and the runtime remained fail-closed (`external_ec2`, V2 API disabled).

## Image publication

The current branch images were built for `linux/amd64` and published with immutable tag `git-f2694e4c` to the existing development ECR repositories for ClickHouse V2, Kafka Connect V2, and the backend. The exact digest evidence is retained in [the deployment receipt](../deploy/eks-realtime-kafka-v2-deployment-attempt-receipt.json); no credentials or account identifiers are recorded.

## Preflight result

Static contract checks, receipt verification, Helm lint/render, and ExternalSecret contract checks passed. The live preflight then stopped because the required `kafka-connect-v2` Service was not present in `asklake-dev`.

No Helm apply, rollout, owner transfer, or runtime flag change was performed. This is a deployment blocker, not a successful production rollout. The next safe step is to provision/apply the canonical V2 Service and its referenced Secret/ExternalSecret resources, then rerun the same preflight before any apply.
