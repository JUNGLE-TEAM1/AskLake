#!/usr/bin/env python3
"""Delete one Kubernetes resource through kubectl proxy with a UID precondition."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import socket
import stat
import subprocess
import tempfile
import time


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float = 15.0) -> None:
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout)
        connection.connect(self.socket_path)
        self.sock = connection


def delete_with_uid(socket_path: str, resource_path: str, uid: str) -> None:
    if not resource_path.startswith("/api/"):
        raise ValueError("resource path must use the Kubernetes /api endpoint")
    if not uid:
        raise ValueError("resource UID is required")

    body = json.dumps(
        {
            "apiVersion": "v1",
            "kind": "DeleteOptions",
            "preconditions": {"uid": uid},
        },
        separators=(",", ":"),
    ).encode("utf-8")
    connection = UnixHTTPConnection(socket_path)
    try:
        connection.request(
            "DELETE",
            resource_path,
            body=body,
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
            },
        )
        response = connection.getresponse()
        response.read()
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(
                f"Kubernetes UID-precondition DELETE failed with HTTP {response.status}"
            )
    finally:
        connection.close()


def proxy_delete(resource_path: str, uid: str, kubectl: str = "kubectl") -> None:
    with tempfile.TemporaryDirectory(prefix="asklake-kubectl-proxy-") as directory:
        socket_path = os.path.join(directory, "proxy.sock")
        proxy = subprocess.Popen(
            [
                kubectl,
                "proxy",
                f"--unix-socket={socket_path}",
                "--accept-hosts=^localhost$",
                "--reject-methods=^$",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(100):
                if proxy.poll() is not None:
                    raise RuntimeError("kubectl proxy stopped before its socket was ready")
                try:
                    if stat.S_ISSOCK(os.stat(socket_path).st_mode):
                        break
                except FileNotFoundError:
                    pass
                time.sleep(0.05)
            else:
                raise RuntimeError("kubectl proxy socket was not ready within five seconds")
            delete_with_uid(socket_path, resource_path, uid)
        finally:
            if proxy.poll() is None:
                proxy.terminate()
                try:
                    proxy.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proxy.kill()
                    proxy.wait(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resource-path", required=True)
    parser.add_argument("--uid", required=True)
    args = parser.parse_args()
    proxy_delete(args.resource_path, args.uid)


if __name__ == "__main__":
    main()
