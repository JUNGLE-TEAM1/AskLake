locals {
  secret_delivery_enabled  = var.secret_delivery_mode != "disabled"
  external_secrets_enabled = var.secret_delivery_mode == "external_secrets"
  workflow_sync_enabled    = var.secret_delivery_mode == "workflow_sync"
  secret_delivery_ready = (
    local.secret_delivery_enabled &&
    try(trimspace(var.secret_rotation_owner), "") != "" &&
    try(trimspace(var.secret_source_prefix), "") != "" &&
    (
      local.external_secrets_enabled ? (
        var.secret_controller_ready &&
        try(trimspace(var.secret_controller_owner), "") != ""
        ) : (
        local.workflow_sync_enabled &&
        !var.secret_controller_ready &&
        var.secret_controller_owner == null
      )
    )
  )

  runtime_secret_contract = {
    backend = {
      name = "asklake-backend-runtime"
      keys = [
        "DATABASE_URL",
        "BOOTSTRAP_ADMIN_PASSWORD",
        "AI_GATEWAY_SERVICE_TOKEN",
        "AI_MCP_SERVICE_TOKEN",
        "AI_CONTEXT_SIGNING_SECRET",
        "AIRFLOW_EXECUTION_API_TOKEN",
        "AIRFLOW_INTERNAL_TOKEN",
        "TRINO_AUTH_USERNAME",
        "TRINO_AUTH_PASSWORD",
        "TRINO_MATERIALIZER_USERNAME",
        "TRINO_MATERIALIZER_PASSWORD",
        "TRINO_RESULT_CURSOR_SECRET",
        "TRINO_QUERY_CONFIRMATION_SECRET",
        "trino-ca.pem",
      ]
    }
    airflow = {
      name = "asklake-airflow-runtime"
      keys = [
        "AIRFLOW__DATABASE__SQL_ALCHEMY_CONN",
        "AIRFLOW_EXECUTION_API_TOKEN",
        "AIRFLOW_INTERNAL_TOKEN",
        "AIRFLOW__CORE__FERNET_KEY",
        "AIRFLOW__API_AUTH__JWT_SECRET",
      ]
    }
    spark = {
      name = "asklake-spark-runtime"
      keys = [
        "ASKLAKE_SPARK_ICEBERG_JDBC_URL",
        "ASKLAKE_SPARK_ICEBERG_JDBC_USER",
        "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD",
      ]
    }
    trino = {
      name = "asklake-trino-runtime"
      keys = [
        "TRINO_ICEBERG_JDBC_URL",
        "TRINO_ICEBERG_JDBC_USER",
        "TRINO_ICEBERG_JDBC_PASSWORD",
        "TRINO_TLS_KEYSTORE_PASSWORD",
        "TRINO_INTERNAL_SHARED_SECRET",
        "trino-keystore.jks",
        "trino-password.db",
      ]
    }
  }
}

check "runtime_secret_delivery_contract" {
  assert {
    condition     = !local.secret_delivery_enabled || local.secret_delivery_ready
    error_message = "enabled Secret delivery requires a rotation owner and source prefix; external_secrets also requires a ready controller owner."
  }
}

check "disabled_secret_delivery_has_no_runtime_values" {
  assert {
    condition = local.secret_delivery_enabled || (
      !var.secret_controller_ready &&
      var.secret_controller_owner == null &&
      var.secret_rotation_owner == null &&
      var.secret_source_prefix == null
    )
    error_message = "disabled Secret delivery must not carry partial controller, rotation, or source values."
  }
}
