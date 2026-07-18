from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import timedelta
from typing import Any

import pendulum

try:
    from airflow.sdk import dag, task
except ImportError:
    from airflow.decorators import dag, task
from airflow.exceptions import AirflowFailException, AirflowSkipException


class RagStageRejectedError(RuntimeError):
    pass


class RagJobAlreadyComplete(RuntimeError):
    pass


class RagHttpError(RuntimeError):
    def __init__(self, status_code: int, body: str, payload: dict[str, Any] | None = None) -> None:
        super().__init__(f"RAG internal API request failed with HTTP {status_code}: {body[:2000]}")
        self.status_code = status_code
        self.body = body
        self.payload = payload or {}


RAG_PHYSICAL_TASK_RETRY_ARGS = {
    "retries": 2,
    "retry_delay": timedelta(seconds=15),
    "retry_exponential_backoff": True,
    "max_retry_delay": timedelta(minutes=2),
}
RAG_STAGE_ORDER = {
    "queued": 0,
    "staging": 1,
    "chunking": 2,
    "embedding": 3,
    "indexing": 4,
    "validating": 5,
    "ready": 6,
}
SPARK_FAILED_STATES = {"FAILED", "ERROR", "KILLED"}


def post_json(
    url: str,
    payload: dict[str, Any],
    token: str,
    *,
    timeout_seconds: int | None = None,
) -> dict[str, Any]:
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        timeout = timeout_seconds if timeout_seconds is not None else int(os.environ.get("ASKLAKE_RAG_TIMEOUT_SECONDS", "1800"))
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            error_payload = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            error_payload = {}
        raise RagHttpError(exc.code, body, error_payload if isinstance(error_payload, dict) else {}) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"RAG internal API request failed: {exc}") from exc
    if not isinstance(body, dict):
        raise RuntimeError("RAG internal API returned an invalid payload")
    return body


def get_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=int(os.environ.get("ASKLAKE_RAG_SPARK_HTTP_TIMEOUT_SECONDS", "30"))) as response:
            body = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(
            f"Spark REST GET {url} failed with HTTP {exc.code}: {detail[:2000]}"
        ) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"Spark REST GET {url} failed: {exc}") from exc
    if not isinstance(body, dict):
        raise RuntimeError("Spark REST returned an invalid payload")
    return body


def wait_for_spark_submission(
    rest_url: str,
    submission_id: str,
    *,
    stage_label: str,
) -> dict[str, str]:
    """Poll Spark until a real terminal state; UNKNOWN is transient."""

    deadline = time.time() + int(os.environ.get("ASKLAKE_RAG_SPARK_TIMEOUT_SECONDS", "7200"))
    while time.time() < deadline:
        payload = get_json(f"{rest_url}/v1/submissions/status/{submission_id}")
        state = str(payload.get("driverState") or "UNKNOWN").upper()
        if state == "FINISHED":
            return {"submissionId": submission_id, "driverState": state}
        if state in SPARK_FAILED_STATES:
            raise RuntimeError(f"{stage_label} failed: {state}")
        time.sleep(
            min(
                10,
                max(1, int(os.environ.get("ASKLAKE_RAG_SPARK_POLL_SECONDS", "5"))),
            )
        )
    raise TimeoutError(f"{stage_label} timed out")


