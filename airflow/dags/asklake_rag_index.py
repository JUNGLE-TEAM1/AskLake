from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

import pendulum

try:
    from airflow.sdk import dag, task
except ImportError:
    from airflow.decorators import dag, task


def post_json(url: str, payload: dict[str, Any], token: str) -> dict[str, Any]:
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=int(os.environ.get("ASKLAKE_RAG_TIMEOUT_SECONDS", "1800"))) as response:
            body = json.loads(response.read().decode("utf-8") or "{}")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"RAG internal API request failed: {exc}") from exc
    if not isinstance(body, dict):
        raise RuntimeError("RAG internal API returned an invalid payload")
    return body


def get_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=int(os.environ.get("ASKLAKE_RAG_SPARK_HTTP_TIMEOUT_SECONDS", "30"))) as response:
        body = json.loads(response.read().decode("utf-8") or "{}")
    if not isinstance(body, dict):
        raise RuntimeError("Spark REST returned an invalid payload")
    return body


def submit_parent_spark_job(conf: dict[str, Any]) -> dict[str, Any]:
    source_path = str(conf.get("sourcePath") or "").strip()
    if not source_path.startswith(("s3a://", "s3://", "file://", "iceberg:")):
        raise ValueError("RAG Spark staging requires a Spark-readable sourcePath; Catalog readUrl is not a Spark path")
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
        "policyFingerprint": conf.get("policyFingerprint"),
        "stagingBasePath": conf.get("stagingBasePath"),
        "icebergTarget": {"catalog": parts[0], "namespace": parts[1], "table": parts[2], "writeMode": "replace", "tableUri": f"iceberg://{parts[0]}/{parts[1]}/{parts[2]}"},
        "sourceCollection": conf.get("sourceManifest", {}).get("sourceCollection") or {},
        "callbackUrl": f"{(os.environ.get('ASKLAKE_EXECUTION_API_BASE_URL') or os.environ.get('AIRFLOW_INTERNAL_BASE_URL') or '').rstrip('/')}/api/internal/airflow/rag-jobs/{conf['jobId']}/result",
        "callbackToken": os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN") or "",
    }
    environment = {
        "ASKLAKE_RAG_PARENT_MANIFEST_JSON": json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        "ASKLAKE_SPARK_APP_NAME": f"asklake-rag-parent-{conf['jobId']}",
        "ASKLAKE_OBJECT_STORAGE_PROVIDER": os.environ.get("ASKLAKE_OBJECT_STORAGE_PROVIDER", "aws"),
        "AWS_REGION": os.environ.get("AWS_REGION", "ap-northeast-2"),
        "S3_ENDPOINT": os.environ.get("S3_ENDPOINT", ""),
        "S3_FORCE_PATH_STYLE": os.environ.get("S3_FORCE_PATH_STYLE", "false"),
        "ASKLAKE_SPARK_ICEBERG_CATALOG_NAME": parts[0],
        "ASKLAKE_SPARK_ICEBERG_JDBC_URL": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_URL", ""),
        "ASKLAKE_SPARK_ICEBERG_JDBC_USER": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_USER", ""),
        "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD", ""),
        "ASKLAKE_SPARK_ICEBERG_WAREHOUSE": os.environ.get("ASKLAKE_SPARK_ICEBERG_WAREHOUSE", ""),
    }
    script = os.environ.get("ASKLAKE_RAG_PARENT_SCRIPT", "/opt/asklake/scripts/rag_parent_staging.py")
    submission = {"action": "CreateSubmissionRequest", "appResource": "", "mainClass": "org.apache.spark.deploy.SparkSubmit", "appArgs": [script], "clientSparkVersion": os.environ.get("ASKLAKE_SPARK_VERSION", "4.0.1"), "environmentVariables": environment, "sparkProperties": {"spark.master": os.environ.get("ASKLAKE_SPARK_MASTER_URL", "spark://spark-master:7077"), "spark.submit.deployMode": "cluster", "spark.cores.max": os.environ.get("ASKLAKE_SPARK_CORES_MAX", "2"), "spark.driver.memory": os.environ.get("ASKLAKE_SPARK_DRIVER_MEMORY", "1g"), "spark.executor.memory": os.environ.get("ASKLAKE_SPARK_EXECUTOR_MEMORY", "4g"), "spark.executor.cores": os.environ.get("ASKLAKE_SPARK_EXECUTOR_CORES", "2"), "spark.sql.shuffle.partitions": os.environ.get("ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS", "32"), "spark.jars.ivy": os.environ.get("ASKLAKE_SPARK_IVY_RUNTIME_DIR", "/var/lib/asklake/spark-ivy"), "spark.jars.packages": ",".join(item for item in (os.environ.get("ASKLAKE_SPARK_HADOOP_AWS_PACKAGE"), os.environ.get("ASKLAKE_SPARK_ICEBERG_PACKAGE"), os.environ.get("ASKLAKE_SPARK_POSTGRES_PACKAGE")) if item)}}
    rest_url = (os.environ.get("ASKLAKE_RAG_SPARK_REST_URL") or "http://spark-master:6066").rstrip("/")
    created = post_json(f"{rest_url}/v1/submissions/create", submission, "")
    submission_id = str(created.get("submissionId") or "")
    if not submission_id:
        raise RuntimeError("Spark REST did not return a submissionId")
    deadline = time.time() + int(os.environ.get("ASKLAKE_RAG_SPARK_TIMEOUT_SECONDS", "7200"))
    terminal = {"FINISHED", "FAILED", "ERROR", "KILLED", "UNKNOWN"}
    while time.time() < deadline:
        state_payload = get_json(f"{rest_url}/v1/submissions/{submission_id}/status")
        state = str(state_payload.get("driverState") or "UNKNOWN").upper()
        if state in terminal:
            if state != "FINISHED":
                raise RuntimeError(f"RAG parent Spark staging failed: {state}")
            return {"submissionId": submission_id, "driverState": state}
        time.sleep(min(10, max(1, int(os.environ.get("ASKLAKE_RAG_SPARK_POLL_SECONDS", "5")))))
    raise TimeoutError("RAG parent Spark staging timed out")


