#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from typing import Any


MODULE_PATH = Path(__file__).with_name("convert_click_events_to_log.py")
SPEC = importlib.util.spec_from_file_location("convert_click_events_to_log", MODULE_PATH)
assert SPEC and SPEC.loader
converter = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = converter
SPEC.loader.exec_module(converter)


def click_event(index: int, *, page_url: str | None = None) -> dict[str, Any]:
    return {
        "event_id": f"EVT-{index:09d}",
        "user_id": f"USR-{index:06d}",
        "session_id": f"SES-{index:08d}",
        "event_time": f"2026-06-01T00:00:{index:02d}+09:00",
        "event_type": "product_click",
        "product_id": f"PRODUCT-{index:04d}",
        "page_url": page_url or f"/dp/PRODUCT-{index:04d}",
        "device_type": "mobile",
        "referrer": "paid_search",
        "properties": {"position": index},
    }


def encode_jsonl(rows: list[dict[str, Any]], *, final_newline: bool = True) -> bytes:
    payload = "\n".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows
    )
    if final_newline:
        payload += "\n"
    return payload.encode("utf-8")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_bytes(encode_jsonl(rows))


def etag(payload: bytes) -> str:
    return f'"{hashlib.sha256(payload).hexdigest()}"'


class FakeClientError(RuntimeError):
    def __init__(self, code: str, status: int, message: str) -> None:
        super().__init__(message)
        self.response = {
            "Error": {"Code": code, "Message": message},
            "ResponseMetadata": {"HTTPStatusCode": status},
        }


class FakeS3Client:
    def __init__(
        self,
        objects: dict[tuple[str, str], bytes] | None = None,
        *,
        page_size: int = 1000,
    ) -> None:
        self.objects = dict(objects or {})
        self.page_size = page_size
        self.uploads: dict[str, dict[str, Any]] = {}
        self.next_upload_id = 1
        self.fail_upload_part: int | None = None
        self.fail_complete = False
        self.aborted_uploads: list[tuple[str, str, str]] = []
        self.completed_uploads: list[tuple[str, str, str]] = []
        self.completed_part_counts: list[int] = []
        self.get_requests: list[tuple[str, str, str | None]] = []
        self.deleted_objects: list[tuple[str, str]] = []

    def list_objects_v2(self, **request: Any) -> dict[str, Any]:
        bucket = request["Bucket"]
        prefix = request["Prefix"]
        start = int(request.get("ContinuationToken") or 0)
        keys = sorted(
            key for candidate_bucket, key in self.objects if candidate_bucket == bucket and key.startswith(prefix)
        )
        page_keys = keys[start : start + self.page_size]
        next_index = start + len(page_keys)
        truncated = next_index < len(keys)
        return {
            "Contents": [
                {
                    "Key": key,
                    "Size": len(self.objects[(bucket, key)]),
                    "ETag": etag(self.objects[(bucket, key)]),
                }
                for key in page_keys
            ],
            "IsTruncated": truncated,
            "NextContinuationToken": str(next_index) if truncated else None,
        }

    def head_object(self, **request: Any) -> dict[str, Any]:
        identity = (request["Bucket"], request["Key"])
        if identity not in self.objects:
            raise FakeClientError("404", 404, "not found")
        payload = self.objects[identity]
        return {"ContentLength": len(payload), "ETag": etag(payload)}

    def get_object(self, **request: Any) -> dict[str, Any]:
        identity = (request["Bucket"], request["Key"])
        if identity not in self.objects:
            raise FakeClientError("NoSuchKey", 404, "not found")
        payload = self.objects[identity]
        expected = request.get("IfMatch")
        if expected and expected != etag(payload):
            raise FakeClientError("PreconditionFailed", 412, "etag changed")
        self.get_requests.append((identity[0], identity[1], expected))
        return {
            "Body": io.BytesIO(payload),
            "ContentLength": len(payload),
            "ContentType": "application/json; charset=utf-8",
            "Metadata": {},
        }

    def create_multipart_upload(self, **request: Any) -> dict[str, Any]:
        upload_id = f"upload-{self.next_upload_id}"
        self.next_upload_id += 1
        self.uploads[upload_id] = {
            "bucket": request["Bucket"],
            "key": request["Key"],
            "parts": {},
        }
        return {"UploadId": upload_id}

    def upload_part(self, **request: Any) -> dict[str, Any]:
        part_number = request["PartNumber"]
        if self.fail_upload_part == part_number:
            raise FakeClientError("InternalError", 500, "injected upload failure")
        upload = self.uploads[request["UploadId"]]
        payload = bytes(request["Body"])
        upload["parts"][part_number] = payload
        return {"ETag": etag(payload)}

    def complete_multipart_upload(self, **request: Any) -> dict[str, Any]:
        if self.fail_complete:
            raise FakeClientError("InternalError", 500, "injected completion failure")
        upload_id = request["UploadId"]
        upload = self.uploads[upload_id]
        part_numbers = [item["PartNumber"] for item in request["MultipartUpload"]["Parts"]]
        payload = b"".join(upload["parts"][part_number] for part_number in part_numbers)
        identity = (upload["bucket"], upload["key"])
        self.objects[identity] = payload
        self.completed_uploads.append((identity[0], identity[1], upload_id))
        self.completed_part_counts.append(len(part_numbers))
        del self.uploads[upload_id]
        return {"ETag": etag(payload)}

    def abort_multipart_upload(self, **request: Any) -> dict[str, Any]:
        upload_id = request["UploadId"]
        self.aborted_uploads.append((request["Bucket"], request["Key"], upload_id))
        self.uploads.pop(upload_id, None)
        return {}

    def put_object(self, **request: Any) -> dict[str, Any]:
        identity = (request["Bucket"], request["Key"])
        if request.get("IfNoneMatch") == "*" and identity in self.objects:
            raise FakeClientError("PreconditionFailed", 412, "already exists")
        payload = bytes(request["Body"])
        self.objects[identity] = payload
        return {"ETag": etag(payload)}

    def delete_object(self, **request: Any) -> dict[str, Any]:
        identity = (request["Bucket"], request["Key"])
        self.objects.pop(identity, None)
        self.deleted_objects.append(identity)
        return {}