def ensure_stage_callback_allows_work(
    response: dict[str, Any],
    *,
    expected_stage: str | None = None,
) -> dict[str, Any]:
    status = str(response.get("status") or "").strip().casefold()
    stage = str(response.get("stage") or "").strip().casefold()
    error = str(response.get("error") or "").strip()
    if status == "ready" or stage == "ready":
        raise RagJobAlreadyComplete("RAG job is already ready; physical retry is unnecessary")
    rejected = {"failed", "canceled", "cancelled", "stale", "superseded"}
    error_key = error.casefold()
    if (
        status in rejected
        or stage in rejected
        or "superseded" in error_key
        or "stale generation" in error_key
        or "no longer current" in error_key
    ):
        raise RagStageRejectedError(error or f"RAG stage was rejected with status={status or stage}")
    expected = str(expected_stage or "").strip().casefold()
    actual = stage if stage in RAG_STAGE_ORDER else status
    if expected in RAG_STAGE_ORDER and actual in RAG_STAGE_ORDER:
        if RAG_STAGE_ORDER[actual] > RAG_STAGE_ORDER[expected]:
            raise RagJobAlreadyComplete(
                f"RAG job already advanced to {actual}; {expected} physical retry is unnecessary"
            )
        if RAG_STAGE_ORDER[actual] < RAG_STAGE_ORDER[expected]:
            raise RuntimeError(
                f"RAG callback did not acknowledge stage {expected}; current stage is {actual}"
            )
    return response


def post_callback_json(url: str, payload: dict[str, Any], token: str) -> dict[str, Any]:
    """Retry only the idempotent backend callback, never Spark submission."""

    if not str(url or "").strip() or not str(token or "").strip():
        raise RuntimeError("RAG callback URL and token are required")
    attempts = max(1, min(int(os.environ.get("ASKLAKE_RAG_CALLBACK_ATTEMPTS", "3")), 5))
    timeout = max(1, min(int(os.environ.get("ASKLAKE_RAG_CALLBACK_TIMEOUT_SECONDS", "30")), 300))
    for attempt in range(1, attempts + 1):
        try:
            return post_json(url, payload, token, timeout_seconds=timeout)
        except RagHttpError as exc:
            error = exc.payload.get("error") if isinstance(exc.payload, dict) else None
            details = error.get("details") if isinstance(error, dict) and isinstance(error.get("details"), dict) else {}
            code = str(error.get("code") or "") if isinstance(error, dict) else ""
            message = str(error.get("message") or exc.body) if isinstance(error, dict) else exc.body
            if (
                code in {"rag_job_superseded", "rag_activation_rejected"}
                or (details.get("stopDag") is True and details.get("retryable") is False)
            ):
                raise RagStageRejectedError(message or code) from exc
            retryable = exc.status_code == 429 or exc.status_code >= 500
            if not retryable or attempt >= attempts:
                raise
            time.sleep(min(4.0, float(2 ** (attempt - 1))))
        except RuntimeError as exc:
            message = str(exc)
            retryable = "request failed:" in message or "HTTP 429" in message or "HTTP 5" in message
            if not retryable or attempt >= attempts:
                raise
            time.sleep(min(4.0, float(2 ** (attempt - 1))))
    raise RuntimeError("RAG callback retry loop exhausted")


