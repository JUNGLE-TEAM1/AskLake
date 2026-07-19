import ast
import hashlib
from pathlib import Path
import unittest

from app.application import (
    etl_catalog_projection,
    etl_job_projection,
    etl_pipeline_policy,
    etl_record_parsing,
    etl_run_projection,
    etl_runtime_support,
    etl_schedule,
    etl_source_window,
)
from app.services import etl_service
from app.services.etl import (
    airflow_operations,
    api_job_operations,
    api_review_operations,
    continuous_maintenance,
    continuous_publication,
    continuous_session,
    replay_schedule,
    snapshot_operations,
    source_runtime,
)
from app.services.etl.runtime_binding import runtime_implementation


BACKEND_ROOT = Path(__file__).resolve().parents[1]
ETL_SERVICE_PATH = BACKEND_ROOT / "app" / "services" / "etl_service.py"

EXTRACTED_EXPORTS = {
    etl_schedule: {
        "cron_matches",
        "has_scheduled_execution",
        "has_scheduled_label",
        "job_schedule_kind",
        "next_custom_cron_local",
        "next_scheduled_run_utc_for_schedule",
        "parse_cron_field",
        "schedule_next_run_label",
        "schedule_policy_from_request",
        "schedule_timezone",
        "trino_sql_job_next_run_utc",
        "trino_sql_job_schedule_label",
        "trino_sql_job_schedule_summary",
    },
    etl_job_projection: {
        "apply_job_command",
        "continuous_config_from_request",
        "continuous_runtime_from_job",
        "dag_steps_from_command",
        "dataset_sample_rows_from_request",
        "dataset_schema_from_request",
        "dataset_storage_key",
        "fallback_lineage_graph",
        "field_value",
        "format_bytes",
        "format_duration_ms",
        "format_iso_duration",
        "format_rows",
        "initial_dag_steps",
        "initial_job_stats",
        "iso_now",
        "kafka_field_value",
        "lineage_node",
        "make_dataset_id",
        "make_job_id",
        "normalize_column_name",
        "normalize_lineage_id",
        "normalize_optional_text",
        "normalize_string_list",
        "normalize_target_tags",
        "parse_positive_integer",
        "quality_status_label",
        "quality_summary_from_request",
        "run_from_command",
        "source_metrics_from_request",
        "source_unit_label",
        "stable_id",
        "stats_from_runs",
        "target_dataset_description",
        "target_dataset_tags",
        "tuple_rows_to_lists",
    },
    etl_record_parsing: {
        "dominant_field_count",
        "infer_record_parsing_type",
        "preview_record_parsing",
        "record_parsing_column_names",
        "record_parsing_timestamp",
    },
    etl_runtime_support: {
        "compact_storage_text",
        "dag_step",
        "is_kafka_job",
        "writer_mode_for_pipeline",
    },
    etl_source_window: {
        "build_source_s3_client",
        "head_s3_object_identity",
        "incremental_object_key_limit",
        "listed_s3_object_identity",
        "normalize_s3_etag",
        "normalize_s3_version_id",
        "object_last_modified",
        "object_last_modified_iso",
        "parse_incremental_timestamp",
        "pin_listed_s3_object_identity",
        "s3_object_size",
        "source_identity_worker_count",
        "source_object_identity_changed_error",
        "source_object_identity_mismatch_fields",
        "source_uses_incremental_folder_window",
    },
    etl_run_projection: {
        "airflow_run_has_materialization",
        "airflow_submission_error_is_definitive",
        "apply_airflow_result_to_reserved_run",
        "apply_airflow_submit_job_state",
        "apply_job_state_from_latest_run",
        "apply_kafka_result_to_reserved_run",
        "apply_kafka_run_reservation_job_state",
        "bind_kafka_result_to_reservation",
        "dag_steps_from_airflow_submit",
        "dag_steps_from_airflow_sync",
        "finalize_job_from_kafka_result",
        "finalize_job_from_spark_result",
        "first_problem_task",
        "kafka_run_reservation",
        "mark_airflow_catalog_reconciliation_failure",
        "mark_airflow_submission_unknown",
        "mark_airflow_success_without_catalog_reconciliation",
        "record_airflow_sync_error",
        "repair_incomplete_airflow_successes",
        "run_from_airflow_submit",
        "run_from_kafka_result",
        "run_from_spark_result",
        "spark_error_summary",
        "spark_failed_stage",
        "task_state_snapshot",
        "task_title",
    },
    etl_catalog_projection: {
        "append_materialization_run",
        "append_unique",
        "append_unique_pair",
        "compact_spark_logs",
        "dag_steps_from_kafka_result",
        "dag_steps_from_spark_result",
        "dataset_from_spark_result",
        "dataset_payload_from_spark_result",
        "dataset_storage_size_bytes",
        "etl_dataset_lineage_graph",
        "format_storage_size",
        "identity_name",
        "identity_profile",
        "lineage_columns_by_name",
        "lineage_edge",
        "lineage_edges_between",
        "lineage_edges_from_job_inputs",
        "lineage_source_engine",
        "lineage_target_engine",
        "normalize_source_object_inventory",
        "parse_count_value",
        "parse_optional_integer",
        "quality_summary_from_spark_result",
        "schema_column_included",
        "schema_from_job",
        "source_lineage_schema",
        "spark_materialization_mode",
        "spark_output_sample_rows",
        "spark_result_schema",
        "spark_source_window_metadata",
    },
    etl_pipeline_policy: {
        "apply_compiled_rules",
        "apply_update_request",
        "canonical_rule_fingerprint",
        "compile_job_rules",
        "compile_pipeline_rules",
        "continuous_checkpoint_initialized",
        "continuous_processing_contract_changed",
        "next_scheduled_run_utc",
        "require_compiled_rules",
        "should_run_scheduled_job",
        "target_contract_issue",
        "target_identity_changed",
        "trino_query_run_belongs_to_actor",
        "trino_sql_job_permission_roles",
        "trino_sql_job_permission_summary",
        "validate_create_request",
        "validate_requested_permission_grants",
        "validate_target_contract",
        "validate_update_request",
    },
}

