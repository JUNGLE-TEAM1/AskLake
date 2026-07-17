import os
from pathlib import Path
import sys
import uuid

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.config import Settings
from app.schemas.iceberg import IcebergWriterTarget
from app.services.iceberg_writer_service import (
    IcebergWriterService,
    build_iceberg_writer_target,
)


def live_verification_enabled() -> bool:
    return str(os.environ.get("ASKLAKE_VERIFY_ICEBERG_LIVE") or "").strip().lower() in {"1", "true", "yes"}


def verify_live() -> None:
    if not live_verification_enabled():
        print("verify-iceberg-writer-foundation-live: skipped (set ASKLAKE_VERIFY_ICEBERG_LIVE=true)")
        return

    settings = Settings(_env_file=None)
    if not settings.trino_enabled:
        raise RuntimeError("TRINO_ENABLED=true is required for live Iceberg verification")

    suffix = uuid.uuid4().hex[:12]
    service = IcebergWriterService(settings)
    append_target = build_iceberg_writer_target(
        f"phase1_append_{suffix}",
        f"phase1_append_{suffix}",
        write_mode="append",
        runtime_settings=settings,
    )
    replace_target = build_iceberg_writer_target(
        f"phase1_replace_{suffix}",
        f"phase1_replace_{suffix}",
        write_mode="replace",
        runtime_settings=settings,
    )
    try:
        first_append = service.commit_select(
            append_target,
            "SELECT * FROM (VALUES ('append-1', BIGINT '1')) AS fixture(event_id, event_offset)",
            job_id="JOB-PHASE1-LIVE",
            run_id=f"RUN-APPEND-1-{suffix}",
        )
        second_append = service.commit_select(
            append_target,
            "SELECT * FROM (VALUES ('append-2', BIGINT '2')) AS fixture(event_id, event_offset)",
            job_id="JOB-PHASE1-LIVE",
            run_id=f"RUN-APPEND-2-{suffix}",
        )
        service.commit_select(
            replace_target,
            "SELECT * FROM (VALUES ('replace-1')) AS fixture(event_id)",
            job_id="JOB-PHASE1-LIVE",
            run_id=f"RUN-REPLACE-1-{suffix}",
        )
        second_replace = service.commit_select(
            replace_target,
            "SELECT * FROM (VALUES ('replace-2')) AS fixture(event_id)",
            job_id="JOB-PHASE1-LIVE",
            run_id=f"RUN-REPLACE-2-{suffix}",
        )
        append_count = service.query_rows(f"SELECT count(*) FROM {qualified(append_target)}")
        replace_rows = service.query_rows(f"SELECT event_id FROM {qualified(replace_target)}")

        assert int(append_count[0][0]) == 2
        assert replace_rows == [["replace-2"]]
        assert first_append.snapshot_id != second_append.snapshot_id
        assert second_append.query_engine_table.table == append_target.table
        assert second_replace.query_engine_table.table == replace_target.table
        assert first_append.warehouse_location.startswith("s3://")
    finally:
        service.drop_table(append_target)
        service.drop_table(replace_target)

    print("verify-iceberg-writer-foundation-live: ok")


def qualified(target: IcebergWriterTarget) -> str:
    return ".".join(
        f'"{str(value).replace(chr(34), chr(34) * 2)}"'
        for value in (target.catalog, target.namespace, target.table)
    )


if __name__ == "__main__":
    verify_live()
