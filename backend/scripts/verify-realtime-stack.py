#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import unittest


BACKEND_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = BACKEND_DIR / "scripts"
TEST_MODULES = (
    "tests.test_realtime_events",
    "tests.test_realtime_feature_flags",
    "tests.test_clickhouse_continuous_sql",
    "tests.test_continuous_sql_planner",
    "tests.test_continuous_sql_runtime_performance",
    "tests.test_continuous_sql_runtime_contract",
    "tests.test_continuous_maintenance_fencing",
    "tests.test_continuous_runtime_sync_config",
    "tests.test_production_auth_hardening",
)


def run_script(name: str) -> None:
    subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / name)],
        cwd=BACKEND_DIR,
        check=True,
    )


def main() -> None:
    run_script("verify-realtime-quality-gates.py")
    run_script("verify-realtime-proxy-contract.py")
    suite = unittest.defaultTestLoader.loadTestsFromNames(TEST_MODULES)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    print(f"Realtime stack verification passed: {result.testsRun} deterministic tests.")


if __name__ == "__main__":
    main()
