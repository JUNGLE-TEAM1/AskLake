#!/usr/bin/env python3
"""Read-only, identifier-free EKS Realtime V1 Pod Identity IAM observation."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any, Callable, Iterable, Mapping


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTRACT = ROOT / "deploy/eks-realtime-kafka-mvp.json"
CONSUMER_ACTIONS = {
    "kafka-cluster:Connect",
    "kafka-cluster:DescribeTopic",
    "kafka-cluster:ReadData",
    "kafka-cluster:DescribeGroup",
    "kafka-cluster:AlterGroup",
}
TOPIC_RE = re.compile(r":topic/[^/]+/[^/]+/asklake\.eks-realtime\.fixture\.[^/*]+$")
GROUP_RE = re.compile(r":group/[^/]+/[^/]+/asklake-eks-realtime-v1-[^/*]+$")
RUNTIME_RE = re.compile(r"^arn:[^:]+:s3:::[^/]+/continuous-runtime/\*$")
SAFE_S3_PREFIX_RE = re.compile(r"^arn:[^:]+:s3:::[^/*]+/.+/\*$")


class ObservationError(RuntimeError):
    pass


def _items(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def allow_statements(documents: Iterable[Mapping[str, Any]]) -> Iterable[Mapping[str, Any]]:
    for document in documents:
        statements = document.get("Statement", [])
        if isinstance(statements, Mapping):
            statements = [statements]
        if isinstance(statements, list):
            for statement in statements:
                if isinstance(statement, Mapping) and statement.get("Effect") == "Allow":
                    yield statement


def all_statements(documents: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    result: list[Mapping[str, Any]] = []
    for document in documents:
        statements = document.get("Statement", [])
        if isinstance(statements, Mapping):
            statements = [statements]
        if isinstance(statements, list):
            result.extend(statement for statement in statements if isinstance(statement, Mapping))
    return result


def _action_resources(statements: Iterable[Mapping[str, Any]]) -> dict[str, set[str]]:
    mapped: dict[str, set[str]] = {}
    for statement in statements:
        if statement.get("Effect") != "Allow" or "NotAction" in statement or "NotResource" in statement:
            continue
        resources = set(_items(statement.get("Resource")))
        for action in _items(statement.get("Action")):
            mapped.setdefault(action, set()).update(resources)
    return mapped


def _kafka_identity(resource: str, kind: str, prefix: str) -> tuple[str, str] | None:
    match = re.fullmatch(
        rf"(arn:[^:]+:kafka:[^:]+:[0-9]{{12}}):{kind}/([^/]+/[^/]+)/{re.escape(prefix)}([^/*]+)",
        resource,
    )
    return (f"{match.group(1)}:cluster/{match.group(2)}", match.group(3)) if match else None


def _runtime_list_prefix_ready(statements: list[Mapping[str, Any]], object_arn: str | None) -> bool:
    match = re.fullmatch(r"(arn:[^:]+:s3:::[^/]+)/(.+)/\*", str(object_arn or ""))
    if match is None:
        return False
    bucket_arn, prefix = match.groups()
    for statement in statements:
        if statement.get("Effect") != "Allow" or "s3:ListBucket" not in _items(statement.get("Action")):
            continue
        if bucket_arn not in _items(statement.get("Resource")):
            continue
        condition = statement.get("Condition")
        string_like = condition.get("StringLike", {}) if isinstance(condition, Mapping) else {}
        prefixes = _items(string_like.get("s3:prefix")) if isinstance(string_like, Mapping) else []
        if prefix in prefixes and f"{prefix}/*" in prefixes:
            return True
    return False


def summarize_readiness(
    *,
    spark_associations: int,
    backend_associations: int,
    spark_documents: Iterable[Mapping[str, Any]],
    backend_documents: Iterable[Mapping[str, Any]],
    spark_permissions_boundary: bool = False,
    backend_permissions_boundary: bool = False,
    target_role_present: bool = False,
    expected_generation: str | None = None,
    expected_runtime_object_arn: str | None = None,
) -> dict[str, Any]:
    spark_all = all_statements(spark_documents)
    backend_all = all_statements(backend_documents)
    spark = list(statement for statement in spark_all if statement.get("Effect") == "Allow")
    backend = list(statement for statement in backend_all if statement.get("Effect") == "Allow")
    spark_actions = {action for statement in spark for action in _items(statement.get("Action"))}
    spark_resources = {resource for statement in spark for resource in _items(statement.get("Resource"))}
    backend_actions = {action for statement in backend for action in _items(statement.get("Action"))}
    backend_resources = {resource for statement in backend for resource in _items(statement.get("Resource"))}

    def broad(actions: set[str], resources: set[str], statements: list[Mapping[str, Any]]) -> bool:
        return any(action == "*" or action.endswith(":*") for action in actions) or any(
            resource == "*"
            or ("*" in resource and SAFE_S3_PREFIX_RE.match(resource) is None)
            for resource in resources
        ) or any("NotAction" in statement or "NotResource" in statement for statement in statements)

    action_resources = _action_resources(spark_all)
    topic_identities = {
        identity for resource in action_resources.get("kafka-cluster:DescribeTopic", set())
        & action_resources.get("kafka-cluster:ReadData", set())
        if (identity := _kafka_identity(resource, "topic", "asklake.eks-realtime.fixture.")) is not None
    }
    group_identities = {
        identity for resource in action_resources.get("kafka-cluster:DescribeGroup", set())
        & action_resources.get("kafka-cluster:AlterGroup", set())
        if (identity := _kafka_identity(resource, "group", "asklake-eks-realtime-v1-")) is not None
    }
    paired = topic_identities & group_identities
    if expected_generation is not None:
        paired = {identity for identity in paired if identity[1] == expected_generation}
    connected_clusters = action_resources.get("kafka-cluster:Connect", set())
    paired = {identity for identity in paired if identity[0] in connected_clusters}
    topic_count = len({identity for identity in topic_identities if expected_generation is None or identity[1] == expected_generation})
    group_count = len({identity for identity in group_identities if expected_generation is None or identity[1] == expected_generation})
    runtime_resources = _action_resources(backend_all)
    runtime_candidates = (
        {expected_runtime_object_arn} if expected_runtime_object_arn else {resource for resource in backend_resources if RUNTIME_RE.match(resource)}
    )
    runtime_count = sum(
        resource in runtime_resources.get("s3:GetObject", set())
        and resource in runtime_resources.get("s3:PutObject", set())
        and resource in runtime_resources.get("s3:DeleteObject", set())
        for resource in runtime_candidates
    )
    runtime_list_ready = _runtime_list_prefix_ready(backend_all, expected_runtime_object_arn)
    explicit_deny = any(
        statement.get("Effect") == "Deny"
        and any(action == "*" or action.endswith(":*") or action in CONSUMER_ACTIONS or action.startswith("s3:") for action in _items(statement.get("Action")))
        for statement in [*spark_all, *backend_all]
    )
    spark_broad = broad(spark_actions, spark_resources, spark_all)
    backend_broad = broad(backend_actions, backend_resources, backend_all)
    exact_actions = CONSUMER_ACTIONS.issubset(spark_actions)
    identity_actions_ready = bool(paired)

    blockers: list[str] = []
    if spark_associations != 1:
        blockers.append("Spark Pod Identity association count is not exactly one")
    if backend_associations != 1:
        blockers.append("Backend Pod Identity association count is not exactly one")
    if not exact_actions:
        blockers.append("missing exact MSK consumer action set")
    if spark_broad:
        blockers.append("Spark policy has broad action or resource")
    if topic_count == 0:
        blockers.append("missing exact generation-scoped MSK topic resource")
    if group_count == 0:
        blockers.append("missing exact generation-scoped MSK consumer-group resource")
    if topic_count > 0 and group_count > 0 and not identity_actions_ready:
        blockers.append("MSK topic/group generation, cluster, or action-resource mapping mismatch")
    if backend_broad:
        blockers.append("Backend policy has broad action or resource")
    if runtime_count == 0:
        blockers.append("missing Backend continuous-runtime S3 resource")
    elif expected_runtime_object_arn is not None and not runtime_list_ready:
        blockers.append("missing exact Backend continuous-runtime ListBucket prefix")
    if explicit_deny:
        blockers.append("related explicit Deny requires effective-policy evaluation")
    if spark_permissions_boundary or backend_permissions_boundary:
        blockers.append("permissions boundary requires separate effective-policy evaluation")
    if target_role_present:
        blockers.append("Pod Identity target role requires separate effective-policy evaluation")

    return {
        "observationMode": "read-only-sanitized-iam-policy",
        "sparkPodIdentityAssociationCount": spark_associations,
        "backendPodIdentityAssociationCount": backend_associations,
        "sparkHasExactConsumerActions": exact_actions,
        "sparkRealtimeIdentityActionsReady": identity_actions_ready,
        "sparkHasBroadActionOrResource": spark_broad,
        "sparkRealtimeTopicResourceCount": topic_count,
        "sparkRealtimeGroupResourceCount": group_count,
        "backendHasBroadActionOrResource": backend_broad,
        "backendContinuousRuntimeResourceCount": runtime_count,
        "backendRuntimeListPrefixReady": runtime_list_ready,
        "permissionsBoundaryPresent": spark_permissions_boundary or backend_permissions_boundary,
        "targetRolePresent": target_role_present,
        "relatedExplicitDenyPresent": explicit_deny,
        "activationReady": not blockers,
        "blockingReasons": blockers,
        "containsSensitiveIdentifiers": False,
    }


class AwsReader:
    def __init__(self, region: str, runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run):
        self.region = region
        self.runner = runner

    def json(self, *arguments: str) -> dict[str, Any]:
        result = self.runner(
            ["aws", "--region", self.region, *arguments, "--output", "json", "--no-cli-pager"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise ObservationError(f"aws command failed: {' '.join(arguments[:2])}")
        payload = json.loads(result.stdout)
        if not isinstance(payload, dict):
            raise ObservationError("aws command returned a non-object")
        return payload

    def cluster_name(self, explicit: str | None) -> str:
        if explicit:
            return explicit
        clusters = self.json("eks", "list-clusters").get("clusters", [])
        if not isinstance(clusters, list) or len(clusters) != 1 or not isinstance(clusters[0], str):
            raise ObservationError("exactly one EKS cluster is required when --cluster-name is omitted")
        return clusters[0]

    def service_account_policies(self, cluster: str, namespace: str, service_account: str) -> tuple[int, list[dict[str, Any]], bool, bool]:
        associations = self.json(
            "eks", "list-pod-identity-associations", "--cluster-name", cluster,
            "--namespace", namespace, "--service-account", service_account,
        ).get("associations", [])
        if not isinstance(associations, list) or len(associations) != 1:
            return len(associations) if isinstance(associations, list) else 0, [], False, False
        association_id = associations[0].get("associationId") if isinstance(associations[0], Mapping) else None
        if not isinstance(association_id, str):
            raise ObservationError("Pod Identity association id is missing")
        association = self.json(
            "eks", "describe-pod-identity-association", "--cluster-name", cluster,
            "--association-id", association_id,
        ).get("association", {})
        role_arn = association.get("roleArn") if isinstance(association, Mapping) else None
        target_role = isinstance(association, Mapping) and bool(association.get("targetRoleArn"))
        if not isinstance(role_arn, str) or "/" not in role_arn:
            raise ObservationError("Pod Identity role is missing")
        role_name = role_arn.rsplit("/", 1)[-1]
        role = self.json("iam", "get-role", "--role-name", role_name).get("Role", {})
        boundary = isinstance(role, Mapping) and bool(role.get("PermissionsBoundary"))
        documents: list[dict[str, Any]] = []
        attached = self.json("iam", "list-attached-role-policies", "--role-name", role_name).get("AttachedPolicies", [])
        for policy in attached if isinstance(attached, list) else []:
            arn = policy.get("PolicyArn") if isinstance(policy, Mapping) else None
            if not isinstance(arn, str):
                continue
            version = self.json("iam", "get-policy", "--policy-arn", arn).get("Policy", {}).get("DefaultVersionId")
            document = self.json("iam", "get-policy-version", "--policy-arn", arn, "--version-id", str(version)).get("PolicyVersion", {}).get("Document")
            if isinstance(document, dict):
                documents.append(document)
        inline = self.json("iam", "list-role-policies", "--role-name", role_name).get("PolicyNames", [])
        for name in inline if isinstance(inline, list) else []:
            document = self.json("iam", "get-role-policy", "--role-name", role_name, "--policy-name", str(name)).get("PolicyDocument")
            if isinstance(document, dict):
                documents.append(document)
        return 1, documents, boundary, target_role


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default=os.getenv("AWS_REGION", "ap-northeast-2"))
    parser.add_argument("--cluster-name", default=os.getenv("ASKLAKE_EKS_CLUSTER_NAME"))
    parser.add_argument("--namespace", default="asklake-dev")
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--require-ready", action="store_true")
    parser.add_argument("--expected-generation")
    parser.add_argument("--expected-runtime-object-arn")
    args = parser.parse_args()
    try:
        reader = AwsReader(args.region)
        cluster = reader.cluster_name(args.cluster_name)
        if args.require_ready and (not args.expected_generation or not args.expected_runtime_object_arn):
            raise ObservationError("ready mode requires exact generation and runtime object ARN")
        spark_count, spark_docs, spark_boundary, spark_target = reader.service_account_policies(cluster, args.namespace, "asklake-spark")
        backend_count, backend_docs, backend_boundary, backend_target = reader.service_account_policies(cluster, args.namespace, "asklake-backend")
        report = summarize_readiness(
            spark_associations=spark_count, backend_associations=backend_count,
            spark_documents=spark_docs, backend_documents=backend_docs,
            spark_permissions_boundary=spark_boundary, backend_permissions_boundary=backend_boundary,
            target_role_present=spark_target or backend_target,
            expected_generation=args.expected_generation,
            expected_runtime_object_arn=args.expected_runtime_object_arn,
        )
        expected = json.loads(args.contract.read_text(encoding="utf-8"))["liveReadiness"]
        drift = sorted(key for key, value in expected.items() if report.get(key) != value)
        output = {"status": "drift" if drift else "match", "contractDriftFields": drift, "liveReadiness": report}
        print(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True))
        if args.require_ready and not report["activationReady"]:
            return 1
        return 2 if drift else 0
    except (ObservationError, json.JSONDecodeError, OSError, KeyError):
        print(json.dumps({"status": "observation-error", "containsSensitiveIdentifiers": False}, sort_keys=True))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
