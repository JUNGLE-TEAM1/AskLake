"""Backward-compatible Spark Job CLI and import façade."""

from __future__ import annotations

import sys

from runtime import spark_job_runtime as _implementation


if __name__ == "__main__":
    raise SystemExit(_implementation.main())

# Existing tests and helper scripts import and patch ``spark_job_run``
# functions directly. Return the implementation module itself so those patch
# points keep their historical module-global semantics.
sys.modules[__name__] = _implementation