def submit_rag_spark_stage(conf: dict[str, Any], *, kind: str) -> dict[str, Any]:
    """Run the chunk or final-dispatch Spark stage with the same secure runtime contract."""
    rest_url = (os.environ.get("ASKLAKE_RAG_SPARK_REST_URL") or "http://spark-master:6066").rstrip("/")
    callback_url = f"{(os.environ.get('ASKLAKE_EXECUTION_API_BASE_URL') or os.environ.get('AIRFLOW_INTERNAL_BASE_URL') or '').rstrip('/')}/api/internal/airflow/rag-jobs/{conf['jobId']}/result"
    callback_token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN") or ""
    common = {
        "datasetId": conf["datasetId"], "jobId": conf["jobId"], "datasetName": conf.get("datasetName") or conf["datasetId"],
        "parentTable": conf.get("parentTable"), "chunkTable": conf.get("chunkTable"), "targetIndex": conf.get("preparedIndex") or conf.get("targetIndex"),
        "chunkerUrl": os.environ.get("RAG_WORKER_BASE_URL", "http://embedding-worker:8090"), "chunkerToken": os.environ.get("RAG_WORKER_TOKEN", ""),
        "workerUrl": os.environ.get("RAG_WORKER_BASE_URL", "http://embedding-worker:8090"), "workerToken": os.environ.get("RAG_WORKER_TOKEN", ""), "embeddingModel": conf.get("embeddingModel") or os.environ.get("RAG_EMBEDDING_MODEL", "text-embedding-3-small"), "embeddingDimensions": conf.get("embeddingDimensions"),
        "chunkTargetTokens": conf.get("chunkTargetTokens", 800), "chunkOverlapTokens": conf.get("chunkOverlapTokens", 400), "chunkMaxTokens": conf.get("chunkMaxTokens", 1200), "callbackUrl": callback_url, "callbackToken": callback_token,
    }
    script = "/opt/asklake/scripts/rag_chunk_staging.py" if kind == "chunk" else "/opt/asklake/scripts/rag_index_dispatch.py"
    env_key = "ASKLAKE_RAG_CHUNK_MANIFEST_JSON" if kind == "chunk" else "ASKLAKE_RAG_INDEX_MANIFEST_JSON"
    environment = {env_key: json.dumps(common, ensure_ascii=False, separators=(",", ":")), "ASKLAKE_OBJECT_STORAGE_PROVIDER": os.environ.get("ASKLAKE_OBJECT_STORAGE_PROVIDER", "aws"), "AWS_REGION": os.environ.get("AWS_REGION", "ap-northeast-2"), "S3_ENDPOINT": os.environ.get("S3_ENDPOINT", ""), "S3_FORCE_PATH_STYLE": os.environ.get("S3_FORCE_PATH_STYLE", "false"), "ASKLAKE_SPARK_ICEBERG_CATALOG_NAME": str(conf.get("parentTable") or conf.get("chunkTable")).split(".")[0], "ASKLAKE_SPARK_ICEBERG_JDBC_URL": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_URL", ""), "ASKLAKE_SPARK_ICEBERG_JDBC_USER": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_USER", ""), "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD": os.environ.get("ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD", ""), "ASKLAKE_SPARK_ICEBERG_WAREHOUSE": os.environ.get("ASKLAKE_SPARK_ICEBERG_WAREHOUSE", "")}
    submission = {"action": "CreateSubmissionRequest", "appResource": "", "mainClass": "org.apache.spark.deploy.SparkSubmit", "appArgs": [script], "clientSparkVersion": os.environ.get("ASKLAKE_SPARK_VERSION", "4.0.1"), "environmentVariables": environment, "sparkProperties": {"spark.master": os.environ.get("ASKLAKE_SPARK_MASTER_URL", "spark://spark-master:7077"), "spark.submit.deployMode": "cluster", "spark.cores.max": os.environ.get("ASKLAKE_SPARK_CORES_MAX", "2"), "spark.driver.memory": os.environ.get("ASKLAKE_SPARK_DRIVER_MEMORY", "1g"), "spark.executor.memory": os.environ.get("ASKLAKE_SPARK_EXECUTOR_MEMORY", "4g"), "spark.executor.cores": os.environ.get("ASKLAKE_SPARK_EXECUTOR_CORES", "2"), "spark.sql.shuffle.partitions": os.environ.get("ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS", "32"), "spark.jars.ivy": os.environ.get("ASKLAKE_SPARK_IVY_RUNTIME_DIR", "/var/lib/asklake/spark-ivy"), "spark.jars.packages": ",".join(item for item in (os.environ.get("ASKLAKE_SPARK_HADOOP_AWS_PACKAGE"), os.environ.get("ASKLAKE_SPARK_ICEBERG_PACKAGE"), os.environ.get("ASKLAKE_SPARK_POSTGRES_PACKAGE")) if item)}}
    created = post_json(f"{rest_url}/v1/submissions/create", submission, "")
    submission_id = str(created.get("submissionId") or "")
    if not submission_id:
        raise RuntimeError(f"RAG {kind} Spark stage did not return a submissionId")
    terminal = {"FINISHED", "FAILED", "ERROR", "KILLED", "UNKNOWN"}
    deadline = time.time() + int(os.environ.get("ASKLAKE_RAG_SPARK_TIMEOUT_SECONDS", "7200"))
    while time.time() < deadline:
        state = str(get_json(f"{rest_url}/v1/submissions/{submission_id}/status").get("driverState") or "UNKNOWN").upper()
        if state in terminal:
            if state != "FINISHED":
                raise RuntimeError(f"RAG {kind} Spark stage failed: {state}")
            return {"submissionId": submission_id, "driverState": state}
        time.sleep(min(10, max(1, int(os.environ.get("ASKLAKE_RAG_SPARK_POLL_SECONDS", "5")))))
    raise TimeoutError(f"RAG {kind} Spark stage timed out")


