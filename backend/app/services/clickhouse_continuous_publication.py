from __future__ import annotations

from datetime import UTC, datetime
import hashlib
import json
from typing import Any

from sqlalchemy.orm import Session

from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.models.catalog import CatalogDatasetModel
from app.models.continuous_sql import (
    ContinuousSqlBatchModel,
    ContinuousSqlJobModel,
    ContinuousSqlRunModel,
)
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.continuous_sql_repository import ContinuousSqlRepository
from app.repositories.dashboard_live_repository import (
    STREAM_COMMIT_KIND,
    DashboardLiveRepository,
    save_catalog_dataset_and_revision,
)
from app.schemas.continuous_sql import ClickHouseWriterTarget


class ClickHouseContinuousSqlPublicationService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repository = ContinuousSqlRepository(db)
        self.catalog_repository = CatalogRepository(db)
        self.live_repository = DashboardLiveRepository(db, ensure_schema=False)

    def reconcile_progress(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        worker: dict[str, Any],
    ) -> ContinuousSqlBatchModel | None:
        progress = normalize_clickhouse_progress(worker.get("clickhouseOffsets"))
        if not progress:
            return None
        output_row_count = normalize_output_row_count(
            worker.get("clickhouseOutputRowCount"),
            fallback=sum(int(item["rowCount"]) for item in progress),
        )
        topic = str(
            (job.compiled_plan.get("streamingSource") or {}).get("topic") or ""
        ).strip()
        if not topic:
            raise ValueError("ClickHouse publication has no Kafka topic")
        target = ClickHouseWriterTarget.model_validate(job.output_target)
        marker = clickhouse_progress_marker(job, run, progress)
        publication_run_id = f"csqlch_{marker[:32]}"
        if self.repository.lock_job(job.id) is None:
            raise ValueError("ClickHouse Continuous SQL Job disappeared during publication")
        existing_commit = self.live_repository.commit_by_run_id(publication_run_id)
        if existing_commit is not None:
            existing_batch = self.repository.batch_by_output_commit_id(
                job.id,
                run.generation,
                publication_run_id,
            )
            batch_id = (
                int(existing_batch.batch_id)
                if existing_batch is not None
                else self.repository.next_batch_id(job.id, run.generation)
            )
            return self._ready_batch(
                job,
                run,
                batch_id=batch_id,
                publication_run_id=publication_run_id,
                progress=progress,
                source_ranges=list(existing_commit.source_ranges or []),
                revision=int(existing_commit.revision),
                target=target,
            )

        source_ranges = self._new_source_ranges(job.output_dataset_id, topic, progress)
        if not source_ranges:
            return None
        batch_id = self.repository.next_batch_id(job.id, run.generation)
        previous = self.catalog_repository.get_dataset_payload(job.output_dataset_id) or {}
        previous_output_row_count = normalize_output_row_count(
            previous.get("clickhouseOutputRowCount"),
            fallback=0,
        )
        row_count_delta = max(output_row_count - previous_output_row_count, 0)
        manifest = f"{target.table_uri}/_publications/{marker}.json"
        evidence = {
            "batchId": batch_id,
            "generation": int(run.generation),
            "marker": marker,
            "rowCount": row_count_delta,
            "outputRowCount": output_row_count,
            "sourceRanges": source_ranges,
            "staticSnapshots": list(run.static_bindings or []),
            "publishedAt": datetime.now(UTC).isoformat(),
        }
        self._stage_output_batch(
            job,
            run,
            batch_id=batch_id,
            publication_run_id=publication_run_id,
            progress=progress,
            source_ranges=source_ranges,
            target=target,
            manifest=manifest,
            evidence=evidence,
        )
        dataset = self._catalog_dataset(job, run, target, progress, evidence, previous)
        commit = save_catalog_dataset_and_revision(
            self.db,
            dataset,
            run_id=publication_run_id,
            storage_location=target.table_uri,
            storage_format="clickhouse",
            materialization_mode="delta",
            row_count=row_count_delta,
            next_check_after_ms=max(
                1_000,
                min(60_000, int(job.trigger_interval_seconds) * 500),
            ),
            source_ranges=source_ranges,
            commit_kind=STREAM_COMMIT_KIND,
            manifest_location=manifest,
        )
        return self._ready_batch(
            job,
            run,
            batch_id=batch_id,
            publication_run_id=publication_run_id,
            progress=progress,
            source_ranges=source_ranges,
            revision=int(commit.revision),
            target=target,
            manifest=manifest,
        )

    def _new_source_ranges(
        self,
        dataset_id: str,
        topic: str,
        progress: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        source_ranges: list[dict[str, Any]] = []
        for item in progress:
            partition = int(item["partition"])
            end_offset = int(item["maxOffset"]) + 1
            cursor = self.live_repository.stream_partition_cursor(
                dataset_id,
                topic,
                partition,
            )
            start_offset = (
                int(cursor.next_offset)
                if cursor is not None
                else int(item["minOffset"])
            )
            if end_offset <= start_offset:
                continue
            source_ranges.append({
                "topic": topic,
                "partition": partition,
                "startOffset": start_offset,
                "endOffset": end_offset,
            })
        return source_ranges

    def _stage_output_batch(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        *,
        batch_id: int,
        publication_run_id: str,
        progress: list[dict[str, Any]],
        source_ranges: list[dict[str, Any]],
        target: ClickHouseWriterTarget,
        manifest: str,
        evidence: dict[str, Any],
    ) -> None:
        batch = ContinuousSqlBatchModel(
            id=f"{job.id}:{run.generation}:{batch_id}",
            job_id=job.id,
            run_id=run.run_id,
            generation=run.generation,
            batch_id=batch_id,
            stage="output_committed",
            plan_hash=job.plan_hash,
            input_offsets=source_ranges,
            static_snapshots=list(run.static_bindings or []),
            source_boundary={
                "kind": "clickhouse_offsets",
                "jobId": job.id,
                "generation": run.generation,
                "progress": progress,
            },
            output_commit={
                "engine": "clickhouse",
                "tableUri": target.table_uri,
                "marker": evidence["marker"],
            },
            output_commit_id=publication_run_id,
            manifest_path=manifest,
            row_count=int(evidence["rowCount"]),
            published_at=str(evidence["publishedAt"]),
        )
        self.repository.stage_batch(batch)

    def _ready_batch(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        *,
        batch_id: int,
        publication_run_id: str,
        progress: list[dict[str, Any]],
        source_ranges: list[dict[str, Any]],
        revision: int,
        target: ClickHouseWriterTarget,
        manifest: str | None = None,
    ) -> ContinuousSqlBatchModel:
        batch = self.repository.get_batch(job.id, run.generation, batch_id)
        if batch is None:
            batch = ContinuousSqlBatchModel(
                id=f"{job.id}:{run.generation}:{batch_id}",
                job_id=job.id,
                run_id=run.run_id,
                generation=run.generation,
                batch_id=batch_id,
                stage="dashboard_ready",
                plan_hash=job.plan_hash,
                input_offsets=source_ranges,
                static_snapshots=list(run.static_bindings or []),
                source_boundary={
                    "kind": "clickhouse_offsets",
                    "jobId": job.id,
                    "generation": run.generation,
                    "progress": progress,
                },
                output_commit={
                    "engine": "clickhouse",
                    "tableUri": target.table_uri,
                    "marker": publication_run_id.removeprefix("csqlch_"),
                },
                output_commit_id=publication_run_id,
                manifest_path=manifest or f"{target.table_uri}/_publications/{publication_run_id}.json",
                row_count=0,
                dataset_revision=revision,
                published_at=datetime.now(UTC).isoformat(),
            )
        batch.stage = "dashboard_ready"
        batch.dataset_revision = revision
        batch.last_error_code = None
        batch.last_error_message = None
        self.db.add(batch)
        self.db.commit()
        return batch

    def _catalog_dataset(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        target: ClickHouseWriterTarget,
        progress: list[dict[str, Any]],
        evidence: dict[str, Any],
        previous_payload: dict[str, Any],
    ) -> CatalogDatasetModel:
        now = str(evidence["publishedAt"])
        output_schema = [
            [str(item[0]), str(item[1])]
            for item in job.compiled_plan.get("outputSchema") or []
            if isinstance(item, (list, tuple)) and len(item) >= 2
        ]
        relation_ids = [
            str(item.get("datasetId") or "")
            for item in job.relation_bindings or []
            if isinstance(item, dict) and str(item.get("datasetId") or "")
        ]
        materialization_run = {
            "createdAt": now,
            "jobId": job.id,
            "materializationMode": "delta",
            "publicationManifest": f"{target.table_uri}/_publications/{evidence['marker']}.json",
            "rowCount": int(evidence["rowCount"]),
            "runId": f"csqlch_{evidence['marker'][:32]}",
            "sourceBoundary": {
                "kind": "clickhouse_offsets",
                "progress": progress,
            },
            "sourceKind": "continuous_sql",
            "sourceLabel": job.name,
            "sourceRanges": list(evidence["sourceRanges"]),
            "staticSnapshots": list(run.static_bindings or []),
            "status": "success",
            "storageFormat": "clickhouse",
            "storageLocation": target.table_uri,
        }
        previous_runs = [
            item
            for item in previous_payload.get("materializationRuns") or []
            if isinstance(item, dict) and item.get("runId") != materialization_run["runId"]
        ]
        payload = {
            **previous_payload,
            "clickhouseProgress": {
                str(item["partition"]): {
                    "maxOffset": int(item["maxOffset"]),
                    "rowCount": int(item["rowCount"]),
                    "latestIngestedAt": str(item.get("latestIngestedAt") or ""),
                }
                for item in progress
            },
            "clickhouseOutputRowCount": int(evidence["outputRowCount"]),
            "clickhouseTable": {
                "database": target.database,
                "table": target.table,
            },
            "createdBy": previous_payload.get("createdBy") or job.created_by,
            "description": previous_payload.get("description")
            or f"ClickHouse Continuous SQL output for {job.name}",
            "downstream": previous_payload.get("downstream") or ["Dashboard"],
            "freshness": "latest",
            "id": job.output_dataset_id,
            "indexColumns": ["kafka_partition", "kafka_offset"],
            "lastUpdated": now,
            "layer": job.output_layer,
            "materializationRuns": [*previous_runs, materialization_run][-100:],
            "name": job.output_dataset_name,
            "nextRefresh": f"Every {job.trigger_interval_seconds} seconds",
            "owner": job.owner,
            "permissionGrants": previous_payload.get("permissionGrants")
            or permission_grants_from_roles(job.owner, default_actions=["view", "query"]),
            "permissions": previous_payload.get("permissions")
            or resource_permissions(can_query=True),
            "quality": "ClickHouse offset publication verified",
            "queryEngineStatus": "unavailable",
            "rag": bool(previous_payload.get("rag")),
            "relationMode": "static",
            "rows": f"{int(evidence['outputRowCount']):,}",
            "sampleRows": previous_payload.get("sampleRows") or [],
            "schema": output_schema,
            "size": previous_payload.get("size") or "ClickHouse managed",
            "source": job.name,
            "sourceRunId": materialization_run["runId"],
            "status": "available",
            "storageFormat": "clickhouse",
            "storageLocation": target.table_uri,
            "tags": previous_payload.get("tags") or ["continuous-sql", "clickhouse"],
            "upstream": relation_ids,
        }
        existing = self.catalog_repository.get_dataset_model_for_update(job.output_dataset_id)
        values = {
            "payload": payload,
            "name": job.output_dataset_name,
            "description": payload["description"],
            "owner": job.owner,
            "layer": job.output_layer,
            "status": "available",
            "freshness": "latest",
            "source": job.name,
            "rows": payload["rows"],
            "size": payload["size"],
            "quality": payload["quality"],
            "last_updated": now,
            "next_refresh": payload["nextRefresh"],
            "rag": payload["rag"],
            "tags": payload["tags"],
            "schema_json": output_schema,
            "sample_rows": payload["sampleRows"],
            "upstream": relation_ids,
            "downstream": payload["downstream"],
            "lineage_graph": previous_payload.get("lineageGraph"),
        }
        if existing is None:
            return CatalogDatasetModel(id=job.output_dataset_id, **values)
        for key, value in values.items():
            setattr(existing, key, value)
        return existing


def normalize_clickhouse_progress(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        try:
            partition = int(item.get("partition"))
            min_offset = int(item.get("minOffset"))
            max_offset = int(item.get("maxOffset"))
            row_count = int(item.get("rowCount"))
        except (TypeError, ValueError):
            continue
        if partition < 0 or min_offset < 0 or max_offset < min_offset or row_count < 0:
            continue
        normalized.append({
            "partition": partition,
            "minOffset": min_offset,
            "maxOffset": max_offset,
            "rowCount": row_count,
            "latestIngestedAt": str(item.get("latestIngestedAt") or ""),
        })
    return sorted(normalized, key=lambda item: int(item["partition"]))


def clickhouse_progress_marker(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel,
    progress: list[dict[str, Any]],
) -> str:
    canonical = json.dumps(
        {
            "jobId": job.id,
            "generation": int(run.generation),
            "planHash": job.plan_hash,
            "progress": progress,
        },
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalize_output_row_count(value: Any, *, fallback: int) -> int:
    if value is None:
        return max(0, int(fallback))
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("ClickHouse output row count is invalid") from exc
    if normalized < 0:
        raise ValueError("ClickHouse output row count cannot be negative")
    return normalized