REVIEWED_FUNCTION_DIGESTS = {
    etl_schedule: "26c08d45a62467ca65e335f5fb96ceb2d013409d27036f506b08e504def07265",
    etl_job_projection: "bc2e0c68fdd9c06207e4e926c4dd325c4fb69c99adc4ebeea9205ea59a990a02",
    etl_record_parsing: "77381844dca157f2f2ac362bd993944e5ce44d5e395ed8d228d45bb75c463400",
    etl_runtime_support: "d410df2ce0f73d32ababf30b0aeeaac09d091bd2f99f0ef0df373468492e7eeb",
    etl_source_window: "96021a5f5ed3aa3f6b2e42f3fba4b3a96f19c88c4b32f84b9e47469f12fc3808",
    etl_run_projection: "009ba2344a14edc775694a32163b3819a5b61eed6fd55e825aa603a6703bfbdd",
    etl_catalog_projection: "8b7af995d75bb825f1bb436288dc064de9bd0fb886c527a441f2fa07741a7176",
    etl_pipeline_policy: "17bc003374c35536a33bf94817000da788a92989631d8aad5139fd7d0abbd2f7",
}

RUNTIME_FACADE_MODULES = (
    api_job_operations,
    api_review_operations,
    snapshot_operations,
    airflow_operations,
    source_runtime,
    continuous_maintenance,
    continuous_session,
    continuous_publication,
    replay_schedule,
)

