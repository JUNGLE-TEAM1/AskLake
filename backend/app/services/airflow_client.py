from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

AIRFLOW_V2_API_PREFIX = "/api/v2"
HTTP_502_BAD_GATEWAY = 502
HTTP_503_SERVICE_UNAVAILABLE = 503

RUN_STATUS_BY_AIRFLOW_STATE = {
    "queued": "queued",
    "scheduled": "queued",
    "deferred": "queued",
    "up_for_retry": "queued",
    "running": "running",
    "success": "success",
    "failed": "failed",
    "upstream_failed": "failed",
    "skipped": "failed",
    "removed": "failed",
}

STEP_STATUS_BY_AIRFLOW_STATE = {
    "queued": "pending",
    "scheduled": "pending",
    "deferred": "pending",
    "up_for_retry": "pending",
    "running": "running",
    "success": "success",
    "failed": "failed",
    "upstream_failed": "failed",
    "skipped": "blocked",
    "removed": "blocked",
}

TERMINAL_ASKLAKE_RUN_STATUSES = {"success", "failed", "canceled"}


@dataclass(frozen=True)
class AirflowClientConfig:
    api_base_url: str
    dag_id: str
    api_token: str | None = None
    username: str | None = None
    password: str | None = None
    request_timeout_seconds: float = 10.0
    ui_base_url: str | None = None

    @classmethod
    def from_settings(cls, source: object | None = None) -> AirflowClientConfig:
        if source is None:
            from app.core.config import settings as source

        missing = cls.missing_settings(source)
        if missing:
            raise api_error(
                "AIRFLOW_CONFIG_MISSING",
                f"Missing Airflow backend configuration: {', '.join(missing)}",
                HTTP_503_SERVICE_UNAVAILABLE,
                {"missing": missing},
            )
        return cls(
            api_base_url=string_or_none(getattr(source, "airflow_api_base_url", None)) or "",
            dag_id=string_or_none(getattr(source, "airflow_dag_id", None)) or "",
            api_token=string_or_none(getattr(source, "airflow_api_token", None)),
            username=string_or_none(getattr(source, "airflow_username", None)),
            password=string_or_none(getattr(source, "airflow_password", None)),
            request_timeout_seconds=float(getattr(source, "airflow_request_timeout_seconds", 10.0) or 10.0),
            ui_base_url=string_or_none(getattr(source, "airflow_ui_base_url", None)),
        )

    @staticmethod
    def missing_settings(source: object) -> list[str]:
        missing = []
        if not string_or_none(getattr(source, "airflow_api_base_url", None)):
            missing.append("AIRFLOW_API_BASE_URL")
        if not string_or_none(getattr(source, "airflow_dag_id", None)):
            missing.append("AIRFLOW_DAG_ID")
        return missing


@dataclass(frozen=True)
class AirflowDagRun:
    dag_id: str
    dag_run_id: str
    state: str | None
    asklake_status: str
    conf: dict[str, Any] | None
    raw: dict[str, Any]

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> AirflowDagRun:
        state = string_or_none(payload.get("state"))
        return cls(
            dag_id=str(payload.get("dag_id") or ""),
            dag_run_id=str(payload.get("dag_run_id") or payload.get("run_id") or ""),
            state=state,
            asklake_status=airflow_run_status(state),
            conf=payload.get("conf") if isinstance(payload.get("conf"), dict) else None,
            raw=payload,
        )


@dataclass(frozen=True)
class AirflowTaskInstance:
    task_id: str
    dag_id: str
    dag_run_id: str
    state: str | None
    asklake_status: str
    raw: dict[str, Any]

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> AirflowTaskInstance:
        state = string_or_none(payload.get("state"))
        return cls(
            task_id=str(payload.get("task_id") or ""),
            dag_id=str(payload.get("dag_id") or ""),
            dag_run_id=str(payload.get("dag_run_id") or ""),
            state=state,
            asklake_status=airflow_step_status(state),
            raw=payload,
        )


