import re
import time

from runtime.contracts import now_iso


def spark_materialization_bytes(spark, paths):
    try:
        configuration = spark.sparkContext._jsc.hadoopConfiguration()
        total = 0
        for value in paths:
            path = spark._jvm.org.apache.hadoop.fs.Path(value)
            status = path.getFileSystem(configuration).getFileStatus(path)
            total += int(status.getLen())
        return total
    except Exception:
        return None


def spark_staging_path(output_path, run_id):
    safe_run_id = re.sub(r"[^0-9A-Za-z_-]+", "_", str(run_id or "run")).strip("_") or "run"
    return f"{str(output_path).rstrip('/')}.__staging__{safe_run_id}"


def spark_materialization_staging_path(output_path, run_id):
    safe_run_id = re.sub(r"[^0-9A-Za-z_-]+", "_", str(run_id or "run")).strip("_") or "run"
    return f"{str(output_path).rstrip('/')}.__materialization__{safe_run_id}"


class RunScopedParquetStaging:
    def __init__(self, output_path, run_id):
        self.path = spark_materialization_staging_path(output_path, run_id)
        self.write_started = False

    def materialize(self, spark, frame, phase_timings, spark_resources):
        phase_started_at = now_iso()
        phase_started_monotonic = time.monotonic()
        try:
            self.write_started = True
            frame.write.mode("overwrite").parquet(self.path)
            staged_frame = spark.read.parquet(self.path)
            materialization_files = staged_frame.inputFiles()
            materialization_bytes = spark_materialization_bytes(
                spark,
                materialization_files,
            )
            spark_resources["materializationBytes"] = materialization_bytes
            spark_resources["materializationFileCount"] = len(materialization_files)
            spark_resources["materializationSizeStatus"] = (
                "exact" if materialization_bytes is not None else "unavailable"
            )
            return staged_frame
        finally:
            phase_timings["materializationStaging"] = {
                "durationMs": max(
                    0,
                    round((time.monotonic() - phase_started_monotonic) * 1000),
                ),
                "endedAt": now_iso(),
                "startedAt": phase_started_at,
            }

    def cleanup(self, spark, spark_resources, cleanup_paths):
        if not self.write_started:
            return []
        errors = cleanup_paths(spark, [self.path])
        spark_resources["materializationCleanupStatus"] = (
            "failed" if errors else "success"
        )
        return errors
