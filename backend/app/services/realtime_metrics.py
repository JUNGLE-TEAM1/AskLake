from threading import Lock
from typing import Any


class RealtimeMetrics:
    def __init__(self) -> None:
        self._lock = Lock()
        self._values: dict[str, int | float | bool | str | None] = {
            "activeConnections": 0,
            "connectionsOpened": 0,
            "connectionsClosed": 0,
            "eventsCreated": 0,
            "eventsDelivered": 0,
            "eventsReplayed": 0,
            "queueOverflows": 0,
            "resyncRequired": 0,
            "authRejections": 0,
            "listenerReady": False,
            "dispatcherReady": False,
            "lastDispatchedCursor": 0,
            "lastDeliveryLagMs": 0.0,
            "lastError": None,
        }

    def increment(self, name: str, amount: int = 1) -> None:
        with self._lock:
            current = self._values.get(name, 0)
            self._values[name] = int(current) + amount if isinstance(current, (int, float)) else amount

    def set(self, name: str, value: int | float | bool | str | None) -> None:
        with self._lock:
            self._values[name] = value

    def snapshot(self) -> dict[str, int | float | bool | str | None]:
        with self._lock:
            return dict(self._values)

    def reset(self, **values: Any) -> None:
        with self._lock:
            for key in self._values:
                if isinstance(self._values[key], bool):
                    self._values[key] = False
                elif isinstance(self._values[key], (int, float)):
                    self._values[key] = 0
                else:
                    self._values[key] = None
            self._values.update(values)


realtime_metrics = RealtimeMetrics()
