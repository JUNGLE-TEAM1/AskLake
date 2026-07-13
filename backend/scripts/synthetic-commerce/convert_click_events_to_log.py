#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterator
from urllib.parse import urlsplit


CONVERTER_VERSION = 2
BACKEND_DIR = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = (
    BACKEND_DIR
    / "fixtures"
    / "synthetic-commerce"
    / "click_events.jsonl"
)
DEFAULT_OUTPUT = (
    BACKEND_DIR
    / "tmp"
    / "synthetic-commerce"
    / "click-events.log"
)
DEFAULT_MULTIPART_PART_SIZE = 64 * 1024 * 1024
MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024
MAX_MULTIPART_PARTS = 10_000
S3_READ_CHUNK_SIZE = 1024 * 1024
WHITESPACE = re.compile(r"\s", re.UNICODE)
SUPPORTED_INPUT_SUFFIXES = (".jsonl", ".ndjson")


@dataclass(frozen=True)
class FieldSpec:
    path: tuple[str, ...]
    output_name: str
    inferred_type: str


@dataclass(frozen=True)
class S3Location:
    bucket: str
    key: str

    @property
    def uri(self) -> str:
        return f"s3://{self.bucket}/{self.key}"


@dataclass(frozen=True)
class S3ObjectRef:
    location: S3Location
    size: int
    etag: str


FIELD_SPECS = (
    FieldSpec(("event_time",), "event_time", "Timestamp"),
    FieldSpec(("event_id",), "event_id", "String"),
    FieldSpec(("user_id",), "user_id", "String"),
    FieldSpec(("session_id",), "session_id", "String"),
    FieldSpec(("event_type",), "event_type", "String"),
    FieldSpec(("product_id",), "product_id", "String"),
    FieldSpec(("page_url",), "page_url", "String"),
    FieldSpec(("device_type",), "device_type", "String"),
    FieldSpec(("referrer",), "referrer", "String"),
    FieldSpec(("properties", "position"), "position", "Integer"),
)


class ConversionError(ValueError):
    pass


