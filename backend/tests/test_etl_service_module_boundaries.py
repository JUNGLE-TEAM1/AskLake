import ast
import hashlib
from pathlib import Path
import unittest

from app.application import (
    etl_airflow_projection,
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
    etl_airflow_projection: "4f93125a9f35f22d65eedabd19d0a84cf42ab3d85bd4ed24b39d6d9d5422652a",
    etl_schedule: "a60c3f1d406e711f459652bae1e1a36bb0747086ab75a0371ea991d96d4f28d1",
    etl_job_projection: "1a899dc6356446a3a434309111d3ce9e60faae872b8f1e525a3724cbd60c1c05",
    etl_record_parsing: "f83831544eeb6ea5f6c2dd70fb432affd87a36af647a834d5b6d809a3e3b993b",
    etl_runtime_support: "2930775e49a12cf20a82a8c1fa58e4fd0891dc178fdb9e1a055181a42fbc4ad8",
    etl_source_window: "4002bc295053f657e696c40158e6773b567b83913e63b6585f85e42b9ea308c9",
    etl_run_projection: "b420423753b9537bc87c7b82b5a9831ce12ef87e78df915f198a396133ea5776",
    etl_catalog_projection: "ebb140d6fbc27163ee37e70e441fb4b38714748f48d2f58db58453328fb7fb87",
    etl_pipeline_policy: "dc2e6e17bd8a2eca553c2079fd2b910f53ed761f45ec401a0a0e76693f5f90c3",
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
    api_job_operations: "75e6bd3df869cca9e2bda400cde9a7a064c46011b5af93a61550aba108ff01c0",
    api_review_operations: "2be232ab29999cf95de561949640ac487ce10c8a3837132c0d3a74779c66ebab",
    snapshot_operations: "a810d372db02d45cb3b2b55cdf8fcdcef22ae7301dded7cc663bb3d33d49f1bc",
    airflow_operations: "567b788d1e346458c21a677bd7d2c8ad21a4784e355c4fb01bf1af2a8a8eea6a",
    source_runtime: "22a2c6dbc4bc1381fab573d847985c674c02775023b5d0adf3ddfa06a14b5417",
    continuous_maintenance: "8adaf231c1e8f7c4e3c839be8d9f5ecdc34b1b567e0bda7f03cf8e7025fcf75a",
    continuous_session: "38179b3174532a806441c973e20f3ebd16806194750e513ce44657f32c4fd9ee",
    continuous_publication: "c931caacd76029934f696b626c76b329bd9338e30f63abcf1bb918c62a1daab9",
    replay_schedule: "02df7315c31da09c0b2505f40c19dd5a153272d52342851a70e5a3db2aafc69d",
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
            etl_airflow_projection: 100,
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