class AirflowClient:
    def __init__(
        self,
        config: AirflowClientConfig | None = None,
        *,
        opener: Callable[..., Any] = urlopen,
    ) -> None:
        self.config = config or AirflowClientConfig.from_settings()
        self._opener = opener
        self._access_token: str | None = None

    def trigger_dag_run(
        self,
        *,
        dag_run_id: str,
        conf: dict[str, Any],
        logical_date: str | None = None,
        note: str | None = None,
    ) -> AirflowDagRun:
        payload = {
            "dag_run_id": dag_run_id,
            "logical_date": logical_date,
            "conf": conf,
        }
        if note:
            payload["note"] = note
        response = self._request_json(
            "POST",
            f"/dags/{path_segment(self.config.dag_id)}/dagRuns",
            payload,
        )
        return AirflowDagRun.from_payload(response)

    def get_dag_run(self, dag_run_id: str) -> AirflowDagRun:
        response = self._request_json(
            "GET",
            f"/dags/{path_segment(self.config.dag_id)}/dagRuns/{path_segment(dag_run_id)}",
        )
        return AirflowDagRun.from_payload(response)

    def list_task_instances(self, dag_run_id: str, *, limit: int = 100) -> list[AirflowTaskInstance]:
        response = self._request_json(
            "GET",
            f"/dags/{path_segment(self.config.dag_id)}/dagRuns/{path_segment(dag_run_id)}/taskInstances",
            query={"limit": str(limit)},
        )
        task_instances = response.get("task_instances")
        if not isinstance(task_instances, list):
            raise api_error(
                "AIRFLOW_BAD_RESPONSE",
                "Airflow task instance response did not include task_instances.",
                HTTP_502_BAD_GATEWAY,
                {"dagId": self.config.dag_id, "dagRunId": dag_run_id},
            )
        return [
            AirflowTaskInstance.from_payload(item)
            for item in task_instances
            if isinstance(item, dict)
        ]

    def get_task_log(
        self,
        dag_run_id: str,
        task_id: str,
        *,
        try_number: int = 1,
    ) -> str:
        response = self._request_json(
            "GET",
            (
                f"/dags/{path_segment(self.config.dag_id)}/dagRuns/{path_segment(dag_run_id)}"
                f"/taskInstances/{path_segment(task_id)}/logs/{max(0, try_number)}"
            ),
            query={"full_content": "true"},
        )
        content = response.get("content")
        if not isinstance(content, list):
            raise api_error(
                "AIRFLOW_BAD_RESPONSE",
                "Airflow task log response did not include content.",
                HTTP_502_BAD_GATEWAY,
                {"dagId": self.config.dag_id, "dagRunId": dag_run_id, "taskId": task_id},
            )
        lines = []
        for item in content:
            if isinstance(item, dict):
                timestamp = string_or_none(item.get("timestamp"))
                event = string_or_none(item.get("event"))
                if event:
                    lines.append(f"{timestamp} {event}" if timestamp else event)
            elif item is not None:
                lines.append(str(item))
        return "\n".join(lines)

    def dag_run_url(self, dag_run_id: str) -> str | None:
        if not self.config.ui_base_url:
            return None
        base = self.config.ui_base_url.rstrip("/")
        query = urlencode({"dag_run_id": dag_run_id})
        return f"{base}/dags/{path_segment(self.config.dag_id)}/grid?{query}"

    def _request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        query: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        import json

        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        url = airflow_api_url(self.config.api_base_url, path, query)
        request = Request(url, data=body, method=method, headers=self._headers(payload is not None))
        try:
            with self._opener(request, timeout=self.config.request_timeout_seconds) as response:
                response_body = response.read().decode("utf-8")
        except HTTPError as exc:
            raise airflow_http_error(exc, method, path) from exc
        except (TimeoutError, URLError) as exc:
            raise api_error(
                "AIRFLOW_API_UNAVAILABLE",
                f"Airflow API request failed: {method} {path}",
                HTTP_502_BAD_GATEWAY,
                {"reason": str(exc), "dagId": self.config.dag_id},
            ) from exc

        try:
            parsed = json.loads(response_body or "{}")
        except json.JSONDecodeError as exc:
            raise api_error(
                "AIRFLOW_BAD_RESPONSE",
                "Airflow API returned invalid JSON.",
                HTTP_502_BAD_GATEWAY,
                {"path": path, "body": response_body[-1000:]},
            ) from exc
        if not isinstance(parsed, dict):
            raise api_error(
                "AIRFLOW_BAD_RESPONSE",
                "Airflow API returned an unexpected JSON shape.",
                HTTP_502_BAD_GATEWAY,
                {"path": path},
            )
        return parsed

    def _headers(self, has_body: bool) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if has_body:
            headers["Content-Type"] = "application/json"
        token = self.config.api_token or self._jwt_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _jwt_token(self) -> str | None:
        if self._access_token:
            return self._access_token
        if not (self.config.username and self.config.password):
            return None

        import json

        payload = {
            "username": self.config.username,
            "password": self.config.password,
        }
        body = json.dumps(payload).encode("utf-8")
        request = Request(
            airflow_auth_token_url(self.config.api_base_url),
            data=body,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with self._opener(request, timeout=self.config.request_timeout_seconds) as response:
                response_body = response.read().decode("utf-8")
        except HTTPError as exc:
            raise airflow_http_error(exc, "POST", "/auth/token") from exc
        except (TimeoutError, URLError) as exc:
            raise api_error(
                "AIRFLOW_API_UNAVAILABLE",
                "Airflow auth token request failed.",
                HTTP_502_BAD_GATEWAY,
                {"reason": str(exc), "dagId": self.config.dag_id},
            ) from exc

        try:
            parsed = json.loads(response_body or "{}")
        except json.JSONDecodeError as exc:
            raise api_error(
                "AIRFLOW_BAD_RESPONSE",
                "Airflow auth token response was invalid JSON.",
                HTTP_502_BAD_GATEWAY,
                {"body": response_body[-1000:]},
            ) from exc
        if not isinstance(parsed, dict) or not string_or_none(parsed.get("access_token")):
            raise api_error(
                "AIRFLOW_BAD_RESPONSE",
                "Airflow auth token response did not include access_token.",
                HTTP_502_BAD_GATEWAY,
                {"body": response_body[-1000:]},
            )
        self._access_token = str(parsed["access_token"])
        return self._access_token


def airflow_run_status(state: str | None) -> str:
    return RUN_STATUS_BY_AIRFLOW_STATE.get(normalize_airflow_state(state), "running")


def airflow_step_status(state: str | None) -> str:
    return STEP_STATUS_BY_AIRFLOW_STATE.get(normalize_airflow_state(state), "pending")


def airflow_run_is_terminal(state: str | None) -> bool:
    return airflow_run_status(state) in TERMINAL_ASKLAKE_RUN_STATUSES


def normalize_airflow_state(state: str | None) -> str:
    return str(state or "").strip().lower()


def airflow_api_url(base_url: str, path: str, query: dict[str, str] | None = None) -> str:
    url = f"{base_url.rstrip('/')}{AIRFLOW_V2_API_PREFIX}{path}"
    if query:
        return f"{url}?{urlencode(query)}"
    return url


def airflow_auth_token_url(base_url: str) -> str:
    return f"{base_url.rstrip('/')}/auth/token"


def path_segment(value: str) -> str:
    return quote(value, safe="")


def string_or_none(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def airflow_http_error(exc: HTTPError, method: str, path: str) -> Exception:
    body = exc.read().decode("utf-8", errors="replace")
    return api_error(
        "AIRFLOW_API_ERROR",
        f"Airflow API returned {exc.code}: {method} {path}",
        HTTP_502_BAD_GATEWAY,
        {"airflowStatus": exc.code, "body": body[-2000:]},
    )


def build_airflow_client() -> AirflowClient:
    return AirflowClient(AirflowClientConfig.from_settings())


def api_error(code: str, message: str, status_code: int, details: dict[str, Any] | None = None) -> Exception:
    from app.core.errors import ApiError

    return ApiError(code, message, status_code, details)