def require_stage_start(
    conf: dict[str, Any],
    *,
    status: str,
    stage: str,
    counts: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base_url = (os.environ.get("ASKLAKE_EXECUTION_API_BASE_URL") or os.environ.get("AIRFLOW_INTERNAL_BASE_URL") or "").rstrip("/")
    token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN") or ""
    job_id = str(conf.get("jobId") or "").strip()
    if not base_url or not token or not job_id:
        raise RuntimeError("RAG stage callback configuration is incomplete")
    payload = {
        "status": status,
        "event": "stage_started",
        "stage": stage,
        "datasetId": conf.get("datasetId"),
        "jobId": job_id,
        "observedAt": pendulum.now("UTC").to_iso8601_string(),
        **(counts or {}),
    }
    response = post_callback_json(
        f"{base_url}/api/internal/airflow/rag-jobs/{job_id}/result",
        payload,
        token,
    )
    return ensure_stage_callback_allows_work(response, expected_stage=stage)


def guard_stage_start(conf: dict[str, Any], *, status: str, stage: str, counts: dict[str, Any] | None = None) -> None:
    try:
        require_stage_start(conf, status=status, stage=stage, counts=counts)
    except RagJobAlreadyComplete as exc:
        raise AirflowSkipException(str(exc)) from exc
    except RagStageRejectedError as exc:
        raise AirflowFailException(str(exc)) from exc


def rag_physical_column(name: str) -> str:
    value = "".join(char if char.isalnum() or char == "_" else "_" for char in str(name or "").strip().lower())
    while "__" in value:
        value = value.replace("__", "_")
    return value.strip("_") or "column"


def metadata_types(conf: dict[str, Any]) -> dict[str, str]:
    declared = conf.get("metadataTypes")
    if isinstance(declared, dict) and declared:
        return {str(key): str(value) for key, value in declared.items()}
    schema = conf.get("schema") or []
    by_name = {
        str(item.get("name")): str(item.get("dataType") or item.get("data_type") or "string")
        for item in schema
        if isinstance(item, dict) and item.get("name")
    }
    mapping = conf.get("physicalColumnMapping") if isinstance(conf.get("physicalColumnMapping"), dict) else {}
    return {str(mapping.get(str(name)) or rag_physical_column(name)): data_type for name in conf.get("metadataColumns") or [] if (data_type := by_name.get(str(name)))}


def submit_parent_spark_job(conf: dict[str, Any]) -> dict[str, Any]:
    source_path = str(conf.get("sourcePath") or "").strip()
    if not source_path.startswith(("s3a://", "s3://", "file://", "iceberg:")):
        raise ValueError("RAG Spark staging requires a Spark-readable sourcePath; Catalog readUrl is not a Spark path")
    source_manifest = conf.get("sourceManifest") if isinstance(conf.get("sourceManifest"), dict) else {}
    if str(conf.get("sourceFormat") or "").casefold() == "iceberg" and not source_manifest.get("icebergSnapshotId"):
        raise ValueError("RAG Iceberg staging requires a Catalog-verified icebergSnapshotId")
    parent_table = str(conf.get("parentTable") or "")
    parts = parent_table.split(".")
    if len(parts) != 3:
        raise ValueError("RAG parentTable must be catalog.namespace.table")
    manifest = {
        "datasetId": conf["datasetId"],
        "jobId": conf["jobId"],
        "sourcePath": source_path,
        "sourceFormat": conf.get("sourceFormat"),
        "sourceFingerprint": conf.get("sourceFingerprint"),
        "schema": conf.get("schema") or [],
        "roles": {"body": conf.get("bodyColumns") or [], "title": conf.get("titleColumns") or [], "metadata": conf.get("metadataColumns") or [], "identifier": conf.get("identifierColumns") or []},
        "physicalColumnMapping": conf.get("physicalColumnMapping") or {},
        "policyFingerprint": conf.get("policyFingerprint"),
        "stagingBasePath": conf.get("stagingBasePath"),
        "icebergTarget": {"catalog": parts[0], "namespace": parts[1], "table": parts[2], "writeMode": "replace", "tableUri": f"iceberg://{parts[0]}/{parts[1]}/{parts[2]}"},
        "sourceCollection": source_manifest.get("sourceCollection") or {},
        "sourceSnapshotId": source_manifest.get("icebergSnapshotId"),
        "callbackUrl": f"{(os.environ.get('ASKLAKE_EXECUTION_API_BASE_URL') or os.environ.get('AIRFLOW_INTERNAL_BASE_URL') or '').rstrip('/')}/api/internal/airflow/rag-jobs/{conf['jobId']}/result",
        "callbackToken": os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN") or "",
    }
    environment = {
        "ASKLAKE_RAG_PARENT_MANIFEST_JSON": json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        "ASKLAKE_SPARK_APP_NAME": f"asklake-rag-parent-{conf['jobId']}",
        "ASKLAKE_OBJECT_STORAGE_PROVIDER": os.environ.get("ASKLAKE_OBJECT_STORAGE_PROVIDER", "aws"),
        "AWS_REGION": os.environ.get("AWS_REGION", "ap-northeast-2"),
        "AWS_ACCESS_KEY_ID": os.environ.get("AWS_ACCESS_KEY_ID", ""),
        "AWS_SECRET_ACCESS_KEY": os.environ.get("AWS_SECRET_ACCESS_KEY", ""),
        "S3_ENDPOINT": os.environ.get("S3_ENDPOINT", ""),
        "S3_FORCE_PATH_STYLE": os.environ.get("S3_FORCE_PATH_STYLE", "false"),
        "ASKLAKE_SPARK_ICEBERG_CATALOG_NAME": parts[0],
        "ASKLAKE_SPARK_ICEBERG_JDBC_URL": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_URL", ""),
        "ASKLAKE_SPARK_ICEBERG_JDBC_USER": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_USER", ""),
        "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD", ""),
        "ASKLAKE_SPARK_ICEBERG_WAREHOUSE": os.environ.get("ASKLAKE_SPARK_ICEBERG_WAREHOUSE", ""),
        "PYTHONPATH": "/opt/asklake/scripts",
    }
    script = os.environ.get("ASKLAKE_RAG_PARENT_SCRIPT", "/opt/asklake/scripts/rag_parent_staging.py")
    submission = {"action": "CreateSubmissionRequest", "appResource": "", "mainClass": "org.apache.spark.deploy.SparkSubmit", "appArgs": [script], "clientSparkVersion": os.environ.get("ASKLAKE_SPARK_VERSION", "4.0.1"), "environmentVariables": environment, "sparkProperties": {"spark.master": os.environ.get("ASKLAKE_SPARK_MASTER_URL", "spark://spark-master:7077"), "spark.submit.deployMode": "cluster", "spark.cores.max": os.environ.get("ASKLAKE_SPARK_CORES_MAX", "2"), "spark.driver.memory": os.environ.get("ASKLAKE_SPARK_DRIVER_MEMORY", "1g"), "spark.executor.memory": os.environ.get("ASKLAKE_SPARK_EXECUTOR_MEMORY", "4g"), "spark.executor.cores": os.environ.get("ASKLAKE_SPARK_EXECUTOR_CORES", "2"), "spark.executorEnv.PYTHONPATH": "/opt/asklake/scripts", "spark.sql.shuffle.partitions": os.environ.get("ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS", "32"), "spark.jars.ivy": os.environ.get("ASKLAKE_SPARK_IVY_RUNTIME_DIR", "/var/lib/asklake/spark-ivy"), "spark.jars.packages": ",".join(item for item in (os.environ.get("ASKLAKE_SPARK_HADOOP_AWS_PACKAGE"), os.environ.get("ASKLAKE_SPARK_ICEBERG_PACKAGE"), os.environ.get("ASKLAKE_SPARK_POSTGRES_PACKAGE")) if item)}}
    rest_url = (os.environ.get("ASKLAKE_RAG_SPARK_REST_URL") or "http://spark-master:6066").rstrip("/")
    created = post_json(f"{rest_url}/v1/submissions/create", submission, "")
    submission_id = str(created.get("submissionId") or "")
    if not submission_id:
        raise RuntimeError("Spark REST did not return a submissionId")
    return wait_for_spark_submission(
        rest_url,
        submission_id,
        stage_label="RAG parent Spark staging",
    )


