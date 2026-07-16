from __future__ import annotations

import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

from app.core.errors import ApiError
from app.infrastructure.runtime_io import (
    Boto3ObjectManifestAdapter,
    JsonFileRuntimeDocumentStore,
    SubprocessNodeBridge,
    VersionedNodeBridge,
)
from app.ports.runtime_io import JsonDocumentState
from app.services import etl_service


class SpyBridge:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def execute(self, script_name, _success_marker, payload, **_options):
        self.calls.append((script_name, payload))
        return {"ok": True}


class RuntimeIoPortTests(unittest.TestCase):
    def test_service_facade_accepts_fake_bridge_without_subprocess(self) -> None:
        bridge = SpyBridge()

        result = etl_service.run_node_bridge(
            "fake.mjs",
            "SUCCESS",
            {"jobId": "job-1"},
            error_marker="ERROR",
            timeout_seconds=1,
            bridge=bridge,
        )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(bridge.calls, [("fake.mjs", {"jobId": "job-1"})])

    def test_subprocess_bridge_returns_marker_payload_and_process_evidence(self) -> None:
        calls = []

        def runner(command, **options):
            calls.append((command, options))
            return SimpleNamespace(
                returncode=0,
                stdout='noise\nSUCCESS={"storedCount":2}\n',
                stderr="warning",
            )

        bridge = SubprocessNodeBridge(
            backend_dir=Path("/backend"),
            scripts_dir=Path("/backend/scripts"),
            runner=runner,
        )
        result = bridge.execute(
            "worker.mjs",
            "SUCCESS",
            {"jobId": "job-1"},
            error_marker="ERROR",
            timeout_seconds=7,
        )

        self.assertEqual(result["storedCount"], 2)
        self.assertIn("SUCCESS=", result["stdout"])
        self.assertEqual(result["stderr"], "warning")
        self.assertEqual(
            calls[0][0],
            ["node", str(Path("/backend/scripts/worker.mjs"))],
        )
        self.assertEqual(calls[0][1]["timeout"], 7)

    def test_subprocess_bridge_normalizes_process_failure(self) -> None:
        bridge = SubprocessNodeBridge(
            backend_dir=Path("/backend"),
            scripts_dir=Path("/backend/scripts"),
            runner=lambda *_args, **_options: SimpleNamespace(
                returncode=2,
                stdout='ERROR={"code":"WORKER_REJECTED","message":"rejected","status":409}\n',
                stderr="details",
            ),
        )

        with self.assertRaises(ApiError) as captured:
            bridge.execute(
                "worker.mjs",
                "SUCCESS",
                {},
                error_marker="ERROR",
                timeout_seconds=7,
            )

        self.assertEqual(captured.exception.code, "WORKER_REJECTED")
        self.assertEqual(captured.exception.status_code, 409)
        self.assertEqual(captured.exception.details["stderr"], "details")

    def test_subprocess_bridge_timeout_runs_recovery_once(self) -> None:
        recovery_calls = []

        def timeout(*_args, **_options):
            raise subprocess.TimeoutExpired("node", 3)

        bridge = SubprocessNodeBridge(
            backend_dir=Path("/backend"),
            scripts_dir=Path("/backend/scripts"),
            runner=timeout,
        )
        with self.assertRaises(ApiError) as captured:
            bridge.execute(
                "worker.mjs",
                "SUCCESS",
                {},
                error_marker="ERROR",
                timeout_seconds=3,
                timeout_recovery=lambda: recovery_calls.append("recover") or {"killed": True},
            )

        self.assertEqual(captured.exception.code, "BACKEND_BRIDGE_TIMEOUT")
        self.assertEqual(recovery_calls, ["recover"])
        self.assertTrue(captured.exception.details["recovery"]["succeeded"])

    def test_legacy_bridge_redacts_secrets_from_diagnostics(self) -> None:
        bridge = SubprocessNodeBridge(
            backend_dir=Path("/backend"),
            scripts_dir=Path("/backend/scripts"),
            runner=lambda *_args, **_options: SimpleNamespace(
                returncode=2,
                stdout="",
                stderr="password=plain-secret token:abc123",
            ),
        )
        with self.assertRaises(ApiError) as captured:
            bridge.execute(
                "worker.mjs",
                "SUCCESS",
                {"jobId": "job-1"},
                error_marker="ERROR",
                timeout_seconds=1,
            )
        self.assertNotIn("plain-secret", captured.exception.details["stderr"])
        self.assertNotIn("abc123", captured.exception.details["stderr"])

    def test_versioned_bridge_validates_identity_and_returns_object(self) -> None:
        calls = []

        def runner(command, **options):
            calls.append((command, options))
            request = json.loads(options["input"])
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps({
                    "version": "1.0",
                    "requestId": request["requestId"],
                    "ok": True,
                    "result": {"status": "ready"},
                }),
                stderr="",
            )

        bridge = VersionedNodeBridge(backend_dir=Path("/backend"), runner=runner)
        result = bridge.execute_operation(
            "reviewAnalysis.suggestSchema",
            {"jobId": "job-1"},
            timeout_seconds=3,
        )
        request = json.loads(calls[0][1]["input"])
        self.assertEqual(result, {"status": "ready"})
        self.assertEqual(request["version"], "1.0")
        self.assertEqual(request["requestId"], "job-1")
        self.assertTrue(request["idempotencyKey"])

    def test_versioned_bridge_classifies_malformed_json(self) -> None:
        bridge = VersionedNodeBridge(
            backend_dir=Path("/backend"),
            runner=lambda *_args, **_options: SimpleNamespace(
                returncode=0,
                stdout="log before json",
                stderr="",
            ),
        )
        with self.assertRaises(ApiError) as captured:
            bridge.execute_operation("reviewAnalysis.run", {}, timeout_seconds=1)
        self.assertEqual(captured.exception.code, "NODE_BRIDGE_PROTOCOL_ERROR")
        self.assertEqual(captured.exception.details["stage"], "protocol")

    def test_json_document_store_distinguishes_missing_invalid_and_found(self) -> None:
        store = JsonFileRuntimeDocumentStore()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.json"
            self.assertEqual(store.read_json(path).state, JsonDocumentState.MISSING)

            path.write_text("{bad", encoding="utf-8")
            invalid = store.read_json(path)
            self.assertEqual(invalid.state, JsonDocumentState.INVALID)
            self.assertEqual((invalid.line, invalid.column), (1, 2))

            store.write_json_atomic(path, {"status": "running"})
            found = store.read_json(path)
            self.assertTrue(found.found)
            self.assertEqual(found.value, {"status": "running"})
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_object_manifest_adapter_paginates_and_decodes_content(self) -> None:
        class Client:
            def __init__(self) -> None:
                self.list_calls = []

            def head_object(self, **_request):
                return {}

            def list_objects_v2(self, **request):
                self.list_calls.append(request)
                if "ContinuationToken" not in request:
                    return {
                        "Contents": [{"Key": "prefix/part-1", "Size": 1}],
                        "IsTruncated": True,
                        "NextContinuationToken": "next",
                    }
                return {
                    "Contents": [{"Key": "prefix/part-2", "Size": "2"}],
                    "IsTruncated": False,
                }

            def get_object(self, **_request):
                return {"Body": SimpleNamespace(read=lambda: b'{"ok":true}')}

        client = Client()
        adapter = Boto3ObjectManifestAdapter(client)
        adapter.ensure_exists("lake", "prefix/_SUCCESS")
        entries = adapter.list_entries("lake", "prefix/")

        self.assertEqual([(item.key, item.size) for item in entries], [
            ("prefix/part-1", 1),
            ("prefix/part-2", 2),
        ])
        self.assertEqual(client.list_calls[1]["ContinuationToken"], "next")
        self.assertEqual(json.loads(adapter.read_text("lake", "prefix/part-2")), {"ok": True})


if __name__ == "__main__":
    unittest.main()
