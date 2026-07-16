import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock
from typing import TypeAlias

import psycopg
from psycopg import sql

from app.core.config import settings
from app.core.database import SessionLocal
from app.repositories.realtime_event_repository import (
    REALTIME_NOTIFY_CHANNEL,
    RealtimeEventRepository,
)
from app.schemas.realtime import RealtimeEventEnvelope
from app.services.realtime_metrics import realtime_metrics


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RealtimeQueueOverflow:
    reason: str = "subscriber_queue_overflow"


RealtimeHubItem: TypeAlias = RealtimeEventEnvelope | RealtimeQueueOverflow


class RealtimeConnectionLimitError(RuntimeError):
    pass


@dataclass
class RealtimeSubscription:
    hub: "RealtimeEventHub"
    subscription_id: int
    actor_key: str
    resources: frozenset[tuple[str, str]]
    queue: asyncio.Queue[RealtimeHubItem]
    closed: bool = False

    async def get(self) -> RealtimeHubItem:
        return await self.queue.get()

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.hub.unsubscribe(self.subscription_id)


class RealtimeEventHub:
    def __init__(self) -> None:
        self._lock = Lock()
        self._next_id = 1
        self._subscriptions: dict[int, RealtimeSubscription] = {}

    def subscribe(
        self,
        *,
        actor_key: str,
        resources: set[tuple[str, str]],
    ) -> RealtimeSubscription:
        with self._lock:
            actor_connections = sum(
                1
                for subscription in self._subscriptions.values()
                if subscription.actor_key == actor_key
            )
            if actor_connections >= settings.realtime_connection_limit_per_actor:
                realtime_metrics.increment("authRejections")
                raise RealtimeConnectionLimitError(
                    "Realtime connection limit reached for this actor"
                )
            subscription_id = self._next_id
            self._next_id += 1
            subscription = RealtimeSubscription(
                hub=self,
                subscription_id=subscription_id,
                actor_key=actor_key,
                resources=frozenset(resources),
                queue=asyncio.Queue(maxsize=settings.realtime_subscriber_queue_size),
            )
            self._subscriptions[subscription_id] = subscription
            realtime_metrics.increment("connectionsOpened")
            realtime_metrics.increment("activeConnections")
            return subscription

    def unsubscribe(self, subscription_id: int) -> None:
        with self._lock:
            removed = self._subscriptions.pop(subscription_id, None)
            if removed is not None:
                realtime_metrics.increment("connectionsClosed")
                realtime_metrics.increment("activeConnections", -1)

    def publish(self, event: RealtimeEventEnvelope) -> None:
        with self._lock:
            subscriptions = list(self._subscriptions.values())
        resource = (event.resource_type, event.resource_id)
        delivered = 0
        for subscription in subscriptions:
            if subscription.closed or resource not in subscription.resources:
                continue
            try:
                subscription.queue.put_nowait(event)
                delivered += 1
            except asyncio.QueueFull:
                while not subscription.queue.empty():
                    try:
                        subscription.queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                try:
                    subscription.queue.put_nowait(RealtimeQueueOverflow())
                except asyncio.QueueFull:
                    pass
                realtime_metrics.increment("queueOverflows")
        if delivered:
            realtime_metrics.increment("eventsDelivered", delivered)
            try:
                occurred_at = datetime.fromisoformat(event.occurred_at)
                if occurred_at.tzinfo is None:
                    occurred_at = occurred_at.replace(tzinfo=UTC)
                realtime_metrics.set(
                    "lastDeliveryLagMs",
                    max(0.0, (datetime.now(UTC) - occurred_at).total_seconds() * 1_000),
                )
            except ValueError:
                pass

    def active_connections(self) -> int:
        with self._lock:
            return len(self._subscriptions)

    def capacity_snapshot(self) -> dict[str, int]:
        with self._lock:
            queue_depths = [
                subscription.queue.qsize()
                for subscription in self._subscriptions.values()
            ]
            return {
                "activeConnections": len(self._subscriptions),
                "queuedEvents": sum(queue_depths),
                "maxSubscriberQueueDepth": max(queue_depths, default=0),
            }

    def reset(self) -> None:
        with self._lock:
            subscriptions = list(self._subscriptions.values())
            self._subscriptions.clear()
        for subscription in subscriptions:
            subscription.closed = True
        if subscriptions:
            realtime_metrics.increment("connectionsClosed", len(subscriptions))
            realtime_metrics.increment("activeConnections", -len(subscriptions))


