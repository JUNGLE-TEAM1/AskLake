"""Query result persistence, paging, retention, and export responsibilities."""

import csv
from datetime import datetime, timezone
from io import StringIO
from typing import Iterator

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.sql_repository import SqlRepository
from app.models.sql import SqlRunResultPageModel
from app.schemas.common import ErrorCode
from app.schemas.trino import (
    TrinoClientPage,
    TrinoQueryRunError,
    TrinoQueryRunResponse,
    TrinoQueryRunResult,
    TrinoQueryRunResultPage,
)
from app.services.trino_client import TrinoClient
from app.services.trino_query_access import TrinoQueryAccessService
from app.services.trino_query_preview import save_inline_preview_page
from app.services.trino_query_result_manifest import (
    build_result_manifest,
    current_utc_timestamp,
    with_result_collection_timing,
)
from app.services.trino_query_run_state import (
    decode_cursor_position,
    encode_cursor,
    normalized_result_page_size,
)
from app.services.trino_query_run_store import TrinoQueryRunStore
from app.services.trino_result_storage import TrinoResultStorage


class CollectorLeaseLost(RuntimeError):
    pass


class TrinoQueryResultService:
    def __init__(
        self,
        repository: SqlRepository,
        result_storage: TrinoResultStorage,
        settings: Settings,
        access: TrinoQueryAccessService,
        run_store: TrinoQueryRunStore,
        client: TrinoClient,
    ) -> None:
        self.repository = repository
        self.result_storage = result_storage
        self.settings = settings
        self.access = access
        self.run_store = run_store
        self.client = client

    def store_page(
        self,
        response: TrinoQueryRunResponse,
        page: TrinoClientPage,
        *,
        source_next_uri: str | None = None,
        worker_id: str | None = None,
        generation: int | None = None,
    ) -> TrinoQueryRunResponse:
        response = with_result_collection_timing(response)
        if source_next_uri and self.repository.get_result_page_by_source_uri(response.run_id, source_next_uri):
            return self.with_manifest(response, page.columns, next_uri=page.next_uri)
        page_count = self.repository.count_result_pages(response.run_id)
        if not page.rows and (response.status != "succeeded" or page_count > 0):
            return response
        columns = page.columns or (response.result.columns if response.result else [])
        if response.mode == "preview":
            outcome = save_inline_preview_page(
                self.repository,
                response,
                page_count=page_count,
                columns=columns,
                rows=page.rows,
                source_next_uri=source_next_uri,
                worker_id=worker_id,
                generation=generation,
            )
            if outcome == "fenced":
                raise CollectorLeaseLost(response.run_id)
            return self.with_manifest(response, columns, next_uri=page.next_uri)
        self._store_object_page(
            response,
            page,
            page_count=page_count,
            columns=columns,
            source_next_uri=source_next_uri,
            worker_id=worker_id,
            generation=generation,
        )
        return self.with_manifest(response, columns, next_uri=page.next_uri)

    def _store_object_page(
        self,
        response: TrinoQueryRunResponse,
        page: TrinoClientPage,
        *,
        page_count: int,
        columns: list[str],
        source_next_uri: str | None,
        worker_id: str | None,
        generation: int | None,
    ) -> None:
        stored_page = self.result_storage.write_page(
            run_id=response.run_id,
            page_index=page_count,
            columns=columns,
            rows=page.rows,
            attempt_id=f"g{generation}" if worker_id is not None and generation is not None else None,
        )
        if worker_id is None or generation is None or not source_next_uri:
            self.repository.save_result_page_metadata(
                run_id=response.run_id,
                page_index=page_count,
                columns=stored_page.columns,
                object_key=stored_page.object_key,
                row_count=stored_page.row_count,
                compressed_bytes=stored_page.compressed_bytes,
                checksum=stored_page.checksum,
                source_next_uri=source_next_uri,
            )
            return
        outcome = self.repository.save_result_page_metadata_if_owned(
            run_id=response.run_id,
            worker_id=worker_id,
            generation=generation,
            page_index=page_count,
            columns=stored_page.columns,
            object_key=stored_page.object_key,
            row_count=stored_page.row_count,
            compressed_bytes=stored_page.compressed_bytes,
            checksum=stored_page.checksum,
            source_next_uri=source_next_uri,
        )
        if outcome != "saved":
            self.result_storage.delete_object(stored_page.object_key, suppress_errors=True)
        if outcome == "fenced":
            raise CollectorLeaseLost(response.run_id)

    def with_manifest(
        self,
        response: TrinoQueryRunResponse,
        columns: list[str],
        *,
        next_uri: str | None,
    ) -> TrinoQueryRunResponse:
        return build_result_manifest(self.repository, response, columns, next_uri=next_uri)

    def finalize_storage(self, response: TrinoQueryRunResponse) -> TrinoQueryRunResponse:
        if response.status != "succeeded" or response.result is None:
            return response
        response = with_result_collection_timing(
            response,
            collection_completed=True,
            first_page_available=(response.result.available_page_count or 0) > 0,
        )
        if response.result is None:
            return response
        expected_rows = response.result.expected_row_count
        if expected_rows is None:
            expected_rows = response.stats.output_rows if response.stats else response.result.row_count
        return response.model_copy(update={
            "result": response.result.model_copy(update={
                "collected_row_count": response.result.row_count,
                "collection_progress_percentage": 100,
                "expected_row_count": expected_rows,
                "storage_status": "available",
            }),
        })

    def persistence_failed(self, response: TrinoQueryRunResponse) -> TrinoQueryRunResponse:
        response = with_result_collection_timing(response)
        result = response.result or TrinoQueryRunResult()
        return response.model_copy(update={
            "completed_at": current_utc_timestamp(),
            "error": TrinoQueryRunError(
                code=ErrorCode.RESULT_PERSISTENCE_FAILED,
                message="Query result persistence failed",
            ),
            "result": result.model_copy(update={"storage_status": "unavailable"}),
            "status": "failed",
        })

    def get_result_page(
        self,
        run_id: str,
        cursor: str | None,
        actor: ActorContext | None = None,
    ) -> TrinoQueryRunResultPage:
        response = self.run_store.load(run_id)
        self.access.require_access_for_response(response, actor or ActorContext(), operation="view")
        self.require_retention(response)
        payload = self.run_store.get_payload(run_id)
        retention_expires_at = response.result.retention_expires_at if response.result else None
        page_index, row_offset, logical_page_index = decode_cursor_position(
            cursor,
            run_id=run_id,
            retention_expires_at=retention_expires_at,
            secret=self.settings.trino_result_cursor_secret,
        )
        first_page = self.repository.get_result_page(run_id, page_index)
        if first_page is None:
            self._raise_missing_page(response)
        self._record_result_view(response, actor or ActorContext(), page_index, row_offset)
        result_page_size = normalized_result_page_size(payload.get("resultPageSize"))
        columns, visible_rows, next_position = self._read_visible_rows(
            run_id,
            page_index=page_index,
            row_offset=row_offset,
            page_size=result_page_size,
        )
        total_rows = response.result.row_count if response.result and response.result.storage_status == "available" else None
        total_pages = ((total_rows + result_page_size - 1) // result_page_size) if total_rows is not None else None
        row_start = logical_page_index * result_page_size + 1 if visible_rows else 0
        row_end = row_start + len(visible_rows) - 1 if visible_rows else 0
        return TrinoQueryRunResultPage(
            columns=columns,
            next_cursor=self._next_cursor(next_position, run_id, retention_expires_at, logical_page_index),
            page_size=result_page_size,
            page_number=logical_page_index + 1,
            row_end=row_end,
            row_start=row_start,
            rows=visible_rows,
            run_id=run_id,
            total_pages=total_pages,
            total_rows=total_rows,
        )

    def _read_visible_rows(
        self,
        run_id: str,
        *,
        page_index: int,
        row_offset: int,
        page_size: int,
    ) -> tuple[list[str], list[list[object]], tuple[int, int] | None]:
        columns: list[str] = []
        visible_rows: list[list[object]] = []
        current_page_index = page_index
        current_row_offset = row_offset
        while len(visible_rows) < page_size:
            current_page = self.repository.get_result_page(run_id, current_page_index)
            if current_page is None:
                break
            current_columns, current_rows = self._read_page(current_page)
            if not columns:
                columns = current_columns
            remaining = page_size - len(visible_rows)
            visible_rows.extend(current_rows[current_row_offset:current_row_offset + remaining])
            current_row_offset += min(remaining, max(0, len(current_rows) - current_row_offset))
            if current_row_offset < len(current_rows):
                break
            current_page_index += 1
            current_row_offset = 0
        if self.repository.get_result_page(run_id, current_page_index) is None:
            return columns, visible_rows, None
        return columns, visible_rows, (current_page_index, current_row_offset)

    def _read_page(self, page: SqlRunResultPageModel) -> tuple[list[str], list[list[object]]]:
        if page.storage_backend in {"s3", "minio"} and page.object_key:
            return self.result_storage.read_page(
                object_key=page.object_key,
                expected_checksum=page.checksum,
            )
        return page.columns, page.rows

    def _next_cursor(
        self,
        position: tuple[int, int] | None,
        run_id: str,
        retention_expires_at: str | None,
        logical_page_index: int,
    ) -> str | None:
        if position is None:
            return None
        return encode_cursor(
            position[0],
            run_id=run_id,
            retention_expires_at=retention_expires_at,
            secret=self.settings.trino_result_cursor_secret,
            row_offset=position[1],
            logical_page_index=logical_page_index + 1,
        )

    def prepare_csv_export(self, run_id: str, actor: ActorContext | None = None) -> Iterator[bytes]:
        response = self.run_store.load(run_id)
        actor_context = actor or ActorContext()
        self.access.require_access_for_response(response, actor_context, operation="view")
        self.require_retention(response)
        if response.mode != "run":
            raise ApiError(
                ErrorCode.RESULT_PAGE_NOT_READY,
                "Create the full result before downloading CSV",
                status.HTTP_409_CONFLICT,
                {"runId": run_id, "mode": response.mode},
            )
        if response.status != "succeeded" or response.result is None or response.result.storage_status != "available":
            raise ApiError(
                ErrorCode.RESULT_PAGE_NOT_READY,
                "CSV export is available after the full query result is prepared",
                status.HTTP_409_CONFLICT,
            )
        self._record_csv_export(response, actor_context)
        pages = self.repository.list_result_pages(run_id)

        def stream() -> Iterator[bytes]:
            wrote_header = False
            for page in pages:
                columns, rows = self._read_page(page)
                buffer = StringIO(newline="")
                writer = csv.writer(buffer, lineterminator="\n")
                if not wrote_header:
                    writer.writerow(columns)
                    wrote_header = True
                writer.writerows(rows)
                content = buffer.getvalue()
                if content:
                    yield content.encode("utf-8")

        return stream()

    def require_retention(self, response: TrinoQueryRunResponse) -> None:
        expires_at = response.result.retention_expires_at if response.result else None
        if not expires_at:
            return
        try:
            expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError:
            return
        if expiry <= datetime.now(timezone.utc):
            raise ApiError(
                ErrorCode.RESULT_EXPIRED,
                "Query result retention has expired",
                status.HTTP_410_GONE,
            )

    def cancel_after_persistence_failure(self, next_uri: str | None) -> None:
        if not next_uri:
            return
        try:
            self.client.cancel(next_uri)
        except ApiError:
            return

    def delete_partial_pages(self, run_id: str) -> None:
        for page in self.repository.list_result_pages(run_id):
            if page.storage_backend in {"s3", "minio"} and page.object_key:
                self.result_storage.delete_object(page.object_key)
        self.repository.delete_result_pages(run_id)

    def _raise_missing_page(self, response: TrinoQueryRunResponse) -> None:
        if response.status in {"queued", "running"}:
            raise ApiError(
                ErrorCode.RESULT_PAGE_NOT_READY,
                "Query result page is still being collected",
                status.HTTP_409_CONFLICT,
            )
        raise ApiError(ErrorCode.NOT_FOUND, "Query result page not found", status.HTTP_404_NOT_FOUND)

    def _record_result_view(
        self,
        response: TrinoQueryRunResponse,
        actor: ActorContext,
        page_index: int,
        row_offset: int,
    ) -> None:
        safe_record_audit_event(
            self.repository.db,
            action="query_run.result.view",
            actor=actor,
            api_path=f"/api/query/runs/{response.run_id}/results",
            http_method="GET",
            metadata={"pageIndex": page_index, "rowOffset": row_offset, "trinoQueryId": response.trino_query_id},
            target_id=response.run_id,
            target_type="query_run",
        )

    def _record_csv_export(self, response: TrinoQueryRunResponse, actor: ActorContext) -> None:
        safe_record_audit_event(
            self.repository.db,
            action="query_run.csv_export.download",
            actor=actor,
            api_path=f"/api/query/runs/{response.run_id}/exports/csv",
            http_method="GET",
            metadata={"rowCount": response.result.row_count if response.result else None},
            result="success",
            status_code=status.HTTP_200_OK,
            target_id=response.run_id,
            target_type="query_run",
        )
