#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def require(relative_path: str, *fragments: str) -> None:
    text = read(relative_path)
    missing = [fragment for fragment in fragments if fragment not in text]
    if missing:
        raise AssertionError(f"{relative_path}: missing required realtime guards: {missing}")


def forbid(relative_path: str, *fragments: str) -> None:
    text = read(relative_path)
    found = [fragment for fragment in fragments if fragment in text]
    if found:
        raise AssertionError(f"{relative_path}: forbidden realtime coupling found: {found}")


def require_absent(*relative_paths: str) -> None:
    present = [relative_path for relative_path in relative_paths if (ROOT / relative_path).exists()]
    if present:
        raise AssertionError(
            "Retired Dashboard live-refresh files must stay removed: " + ", ".join(present)
        )


def verify_dashboard_realtime_contract() -> None:
    runtime_directory = ROOT / "frontend" / "src" / "pages" / "dashboard" / "runtime"
    timer_violations: list[str] = []
    for path in sorted(runtime_directory.glob("*.ts*")):
        text = path.read_text(encoding="utf-8")
        for forbidden in ("refetchInterval", "setInterval("):
            if forbidden in text:
                timer_violations.append(f"{path.relative_to(ROOT)}:{forbidden}")
    if timer_violations:
        raise AssertionError(
            "Dashboard realtime runtime must not add an unbounded polling interval: "
            + ", ".join(timer_violations)
        )

    require_absent(
        "frontend/src/pages/dashboard/runtime/dashboardLiveRefresh.ts",
        "frontend/src/pages/dashboard/runtime/usePublishedDashboardLiveRefresh.ts",
        "frontend/src/pages/dashboard/runtime/useDashboardDraftLiveRefresh.ts",
    )
    require(
        "frontend/src/pages/dashboard/runtime/dashboardAutoRefresh.ts",
        'const PREFERENCE_PREFIX = "asklake:dashboard:auto-refresh"',
        "readDashboardAutoRefreshPreference",
        "writeDashboardAutoRefreshPreference",
        'return "수동 새로고침"',
    )
    require(
        "frontend/src/pages/dashboard/runtime/useDashboardAutoRefresh.ts",
        "if (!active || !enabled)",
        'document.visibilityState !== "hidden"',
        "pendingDatasetIdsRef = useRef(new Set<string>())",
        "refreshDatasetsRef.current(pendingDatasetIds)",
        "new RealtimeEventClient()",
        'config.dashboardSyncMode === "polling"',
        "client.close()",
    )
    require(
        "frontend/src/pages/dashboard/runtime/useDashboardWidgetData.ts",
        "refreshCurrentPageWidgetData",
        "refreshWidgetDataForDatasets",
        "queryDashboardWidgets",
    )
    require(
        "backend/app/repositories/realtime_event_repository.py",
        "RealtimeEventModel",
        "pg_notify",
        "idempotency_key",
    )
    require(
        "backend/app/services/realtime_event_service.py",
        "LISTEN {}",
        "dispatch_after",
        "self.hub.publish(event)",
    )
    require(
        "backend/app/services/dashboard_realtime_bridge.py",
        "RealtimeEventRepository(db).append",
        'event_type="dataset.revision.committed"',
        'event_type="dashboard.published"',
    )
    require(
        "backend/app/repositories/dashboard_live_repository.py",
        "append_dataset_revision_event",
    )
    require(
        "backend/app/services/dashboard_runtime_service.py",
        "append_dashboard_published_event",
    )
    require(
        "backend/app/services/continuous_sql_planner.py",
        "from sqlglot import exp, parse",
        "parse_single_select",
    )
    require(
        "backend/tests/test_continuous_sql_planner.py",
        "test_stateful_unbounded_and_nondeterministic_constructs_have_stable_errors",
        "test_only_inner_left_and_equality_predicates_are_supported",
    )


def verify_architecture_boundaries() -> None:
    production_python = [
        path
        for path in (ROOT / "backend" / "app").rglob("*.py")
        if path.name != "realtime_event_service.py"
    ]
    direct_publish_markers = ("realtime_event_hub.publish", "RealtimeEventHub(", ".hub.publish(")
    direct_publish = [
        str(path.relative_to(ROOT))
        for path in production_python
        if any(
            marker in path.read_text(encoding="utf-8")
            for marker in direct_publish_markers
        )
    ]
    if direct_publish:
        raise AssertionError(
            "Production event producers must append to the durable log, not publish directly: "
            + ", ".join(direct_publish)
        )

    god_file_line_budgets = {
        "backend/app/services/etl_service.py": 9_550,
        "frontend/src/App.tsx": 700,
        "frontend/src/hooks/useAskLakeData.ts": 1_600,
    }
    for relative_path, line_budget in god_file_line_budgets.items():
        path = ROOT / relative_path
        if not path.exists():
            continue
        line_count = len(path.read_text(encoding="utf-8").splitlines())
        if line_count > line_budget:
            raise AssertionError(
                f"{relative_path}: {line_count} lines exceeds the realtime architecture budget {line_budget}"
            )
        forbid(
            relative_path,
            "ContinuousSqlPlanner",
            "RealtimeEventHub",
            "dashboardRealtimeEventClient",
        )


def main() -> None:
    verify_dashboard_realtime_contract()
    verify_architecture_boundaries()
    print(
        "Realtime quality gates passed: auto-refresh remains explicit and SSE-driven with a manual "
        "fallback, no silent polling interval exists, the durable event path is retained, SQL "
        "validation is present, and God-file size/symbol budgets are retained."
    )


if __name__ == "__main__":
    main()
