"""Runtime binding support for the legacy ETL service compatibility facade.

The extracted modules own implementation bodies, while ``etl_service`` keeps the
stable public names that routers and tests patch.  Bindings refresh only the
globals used by a fragment so a patch on the facade remains observable without
introducing a reverse import back to the facade.
"""

from __future__ import annotations

from collections.abc import Callable, MutableMapping, Set
from functools import wraps
from typing import Any, TypeVar, cast


ResultT = TypeVar("ResultT")
_IMPLEMENTATION_ATTRIBUTE = "__etl_runtime_implementation__"


def bind_runtime(
    implementation: Callable[..., ResultT],
    facade_globals: MutableMapping[str, Any],
    *,
    runtime_names: Set[str],
) -> Callable[..., ResultT]:
    """Return a signature-preserving facade wrapper for one extracted function."""

    implementation_globals = implementation.__globals__
    names = tuple(sorted(runtime_names))

    def sync_runtime_globals() -> None:
        for name in names:
            if name not in facade_globals:
                continue
            value = facade_globals[name]
            local_implementation = getattr(value, _IMPLEMENTATION_ATTRIBUTE, None)
            if (
                callable(local_implementation)
                and getattr(local_implementation, "__globals__", None) is implementation_globals
            ):
                value = local_implementation
            implementation_globals[name] = value

    sync_runtime_globals()

    @wraps(implementation)
    def bound(*args: Any, **kwargs: Any) -> ResultT:
        sync_runtime_globals()
        return implementation(*args, **kwargs)

    bound.__module__ = str(facade_globals.get("__name__") or bound.__module__)
    setattr(bound, _IMPLEMENTATION_ATTRIBUTE, implementation)
    return cast(Callable[..., ResultT], bound)


def runtime_implementation(value: Callable[..., ResultT]) -> Callable[..., ResultT] | None:
    """Expose the bound implementation for structural regression tests."""

    implementation = getattr(value, _IMPLEMENTATION_ATTRIBUTE, None)
    return cast(Callable[..., ResultT], implementation) if callable(implementation) else None
