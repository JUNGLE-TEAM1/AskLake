import gzip
import hashlib
import json
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import status

from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.schemas.common import ErrorCode


RESULT_PAGE_FORMAT_VERSION = 1


@dataclass(frozen=True)
class StoredTrinoResultPage:
    checksum: str
    columns: list[str]
    compressed_bytes: int
    object_key: str
    row_count: int


class TrinoResultStorage:
    """Private MinIO-backed storage for collected Trino result pages."""

    def __init__(self, runtime_settings: Settings | None = None) -> None:
        self.settings = runtime_settings or settings
        self.bucket = self.settings.trino_result_storage_bucket.strip()
        self.prefix = self.settings.trino_result_storage_prefix.strip("/")
        self.client: Any | None = None
        self._bucket_ready = False

    def write_page(
        self,
        *,
        run_id: str,
        page_index: int,
        columns: list[str],
        rows: list[list[object]],
    ) -> StoredTrinoResultPage:
        self._ensure_bucket()
        object_key = self.page_object_key(run_id, page_index)
        payload = {
            "columns": columns,
            "formatVersion": RESULT_PAGE_FORMAT_VERSION,
            "rows": rows,
        }
        compressed = gzip.compress(json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8"))
        checksum = hashlib.sha256(compressed).hexdigest()
        temporary_key = f"{object_key}.uploading"
        try:
            self._client().put_object(
                Bucket=self.bucket,
                Key=temporary_key,
                Body=compressed,
                ContentEncoding="gzip",
                ContentType="application/json",
                Metadata={"sha256": checksum},
            )
            self._client().copy_object(
                Bucket=self.bucket,
                Key=object_key,
                CopySource={"Bucket": self.bucket, "Key": temporary_key},
                MetadataDirective="COPY",
            )
            head = self._client().head_object(Bucket=self.bucket, Key=object_key)
            stored_checksum = str((head.get("Metadata") or {}).get("sha256") or "")
            if stored_checksum != checksum or int(head.get("ContentLength") or -1) != len(compressed):
                raise ApiError(
                    ErrorCode.RESULT_STORAGE_UNAVAILABLE,
                    "Trino result page integrity verification failed",
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                )
        except ApiError:
            self.delete_object(object_key, suppress_errors=True)
            raise
        except (BotoCoreError, ClientError) as exc:
            self.delete_object(object_key, suppress_errors=True)
            raise self._storage_error("Unable to persist Trino result page") from exc
        finally:
            self.delete_object(temporary_key, suppress_errors=True)

        return StoredTrinoResultPage(
            checksum=checksum,
            columns=columns,
            compressed_bytes=len(compressed),
            object_key=object_key,
            row_count=len(rows),
        )

    def read_page(self, *, object_key: str, expected_checksum: str | None = None) -> tuple[list[str], list[list[object]]]:
        self._ensure_bucket()
        try:
            response = self._client().get_object(Bucket=self.bucket, Key=object_key)
            compressed = response["Body"].read()
        except (BotoCoreError, ClientError) as exc:
            raise self._storage_error("Trino result page is unavailable") from exc

        checksum = hashlib.sha256(compressed).hexdigest()
        if expected_checksum and checksum != expected_checksum:
            raise ApiError(
                ErrorCode.RESULT_STORAGE_UNAVAILABLE,
                "Trino result page integrity check failed",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            payload = json.loads(gzip.decompress(compressed).decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(
                ErrorCode.RESULT_STORAGE_UNAVAILABLE,
                "Trino result page is corrupted",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            ) from exc
        if payload.get("formatVersion") != RESULT_PAGE_FORMAT_VERSION:
            raise ApiError(
                ErrorCode.RESULT_STORAGE_UNAVAILABLE,
                "Trino result page format is unsupported",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        columns = payload.get("columns")
        rows = payload.get("rows")
        if not isinstance(columns, list) or not all(isinstance(column, str) for column in columns) or not isinstance(rows, list) or not all(isinstance(row, list) for row in rows):
            raise ApiError(
                ErrorCode.RESULT_STORAGE_UNAVAILABLE,
                "Trino result page payload is invalid",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return columns, rows

    def delete_object(self, object_key: str, *, suppress_errors: bool = False) -> None:
        try:
            self._client().delete_object(Bucket=self.bucket, Key=object_key)
        except (BotoCoreError, ClientError) as exc:
            if not suppress_errors:
                raise self._storage_error("Unable to remove Trino result page") from exc

    def page_object_key(self, run_id: str, page_index: int) -> str:
        if page_index < 0 or not run_id.startswith("trino_"):
            raise ApiError(ErrorCode.VALIDATION_ERROR, "Invalid Trino result page identity", status.HTTP_422_UNPROCESSABLE_ENTITY)
        filename = f"{page_index:08d}.json.gz"
        return f"{self.prefix}/{run_id}/pages/{filename}" if self.prefix else f"{run_id}/pages/{filename}"

    def _ensure_bucket(self) -> None:
        if self._bucket_ready:
            return
        client = self._client()
        try:
            client.head_bucket(Bucket=self.bucket)
        except ClientError as exc:
            error_code = str((exc.response.get("Error") or {}).get("Code") or "")
            if error_code not in {"404", "NoSuchBucket", "NoSuchBucketPolicy"} or not self.settings.trino_result_storage_auto_create_bucket:
                raise self._storage_error("Trino result storage bucket is unavailable") from exc
            try:
                client.create_bucket(Bucket=self.bucket)
            except (BotoCoreError, ClientError) as create_exc:
                raise self._storage_error("Unable to create Trino result storage bucket") from create_exc
        except BotoCoreError as exc:
            raise self._storage_error("Trino result storage bucket is unavailable") from exc
        self._bucket_ready = True

    def _client(self) -> Any:
        if self.client is not None:
            return self.client
        endpoint = self.settings.minio_endpoint
        access_key = self.settings.minio_access_key
        secret_key = self.settings.minio_secret_key
        if not self.bucket or not endpoint or not access_key or not secret_key:
            raise ApiError(
                ErrorCode.RESULT_STORAGE_UNAVAILABLE,
                "Trino result storage is not configured",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=self.settings.minio_region,
            config=Config(
                connect_timeout=3,
                read_timeout=15,
                retries={"max_attempts": 2, "mode": "standard"},
                s3={"addressing_style": "path"},
            ),
        )
        return self.client

    @staticmethod
    def _storage_error(message: str) -> ApiError:
        return ApiError(ErrorCode.RESULT_STORAGE_UNAVAILABLE, message, status.HTTP_503_SERVICE_UNAVAILABLE)