class MultipartUploadWriter:
    def __init__(
        self,
        client: Any,
        destination: S3Location,
        *,
        part_size: int,
    ) -> None:
        if part_size < MIN_MULTIPART_PART_SIZE:
            raise ConversionError(
                f"S3 multipart part size must be at least {MIN_MULTIPART_PART_SIZE} bytes."
            )
        self.client = client
        self.destination = destination
        self.part_size = part_size
        self.name = destination.uri
        self.buffer = bytearray()
        self.parts: list[dict[str, Any]] = []
        self.completed = False
        self.aborted = False
        response = client.create_multipart_upload(
            Bucket=destination.bucket,
            Key=destination.key,
            ContentType="text/plain; charset=utf-8",
            Metadata={"asklake-converter-version": str(CONVERTER_VERSION)},
        )
        upload_id = response.get("UploadId")
        if not upload_id:
            raise ConversionError(f"S3 did not return an UploadId for {destination.uri}.")
        self.upload_id = str(upload_id)

    def write(self, payload: bytes) -> int:
        if self.completed or self.aborted:
            raise ConversionError(f"S3 multipart writer is already closed: {self.name}")
        if not isinstance(payload, bytes):
            raise TypeError("MultipartUploadWriter.write expects bytes.")
        self.buffer.extend(payload)
        while len(self.buffer) >= self.part_size:
            chunk = bytes(self.buffer[: self.part_size])
            del self.buffer[: self.part_size]
            self._upload_part(chunk)
        return len(payload)

    def complete(self) -> None:
        if self.completed:
            return
        if self.aborted:
            raise ConversionError(f"Cannot complete an aborted upload: {self.name}")
        if self.buffer:
            chunk = bytes(self.buffer)
            self.buffer.clear()
            self._upload_part(chunk)
        if not self.parts:
            raise ConversionError(f"Refusing to publish an empty S3 log object: {self.name}")
        self.client.complete_multipart_upload(
            Bucket=self.destination.bucket,
            Key=self.destination.key,
            UploadId=self.upload_id,
            MultipartUpload={"Parts": self.parts},
        )
        self.completed = True

    def abort(self) -> None:
        if self.completed or self.aborted:
            return
        self.client.abort_multipart_upload(
            Bucket=self.destination.bucket,
            Key=self.destination.key,
            UploadId=self.upload_id,
        )
        self.aborted = True
        self.buffer.clear()

    def _upload_part(self, payload: bytes) -> None:
        if len(self.parts) >= MAX_MULTIPART_PARTS:
            raise ConversionError(
                f"S3 multipart upload exceeded {MAX_MULTIPART_PARTS} parts; "
                "increase --multipart-part-size-mib."
            )
        part_number = len(self.parts) + 1
        response = self.client.upload_part(
            Bucket=self.destination.bucket,
            Key=self.destination.key,
            UploadId=self.upload_id,
            PartNumber=part_number,
            Body=payload,
        )
        etag = response.get("ETag")
        if not etag:
            raise ConversionError(
                f"S3 did not return an ETag for {self.name} part {part_number}."
            )
        self.parts.append({"ETag": str(etag), "PartNumber": part_number})


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Stream synthetic click-event JSONL into the headerless whitespace log "
            "format used by AskLake's record-parsing step. Local paths and direct "
            "S3-to-S3 conversion are supported."
        )
    )
    parser.add_argument(
        "--input",
        type=Path,
        help="A local JSONL file or directory (default: the fixed synthetic fixture).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Local destination .log file (default: backend/tmp synthetic output).",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        help="Local manifest path (default: <output>.manifest.json).",
    )
    parser.add_argument(
        "--input-s3-uri",
        help="S3 JSONL object or prefix, for example s3://raw/click_events/.",
    )
    parser.add_argument(
        "--output-s3-uri",
        help="S3 destination .log object, for example s3://raw/logs/click-events.log.",
    )
    parser.add_argument(
        "--manifest-s3-uri",
        help="S3 manifest object (default: <output-s3-uri>.manifest.json).",
    )
    parser.add_argument(
        "--s3-endpoint-url",
        help="Optional S3-compatible endpoint. Omit for AWS S3 credential-chain defaults.",
    )
    parser.add_argument(
        "--s3-region",
        help="Optional AWS region override. Omit to use the standard AWS configuration chain.",
    )
    parser.add_argument(
        "--s3-force-path-style",
        action="store_true",
        help="Use path-style addressing for a compatible endpoint such as local MinIO.",
    )
    parser.add_argument(
        "--multipart-part-size-mib",
        type=positive_integer,
        default=DEFAULT_MULTIPART_PART_SIZE // (1024 * 1024),
        help="S3 multipart part size in MiB (default: 64, minimum: 5).",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace existing output and manifest only after successful conversion.",
    )
    parser.add_argument(
        "--progress-every",
        type=positive_integer,
        default=100_000,
        help="Write progress to stderr after this many rows (default: 100000).",
    )
    return parser.parse_args(argv)


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return parsed


def discover_input_files(input_path: Path) -> list[Path]:
    resolved = input_path.expanduser().resolve()
    if resolved.is_file():
        if not is_supported_input_name(resolved.name):
            raise ConversionError(f"Input file must be JSONL or NDJSON: {resolved}")
        return [resolved]
    if not resolved.is_dir():
        raise ConversionError(f"Input path does not exist: {resolved}")
    files = sorted(
        (
            path.resolve()
            for path in resolved.rglob("*")
            if path.is_file() and is_supported_input_name(path.name)
        ),
        key=lambda path: path.relative_to(resolved).as_posix(),
    )
    if not files:
        raise ConversionError(f"Input directory contains no JSONL files: {resolved}")
    return files