class RealtimeEventDispatcher:
    def __init__(self, hub: RealtimeEventHub) -> None:
        self.hub = hub
        self._wake = asyncio.Event()
        self._last_cursor = 0
        self._ready = False

    @property
    def ready(self) -> bool:
        return self._ready

    @property
    def last_cursor(self) -> int:
        return self._last_cursor

    async def run(self) -> None:
        listener_task: asyncio.Task[None] | None = None
        initialized = False
        backoff_seconds = 0.5
        next_cleanup_at = time.monotonic() + settings.realtime_cleanup_interval_seconds
        try:
            while True:
                try:
                    if not initialized:
                        self._last_cursor = await asyncio.to_thread(self._current_cursor)
                        initialized = True
                        realtime_metrics.set("lastDispatchedCursor", self._last_cursor)
                        self._ready = True
                        realtime_metrics.set("dispatcherReady", True)
                        if _is_postgres_database():
                            listener_task = asyncio.create_task(
                                self._postgres_listener_loop(),
                                name="asklake-realtime-postgres-listener",
                            )
                    try:
                        await asyncio.wait_for(
                            self._wake.wait(),
                            timeout=settings.realtime_dispatch_poll_seconds,
                        )
                    except TimeoutError:
                        pass
                    self._wake.clear()
                    await self._dispatch_available()
                    if time.monotonic() >= next_cleanup_at:
                        await asyncio.to_thread(self._cleanup_expired)
                        next_cleanup_at = time.monotonic() + settings.realtime_cleanup_interval_seconds
                    self._ready = True
                    realtime_metrics.set("dispatcherReady", True)
                    realtime_metrics.set("lastError", None)
                    backoff_seconds = 0.5
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self._ready = False
                    realtime_metrics.set("dispatcherReady", False)
                    realtime_metrics.set("lastError", error.__class__.__name__)
                    logger.warning(
                        "Realtime event dispatcher retrying after %s",
                        error.__class__.__name__,
                    )
                    await asyncio.sleep(backoff_seconds)
                    backoff_seconds = min(10.0, backoff_seconds * 2)
        except asyncio.CancelledError:
            raise
        finally:
            self._ready = False
            realtime_metrics.set("dispatcherReady", False)
            realtime_metrics.set("listenerReady", False)
            if listener_task is not None:
                listener_task.cancel()
                try:
                    await listener_task
                except asyncio.CancelledError:
                    pass

    async def _dispatch_available(self) -> None:
        while True:
            events = await asyncio.to_thread(
                self._load_after,
                self._last_cursor,
                settings.realtime_replay_limit,
            )
            if not events:
                return
            for event in events:
                if event.event_id <= self._last_cursor:
                    continue
                self.hub.publish(event)
                self._last_cursor = event.event_id
                realtime_metrics.set("lastDispatchedCursor", self._last_cursor)
            if len(events) < settings.realtime_replay_limit:
                return

    async def _postgres_listener_loop(self) -> None:
        backoff_seconds = 0.5
        while True:
            try:
                connection = await psycopg.AsyncConnection.connect(
                    _psycopg_dsn(settings.database_url),
                    autocommit=True,
                    connect_timeout=settings.database_connect_timeout_seconds,
                )
                async with connection:
                    await connection.execute(
                        sql.SQL("LISTEN {}").format(sql.Identifier(REALTIME_NOTIFY_CHANNEL))
                    )
                    realtime_metrics.set("listenerReady", True)
                    realtime_metrics.set("lastError", None)
                    backoff_seconds = 0.5
                    self._wake.set()
                    async for _notification in connection.notifies():
                        self._wake.set()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                realtime_metrics.set("listenerReady", False)
                realtime_metrics.set("lastError", error.__class__.__name__)
                logger.warning(
                    "Realtime PostgreSQL listener reconnecting after %s",
                    error.__class__.__name__,
                )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds = min(10.0, backoff_seconds * 2)

    @staticmethod
    def _current_cursor() -> int:
        with SessionLocal() as db:
            return RealtimeEventRepository(db).max_cursor()

    @staticmethod
    def _load_after(cursor: int, limit: int) -> list[RealtimeEventEnvelope]:
        with SessionLocal() as db:
            return RealtimeEventRepository(db).dispatch_after(cursor, limit=limit)

    @staticmethod
    def _cleanup_expired() -> None:
        with SessionLocal() as db:
            RealtimeEventRepository(db).cleanup_expired()
            db.commit()


def _is_postgres_database() -> bool:
    return settings.database_url.startswith(("postgresql://", "postgresql+", "postgres://"))


def _psycopg_dsn(database_url: str) -> str:
    if database_url.startswith("postgresql+psycopg://"):
        return "postgresql://" + database_url.removeprefix("postgresql+psycopg://")
    if database_url.startswith("postgres://"):
        return "postgresql://" + database_url.removeprefix("postgres://")
    return database_url


realtime_event_hub = RealtimeEventHub()
realtime_event_dispatcher = RealtimeEventDispatcher(realtime_event_hub)
