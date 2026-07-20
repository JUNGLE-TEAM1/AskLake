from __future__ import annotations

import hashlib
import json
from typing import Any, Protocol

from app.core.config import Settings
from app.models.continuous_sql import ContinuousSqlJobModel, ContinuousSqlRunModel
from app.services.node_bridge import run_node_bridge


class ContinuousSqlWorkerGateway(Protocol):
    def manage(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel | None,
        action: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...


class NodeContinuousSqlWorkerGateway:
    def manage(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel | None,
        action: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        plan = dict(job.compiled_plan or {})
        source = plan.get("streamingSource") if isinstance(plan.get("streamingSource"), dict) else {}
        runtime_plan = {
            **plan,
            "runGeneration": int(run.generation if run is not None else job.generation),
            "fencingToken": str(run.fencing_token if run is not None else job.fencing_token or ""),
            "staticBindings": list(run.static_bindings or []) if run is not None else [],
        }
        rule_fingerprint = canonical_hash({"contractVersion": "1.0", "rules": []})
        return run_node_bridge(
            "manage-kafka-continuous.mjs",
            "ASKLAKE_KAFKA_CONTINUOUS_RESULT",
            {
                "action": action,
                "broker": source.get("broker"),
                "checkpointPath": job.checkpoint_path,
                "consumerGroupId": source.get("consumerGroupId"),
                "continuousSqlPlan": runtime_plan,
                "icebergTarget": job.output_target,
                "initialCounts": {},
                "initialMetrics": {
                    "continuousSqlGeneration": runtime_plan["runGeneration"],
                    "continuousSqlPlanHash": job.plan_hash,
                },
                "initialOffsetPolicy": source.get("initialOffsetPolicy") or "earliest",
                "initialSchemaState": {},
                "jobId": job.id,
                "maxOffsetsPerTrigger": source.get("maxOffsetsPerTrigger") or 10_000,
                "outputPath": job.output_storage_path,
                "recordParsing": source.get("recordParsing") or {},
                "ruleContractVersion": "1.0",
                "ruleFingerprint": rule_fingerprint,
                "ruleOutputSchema": plan.get("outputSchema") or [],
                "rules": [],
                "schemaColumns": source.get("schemaColumns") or [],
                "schemaEvolutionPolicy": {
                    "additiveNullable": "allow",
                    "missingRequired": "pause",
                    "incompatibleType": "pause",
                    "unknownField": "preserve",
                },
                "schemaFingerprint": source.get("schemaFingerprint") or "",
                "streamPartitionCursors": [],
                "topic": source.get("topic"),
                "triggerIntervalSeconds": int(job.trigger_interval_seconds),
                **(options or {}),
            },
            error_marker="ASKLAKE_KAFKA_CONTINUOUS_ERROR",
            timeout_seconds=90 if action == "start" else 20,
        )


class RoutedContinuousSqlWorkerGateway:
    def __init__(
        self,
        runtime_settings: Settings | None = None,
        *,
        iceberg_gateway: ContinuousSqlWorkerGateway | None = None,
    ) -> None:
        del runtime_settings
        self.iceberg_gateway = iceberg_gateway or NodeContinuousSqlWorkerGateway()

    def manage(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel | None,
        action: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.iceberg_gateway.manage(job, run, action, options)


def canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
