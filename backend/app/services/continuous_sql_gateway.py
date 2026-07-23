from __future__ import annotations

import hashlib
import json
from typing import Any, Protocol

from fastapi import status

from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.models.continuous_sql import ContinuousSqlJobModel, ContinuousSqlRunModel
from app.schemas.continuous_sql import continuous_sql_serving_mode
from app.services.clickhouse_continuous_sql import ClickHouseContinuousSqlWorkerGateway
from app.services.clickhouse_realtime_v2 import ClickHouseRealtimeV2WorkerGateway
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
        if str(plan.get("executionInputMode") or "legacy_kafka") == "dataset_revision":
            # Do not silently fall through to the historical Kafka runner:
            # that would create a SQL-owned consumer and break the execution
            # tree's single-producer ownership guarantee.  A revision runner
            # is selected by the routed gateway in the next implementation
            # step; keeping this guard here protects old deployments that
            # instantiate NodeContinuousSqlWorkerGateway directly.
            raise ApiError(
                "CONTINUOUS_SQL_REVISION_RUNNER_REQUIRED",
                "Dataset-revision Continuous SQL requires the revision transform runner; "
                "the legacy Kafka worker is not permitted for this Job.",
                status.HTTP_409_CONFLICT,
            )
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
                "maxOffsetsPerTrigger": source.get("maxOffsetsPerTrigger") or 100,
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
        clickhouse_gateway: ContinuousSqlWorkerGateway | None = None,
        clickhouse_v2_gateway: ContinuousSqlWorkerGateway | None = None,
    ) -> None:
        resolved_settings = runtime_settings or settings
        self.settings = resolved_settings
        self.iceberg_gateway = iceberg_gateway or NodeContinuousSqlWorkerGateway()
        self.clickhouse_gateway = clickhouse_gateway or ClickHouseContinuousSqlWorkerGateway(
            resolved_settings
        )
        self.clickhouse_v2_gateway = (
            clickhouse_v2_gateway
            or ClickHouseRealtimeV2WorkerGateway(resolved_settings)
        )

    def manage(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel | None,
        action: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if continuous_sql_serving_mode(job) != "clickhouse":
            gateway = self.iceberg_gateway
        elif (
            self.settings.clickhouse_realtime_v2_enabled
            and self.settings.kafka_connect_sink_enabled
            and self.settings.clickhouse_realtime_consumer_owner == "kafka_connect_v2"
        ):
            gateway = self.clickhouse_v2_gateway
        else:
            gateway = self.clickhouse_gateway
        return gateway.manage(job, run, action, options)


def canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
