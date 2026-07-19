#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import socketserver
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler

from lib.delete_kubernetes_resource_with_uid import delete_with_uid


class RecordingHandler(BaseHTTPRequestHandler):
    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        content_length = int(self.headers.get("Content-Length", "0"))
        self.server.recorded_path = self.path  # type: ignore[attr-defined]
        self.server.recorded_type = self.headers.get("Content-Type")  # type: ignore[attr-defined]
        self.server.recorded_body = self.rfile.read(content_length)  # type: ignore[attr-defined]
        self.send_response(self.server.response_status)  # type: ignore[attr-defined]
        self.end_headers()
        self.wfile.write(b'{}')

    def log_message(self, _format: str, *_args: object) -> None:
        return


class UnixHTTPServer(socketserver.UnixStreamServer):
    allow_reuse_address = True


class DeleteWithUidTest(unittest.TestCase):
    def run_server(self, status: int = 200):
        temporary_directory = tempfile.TemporaryDirectory()
        socket_path = os.path.join(temporary_directory.name, "server.sock")
        server = UnixHTTPServer(socket_path, RecordingHandler)
        server.response_status = status  # type: ignore[attr-defined]
        thread = threading.Thread(target=server.handle_request, daemon=True)
        thread.start()
        return temporary_directory, socket_path, server, thread

    def test_sends_delete_options_uid_in_http_body(self) -> None:
        temporary_directory, socket_path, server, thread = self.run_server()
        try:
            resource_path = "/api/v1/namespaces/asklake-dev/configmaps/deploy-lock"
            delete_with_uid(socket_path, resource_path, "uid-from-created-lock")
            thread.join(timeout=2)
            self.assertEqual(server.recorded_path, resource_path)  # type: ignore[attr-defined]
            self.assertEqual(server.recorded_type, "application/json")  # type: ignore[attr-defined]
            self.assertEqual(
                json.loads(server.recorded_body),  # type: ignore[attr-defined]
                {
                    "apiVersion": "v1",
                    "kind": "DeleteOptions",
                    "preconditions": {"uid": "uid-from-created-lock"},
                },
            )
        finally:
            server.server_close()
            temporary_directory.cleanup()

    def test_rejects_non_success_response(self) -> None:
        temporary_directory, socket_path, server, thread = self.run_server(409)
        try:
            with self.assertRaisesRegex(RuntimeError, "HTTP 409"):
                delete_with_uid(
                    socket_path,
                    "/api/v1/namespaces/asklake-dev/configmaps/deploy-lock",
                    "stale-uid",
                )
            thread.join(timeout=2)
        finally:
            server.server_close()
            temporary_directory.cleanup()


if __name__ == "__main__":
    unittest.main()