RUNTIME_FACADE_DIGESTS = {
    api_job_operations: "2ca3451cf8d8191ee26007932e382e5026e3f04705a53ee71ccc1aa9db788214",
    api_review_operations: "87451913ae4b2dcb366ed63cb5dfd083051cf1b8ea1f3e2026b7fff30eeb1e0a",
    snapshot_operations: "6e6466845b2e74b89ebc8e9686401f24a5d705ccce8c2a2eeedba7638a7640e1",
    airflow_operations: "3ba467762ed088581513e591e232e7bed96c0b73654541dc24844715beafec76",
    source_runtime: "50528e057222df75676b42aa6a8f170dd2b94eda123c2b77b7f164071457536f",
    continuous_maintenance: "dc590f1f9469421dd7b4a5484ce469507e3ad710eca13ad5542b871b2b462b1d",
    continuous_session: "218eea6f08099161193e8c75d52bdfd488f8403c0e1dea24e8b3c60d4d03a3f5",
    continuous_publication: "6f5b6368a7fd8eca224b67fb3c20fb406997bb913a93f85a5a1dd5ac98fb6f57",
    replay_schedule: "fe83ec3f2262ccc5e30aa2c0bfe0226b0425f6556fa59128f1f3297edb4be772",
}


class EtlServiceModuleBoundaryTests(unittest.TestCase):
    def test_etl_service_remains_a_bounded_compatibility_facade(self) -> None:
        source = ETL_SERVICE_PATH.read_text(encoding="utf-8")
        self.assertLessEqual(len(source.splitlines()), 2_500)

        service_definitions = {
            node.name
            for node in ast.parse(source).body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        for module, names in EXTRACTED_EXPORTS.items():
            for name in names:
                self.assertNotIn(name, service_definitions)
                self.assertIs(getattr(etl_service, name), getattr(module, name))

        for module in RUNTIME_FACADE_MODULES:
            for name in module.EXPORTED_FUNCTIONS:
                self.assertNotIn(name, service_definitions)
                self.assertIs(
                    runtime_implementation(getattr(etl_service, name)),
                    module.IMPLEMENTATIONS[name],
                )
                self.assertEqual(getattr(etl_service, name).__module__, etl_service.__name__)

    def test_extracted_modules_stay_small_and_do_not_import_the_facade(self) -> None:
        budgets = {
            etl_schedule: 320,
            etl_job_projection: 480,
            etl_record_parsing: 170,
            etl_runtime_support: 120,
            etl_source_window: 270,
            etl_run_projection: 620,
            etl_catalog_projection: 800,
            etl_pipeline_policy: 460,
        }
        for module, line_budget in budgets.items():
            module_path = Path(module.__file__).resolve()
            source = module_path.read_text(encoding="utf-8")
            self.assertLessEqual(len(source.splitlines()), line_budget)
            self.assertNotIn("app.services.etl_service", source)

            functions = [
                node
                for node in ast.parse(source).body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            ]
            payload = "\n".join(ast.dump(node, include_attributes=False) for node in functions)
            self.assertEqual(
                hashlib.sha256(payload.encode("utf-8")).hexdigest(),
                REVIEWED_FUNCTION_DIGESTS[module],
            )

    def test_runtime_facade_modules_stay_bounded_and_reviewed(self) -> None:
        budgets = {
            api_job_operations: 670,
            api_review_operations: 450,
            snapshot_operations: 460,
            airflow_operations: 980,
            source_runtime: 800,
            continuous_maintenance: 660,
            continuous_session: 530,
            continuous_publication: 810,
            replay_schedule: 200,
        }
        for module, line_budget in budgets.items():
            source = Path(module.__file__).read_text(encoding="utf-8")
            self.assertLessEqual(len(source.splitlines()), line_budget)
            self.assertNotIn("app.services.etl_service", source)

            functions = [
                node
                for node in ast.parse(source).body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            ]
            payload = "\n".join(ast.dump(node, include_attributes=False) for node in functions)
            payload += "\nEXPORTS\n" + "\n".join(module.EXPORTED_FUNCTIONS)
            self.assertEqual(
                hashlib.sha256(payload.encode("utf-8")).hexdigest(),
                RUNTIME_FACADE_DIGESTS[module],
            )


if __name__ == "__main__":
    unittest.main()
