from __future__ import annotations

import unittest


MODULES = (
    "tests.test_continuous_runtime_contract",
    "tests.test_continuous_maintenance_fencing",
    "tests.test_kafka_continuous_dashboard_sync",
)


def main() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromNames(MODULES)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
