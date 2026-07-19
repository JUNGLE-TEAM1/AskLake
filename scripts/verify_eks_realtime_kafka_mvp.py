#!/usr/bin/env python3
"""Validate the selected-but-disabled EKS Realtime Kafka MVP contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTRACT = ROOT / "deploy/eks-realtime-kafka-mvp.json"
CANDIDATES = {"v1-spark-structured-streaming", "v2-kafka-connect-clickhouse"}
IDENTITY_FIELDS = {
    "brokerIdentity",
    "topic",
    "consumerGroup",
    "generation",
    "checkpointIdentity",
}


def load_contract(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("EKS Realtime Kafka contract must be a JSON object")
    return payload


def _mapping(value: object, field: str, errors: list[str]) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        errors.append(f"{field} must be an object")
        return {}
    return value


def _string_list(value: object, field: str, errors: list[str], *, allow_empty: bool = False) -> list[str]:
    if not isinstance(value, list) or (not value and not allow_empty):
        errors.append(f"{field} must be a {'possibly empty ' if allow_empty else 'non-empty '}string list")
        return []
    if not all(isinstance(item, str) and item.strip() for item in value):
        errors.append(f"{field} must contain only non-empty strings")
        return []
    normalized = [item.strip() for item in value]
    if len(normalized) != len(set(normalized)):
        errors.append(f"{field} contains duplicate values")
    return normalized


def _repository_reference(root: Path, reference: str, field: str, errors: list[str]) -> None:
    file_name, separator, marker = reference.partition("::")
    if not separator or not file_name or not marker:
        errors.append(f"{field} must use path::marker")
        return
    candidate = (root / file_name).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        errors.append(f"{field} escapes the repository")
        return
    if not candidate.is_file():
        errors.append(f"{field} file does not exist: {file_name}")
        return
    if marker not in candidate.read_text(encoding="utf-8", errors="replace"):
        errors.append(f"{field} marker is missing: {reference}")


def validate_contract(contract: Mapping[str, Any], *, root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    if contract.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    if contract.get("issue") != 1044:
        errors.append("issue must be 1044")
    if contract.get("phase") != "v1-static-foundation-complete":
        errors.append("phase must describe the completed V1 static foundation")

    baseline = _mapping(contract.get("baseline"), "baseline", errors)
    if baseline.get("branch") != "pair1":
        errors.append("baseline.branch must be pair1")
    if baseline.get("commit") != "a782ab7aee560df8c68b4e64452a8d00e415d8ab":
        errors.append("baseline.commit must match the Issue #1044 pair1 baseline")

    decision = _mapping(contract.get("decision"), "decision", errors)
    if decision.get("status") != "decided":
        errors.append("decision.status must be decided")
    if decision.get("selectedPath") != "v1-spark-structured-streaming":
        errors.append("selectedPath must be the evidence-backed V1 MVP")
    if decision.get("activationAllowed") is not False:
        errors.append("path selection must not enable EKS activation")

    evidence = _mapping(contract.get("decisionEvidence"), "decisionEvidence", errors)
    expected_inventory = {
        "observationMode": "read-only-sanitized-inventory",
        "runtimeBoundary": "external_ec2",
        "eksClusterCount": 1,
        "mskServerlessClusterCount": 1,
        "runningEc2InstanceCount": 1,
        "eksContinuousWorkerCount": 0,
        "eksKafkaConnectClickHouseKeeperCount": 0,
        "sparkApplicationCrdPresent": True,
        "sparkPodIdentityAssociationCount": 1,
        "mskSmokePodIdentityAssociationCount": 1,
        "completedBoundedSparkApplicationCount": 3,
        "continuousSparkApplicationCount": 0,
        "containsSensitiveIdentifiers": False,
    }
    for field, expected in expected_inventory.items():
        if evidence.get(field) != expected:
            errors.append(f"decisionEvidence.{field} must equal the sanitized decision observation")

    candidates = contract.get("candidates")
    seen: set[str] = set()
    if not isinstance(candidates, list) or len(candidates) != 2:
        errors.append("candidates must contain exactly V1 and V2")
        candidates = []
    for index, candidate_value in enumerate(candidates):
        candidate = _mapping(candidate_value, f"candidates[{index}]", errors)
        identifier = str(candidate.get("id") or "")
        if identifier not in CANDIDATES or identifier in seen:
            errors.append(f"candidates[{index}].id is unknown or duplicated")
        seen.add(identifier)
        if candidate.get("enabled") is not False:
            errors.append(f"candidate {identifier or index} must remain disabled before owner transfer")
        if candidate.get("eksReadiness") not in {"partial", "insufficient"}:
            errors.append(f"candidate {identifier or index} has invalid eksReadiness")
        if not str(candidate.get("recommendation") or "").strip():
            errors.append(f"candidate {identifier or index} recommendation is required")
        _string_list(candidate.get("durableState"), f"candidates[{index}].durableState", errors)
        _string_list(candidate.get("openGates"), f"candidates[{index}].openGates", errors)
        evidence = _string_list(candidate.get("evidence"), f"candidates[{index}].evidence", errors)
        for evidence_index, reference in enumerate(evidence):
            _repository_reference(root, reference, f"candidates[{index}].evidence[{evidence_index}]", errors)
    if seen != CANDIDATES:
        errors.append("candidates must include the exact V1 and V2 identifiers")

    ownership = _mapping(contract.get("ownership"), "ownership", errors)
    if ownership.get("policy") != "exactly-one":
        errors.append("ownership.policy must be exactly-one")
    identity_fields = set(_string_list(ownership.get("identityFields"), "ownership.identityFields", errors))
    if identity_fields != IDENTITY_FIELDS:
        errors.append("ownership.identityFields must fix broker/topic/group/generation/checkpoint identity")
    if ownership.get("currentOwner") != "ec2-continuous-worker":
        errors.append("currentOwner must remain ec2-continuous-worker before transfer")
    if ownership.get("proposedOwner") != "eks-continuous-worker-v1":
        errors.append("proposedOwner must be the selected EKS V1 worker")
    if ownership.get("transferState") != "blocked":
        errors.append("ownership transferState must remain blocked")
    claims = _string_list(ownership.get("activeClaims"), "ownership.activeClaims", errors)
    if claims != ["ec2-continuous-worker"]:
        errors.append("exactly one EC2 active claim is required before transfer")

    runtime = _mapping(contract.get("runtimeIdentity"), "runtimeIdentity", errors)
    if runtime.get("brokerKind") != "msk-serverless" or runtime.get("authentication") != "iam":
        errors.append("runtimeIdentity must require MSK Serverless IAM")
    if runtime.get("generation") != "assigned-only-at-approved-owner-transfer":
        errors.append("generation must be assigned only at approved owner transfer")
    if runtime.get("checkpointIdentity") != "s3-prefix-derived-from-job-target-and-generation":
        errors.append("checkpointIdentity must derive from job, target, and generation")
    if runtime.get("isolationRequired") is not True or runtime.get("sharedProductionIdentityAllowed") is not False:
        errors.append("runtime identity must be isolated from shared production")

    durable = _mapping(contract.get("durableState"), "durableState", errors)
    if durable.get("controlPlane") != "postgresql" or durable.get("runtimeDocuments") != "private-s3-prefix":
        errors.append("durableState must keep PostgreSQL control state and private S3 runtime documents")
    if durable.get("selectedCheckpointAuthority") != "s3-structured-streaming-checkpoint":
        errors.append("V1 checkpoint authority must be the S3 Structured Streaming checkpoint")
    if durable.get("localFilesystemAuthoritative") is not False:
        errors.append("local filesystem must not be authoritative")
    required_keys = set(_string_list(durable.get("requiredKeys"), "durableState.requiredKeys", errors))
    if not {"owner", "generation", "fencingToken", "sourceOffsets", "evidenceReference"}.issubset(required_keys):
        errors.append("durableState.requiredKeys is missing fencing or evidence identity")

    implementation = _mapping(contract.get("implementation"), "implementation", errors)
    expected_implementation = {
        "status": "static-foundation",
        "workloadPackage": "infra/eks/helm/asklake-workloads/templates/realtime-v1-worker.yaml",
        "defaultEnabled": False,
        "controlPlaneScope": "kafka",
        "legacyEc2DefaultScope": "all",
        "ownerClaimAuthority": "postgresql-kafka-continuous-runtime-metrics",
        "ownerClaimKey": "ownerClaim",
        "ownerClaimRequiredForEks": True,
        "runtimeDocumentPrefix": "continuous-runtime",
        "checkpointPrefix": "checkpoints",
        "sparkServiceAccount": "asklake-spark",
        "workerServiceAccount": "asklake-backend",
    }
    for field, expected in expected_implementation.items():
        if implementation.get(field) != expected:
            errors.append(f"implementation.{field} must match the selected V1 static foundation")
    expected_msk_actions = {
        "kafka-cluster:Connect",
        "kafka-cluster:DescribeTopic",
        "kafka-cluster:ReadData",
        "kafka-cluster:DescribeGroup",
        "kafka-cluster:AlterGroup",
    }
    if set(_string_list(implementation.get("mskIamActions"), "implementation.mskIamActions", errors)) != expected_msk_actions:
        errors.append("implementation.mskIamActions must be the exact V1 consumer action set")
    implementation_evidence = _string_list(
        implementation.get("evidence"), "implementation.evidence", errors
    )
    for evidence_index, reference in enumerate(implementation_evidence):
        _repository_reference(
            root,
            reference,
            f"implementation.evidence[{evidence_index}]",
            errors,
        )

    live = _mapping(contract.get("liveReadiness"), "liveReadiness", errors)
    expected_live = {
        "observationMode": "read-only-sanitized-iam-policy",
        "sparkPodIdentityAssociationCount": 1,
        "backendPodIdentityAssociationCount": 1,
        "sparkHasExactConsumerActions": True,
        "sparkRealtimeIdentityActionsReady": False,
        "sparkHasBroadActionOrResource": True,
        "sparkRealtimeTopicResourceCount": 0,
        "sparkRealtimeGroupResourceCount": 0,
        "backendHasBroadActionOrResource": True,
        "backendContinuousRuntimeResourceCount": 0,
        "backendRuntimeListPrefixReady": False,
        "permissionsBoundaryPresent": False,
        "targetRolePresent": False,
        "relatedExplicitDenyPresent": False,
        "activationReady": False,
        "containsSensitiveIdentifiers": False,
    }
    for field, expected in expected_live.items():
        if live.get(field) != expected:
            errors.append(f"liveReadiness.{field} must preserve the sanitized fail-closed observation")
    if len(_string_list(live.get("blockingReasons"), "liveReadiness.blockingReasons", errors)) != 5:
        errors.append("liveReadiness must retain all five IAM blockers")

    rollout = _mapping(contract.get("rolloutPlan"), "rolloutPlan", errors)
    if rollout.get("status") != "blocked-on-shared-infrastructure-and-owner-transfer":
        errors.append("rolloutPlan.status must remain blocked before live IAM and owner transfer")
    if rollout.get("executionMode") != "approved-manual-only":
        errors.append("rolloutPlan.executionMode must require explicit manual approval")
    if rollout.get("receiptAuthority") != "private-s3-continuous-runtime-prefix":
        errors.append("rolloutPlan.receiptAuthority must be the private durable runtime prefix")
    canary = _mapping(rollout.get("canary"), "rolloutPlan.canary", errors)
    if canary.get("sharedProductionIdentityAllowed") is not False:
        errors.append("rollout canary must not reuse a production identity")
    if canary.get("consumerGroupTemplate") != "asklake-eks-realtime-v1-<generation>":
        errors.append("rollout canary group must match the exact V1 IAM group prefix")
    if canary.get("checkpointTemplate") != "checkpoints/<jobId>/<targetId>/<generation>":
        errors.append("rollout canary checkpoint must be generation-scoped")
    if canary.get("newGenerationRequired") is not True:
        errors.append("rollout canary must require a new generation")
    expected_stages = [
        "record-preflight-inventory-and-current-ec2-claim",
        "apply-exact-msk-group-and-runtime-document-iam",
        "prove-isolated-canary-consume-checkpoint-and-restart",
        "approve-owner-transfer-and-assign-new-generation",
        "set-ec2-worker-scope-to-continuous-sql-and-prove-zero-kafka-claim",
        "activate-single-eks-kafka-worker-and-record-claim",
        "compare-offset-count-checkpoint-and-publication-evidence",
        "close-transfer-receipt-or-run-ordered-rollback",
    ]
    if _string_list(rollout.get("orderedStages"), "rolloutPlan.orderedStages", errors) != expected_stages:
        errors.append("rolloutPlan.orderedStages must preserve the exact fence-before-activate order")
    required_receipts = set(
        _string_list(rollout.get("requiredReceipts"), "rolloutPlan.requiredReceipts", errors)
    )
    if not {
        "owner-generation-and-fencing-token",
        "source-offsets-before-and-after-restart",
        "input-stored-quarantine-counts",
        "iceberg-snapshot-manifest-and-catalog-ack-reference",
    }.issubset(required_receipts):
        errors.append("rolloutPlan.requiredReceipts is missing ownership or data-plane evidence")
    success_criteria = set(
        _string_list(rollout.get("successCriteria"), "rolloutPlan.successCriteria", errors)
    )
    if not {
        "exactly-one-active-owner-claim",
        "no-offset-regression-after-restart",
        "no-duplicate-publication-for-the-same-source-boundary",
        "durable-receipt-readable-after-pod-replacement",
    }.issubset(success_criteria):
        errors.append("rolloutPlan.successCriteria is missing exact-one or durable recovery proof")

    rollback = _mapping(contract.get("rollback"), "rollback", errors)
    if rollback.get("targetOwner") != "ec2-continuous-worker" or rollback.get("automatic") is not False:
        errors.append("rollback must be manual and target the preserved EC2 owner")
    forbidden = set(_string_list(rollback.get("forbidden"), "rollback.forbidden", errors))
    required_forbidden = {
        "delete-or-rewind-checkpoint-to-force-recovery",
        "reuse-generation-across-owner-transfer",
        "run-ec2-and-eks-owners-concurrently",
        "automatic-cross-engine-fallback-for-the-same-run",
    }
    if not required_forbidden.issubset(forbidden):
        errors.append("rollback.forbidden is missing a safety invariant")
    if len(_string_list(rollback.get("orderedInvariants"), "rollback.orderedInvariants", errors)) < 6:
        errors.append("rollback.orderedInvariants must preserve the full fence-to-verify order")

    gates = _mapping(contract.get("gates"), "gates", errors)
    expected_gates = {
        "pathDecisionRecorded",
        "ownerTransferApproved",
        "mskIamLiveEvidence",
        "durableRestartEvidence",
        "rollbackRehearsalEvidence",
        "sharedAwsApplyAllowed",
    }
    if set(gates) != expected_gates:
        errors.append("all activation gates must exist")
    elif gates.get("pathDecisionRecorded") is not True or any(
        gates.get(name) is not False for name in expected_gates - {"pathDecisionRecorded"}
    ):
        errors.append("only pathDecisionRecorded may be true before implementation and live evidence")
    return sorted(set(errors))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    path = args.contract.resolve()
    errors = validate_contract(load_contract(path), root=args.root.resolve())
    result = {"contract": str(path), "errors": errors, "status": "fail" if errors else "pass"}
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
