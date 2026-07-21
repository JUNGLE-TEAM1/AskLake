from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = ROOT / "docs/realtime-2026/contracts/sql-job-execution-tree-v1.md"
ADR_PATH = ROOT / "docs/realtime-2026/adr/003-sql-job-execution-tree-ownership.md"
CONTRACT_REFERENCE = "realtime-2026/contracts/sql-job-execution-tree-v1.md"


def read(relative_path: str) -> str:
    path = ROOT / relative_path
    if not path.is_file():
        raise AssertionError(f"required file is missing: {relative_path}")
    return path.read_text(encoding="utf-8")


def require(text: str, token: str, label: str) -> None:
    if token not in text:
        raise AssertionError(f"{label} is missing required token: {token}")


def reject(text: str, token: str, label: str) -> None:
    if token in text:
        raise AssertionError(f"{label} still contains forbidden token: {token}")


def main() -> None:
    contract = read(str(CONTRACT_PATH.relative_to(ROOT)))
    adr = read(str(ADR_PATH.relative_to(ROOT)))

    for number in range(1, 14):
        require(contract, f"TREE-{number:02d}", "execution-tree contract")

    for token in (
        "producerJobId",
        "dependencyBindings",
        "asklake-continuous-sql-{jobId}",
        "수동 새로고침",
        "Phase 0",
        "Dashboard Job Binding API/model/worker를 다시 만들지 않는다",
    ):
        require(contract, token, "execution-tree contract")

    for token in (
        "SQL JOIN Job",
        "실행 트리의 부모/root",
        "기존 Kafka 또는 Batch Job",
        "수동 새로고침",
    ):
        require(adr, token, "ADR-003")

    reference_docs = (
        "docs/01-product-planning.md",
        "docs/02-architecture.md",
        "docs/03-api-reference.md",
        "docs/04-development-guide.md",
        "docs/api-contract.md",
        "docs/backend-integration-readiness.md",
    )
    for relative_path in reference_docs:
        require(read(relative_path), CONTRACT_REFERENCE, relative_path)

    legacy_backend = read("backend/app/services/continuous_sql_service.py")
    require(
        legacy_backend,
        'f"asklake-continuous-sql-{job_id}"',
        "Phase 0 backend legacy evidence",
    )

    authoritative_frontend = read("frontend/src/pages/sql/continuousSqlUi.ts")
    require(authoritative_frontend, "isStreamingCatalogDataset", "Phase 2 frontend evidence")
    require(authoritative_frontend, 'relationMode === "streaming"', "Phase 2 frontend evidence")
    reject(authoritative_frontend, "kafka|stream", "Phase 2 frontend inference boundary")

    phase_one_evidence = {
        "backend/alembic/versions/0023_sql_job_execution_tree_persistence.py": (
            "continuous_sql_dependencies",
            "producer_job_id",
            "runtime_status",
        ),
        "backend/app/models/continuous_sql.py": (
            "ContinuousSqlDependencyModel",
            "ck_continuous_sql_dependency_owner",
        ),
        "backend/app/models/catalog.py": (
            "producer_job_id",
            "relation_mode",
        ),
        "backend/app/repositories/continuous_sql_repository.py": (
            "replace_dependencies",
            "list_dependencies",
        ),
        "backend/app/schemas/continuous_sql.py": (
            "ContinuousSqlDependencyBinding",
            "dependency_bindings",
        ),
        "frontend/src/types/catalog.ts": (
            "producerJobId",
            "relationMode",
        ),
    }
    for relative_path, tokens in phase_one_evidence.items():
        contents = read(relative_path)
        for token in tokens:
            require(contents, token, f"Phase 1 evidence in {relative_path}")

    phase_two_evidence = {
        "backend/app/services/continuous_sql_catalog.py": (
            "CONTINUOUS_SQL_REALTIME_PRODUCER_REQUIRED",
            "CONTINUOUS_SQL_INPUT_RELATION_UNSUPPORTED",
            "CONTINUOUS_SQL_RELATION_MODE_REQUIRED",
            "producer_job_id",
        ),
        "backend/app/services/continuous_sql_service.py": (
            "_dependency_bindings",
            "replace_dependencies",
        ),
        "backend/tests/test_continuous_sql_dependency_resolution.py": (
            "test_create_commits_job_and_dependencies_together",
            "test_relation_mode_is_required_and_never_inferred_from_legacy_fields",
        ),
        "frontend/scripts/continuous-sql-ui.test.mts": (
            "does not infer streaming inputs from legacy names",
        ),
    }
    for relative_path, tokens in phase_two_evidence.items():
        contents = read(relative_path)
        for token in tokens:
            require(contents, token, f"Phase 2 evidence in {relative_path}")

    phase_three_evidence = {
        "backend/alembic/versions/0024_sql_execution_tree_locking.py": (
            "continuous_sql_tree_runs",
            "continuous_sql_tree_node_runs",
            "continuous_sql_tree_job_locks",
        ),
        "backend/app/models/continuous_sql.py": (
            "ContinuousSqlTreeRunModel",
            "ContinuousSqlTreeNodeRunModel",
            "ContinuousSqlTreeJobLockModel",
        ),
        "backend/app/services/continuous_sql_service.py": (
            "_acquire_execution_tree",
            "CONTINUOUS_SQL_DEPENDENCY_CONFLICT",
            "_sync_execution_tree_status",
        ),
        "backend/app/repositories/execution_tree_lock_repository.py": (
            "require_standalone_job_unlocked",
            "with_for_update",
        ),
        "backend/tests/test_sql_execution_tree_locking.py": (
            "test_conflict_rolls_back_every_lock_and_tree_row",
            "test_expired_lock_can_be_taken_over_with_monotonic_generation",
        ),
    }
    for relative_path, tokens in phase_three_evidence.items():
        contents = read(relative_path)
        for token in tokens:
            require(contents, token, f"Phase 3 evidence in {relative_path}")

    phase_four_evidence = {
        "backend/app/services/continuous_sql_service.py": (
            "_start_execution_tree_children",
            "_stop_started_realtime_children",
            "tree_fencing_token",
        ),
        "backend/app/services/etl_service.py": (
            "tree_run_id",
            "require_tree_owned_job",
        ),
        "backend/app/repositories/execution_tree_lock_repository.py": (
            "require_tree_owned_job",
            "fencing_token",
        ),
        "backend/tests/test_sql_execution_tree_locking.py": (
            "test_parent_starts_batch_then_realtime_child_before_sql_worker",
            "test_child_start_failure_skips_parent_worker_and_releases_tree_locks",
        ),
    }
    for relative_path, tokens in phase_four_evidence.items():
        contents = read(relative_path)
        for token in tokens:
            require(contents, token, f"Phase 4 evidence in {relative_path}")

    print("CONTINUOUS_SQL_EXECUTION_TREE_CONTRACT_OK")


if __name__ == "__main__":
    main()
