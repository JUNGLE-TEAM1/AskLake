#!/usr/bin/env python3
from __future__ import annotations

import unittest


TEST_MODULES = (
    "tests.test_realtime_feature_flags",
    "tests.test_clickhouse_realtime_alembic",
    "tests.test_clickhouse_realtime_ingest",
    "tests.test_clickhouse_realtime_dimensions",
    "tests.test_clickhouse_realtime_materializer",
    "tests.test_catalog_realtime_publication",
    "tests.test_dashboard_clickhouse_v2",
    "tests.test_realtime_archive_recovery",
)


def main() -> None:
    suite = unittest.defaultTestLoader.loadTestsFromNames(TEST_MODULES)
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    print(f"ClickHouse realtime V2 release contracts passed: {result.testsRun} tests.")


if __name__ == "__main__":
    main()