def rag_dag_failure_callback(context: dict[str, Any]) -> None:
    dag_run = context.get("dag_run")
    conf = dict(getattr(dag_run, "conf", None) or {})
    job_id = str(conf.get("jobId") or "")
    if not job_id:
        return
    backend_url = (os.environ.get("ASKLAKE_EXECUTION_API_BASE_URL") or os.environ.get("AIRFLOW_INTERNAL_BASE_URL") or "").rstrip("/")
    token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN") or ""
    if not backend_url or not token:
        return
    try:
        post_json(f"{backend_url}/api/internal/airflow/rag-jobs/{job_id}/result", {"status": "failed", "error": "Airflow RAG DAG failed; inspect the failed task logs"}, token)
    except Exception:
        return


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
        if not isinstance(manifest, dict) or manifest.get("manifestVersion") != 1 or manifest.get("datasetId") != conf.get("datasetId") or not manifest.get("readUrl") or not manifest.get("sparkPath") or not manifest.get("fingerprint") or not manifest.get("expiresAt"):
            raise ValueError("RAG indexing requires a Catalog-issued sourceManifest")
        if not conf.get("bodyColumns"):
            raise ValueError("RAG indexing requires approved bodyColumns")
        return conf

    @task(task_id="stage_parent_documents")
    def stage_parent_documents(conf: dict[str, Any]) -> dict[str, Any]:
        result = submit_parent_spark_job(conf)
        return {"conf": conf, "spark": result}

    @task(task_id="stage_chunks")
    def stage_chunks(bundle: dict[str, Any]) -> dict[str, Any]:
        conf = bundle["conf"]
        conf["parentStage"] = bundle.get("spark")
        return {"conf": conf, "spark": submit_rag_spark_stage(conf, kind="chunk")}

    @task(task_id="prepare_index_version")
    def prepare(bundle: dict[str, Any]) -> dict[str, Any]:
        conf = bundle["conf"]
        conf["preparedIndex"] = conf["targetIndex"]
        conf["chunkStage"] = bundle["spark"]
        return conf

    @task(task_id="run_embedding_worker")
    def run_worker(conf: dict[str, Any]) -> dict[str, Any]:
        backend_url = os.environ.get("ASKLAKE_EXECUTION_API_BASE_URL") or os.environ.get("AIRFLOW_INTERNAL_BASE_URL")
        backend_token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN")
        post_json(f"{backend_url.rstrip('/')}/api/internal/airflow/rag-jobs/{conf['jobId']}/result", {"status": "embedding"}, backend_token)
        return submit_rag_spark_stage(conf, kind="index")

    @task(task_id="verify_opensearch_counts")
    def verify(conf: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        if result.get("driverState") != "FINISHED":
            raise ValueError("OpenSearch dispatch Spark stage did not finish")
        return {"conf": conf, "result": result}

    @task(task_id="activate_index_alias")
    def activate(bundle: dict[str, Any]) -> dict[str, Any]:
        base_url = os.environ.get("ASKLAKE_EXECUTION_API_BASE_URL") or os.environ.get("AIRFLOW_INTERNAL_BASE_URL")
        token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN") or os.environ.get("AIRFLOW_INTERNAL_TOKEN")
        return post_json(f"{base_url.rstrip('/')}/api/internal/airflow/rag-jobs/{bundle['conf']['jobId']}/result", {"status": "success", "indexedCount": bundle["result"].get("indexedCount"), "activeIndex": bundle["conf"]["preparedIndex"]}, token)

    received = receive()
    validated = validate(received)
    staged = stage_parent_documents(validated)
    chunked = stage_chunks(staged)
    prepared = prepare(chunked)
    result = run_worker(prepared)
    bundle = verify(prepared, result)
    activate(bundle)


asklake_rag_index()