class ClickLogConverterTests(unittest.TestCase):
    def test_merges_parts_in_filename_order_and_writes_record_parsing_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_dir = root / "click_events"
            input_dir.mkdir()
            write_jsonl(input_dir / "part-00001.jsonl", [click_event(2)])
            write_jsonl(input_dir / "part-00000.jsonl", [click_event(1)])
            (input_dir / "_temporary.jsonl").write_text("not-json\n", encoding="utf-8")
            (input_dir / ".partial.ndjson").write_text("not-json\n", encoding="utf-8")
            output = root / "click-events.log"

            result = converter.convert_click_events(input_dir, output, progress_every=10)

            lines = output.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(lines[0].split()[1], "EVT-000000001")
            self.assertEqual(lines[1].split()[1], "EVT-000000002")
            self.assertTrue(all(len(line.split()) == 10 for line in lines))
            self.assertEqual(result["input"]["file_count"], 2)
            self.assertEqual(result["input"]["rows"], 2)
            self.assertEqual(result["output"]["rows"], 2)
            self.assertEqual(result["record_parsing"]["expectedFieldCount"], 10)
            self.assertEqual(
                [column["name"] for column in result["record_parsing"]["columns"]],
                [spec.output_name for spec in converter.FIELD_SPECS],
            )
            manifest = json.loads(
                converter.default_manifest_path(output).read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["output"]["sha256"], result["output"]["sha256"])

    def test_percent_encodes_whitespace_so_each_record_keeps_ten_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "events.jsonl"
            write_jsonl(source, [click_event(1, page_url="/search?q=data lake")])
            output = root / "events.log"

            converter.convert_click_events(source, output, progress_every=10)

            line = output.read_text(encoding="utf-8").strip()
            self.assertIn("/search?q=data%20lake", line)
            self.assertEqual(len(line.split()), 10)

    def test_invalid_record_fails_without_publishing_local_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "invalid.jsonl"
            invalid = click_event(1)
            del invalid["properties"]["position"]
            write_jsonl(source, [invalid])
            output = root / "invalid.log"
            manifest = converter.default_manifest_path(output)

            with self.assertRaisesRegex(converter.ConversionError, "properties.position"):
                converter.convert_click_events(source, output, progress_every=10)

            self.assertFalse(output.exists())
            self.assertFalse(manifest.exists())
            self.assertEqual(list(root.glob(".*.tmp")), [])

    def test_existing_local_output_requires_explicit_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "events.jsonl"
            write_jsonl(source, [click_event(1)])
            output = root / "events.log"
            first = converter.convert_click_events(source, output, progress_every=10)

            with self.assertRaisesRegex(converter.ConversionError, "--overwrite"):
                converter.convert_click_events(source, output, progress_every=10)

            second = converter.convert_click_events(
                source,
                output,
                overwrite=True,
                progress_every=10,
            )
            self.assertEqual(first["output"]["sha256"], second["output"]["sha256"])

    def test_s3_streams_paginated_objects_in_key_order_and_writes_manifest(self) -> None:
        first = encode_jsonl([click_event(1)])
        second = encode_jsonl([click_event(2)], final_newline=False)
        client = FakeS3Client(
            {
                ("raw", "clicks/part-00001.jsonl"): second,
                ("raw", "clicks/manifest.json"): b"{}",
                ("raw", "clicks/part-00000.jsonl"): first,
                ("raw", "clicks/_temporary.jsonl"): b"not-json\n",
                ("raw", "clicks/.partial.ndjson"): b"not-json\n",
                ("raw", "clickstream/part-ignored.jsonl"): encode_jsonl([click_event(9)]),
            },
            page_size=1,
        )

        result = converter.convert_click_events_s3(
            client,
            "s3://raw/clicks",
            "s3://processed/click-events.log",
            progress_every=10,
        )

        output = client.objects[("processed", "click-events.log")]
        lines = output.decode("utf-8").splitlines()
        self.assertEqual([line.split()[1] for line in lines], ["EVT-000000001", "EVT-000000002"])
        self.assertEqual(result["input"]["file_count"], 2)
        self.assertEqual(result["input"]["path"], "s3://raw/clicks/")
        self.assertEqual(result["input"]["rows"], 2)
        self.assertEqual(result["output"]["sha256"], hashlib.sha256(output).hexdigest())
        self.assertEqual(
            [request[1] for request in client.get_requests],
            ["clicks/part-00000.jsonl", "clicks/part-00001.jsonl"],
        )
        self.assertTrue(all(request[2] for request in client.get_requests))
        manifest = json.loads(
            client.objects[("processed", "click-events.log.manifest.json")]
        )
        self.assertEqual(manifest["output"], result["output"])
        self.assertEqual(result["manifest_path"], "s3://processed/click-events.log.manifest.json")

    def test_existing_s3_output_requires_overwrite(self) -> None:
        client = FakeS3Client(
            {
                ("raw", "clicks/part-00000.jsonl"): encode_jsonl([click_event(1)]),
                ("processed", "click-events.log"): b"existing",
            }
        )

        with self.assertRaisesRegex(converter.ConversionError, "--overwrite"):
            converter.convert_click_events_s3(
                client,
                "s3://raw/clicks/",
                "s3://processed/click-events.log",
            )

        self.assertEqual(client.objects[("processed", "click-events.log")], b"existing")
        self.assertEqual(client.uploads, {})

    def test_s3_manifest_cannot_be_selected_as_jsonl_on_the_next_run(self) -> None:
        client = FakeS3Client(
            {("raw", "clicks/part-00000.jsonl"): encode_jsonl([click_event(1)])}
        )

        with self.assertRaisesRegex(converter.ConversionError, "manifest object"):
            converter.convert_click_events_s3(
                client,
                "s3://raw/clicks/",
                "s3://processed/click-events.log",
                manifest_uri="s3://raw/clicks/conversion-manifest.jsonl",
            )

        self.assertEqual(client.uploads, {})

    def test_s3_upload_failure_aborts_multipart_and_preserves_existing_output(self) -> None:
        client = FakeS3Client(
            {
                ("raw", "clicks/part-00000.jsonl"): encode_jsonl([click_event(1)]),
                ("processed", "click-events.log"): b"previous-good-output",
                ("processed", "click-events.log.manifest.json"): b"previous-good-manifest",
            }
        )
        client.fail_upload_part = 1

        with self.assertRaisesRegex(FakeClientError, "injected upload failure"):
            converter.convert_click_events_s3(
                client,
                "s3://raw/clicks/",
                "s3://processed/click-events.log",
                overwrite=True,
            )

        self.assertEqual(
            client.objects[("processed", "click-events.log")],
            b"previous-good-output",
        )
        self.assertEqual(
            client.objects[("processed", "click-events.log.manifest.json")],
            b"previous-good-manifest",
        )
        self.assertEqual(len(client.aborted_uploads), 1)
        self.assertEqual(client.uploads, {})

    def test_multipart_writer_splits_large_output_without_buffering_the_whole_object(self) -> None:
        client = FakeS3Client()
        destination = converter.S3Location("processed", "large-click-events.log")
        writer = converter.MultipartUploadWriter(
            client,
            destination,
            part_size=converter.MIN_MULTIPART_PART_SIZE,
        )
        payload = b"a" * (converter.MIN_MULTIPART_PART_SIZE + 17)

        writer.write(payload[:1_000_000])
        writer.write(payload[1_000_000:])
        writer.complete()

        self.assertEqual(client.objects[("processed", "large-click-events.log")], payload)
        self.assertEqual(client.completed_part_counts, [2])

    def test_s3_completion_failure_restores_previous_manifest_and_output(self) -> None:
        previous_output = b"previous-good-output"
        previous_manifest = b'{"previous":true}\n'
        client = FakeS3Client(
            {
                ("raw", "clicks/part-00000.jsonl"): encode_jsonl([click_event(1)]),
                ("processed", "click-events.log"): previous_output,
                ("processed", "click-events.log.manifest.json"): previous_manifest,
            }
        )
        client.fail_complete = True

        with self.assertRaisesRegex(FakeClientError, "injected completion failure"):
            converter.convert_click_events_s3(
                client,
                "s3://raw/clicks/",
                "s3://processed/click-events.log",
                overwrite=True,
            )

        self.assertEqual(client.objects[("processed", "click-events.log")], previous_output)
        self.assertEqual(
            client.objects[("processed", "click-events.log.manifest.json")],
            previous_manifest,
        )
        self.assertEqual(len(client.aborted_uploads), 1)

    def test_s3_completion_failure_removes_new_manifest_when_no_previous_result_exists(self) -> None:
        client = FakeS3Client(
            {("raw", "clicks/part-00000.jsonl"): encode_jsonl([click_event(1)])}
        )
        client.fail_complete = True

        with self.assertRaisesRegex(FakeClientError, "injected completion failure"):
            converter.convert_click_events_s3(
                client,
                "s3://raw/clicks/",
                "s3://processed/click-events.log",
            )

        self.assertNotIn(("processed", "click-events.log"), client.objects)
        self.assertNotIn(("processed", "click-events.log.manifest.json"), client.objects)
        self.assertEqual(
            client.deleted_objects,
            [("processed", "click-events.log.manifest.json")],
        )

    def test_s3_rejects_local_option_mixing_and_too_small_parts(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            return_code = converter.main(
                [
                    "--input",
                    "local.jsonl",
                    "--input-s3-uri",
                    "s3://raw/clicks/",
                    "--output-s3-uri",
                    "s3://processed/click-events.log",
                ]
            )
        self.assertEqual(return_code, 1)
        self.assertIn("Do not mix local path options", stderr.getvalue())
        with self.assertRaisesRegex(converter.ConversionError, "at least"):
            converter.convert_click_events_s3(
                FakeS3Client(),
                "s3://raw/clicks/",
                "s3://processed/click-events.log",
                multipart_part_size=1024,
            )
        with self.assertRaisesRegex(converter.ConversionError, "without credentials"):
            converter.create_s3_client(
                endpoint_url="http://user:secret@127.0.0.1:9000",
                region_name=None,
                force_path_style=True,
            )


if __name__ == "__main__":
    unittest.main()