def convert_click_events(
    input_path: Path,
    output_path: Path,
    *,
    manifest_path: Path | None = None,
    overwrite: bool = False,
    progress_every: int = 100_000,
) -> dict[str, Any]:
    if progress_every <= 0:
        raise ConversionError("progress_every must be greater than zero.")
    input_files = discover_input_files(input_path)
    output = output_path.expanduser().resolve()
    manifest = (manifest_path or default_manifest_path(output)).expanduser().resolve()
    if output.suffix.lower() != ".log":
        raise ConversionError(f"Output file must use the .log extension: {output}")
    if output == manifest:
        raise ConversionError("Output and manifest paths must be different.")
    if output in input_files or manifest in input_files:
        raise ConversionError("Output paths must not replace an input JSONL file.")
    if not overwrite:
        existing = [path for path in (output, manifest) if path.exists()]
        if existing:
            raise ConversionError(
                "Output already exists; use --overwrite to replace it atomically: "
                + ", ".join(str(path) for path in existing)
            )

    output.parent.mkdir(parents=True, exist_ok=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    output_temp: Path | None = None
    manifest_temp: Path | None = None
    output_digest = hashlib.sha256()
    output_rows = 0
    output_bytes = 0
    input_summaries: list[dict[str, Any]] = []

    try:
        output_temp = temporary_path(output)
        manifest_temp = temporary_path(manifest)
        with output_temp.open("wb") as output_handle:
            for input_file in input_files:
                summary, written_rows, written_bytes = convert_input_file(
                    input_file,
                    output_handle,
                    output_digest,
                    starting_output_rows=output_rows,
                    progress_every=progress_every,
                )
                input_summaries.append(summary)
                output_rows += written_rows
                output_bytes += written_bytes
            if output_rows == 0:
                raise ConversionError("Input JSONL contains no records.")
            output_handle.flush()
            os.fsync(output_handle.fileno())

        result = build_manifest(
            input_path=input_path.expanduser().resolve(),
            input_summaries=input_summaries,
            output_path=output,
            output_rows=output_rows,
            output_bytes=output_bytes,
            output_sha256=output_digest.hexdigest(),
        )
        with manifest_temp.open("w", encoding="utf-8", newline="\n") as manifest_handle:
            json.dump(result, manifest_handle, ensure_ascii=False, indent=2)
            manifest_handle.write("\n")
            manifest_handle.flush()
            os.fsync(manifest_handle.fileno())

        output_temp.replace(output)
        manifest_temp.replace(manifest)
        result["manifest_path"] = portable_path(manifest)
        return result
    except Exception:
        if output_temp is not None:
            output_temp.unlink(missing_ok=True)
        if manifest_temp is not None:
            manifest_temp.unlink(missing_ok=True)
        raise


def convert_click_events_s3(
    client: Any,
    input_uri: str,
    output_uri: str,
    *,
    manifest_uri: str | None = None,
    overwrite: bool = False,
    progress_every: int = 100_000,
    multipart_part_size: int = DEFAULT_MULTIPART_PART_SIZE,
) -> dict[str, Any]:
    if progress_every <= 0:
        raise ConversionError("progress_every must be greater than zero.")
    source = normalize_s3_input_location(parse_s3_uri(input_uri, require_key=True))
    output = parse_s3_uri(output_uri, require_key=True)
    manifest = parse_s3_uri(
        manifest_uri or default_s3_manifest_uri(output.uri),
        require_key=True,
    )
    if not output.key.lower().endswith(".log"):
        raise ConversionError(f"S3 output object must use the .log extension: {output.uri}")
    if output == manifest:
        raise ConversionError("S3 output and manifest objects must be different.")
    if manifest.key.lower().endswith(SUPPORTED_INPUT_SUFFIXES):
        raise ConversionError(
            f"S3 manifest object must not use a JSONL or NDJSON extension: {manifest.uri}"
        )
    if multipart_part_size < MIN_MULTIPART_PART_SIZE:
        raise ConversionError(
            f"S3 multipart part size must be at least {MIN_MULTIPART_PART_SIZE} bytes."
        )

    input_objects = discover_s3_input_objects(client, source)
    if not overwrite:
        existing = [
            location.uri
            for location in (output, manifest)
            if s3_object_exists(client, location)
        ]
        if existing:
            raise ConversionError(
                "S3 output already exists; use --overwrite to replace it: "
                + ", ".join(existing)
            )

    writer: MultipartUploadWriter | None = None
    output_digest = hashlib.sha256()
    output_rows = 0
    output_bytes = 0
    input_summaries: list[dict[str, Any]] = []
    try:
        writer = MultipartUploadWriter(
            client,
            output,
            part_size=multipart_part_size,
        )
        for input_object in input_objects:
            summary, written_rows, written_bytes = convert_s3_input_object(
                client,
                input_object,
                writer,
                output_digest,
                starting_output_rows=output_rows,
                progress_every=progress_every,
            )
            input_summaries.append(summary)
            output_rows += written_rows
            output_bytes += written_bytes
        if output_rows == 0:
            raise ConversionError(f"S3 input contains no JSONL records: {source.uri}")

        result = build_manifest(
            input_path=source.uri,
            input_summaries=input_summaries,
            output_path=output.uri,
            output_rows=output_rows,
            output_bytes=output_bytes,
            output_sha256=output_digest.hexdigest(),
        )
        writer.complete()
        manifest_body = (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode(
            "utf-8"
        )
        put_request: dict[str, Any] = {
            "Bucket": manifest.bucket,
            "Key": manifest.key,
            "Body": manifest_body,
            "ContentType": "application/json; charset=utf-8",
            "Metadata": {
                "asklake-output-sha256": result["output"]["sha256"],
                "asklake-output-rows": str(result["output"]["rows"]),
            },
        }
        if not overwrite:
            put_request["IfNoneMatch"] = "*"
        client.put_object(**put_request)
        result["manifest_path"] = manifest.uri
        return result
    except Exception:
        if writer is not None and not writer.completed:
            try:
                writer.abort()
            except Exception as cleanup_error:
                print(
                    f"warning: failed to abort S3 multipart upload for {output.uri}: "
                    f"{cleanup_error}",
                    file=os.sys.stderr,
                )
        raise


def convert_input_file(
    input_file: Path,
    output_handle: BinaryIO,
    output_digest: Any,
    *,
    starting_output_rows: int,
    progress_every: int,
) -> tuple[dict[str, Any], int, int]:
    with input_file.open("rb") as input_handle:
        return convert_input_stream(
            input_handle,
            input_label=portable_path(input_file),
            output_handle=output_handle,
            output_digest=output_digest,
            starting_output_rows=starting_output_rows,
            progress_every=progress_every,
        )


def convert_s3_input_object(
    client: Any,
    input_object: S3ObjectRef,
    output_handle: MultipartUploadWriter,
    output_digest: Any,
    *,
    starting_output_rows: int,
    progress_every: int,
) -> tuple[dict[str, Any], int, int]:
    request: dict[str, Any] = {
        "Bucket": input_object.location.bucket,
        "Key": input_object.location.key,
    }
    if input_object.etag:
        request["IfMatch"] = input_object.etag
    response = client.get_object(**request)
    input_handle = response.get("Body")
    if input_handle is None or not hasattr(input_handle, "read"):
        raise ConversionError(f"S3 object has no readable body: {input_object.location.uri}")
    try:
        summary, rows, written_bytes = convert_input_stream(
            input_handle,
            input_label=input_object.location.uri,
            output_handle=output_handle,
            output_digest=output_digest,
            starting_output_rows=starting_output_rows,
            progress_every=progress_every,
        )
    finally:
        close = getattr(input_handle, "close", None)
        if callable(close):
            close()
    if summary["bytes"] != input_object.size:
        raise ConversionError(
            f"S3 object size changed while reading {input_object.location.uri}: "
            f"listed={input_object.size} read={summary['bytes']}"
        )
    summary["etag"] = input_object.etag
    return summary, rows, written_bytes


def convert_input_stream(
    input_handle: Any,
    *,
    input_label: str,
    output_handle: Any,
    output_digest: Any,
    starting_output_rows: int,
    progress_every: int,
) -> tuple[dict[str, Any], int, int]:
    input_digest = hashlib.sha256()
    input_bytes = 0
    rows = 0
    written_bytes = 0

    for line_number, raw_line in enumerate(iter_binary_lines(input_handle), start=1):
        input_digest.update(raw_line)
        input_bytes += len(raw_line)
        stripped = raw_line.strip()
        if not stripped:
            raise ConversionError(f"Blank JSONL record: {input_label}:{line_number}")
        try:
            decoded = stripped.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ConversionError(
                f"Input is not valid UTF-8: {input_label}:{line_number}: {error}"
            ) from error
        try:
            record = json.loads(decoded)
        except json.JSONDecodeError as error:
            raise ConversionError(
                f"Invalid JSON object: {input_label}:{line_number}: {error.msg}"
            ) from error
        log_line = encode_record(record, input_label, line_number)
        output_handle.write(log_line)
        output_digest.update(log_line)
        rows += 1
        written_bytes += len(log_line)
        total_rows = starting_output_rows + rows
        if total_rows % progress_every == 0:
            print(
                f"converted {total_rows:,} rows -> {output_handle.name}",
                file=os.sys.stderr,
            )

    return (
        {
            "path": input_label,
            "rows": rows,
            "bytes": input_bytes,
            "sha256": input_digest.hexdigest(),
        },
        rows,
        written_bytes,
    )


def iter_binary_lines(input_handle: Any) -> Iterator[bytes]:
    pending = bytearray()
    while True:
        chunk = input_handle.read(S3_READ_CHUNK_SIZE)
        if not chunk:
            break
        if not isinstance(chunk, bytes):
            raise ConversionError("JSONL input stream must return bytes.")
        pending.extend(chunk)
        consumed = 0
        while True:
            newline = pending.find(b"\n", consumed)
            if newline < 0:
                break
            yield bytes(pending[consumed : newline + 1])
            consumed = newline + 1
        if consumed:
            del pending[:consumed]
    if pending:
        yield bytes(pending)


def discover_s3_input_objects(client: Any, source: S3Location) -> list[S3ObjectRef]:
    objects: list[S3ObjectRef] = []
    continuation_token: str | None = None
    seen_tokens: set[str] = set()
    while True:
        request: dict[str, Any] = {"Bucket": source.bucket, "Prefix": source.key}
        if continuation_token:
            request["ContinuationToken"] = continuation_token
        response = client.list_objects_v2(**request)
        for item in response.get("Contents") or []:
            key = str(item.get("Key") or "")
            if source.key.lower().endswith(SUPPORTED_INPUT_SUFFIXES) and key != source.key:
                continue
            if not is_supported_input_name(key.rsplit("/", 1)[-1]):
                continue
            objects.append(
                S3ObjectRef(
                    location=S3Location(source.bucket, key),
                    size=int(item.get("Size") or 0),
                    etag=str(item.get("ETag") or ""),
                )
            )
        if not response.get("IsTruncated"):
            break
        next_token = str(response.get("NextContinuationToken") or "")
        if not next_token or next_token in seen_tokens:
            raise ConversionError(f"S3 listing returned an invalid continuation token: {source.uri}")
        seen_tokens.add(next_token)
        continuation_token = next_token
    objects.sort(key=lambda item: item.location.key)
    if not objects:
        raise ConversionError(f"S3 prefix contains no JSONL or NDJSON objects: {source.uri}")
    return objects


def normalize_s3_input_location(source: S3Location) -> S3Location:
    if source.key.lower().endswith(SUPPORTED_INPUT_SUFFIXES):
        return source
    return S3Location(source.bucket, f"{source.key.rstrip('/')}/")


def is_supported_input_name(name: str) -> bool:
    return (
        bool(name)
        and not name.startswith((".", "_"))
        and name.lower().endswith(SUPPORTED_INPUT_SUFFIXES)
    )


def parse_s3_uri(value: str, *, require_key: bool) -> S3Location:
    parsed = urlsplit(value)
    if parsed.scheme.lower() != "s3" or not parsed.netloc:
        raise ConversionError(f"Expected an s3://bucket/key URI: {value}")
    if parsed.query or parsed.fragment or parsed.username or parsed.password or parsed.port:
        raise ConversionError(f"S3 URI must not contain credentials, query, fragment, or port: {value}")
    key = parsed.path.lstrip("/")
    if require_key and not key:
        raise ConversionError(f"S3 URI must include an object key or prefix: {value}")
    if "\\" in key or any(ord(character) < 32 for character in key):
        raise ConversionError(f"S3 key contains an unsupported character: {value}")
    return S3Location(parsed.netloc, key)


def s3_object_exists(client: Any, location: S3Location) -> bool:
    try:
        client.head_object(Bucket=location.bucket, Key=location.key)
        return True
    except Exception as error:
        response = getattr(error, "response", {})
        code = str(response.get("Error", {}).get("Code", ""))
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in {"404", "NoSuchKey", "NotFound"} or status == 404:
            return False
        raise


def create_s3_client(
    *,
    endpoint_url: str | None,
    region_name: str | None,
    force_path_style: bool,
) -> Any:
    if endpoint_url:
        parsed_endpoint = urlsplit(endpoint_url)
        if (
            parsed_endpoint.scheme not in {"http", "https"}
            or not parsed_endpoint.netloc
            or parsed_endpoint.username
            or parsed_endpoint.password
            or parsed_endpoint.query
            or parsed_endpoint.fragment
        ):
            raise ConversionError(
                "--s3-endpoint-url must be an http(s) URL without credentials, query, or fragment."
            )
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise ConversionError(
            "S3 conversion requires backend/requirements.txt dependencies; install boto3."
        ) from error

    options: dict[str, Any] = {}
    if endpoint_url:
        options["endpoint_url"] = endpoint_url
    if region_name:
        options["region_name"] = region_name
    if force_path_style:
        options["config"] = Config(s3={"addressing_style": "path"})
    return boto3.client("s3", **options)


def encode_record(record: Any, input_label: str, line_number: int) -> bytes:
    if not isinstance(record, dict):
        raise ConversionError(f"JSONL record must be an object: {input_label}:{line_number}")
    tokens = [encode_field(record, spec, input_label, line_number) for spec in FIELD_SPECS]
    if len(tokens) != len(FIELD_SPECS) or any(WHITESPACE.search(token) for token in tokens):
        raise ConversionError(f"Log tokenization invariant failed: {input_label}:{line_number}")
    return (" ".join(tokens) + "\n").encode("utf-8")


def encode_field(
    record: dict[str, Any],
    spec: FieldSpec,
    input_label: str,
    line_number: int,
) -> str:
    value: Any = record
    for segment in spec.path:
        if not isinstance(value, dict) or segment not in value:
            raise ConversionError(
                f"Missing required field {'.'.join(spec.path)}: {input_label}:{line_number}"
            )
        value = value[segment]
    if value is None:
        raise ConversionError(
            f"Null required field {'.'.join(spec.path)}: {input_label}:{line_number}"
        )
    if spec.inferred_type == "Integer":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ConversionError(
                f"Field {'.'.join(spec.path)} must be an integer: "
                f"{input_label}:{line_number}"
            )
    elif not isinstance(value, str):
        raise ConversionError(
            f"Field {'.'.join(spec.path)} must be a string: {input_label}:{line_number}"
        )
    text = str(value)
    if not text:
        raise ConversionError(
            f"Empty required field {'.'.join(spec.path)}: {input_label}:{line_number}"
        )
    return escape_whitespace(text)


def escape_whitespace(value: str) -> str:
    parts: list[str] = []
    for character in value:
        if character.isspace():
            parts.extend(f"%{byte:02X}" for byte in character.encode("utf-8"))
        else:
            parts.append(character)
    escaped = "".join(parts)
    if not escaped or WHITESPACE.search(escaped):
        raise ConversionError("A log token could not be encoded without whitespace.")
    return escaped


def build_manifest(
    *,
    input_path: Path | str,
    input_summaries: list[dict[str, Any]],
    output_path: Path | str,
    output_rows: int,
    output_bytes: int,
    output_sha256: str,
) -> dict[str, Any]:
    return {
        "converter_version": CONVERTER_VERSION,
        "format": "asklake_whitespace_click_log",
        "delimiter_kind": "whitespace",
        "delimiter_pattern": "\\s+",
        "header": False,
        "column_order": [spec.output_name for spec in FIELD_SPECS],
        "whitespace_encoding": (
            "Unicode whitespace as UTF-8 percent bytes (for example, a space becomes %20)"
        ),
        "input": {
            "path": portable_location(input_path),
            "file_count": len(input_summaries),
            "rows": sum(item["rows"] for item in input_summaries),
            "bytes": sum(item["bytes"] for item in input_summaries),
            "files": input_summaries,
        },
        "output": {
            "path": portable_location(output_path),
            "file_count": 1,
            "rows": output_rows,
            "bytes": output_bytes,
            "sha256": output_sha256,
        },
        "record_parsing": {
            "enabled": True,
            "delimiterKind": "whitespace",
            "delimiterPattern": "\\s+",
            "header": False,
            "expectedFieldCount": len(FIELD_SPECS),
            "columns": [
                {
                    "position": position,
                    "name": spec.output_name,
                    "inferredType": spec.inferred_type,
                }
                for position, spec in enumerate(FIELD_SPECS)
            ],
        },
    }


def default_manifest_path(output_path: Path) -> Path:
    return output_path.with_name(f"{output_path.name}.manifest.json")


def default_s3_manifest_uri(output_uri: str) -> str:
    return f"{output_uri}.manifest.json"


def temporary_path(destination: Path) -> Path:
    descriptor, name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
    )
    os.close(descriptor)
    return Path(name)


def portable_location(value: Path | str) -> str:
    return portable_path(value) if isinstance(value, Path) else value


def portable_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(BACKEND_DIR.parent).as_posix()
    except ValueError:
        return resolved.as_posix()


def print_summary(result: dict[str, Any]) -> None:
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    s3_mode = bool(args.input_s3_uri or args.output_s3_uri or args.manifest_s3_uri)
    try:
        if s3_mode:
            if not args.input_s3_uri or not args.output_s3_uri:
                raise ConversionError(
                    "S3 mode requires both --input-s3-uri and --output-s3-uri."
                )
            if args.input is not None or args.output is not None or args.manifest is not None:
                raise ConversionError("Do not mix local path options with S3 URI options.")
            part_size = args.multipart_part_size_mib * 1024 * 1024
            if part_size < MIN_MULTIPART_PART_SIZE:
                raise ConversionError("--multipart-part-size-mib must be at least 5.")
            client = create_s3_client(
                endpoint_url=args.s3_endpoint_url,
                region_name=args.s3_region,
                force_path_style=args.s3_force_path_style,
            )
            result = convert_click_events_s3(
                client,
                args.input_s3_uri,
                args.output_s3_uri,
                manifest_uri=args.manifest_s3_uri,
                overwrite=args.overwrite,
                progress_every=args.progress_every,
                multipart_part_size=part_size,
            )
        else:
            result = convert_click_events(
                args.input or DEFAULT_INPUT,
                args.output or DEFAULT_OUTPUT,
                manifest_path=args.manifest,
                overwrite=args.overwrite,
                progress_every=args.progress_every,
            )
    except (ConversionError, OSError) as error:
        print(f"click log conversion failed: {error}", file=os.sys.stderr)
        return 1
    except Exception as error:
        if not s3_mode:
            raise
        print(f"click log S3 conversion failed: {error}", file=os.sys.stderr)
        return 1
    print_summary(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
