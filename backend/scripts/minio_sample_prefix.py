#!/usr/bin/env python3
"""Prepare and verify small type-specific sample prefixes in MinIO.

The script copies bounded samples from a large raw prefix into:

    {MINIO_SAMPLE_PREFIX}/{type}/...

It intentionally reads credentials only from environment variables. Install the
runtime dependency with `python -m pip install boto3`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

try:
    import boto3
    from botocore.client import Config
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError as exc:  # pragma: no cover - exercised only without deps.
    print(
        "Missing dependency: install boto3 with `python -m pip install boto3`.",
        file=sys.stderr,
    )
    raise SystemExit(2) from exc


TYPE_SUFFIXES: dict[str, tuple[str, ...]] = {
    "csv": (".csv", ".csv.gz"),
    "jsonl": (".jsonl", ".jsonl.gz", ".ndjson", ".ndjson.gz"),
    "json": (".json", ".json.gz"),
    "parquet": (".parquet",),
    "txt": (".txt", ".text", ".log", ".tsv"),
}


@dataclass(frozen=True)
class MinioConfig:
    endpoint: str
    region: str
    bucket: str
    raw_prefix: str
    sample_prefix: str
    access_key: str
    secret_key: str
    max_objects_per_type: int
    max_scan_objects: int
    max_bytes_per_object: int | None


def normalize_prefix(value: str | None, *, trailing: bool = True) -> str:
    cleaned = (value or "").strip().strip("/")
    if cleaned and trailing:
        return f"{cleaned}/"
    return cleaned


def normalize_endpoint(value: str) -> str:
    return value.strip().rstrip("/")


def getenv_first(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def required_env(*names: str) -> str:
    value = getenv_first(*names)
    if value:
        return value
    joined = " or ".join(names)
    raise ValueError(f"Missing required environment variable: {joined}")


def parse_int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 1:
        raise ValueError(f"{name} must be >= 1")
    return parsed


def parse_optional_int_env(name: str) -> int | None:
    value = os.environ.get(name)
    if not value:
        return None
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 1:
        raise ValueError(f"{name} must be >= 1")
    return parsed


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return parsed


def load_config(args: argparse.Namespace) -> MinioConfig:
    endpoint = normalize_endpoint(os.environ.get("MINIO_ENDPOINT", "http://127.0.0.1:9000"))
    return MinioConfig(
        endpoint=endpoint,
        region=os.environ.get("MINIO_REGION", "us-east-1"),
        bucket=os.environ.get("MINIO_BUCKET", "m3-raw"),
        raw_prefix=normalize_prefix(os.environ.get("MINIO_RAW_PREFIX", "raw/100gb")),
        sample_prefix=normalize_prefix(
            os.environ.get("MINIO_SAMPLE_PREFIX", "asklake_samples"),
        ),
        access_key=required_env("MINIO_ACCESS_KEY", "AWS_ACCESS_KEY_ID"),
        secret_key=required_env("MINIO_SECRET_KEY", "AWS_SECRET_ACCESS_KEY"),
        max_objects_per_type=args.max_objects_per_type
        or parse_int_env("MINIO_SAMPLE_MAX_OBJECTS_PER_TYPE", 3),
        max_scan_objects=args.max_scan_objects
        or parse_int_env("MINIO_SAMPLE_MAX_SCAN_OBJECTS", 50000),
        max_bytes_per_object=args.max_bytes_per_object
        if args.max_bytes_per_object is not None
        else parse_optional_int_env("MINIO_SAMPLE_MAX_BYTES"),
    )


def s3_client(config: MinioConfig):
    return boto3.client(
        "s3",
        aws_access_key_id=config.access_key,
        aws_secret_access_key=config.secret_key,
        endpoint_url=config.endpoint,
        region_name=config.region,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def object_type(key: str) -> str | None:
    lower = key.lower()
    for data_type, suffixes in TYPE_SUFFIXES.items():
        if lower.endswith(suffixes):
            return data_type
    return None


def iter_objects(client, bucket: str, prefix: str, max_scan_objects: int):
    paginator = client.get_paginator("list_objects_v2")
    scanned = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            key = item.get("Key", "")
            if not key or key.endswith("/"):
                continue
            scanned += 1
            if scanned > max_scan_objects:
                return
            yield item


def relative_key(source_key: str, raw_prefix: str) -> str:
    if raw_prefix and source_key.startswith(raw_prefix):
        return source_key[len(raw_prefix) :].lstrip("/")
    return source_key.lstrip("/")


def sample_key(source_key: str, config: MinioConfig, data_type: str) -> str:
    relative = relative_key(source_key, config.raw_prefix)
    if not relative:
        relative = Path(source_key).name
    return f"{config.sample_prefix}{data_type}/{relative}"


def collect_samples(client, config: MinioConfig) -> dict[str, list[dict]]:
    samples: dict[str, list[dict]] = {data_type: [] for data_type in TYPE_SUFFIXES}
    for item in iter_objects(
        client,
        config.bucket,
        config.raw_prefix,
        config.max_scan_objects,
    ):
        key = item["Key"]
        if config.sample_prefix and key.startswith(config.sample_prefix):
            continue
        data_type = object_type(key)
        if data_type is None:
            continue
        if len(samples[data_type]) >= config.max_objects_per_type:
            continue
        size = int(item.get("Size", 0))
        if config.max_bytes_per_object is not None and size > config.max_bytes_per_object:
            continue
        samples[data_type].append(item)
        if all(len(items) >= config.max_objects_per_type for items in samples.values()):
            break
    return samples


def missing_sample_types(samples: dict[str, list[dict]]) -> list[str]:
    return [data_type for data_type, items in samples.items() if not items]


def copy_samples(
    client,
    config: MinioConfig,
    samples: dict[str, list[dict]],
    *,
    dry_run: bool,
) -> list[dict]:
    manifest: list[dict] = []
    copied_at = datetime.now(timezone.utc).isoformat()
    for data_type, items in samples.items():
        for item in items:
            source_key = item["Key"]
            target_key = sample_key(source_key, config, data_type)
            record = {
                "type": data_type,
                "bucket": config.bucket,
                "source_key": source_key,
                "sample_key": target_key,
                "size": int(item.get("Size", 0)),
                "etag": (item.get("ETag") or "").strip('"'),
                "copied_at": copied_at,
                "dry_run": dry_run,
            }
            print(
                f"{'[dry-run] ' if dry_run else ''}copy "
                f"s3://{config.bucket}/{source_key} -> s3://{config.bucket}/{target_key}"
            )
            if not dry_run:
                client.copy_object(
                    Bucket=config.bucket,
                    CopySource={"Bucket": config.bucket, "Key": source_key},
                    Key=target_key,
                    MetadataDirective="COPY",
                )
            manifest.append(record)
    return manifest


def write_manifest(records: Iterable[dict], path: str | None) -> None:
    if not path:
        return
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True))
            handle.write("\n")
    print(f"manifest written: {output}")


def verify_prefix(client, config: MinioConfig) -> tuple[list[dict], bool]:
    results: list[dict] = []
    ok = True
    for data_type, suffixes in TYPE_SUFFIXES.items():
        prefix = f"{config.sample_prefix}{data_type}/"
        count = 0
        total_bytes = 0
        mismatches: list[str] = []
        for item in iter_objects(
            client,
            config.bucket,
            prefix,
            config.max_scan_objects,
        ):
            key = item["Key"]
            count += 1
            total_bytes += int(item.get("Size", 0))
            if not key.lower().endswith(suffixes):
                mismatches.append(key)
        passed = count > 0 and not mismatches
        ok = ok and passed
        result = {
            "type": data_type,
            "prefix": prefix,
            "count": count,
            "total_bytes": total_bytes,
            "mismatches": mismatches,
            "passed": passed,
        }
        print(
            f"verify {data_type}: count={count}, bytes={total_bytes}, "
            f"mismatches={len(mismatches)}, passed={passed}"
        )
        results.append(result)
    return results, ok


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare or verify AskLake MinIO sample prefixes.",
    )
    parser.add_argument(
        "action",
        choices=("prepare", "verify", "prepare-verify"),
        help="prepare copies samples; verify checks sample prefixes.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print copy actions without writing to MinIO.",
    )
    parser.add_argument(
        "--manifest-file",
        help="Optional local JSONL manifest output path.",
    )
    parser.add_argument(
        "--max-objects-per-type",
        type=positive_int,
        help="Override MINIO_SAMPLE_MAX_OBJECTS_PER_TYPE.",
    )
    parser.add_argument(
        "--max-scan-objects",
        type=positive_int,
        help="Override MINIO_SAMPLE_MAX_SCAN_OBJECTS.",
    )
    parser.add_argument(
        "--max-bytes-per-object",
        type=positive_int,
        help="Override MINIO_SAMPLE_MAX_BYTES.",
    )
    parser.add_argument(
        "--allow-missing-types",
        action="store_true",
        help="Return success even if some configured file types are not found.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        config = load_config(args)
        client = s3_client(config)

        manifest: list[dict] = []
        if args.action in {"prepare", "prepare-verify"}:
            samples = collect_samples(client, config)
            for data_type, items in samples.items():
                print(f"selected {data_type}: {len(items)} object(s)")
            missing_types = missing_sample_types(samples)
            if missing_types and not args.allow_missing_types:
                print(
                    "missing sample type(s): "
                    f"{', '.join(missing_types)}. Use --allow-missing-types to continue.",
                    file=sys.stderr,
                )
                return 1
            manifest.extend(copy_samples(client, config, samples, dry_run=args.dry_run))

        if args.action in {"verify", "prepare-verify"}:
            verify_results, ok = verify_prefix(client, config)
            manifest.extend({"verification": item} for item in verify_results)
            if not ok:
                write_manifest(manifest, args.manifest_file)
                return 1

        write_manifest(manifest, args.manifest_file)
        return 0
    except (BotoCoreError, ClientError, ValueError) as exc:
        print(f"minio sample prefix failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
