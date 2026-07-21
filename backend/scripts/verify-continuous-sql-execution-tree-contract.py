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

    legacy_frontend = read("frontend/src/pages/sql/continuousSqlUi.ts")
    require(legacy_frontend, "isStreamingCatalogDataset", "Phase 0 frontend legacy evidence")
    require(legacy_frontend, "kafka|stream", "Phase 0 frontend regex evidence")

    print("CONTINUOUS_SQL_EXECUTION_TREE_CONTRACT_OK")


if __name__ == "__main__":
    main()
