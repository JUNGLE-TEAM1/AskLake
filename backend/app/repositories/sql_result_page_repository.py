from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.sql import SqlRunModel, SqlRunResultPageModel
from app.repositories.sql_repository_schema import ensure_sql_schema


class SqlResultPageRepository:
    db: Session

    def save_result_page(
        self,
        *,
        run_id: str,
        page_index: int,
        columns: list[str],
        rows: list[list[object]],
        byte_size: int,
        source_next_uri: str | None = None,
    ) -> None:
        ensure_sql_schema(self.db)
        page_id = f"{run_id}:{page_index}"
        model = self.db.get(SqlRunResultPageModel, page_id)
        if model is None:
            self.db.add(SqlRunResultPageModel(
                id=page_id,
                run_id=run_id,
                page_index=page_index,
                columns=columns,
                rows=rows,
                byte_size=byte_size,
                row_count=len(rows),
                storage_backend="postgres",
                source_next_uri=source_next_uri,
            ))
        else:
            model.columns = columns
            model.rows = rows
            model.byte_size = byte_size
            model.row_count = len(rows)
            model.storage_backend = "postgres"
            model.object_key = None
            model.checksum = None
            model.source_next_uri = source_next_uri
        self.db.commit()

    def save_result_page_if_owned(
        self,
        *,
        run_id: str,
        worker_id: str,
        generation: int,
        page_index: int,
        columns: list[str],
        rows: list[list[object]],
        byte_size: int,
        source_next_uri: str,
    ) -> Literal["saved", "duplicate", "fenced"]:
        """Atomically save an inline preview page while the collector lease is valid."""
        ensure_sql_schema(self.db)
        run = self.db.scalar(select(SqlRunModel).where(SqlRunModel.id == run_id).with_for_update())
        now = datetime.now(timezone.utc)
        if (
            run is None
            or run.collector_owner != worker_id
            or run.collector_generation != generation
            or run.collector_lease_expires_at is None
            or run.collector_lease_expires_at <= now
        ):
            self.db.rollback()
            return "fenced"
        duplicate = self.db.scalar(
            select(SqlRunResultPageModel)
            .where(SqlRunResultPageModel.run_id == run_id)
            .where(SqlRunResultPageModel.source_next_uri == source_next_uri)
        )
        if duplicate is not None:
            self.db.rollback()
            return "duplicate"
        self.db.add(SqlRunResultPageModel(
            id=f"{run_id}:{page_index}",
            run_id=run_id,
            page_index=page_index,
            columns=columns,
            rows=rows,
            byte_size=byte_size,
            storage_backend="postgres",
            row_count=len(rows),
            source_next_uri=source_next_uri,
        ))
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            return "duplicate"
        return "saved"

    def save_result_page_metadata(
        self,
        *,
        run_id: str,
        page_index: int,
        columns: list[str],
        object_key: str,
        row_count: int,
        compressed_bytes: int,
        checksum: str,
        source_next_uri: str | None = None,
    ) -> None:
        ensure_sql_schema(self.db)
        page_id = f"{run_id}:{page_index}"
        model = self.db.get(SqlRunResultPageModel, page_id)
        if model is None:
            self.db.add(SqlRunResultPageModel(
                id=page_id,
                run_id=run_id,
                page_index=page_index,
                columns=columns,
                rows=[],
                byte_size=compressed_bytes,
                storage_backend="s3",
                object_key=object_key,
                row_count=row_count,
                checksum=checksum,
                source_next_uri=source_next_uri,
            ))
        else:
            model.columns = columns
            model.rows = []
            model.byte_size = compressed_bytes
            model.storage_backend = "s3"
            model.object_key = object_key
            model.row_count = row_count
            model.checksum = checksum
            model.source_next_uri = source_next_uri
        self.db.commit()

    def save_result_page_metadata_if_owned(
        self,
        *,
        run_id: str,
        worker_id: str,
        generation: int,
        page_index: int,
        columns: list[str],
        object_key: str,
        row_count: int,
        compressed_bytes: int,
        checksum: str,
        source_next_uri: str,
    ) -> Literal["saved", "duplicate", "fenced"]:
        ensure_sql_schema(self.db)
        run = self.db.scalar(select(SqlRunModel).where(SqlRunModel.id == run_id).with_for_update())
        now = datetime.now(timezone.utc)
        if (
            run is None
            or run.collector_owner != worker_id
            or run.collector_generation != generation
            or run.collector_lease_expires_at is None
            or run.collector_lease_expires_at <= now
        ):
            self.db.rollback()
            return "fenced"
        duplicate = self.db.scalar(
            select(SqlRunResultPageModel)
            .where(SqlRunResultPageModel.run_id == run_id)
            .where(SqlRunResultPageModel.source_next_uri == source_next_uri)
        )
        if duplicate is not None:
            self.db.rollback()
            return "duplicate"
        self.db.add(SqlRunResultPageModel(
            id=f"{run_id}:{page_index}",
            run_id=run_id,
            page_index=page_index,
            columns=columns,
            rows=[],
            byte_size=compressed_bytes,
            storage_backend="s3",
            object_key=object_key,
            row_count=row_count,
            checksum=checksum,
            source_next_uri=source_next_uri,
        ))
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            return "duplicate"
        return "saved"

    def get_result_page(self, run_id: str, page_index: int) -> SqlRunResultPageModel | None:
        ensure_sql_schema(self.db)
        return self.db.scalar(select(SqlRunResultPageModel).where(
            SqlRunResultPageModel.run_id == run_id,
            SqlRunResultPageModel.page_index == page_index,
        ))

    def count_result_pages(self, run_id: str) -> int:
        ensure_sql_schema(self.db)
        return len(self.db.scalars(select(SqlRunResultPageModel.id).where(
            SqlRunResultPageModel.run_id == run_id,
        )).all())

    def total_result_rows(self, run_id: str) -> int:
        ensure_sql_schema(self.db)
        values = self.db.scalars(select(SqlRunResultPageModel.row_count).where(
            SqlRunResultPageModel.run_id == run_id,
        )).all()
        return sum(int(value or 0) for value in values)

    def get_result_page_by_source_uri(self, run_id: str, source_next_uri: str) -> SqlRunResultPageModel | None:
        ensure_sql_schema(self.db)
        return self.db.scalar(select(SqlRunResultPageModel).where(
            SqlRunResultPageModel.run_id == run_id,
            SqlRunResultPageModel.source_next_uri == source_next_uri,
        ))

    def total_result_bytes(self, run_id: str) -> int:
        ensure_sql_schema(self.db)
        rows = self.db.scalars(select(SqlRunResultPageModel.byte_size).where(
            SqlRunResultPageModel.run_id == run_id,
        )).all()
        return sum(int(value or 0) for value in rows)

    def list_result_pages(self, run_id: str) -> list[SqlRunResultPageModel]:
        ensure_sql_schema(self.db)
        return list(self.db.scalars(select(SqlRunResultPageModel).where(
            SqlRunResultPageModel.run_id == run_id,
        ).order_by(SqlRunResultPageModel.page_index.asc())).all())

    def delete_result_pages(self, run_id: str) -> int:
        ensure_sql_schema(self.db)
        result = self.db.execute(delete(SqlRunResultPageModel).where(
            SqlRunResultPageModel.run_id == run_id,
        ))
        self.db.commit()
        return int(result.rowcount or 0)
