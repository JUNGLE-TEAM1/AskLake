"""Minimal contracts for ETL runtime infrastructure.

The application layer depends on these shapes instead of subprocess, local
filesystem, Airflow HTTP, or object-storage SDK details.  Production adapters
live under :mod:`app.infrastructure`; tests can provide small fakes directly.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol


class JsonDocumentState(StrEnum):
    FOUND = "found"
    MISSING = "missing"
    UNREADABLE = "unreadable"
    INVALID = "invalid"


@dataclass(frozen=True, slots=True)
class JsonDocument:
    state: JsonDocumentState
    value: dict[str, Any] | None = None
    error: str | None = None
    line: int | None = None
    column: int | None = None

    @property
    def found(self) -> bool:
        return self.state is JsonDocumentState.FOUND and self.value is not None


@dataclass(frozen=True, slots=True)
class ObjectEntry:
    key: str
    size: int | None = None


class NodeBridgePort(Protocol):
    def execute(
        self,
        script_name: str,
        success_marker: str,
        payload: dict[str, Any],
        *,
        error_marker: str,
        timeout_seconds: int,
        timeout_recovery: Callable[[], dict[str, Any]] | None = None,
    ) -> dict[str, Any]: ...


class RuntimeDocumentStore(Protocol):
    def read_json(self, path: Path) -> JsonDocument: ...

    def write_json_atomic(self, path: Path, payload: dict[str, Any]) -> None: ...


class ObjectManifestPort(Protocol):
    def ensure_exists(self, bucket: str, key: str) -> None: ...

    def list_entries(self, bucket: str, prefix: str) -> list[ObjectEntry]: ...

    def read_text(self, bucket: str, key: str) -> str: ...


class KafkaRuntimeGateway(Protocol):
    def command(
        self,
        job: Any,
        runtime: Any,
        action: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...


class AirflowGateway(Protocol):
    @property
    def config(self) -> Any: ...

    def trigger_dag_run(
        self,
        *,
        dag_run_id: str,
        conf: dict[str, Any],
        logical_date: str | None = None,
        note: str | None = None,
    ) -> Any: ...

    def get_dag_run(self, dag_run_id: str) -> Any: ...

    def list_task_instances(self, dag_run_id: str, *, limit: int = 100) -> list[Any]: ...

    def dag_run_url(self, dag_run_id: str) -> str | None: ...
