from __future__ import annotations

import unittest


MODULES = (
    "tests.test_continuous_sql_planner",
    "tests.test_continuous_sql_runtime_performance",
    "tests.test_continuous_sql_runtime_contract",
)


def main() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromNames(MODULES)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print("CONTINUOUS_SQL_CONTRACT_OK")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