def submit_rag_spark_stage(conf: dict[str, Any], *, kind: str) -> dict[str, Any]:
    """Run the chunk or final-dispatch Spark stage with the same secure runtime contract."""
    rest_url = (os.environ.get("ASKLAKE_RAG_SPARK_REST_URL") or "http://spark-master:6066").rstrip("/")
    callback_url = f"{(os.environ.get('ASKLAKE_EXECUTION_API_BASE_URL') or os.environ.get('AIRFLOW_INTERNAL_BASE_URL') or '').rstrip('/')}/api/internal/airflow/rag-jobs/{conf['jobId']}/result"
    callback_token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN") or ""
    common = {
        "datasetId": conf["datasetId"], "jobId": conf["jobId"], "datasetName": conf.get("datasetName") or conf["datasetId"], "physicalColumnMapping": conf.get("physicalColumnMapping") or {},
        "parentTable": conf.get("parentTable"), "chunkTable": conf.get("chunkTable"), "targetIndex": conf.get("preparedIndex") or conf.get("targetIndex"),
        "chunkerUrl": os.environ.get("RAG_WORKER_BASE_URL", "http://embedding-worker:8090"), "chunkerToken": os.environ.get("RAG_WORKER_TOKEN", ""),
        "workerUrl": os.environ.get("RAG_WORKER_BASE_URL", "http://embedding-worker:8090"), "workerToken": os.environ.get("RAG_WORKER_TOKEN", ""), "embeddingModel": conf.get("embeddingModel") or os.environ.get("RAG_EMBEDDING_MODEL", "text-embedding-3-small"), "embeddingDimensions": conf.get("embeddingDimensions"),
        "chunkTargetTokens": conf.get("chunkTargetTokens", 800), "chunkOverlapTokens": conf.get("chunkOverlapTokens", 400), "chunkMaxTokens": conf.get("chunkMaxTokens", 1200), "failedRowRateThreshold": conf.get("failedRowRateThreshold", 0.05), "metadataTypes": metadata_types(conf), "parentSchemaVersion": conf.get("parentSchemaVersion", "rag-parent-v3"), "embeddingInputVersion": conf.get("embeddingInputVersion", "title_body_fields_v2"), "chunkingVersion": conf.get("chunkingVersion", "rag-chunk-v3"), "fieldRenderingVersion": conf.get("fieldRenderingVersion", "field_blocks_v1"), "callbackUrl": callback_url, "callbackToken": callback_token,
    }
    script = "/opt/asklake/scripts/rag_chunk_staging.py" if kind == "chunk" else "/opt/asklake/scripts/rag_index_dispatch.py"
    env_key = "ASKLAKE_RAG_CHUNK_MANIFEST_JSON" if kind == "chunk" else "ASKLAKE_RAG_INDEX_MANIFEST_JSON"
    environment = {env_key: json.dumps(common, ensure_ascii=False, separators=(",", ":")), "ASKLAKE_OBJECT_STORAGE_PROVIDER": os.environ.get("ASKLAKE_OBJECT_STORAGE_PROVIDER", "aws"), "AWS_REGION": os.environ.get("AWS_REGION", "ap-northeast-2"), "AWS_ACCESS_KEY_ID": os.environ.get("AWS_ACCESS_KEY_ID", ""), "AWS_SECRET_ACCESS_KEY": os.environ.get("AWS_SECRET_ACCESS_KEY", ""), "S3_ENDPOINT": os.environ.get("S3_ENDPOINT", ""), "S3_FORCE_PATH_STYLE": os.environ.get("S3_FORCE_PATH_STYLE", "false"), "PYTHONPATH": "/opt/asklake/scripts", "ASKLAKE_SPARK_ICEBERG_CATALOG_NAME": str(conf.get("parentTable") or conf.get("chunkTable")).split(".")[0], "ASKLAKE_SPARK_ICEBERG_JDBC_URL": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_URL", ""), "ASKLAKE_SPARK_ICEBERG_JDBC_USER": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_USER", ""), "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD", ""), "ASKLAKE_SPARK_ICEBERG_WAREHOUSE": os.environ.get("ASKLAKE_SPARK_ICEBERG_WAREHOUSE", "")}
    submission = {"action": "CreateSubmissionRequest", "appResource": "", "mainClass": "org.apache.spark.deploy.SparkSubmit", "appArgs": [script], "clientSparkVersion": os.environ.get("ASKLAKE_SPARK_VERSION", "4.0.1"), "environmentVariables": environment, "sparkProperties": {"spark.master": os.environ.get("ASKLAKE_SPARK_MASTER_URL", "spark://spark-master:7077"), "spark.submit.deployMode": "cluster", "spark.cores.max": os.environ.get("ASKLAKE_SPARK_CORES_MAX", "2"), "spark.driver.memory": os.environ.get("ASKLAKE_SPARK_DRIVER_MEMORY", "1g"), "spark.executor.memory": os.environ.get("ASKLAKE_SPARK_EXECUTOR_MEMORY", "4g"), "spark.executor.cores": os.environ.get("ASKLAKE_SPARK_EXECUTOR_CORES", "2"), "spark.executorEnv.PYTHONPATH": "/opt/asklake/scripts", "spark.sql.shuffle.partitions": os.environ.get("ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS", "32"), "spark.jars.ivy": os.environ.get("ASKLAKE_SPARK_IVY_RUNTIME_DIR", "/var/lib/asklake/spark-ivy"), "spark.jars.packages": ",".join(item for item in (os.environ.get("ASKLAKE_SPARK_HADOOP_AWS_PACKAGE"), os.environ.get("ASKLAKE_SPARK_ICEBERG_PACKAGE"), os.environ.get("ASKLAKE_SPARK_POSTGRES_PACKAGE")) if item)}}
    created = post_json(f"{rest_url}/v1/submissions/create", submission, "")
    submission_id = str(created.get("submissionId") or "")
    if not submission_id:
        raise RuntimeError(f"RAG {kind} Spark stage did not return a submissionId")
    return wait_for_spark_submission(
        rest_url,
        submission_id,
        stage_label=f"RAG {kind} Spark stage",
    )


