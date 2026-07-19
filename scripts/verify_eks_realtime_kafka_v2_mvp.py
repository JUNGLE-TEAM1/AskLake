#!/usr/bin/env python3
"""Fail-closed static verifier for the Issue #1062 EKS V2 contract."""

from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "deploy" / "eks-realtime-kafka-v2-mvp.json"


def verify(contract: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    decision = contract.get("decision") or {}
    ownership = contract.get("ownership") or {}
    identity = contract.get("runtimeIdentity") or {}
    topology = contract.get("topology") or {}
    iam = contract.get("iam") or {}
    durable = contract.get("durableState") or {}
    implementation = contract.get("implementation") or {}
    preflight = contract.get("livePreflight") or {}
    live = contract.get("liveValidation") or {}
    rollback = contract.get("rollback") or {}
    gates = contract.get("gates") or {}

    if contract.get("issue") != 1062 or contract.get("schemaVersion") != 1:
        errors.append("contract must identify Issue #1062 with schemaVersion 1")
    if decision.get("selectedPath") != "v2-kafka-connect-clickhouse":
        errors.append("selected path must be Kafka Connect to ClickHouse V2")
    if decision.get("selectedTopology") != "single-connect-single-clickhouse-single-keeper-ebs-canary":
        errors.append("Phase 0 must select the bounded single-node EBS canary topology")
    if decision.get("activationAllowed") is not True or decision.get("productionHaClaimAllowed") is not False:
        errors.append("validated isolated activation must be recorded without a production HA claim")
    if ownership.get("policy") != "exactly-one" or ownership.get("productionOwnerUnchanged") is not True:
        errors.append("exact-one ownership and unchanged production ownership are required")
    if identity.get("sharedProductionIdentityAllowed") is not False:
        errors.append("shared production identity must be forbidden")
    templates = [
        identity.get("sourceTopicTemplate"),
        identity.get("consumerGroupTemplate"),
        identity.get("connectWorkerGroupTemplate"),
        identity.get("connectorTemplate"),
        identity.get("dlqTopicTemplate"),
        *((identity.get("connectInternalTopicTemplates") or {}).values()),
    ]
    if any(not isinstance(value, str) or "<generation>" not in value for value in templates):
        errors.append("every Kafka and connector identity must be generation scoped")
    if [topology.get(key) for key in ("kafkaConnectReplicas", "clickhouseReplicas", "keeperReplicas")] != [1, 1, 1]:
        errors.append("canary topology must render exactly one Connect, ClickHouse and Keeper replica")
    if topology.get("sinkTasksMax") != 1:
        errors.append("bounded canary must use exactly one sink task")
    if topology.get("localFilesystemAuthoritative") is not False or topology.get("ha") is not False:
        errors.append("local state and HA claims must remain disabled")
    if topology.get("clickhouseState") != "encrypted-ebs-pvc" or topology.get("keeperState") != "encrypted-ebs-pvc":
        errors.append("ClickHouse and Keeper must use encrypted EBS PVC authority")
    if iam.get("serviceAccount") != "asklake-realtime-v2-connect" or iam.get("wildcardsAllowed") is not False:
        errors.append("V2 Connect requires its dedicated exact IAM identity")
    plugin = iam.get("imagePlugin") or {}
    if (
        iam.get("contractReady") is not True
        or iam.get("applied") is not True
        or iam.get("plannedPodIdentityAssociationCount") != 1
        or iam.get("appliedPodIdentityAssociationCount") != 1
        or iam.get("topicResourceCount") != 5
        or iam.get("groupResourceCount") != 2
    ):
        errors.append("live IAM must retain the exact planned counts and one applied association")
    if (
        plugin.get("version") != "2.3.6"
        or plugin.get("sha256") != "de63517a6275b4f112c0375f9246b2a78e8ad1a8fe88b1d096244bfc11981c08"
        or plugin.get("classpath") != "/usr/share/java/cp-base-new/aws-msk-iam-auth-2.3.6-all.jar"
        or plugin.get("connectPluginPathAllowed") is not False
    ):
        errors.append("MSK IAM auth must be checksum-pinned on the worker classpath outside the Connect plugin path")
    if durable.get("sourceBoundary") != ["topic", "partition", "offset"]:
        errors.append("durable source boundary must be topic, partition and offset")
    if (
        durable.get("contractReady") is not True
        or durable.get("liveRestartProven") is not True
        or durable.get("liveRestoreProven") is not True
        or durable.get("restoreTargetMustBeIsolated") is not True
        or durable.get("recoveryModeConsumerResources") != 0
        or durable.get("backupAuthority") != "paired-csi-volume-snapshot-receipt"
    ):
        errors.append("durable recovery must be isolated and proven by live restart and restore")
    if (
        implementation.get("status") != "live-canary-validated-and-rolled-back"
        or implementation.get("workloadCount") != 4
        or implementation.get("isolatedRecoveryWorkloadCount") != 2
    ):
        errors.append("implementation must record the validated active and recovery workload counts")
    if implementation.get("workloadTemplate") != "infra/eks/helm/asklake-workloads/templates/realtime-v2.yaml":
        errors.append("Phase 1 must use the canonical Helm V2 template")
    if (
        preflight.get("mode") != "read-only"
        or preflight.get("result") != "no-go"
        or preflight.get("observedV1OwnerActive") is not True
        or preflight.get("sharedMutationPerformed") is not False
        or preflight.get("staticRemediationReady") is not True
    ):
        errors.append("Phase 4A must record a read-only no-go preflight with zero shared mutation")
    for observation in (
        "autoModeEncryptedStorageClassObserved",
        "snapshotApiObserved",
        "snapshotControllerObserved",
        "v2ServiceAccountsObserved",
        "v2PodIdentityObserved",
        "v2ImageRepositoriesObserved",
    ):
        if preflight.get(observation) is not False:
            errors.append(f"Phase 4A missing live prerequisite must remain false: {observation}")
    if preflight.get("evidence") != "docs/eks-realtime-kafka-v2-live-preflight.md":
        errors.append("Phase 4A must bind the sanitized live preflight evidence")
    forbidden = set(rollback.get("forbidden") or [])
    if {"automatic-cross-engine-fallback", "run-v1-and-v2-for-the-same-identity"} - forbidden:
        errors.append("rollback must forbid automatic fallback and concurrent V1/V2 ownership")
    if rollback.get("automatic") is not False or rollback.get("newGenerationRequired") is not True:
        errors.append("rollback must be manual and issue a new generation")
    if gates.get("topologyDecisionRecorded") is not True:
        errors.append("topology decision gate must be recorded")
    if gates.get("staticWorkloadContractReady") is not True:
        errors.append("static workload contract gate must be ready after Phase 1")
    for gate in ("mskIamContractReady", "durableRestartContractReady", "backupRestoreContractReady"):
        if gates.get(gate) is not True:
            errors.append(f"Phase 2 static gate {gate} must be ready")
    for gate in ("sharedAwsApplyAllowed", "liveCanaryReady"):
        if gates.get(gate) is not True:
            errors.append(f"validated live gate {gate} must be true")
    if gates.get("productionTransferAllowed") is not False:
        errors.append("production transfer must remain blocked after an isolated canary")

    if (
        live.get("result") != "pass"
        or live.get("receipt") != "deploy/eks-realtime-kafka-v2-receipt.json"
        or any(live.get(key) is not True for key in (
            "ingestProven",
            "restartProven",
            "pairedSnapshotReady",
            "isolatedRestoreProven",
            "rollbackProven",
        ))
        or live.get("productionTransferClaimed") is not False
    ):
        errors.append("live validation must bind a passing receipt without claiming production transfer")

    required_evidence = [
        ROOT / "deploy" / "docker-compose.prod.yml",
        ROOT / "deploy" / "kafka-connect" / "Dockerfile",
        ROOT / "backend" / "app" / "realtime" / "infrastructure" / "kafka_connect_gateway.py",
        ROOT / "infra" / "eks" / "helm" / "asklake-workloads" / "templates" / "realtime-v1-worker.yaml",
        ROOT / "infra" / "eks" / "helm" / "asklake-workloads" / "templates" / "realtime-v2.yaml",
        ROOT / "scripts" / "verify-eks-realtime-v2-workload.sh",
        ROOT / "infra" / "eks" / "terraform" / "workload-identity.tf",
        ROOT / "deploy" / "eks-realtime-kafka-v2-receipt.schema.json",
        ROOT / "deploy" / "eks-realtime-kafka-v2-receipt.json",
        ROOT / "docs" / "eks-realtime-kafka-v2-canary-runbook.md",
        ROOT / "docs" / "eks-realtime-kafka-v2-live-preflight.md",
        ROOT / "infra" / "eks" / "storage" / "realtime-v2-auto-mode.yaml",
        ROOT / "infra" / "eks" / "terraform" / "realtime-v2-storage.tf",
        ROOT / "scripts" / "verify-eks-realtime-v2-storage.py",
        ROOT / "deploy" / "realtime-v2-provenance.json",
    ]
    for path in required_evidence:
        if not path.is_file():
            errors.append(f"missing repository evidence: {path.relative_to(ROOT)}")

    provenance_path = ROOT / "deploy" / "realtime-v2-provenance.json"
    if provenance_path.is_file():
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
        iam_artifacts = [
            artifact
            for artifact in provenance.get("artifacts", [])
            if artifact.get("name") == "aws-msk-iam-auth-2.3.6-all.jar"
        ]
        if len(iam_artifacts) != 1 or iam_artifacts[0].get("sha256") != plugin.get("sha256"):
            errors.append("V2 provenance must contain one MSK IAM auth artifact matching the machine contract")

    dockerfile_path = ROOT / "deploy" / "kafka-connect" / "Dockerfile"
    if dockerfile_path.is_file():
        dockerfile = dockerfile_path.read_text(encoding="utf-8")
        if plugin.get("sha256") not in dockerfile or f"ENV CLASSPATH={plugin.get('classpath')}" not in dockerfile:
            errors.append("Connect Dockerfile must bind the contracted IAM plugin checksum and classpath")

    receipt_path = ROOT / "deploy" / "eks-realtime-kafka-v2-receipt.json"
    if receipt_path.is_file():
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        snapshots = receipt.get("snapshots") or []
        if (
            receipt.get("result") != "pass"
            or receipt.get("generation") != live.get("generation")
            or (receipt.get("iam") or {}).get("associationCount") != 1
            or (receipt.get("restart") or {}).get("offsetRegressions") != 0
            or len(snapshots) != 2
            or any(item.get("readyToUse") is not True for item in snapshots)
            or (receipt.get("isolatedRestore") or {}).get("consumerResourcesRendered") != 0
            or (receipt.get("rollback") or {}).get("v2RunningTasks") != 0
            or (receipt.get("rollback") or {}).get("v2OwnerClaims") != 0
        ):
            errors.append("live receipt must prove IAM, restart, paired restore and zero-owner rollback")
    return errors


def main() -> int:
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    errors = verify(contract)
    print(json.dumps({"contract": str(CONTRACT), "errors": errors, "status": "pass" if not errors else "fail"}, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
