"""Backward-compatible Kafka Continuous worker CLI and import façade."""

from __future__ import annotations

import sys

from runtime import kafka_continuous_runtime as _implementation


if __name__ == "__main__":
    _implementation.run_cli()

sys.modules[__name__] = _implementation