def rag_dag_failure_callback(context: dict[str, Any]) -> None:
    dag_run = context.get("dag_run")
    conf = dict(getattr(dag_run, "conf", None) or {})
    job_id = str(conf.get("jobId") or "")
    if not job_id:
        return
    backend_url = (os.environ.get("ASKLAKE_EXECUTION_API_BASE_URL") or os.environ.get("AIRFLOW_INTERNAL_BASE_URL") or "").rstrip("/")
    token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN") or ""
    if not backend_url or not token:
        raise RuntimeError("RAG DAG failure callback is not configured")
    try:
        post_callback_json(f"{backend_url}/api/internal/airflow/rag-jobs/{job_id}/result", {"status": "failed", "error": "Airflow RAG DAG failed; inspect the failed task logs"}, token)
    except Exception as exc:
        print(f"RAG DAG failure callback could not be acknowledged for job {job_id}: {exc}", file=sys.stderr)
        raise


@dag(dag_id="asklake_rag_index", schedule=None, start_date=pendulum.datetime(2026, 1, 1, tz="UTC"), catchup=False, tags=["asklake", "rag", "opensearch"], is_paused_upon_creation=False, on_failure_callback=rag_dag_failure_callback)
def asklake_rag_index() -> None:
    @task(task_id="receive_rag_index_request")
    def receive(**context: Any) -> dict[str, Any]:
        conf = dict(context["dag_run"].conf or {})
        for key in ("jobId", "datasetId", "targetIndex"):
            if not conf.get(key):
                raise ValueError(f"RAG DAG conf must include {key}")
        return conf

    @task(task_id="validate_rag_source")
    def validate(conf: dict[str, Any]) -> dict[str, Any]:
        manifest = conf.get("sourceManifest")
        if not isinstance(manifest, dict) or manifest.get("manifestVersion") != 1 or manifest.get("datasetId") != conf.get("datasetId") or not manifest.get("readUrl") or not manifest.get("sparkPath") or not manifest.get("format") or not manifest.get("fingerprint") or not manifest.get("expiresAt") or (str(manifest.get("format") or "").casefold() == "iceberg" and not manifest.get("icebergSnapshotId")):
            raise ValueError("RAG indexing requires a Catalog-issued sourceManifest")
        if not conf.get("bodyColumns"):
            raise ValueError("RAG indexing requires approved bodyColumns")
        return conf

    @task(task_id="stage_parent_documents", **RAG_PHYSICAL_TASK_RETRY_ARGS)
    def stage_parent_documents(conf: dict[str, Any]) -> dict[str, Any]:
        guard_stage_start(conf, status="parent_staged", stage="staging")
        result = submit_parent_spark_job(conf)
        return {"conf": conf, "spark": result}

    @task(task_id="stage_chunks", **RAG_PHYSICAL_TASK_RETRY_ARGS)
    def stage_chunks(bundle: dict[str, Any]) -> dict[str, Any]:
        conf = bundle["conf"]
        conf["parentStage"] = bundle.get("spark")
        guard_stage_start(conf, status="chunked", stage="chunking")
        return {"conf": conf, "spark": submit_rag_spark_stage(conf, kind="chunk")}

    @task(task_id="prepare_index_version")
    def prepare(bundle: dict[str, Any]) -> dict[str, Any]:
        conf = bundle["conf"]
        conf["preparedIndex"] = conf["targetIndex"]
        conf["chunkStage"] = bundle["spark"]
        return conf

    @task(task_id="run_embedding_worker", **RAG_PHYSICAL_TASK_RETRY_ARGS)
    def run_worker(conf: dict[str, Any]) -> dict[str, Any]:
        guard_stage_start(conf, status="embedding", stage="embedding")
        return submit_rag_spark_stage(conf, kind="index")

    @task(task_id="verify_opensearch_counts")
    def verify(conf: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        if result.get("driverState") != "FINISHED":
            raise ValueError("OpenSearch dispatch Spark stage did not finish")
        return {"conf": conf, "result": result}

    @task(task_id="validate_opensearch_index", **RAG_PHYSICAL_TASK_RETRY_ARGS)
    def validate_opensearch(bundle: dict[str, Any]) -> dict[str, Any]:
        base_url = os.environ.get("ASKLAKE_EXECUTION_API_BASE_URL") or os.environ.get("AIRFLOW_INTERNAL_BASE_URL")
        token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN")
        guard_stage_start(
            bundle["conf"],
            status="validating",
            stage="validating",
            counts={
                "documentCount": bundle["result"].get("documentCount"),
                "chunkCount": bundle["result"].get("chunkCount"),
                "parentCount": bundle["result"].get("parentCount"),
                "indexedCount": bundle["result"].get("indexedCount"),
                "dimensions": bundle["result"].get("dimensions"),
                "embeddingProvider": bundle["result"].get("embeddingProvider"),
                "embeddingModel": bundle["result"].get("embeddingModel"),
            },
        )
        validation = post_callback_json(f"{base_url.rstrip('/')}/api/internal/airflow/rag-jobs/{bundle['conf']['jobId']}/validate", {}, token)
        if validation.get("validationPassed") is not True:
            raise ValueError("OpenSearch physical index validation failed")
        return {"conf": bundle["conf"], "result": bundle["result"], "validation": validation}

    @task(task_id="activate_index_alias", **RAG_PHYSICAL_TASK_RETRY_ARGS)
    def activate(bundle: dict[str, Any]) -> dict[str, Any]:
        base_url = os.environ.get("ASKLAKE_EXECUTION_API_BASE_URL") or os.environ.get("AIRFLOW_INTERNAL_BASE_URL")
        token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN")
        return post_callback_json(f"{base_url.rstrip('/')}/api/internal/airflow/rag-jobs/{bundle['conf']['jobId']}/result", {"status": "success", "validationPassed": bundle["validation"].get("validationPassed"), "indexedCount": bundle["validation"].get("documentCount"), "parentCount": bundle["validation"].get("parentCount"), "dimensions": bundle["validation"].get("dimensions"), "activeIndex": bundle["conf"]["preparedIndex"]}, token)

    received = receive()
    validated = validate(received)
    staged = stage_parent_documents(validated)
    chunked = stage_chunks(staged)
    prepared = prepare(chunked)
    result = run_worker(prepared)
    bundle = verify(prepared, result)
    validated_index = validate_opensearch(bundle)
    activate(validated_index)


asklake_rag_index()
