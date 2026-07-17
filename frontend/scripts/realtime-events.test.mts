import assert from "node:assert/strict";
import test from "node:test";

import {
  RealtimeEventClient,
  coalesceDatasetRevisions,
  parseRealtimeEvent,
  realtimeEventsUrl,
  type RealtimeConnectionState,
  type RealtimeEventEnvelope,
} from "../src/services/realtimeEvents.ts";


class FakeEventSource {
  closed = false;
  listeners = new Map<string, EventListener[]>();
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  addEventListener(type: string, listener: EventListener) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: string) {
    const message = { data } as MessageEvent<string>;
    (this.listeners.get(type) ?? []).forEach((listener) => listener(message as unknown as Event));
  }
}


function realtimeEvent(
  eventId: number,
  revision: number,
  datasetId = "dataset-live",
): RealtimeEventEnvelope {
  return {
    aggregateRevision: revision,
    correlationId: `run-${eventId}`,
    eventId,
    eventType: "dataset.revision.committed",
    invalidate: [`dataset:${datasetId}:freshness`],
    occurredAt: "2026-07-16T00:00:00+00:00",
    payload: { commitKind: "stream", runId: `run-${eventId}` },
    resourceId: datasetId,
    resourceType: "dataset",
    schemaVersion: 1,
    scopeId: "deployment",
  };
}


test("realtime event parser rejects unknown versions and keeps UTF-8 payloads", () => {
  const valid = realtimeEvent(3, 7);
  valid.payload = { commitKind: "stream", runId: "한글-run" };

  assert.deepEqual(parseRealtimeEvent(JSON.stringify(valid)), valid);
  const dashboardEvent: RealtimeEventEnvelope = {
    ...valid,
    eventType: "dashboard.published",
    payload: { publishedRevisionId: "revision-2" },
    resourceId: "dashboard-live",
    resourceType: "dashboard",
  };
  assert.deepEqual(parseRealtimeEvent(JSON.stringify(dashboardEvent)), dashboardEvent);
  assert.equal(parseRealtimeEvent(JSON.stringify({
    ...dashboardEvent,
    resourceType: "dataset",
  })), null);
  assert.equal(parseRealtimeEvent(JSON.stringify({ ...valid, schemaVersion: 2 })), null);
  assert.equal(parseRealtimeEvent("{invalid"), null);
});


test("dataset revisions coalesce by highest revision and event cursor", () => {
  const coalesced = coalesceDatasetRevisions([
    realtimeEvent(4, 2),
    realtimeEvent(5, 1),
    realtimeEvent(6, 3),
    realtimeEvent(7, 3),
  ]);

  assert.deepEqual(coalesced.get("dataset-live"), {
    eventCursor: 7,
    revision: 3,
  });
});


test("event URL is stable and contains the snapshot cursor", () => {
  const url = realtimeEventsUrl(
    "dashboard-live",
    ["dataset-b", "dataset-a", "dataset-a"],
    12,
  );

  assert.match(url, /\/api\/realtime\/events\?/);
  assert.match(url, /cursor=12/);
  assert.match(url, /dashboardId=dashboard-live/);
  assert.match(url, /datasetIds=dataset-a%2Cdataset-b/);
});


test("single client owns connection state, parses events, and supports resync restart", () => {
  const sources: FakeEventSource[] = [];
  const urls: string[] = [];
  const states: RealtimeConnectionState[] = [];
  const events: RealtimeEventEnvelope[] = [];
  const resyncReasons: string[] = [];
  const client = new RealtimeEventClient((url) => {
    const source = new FakeEventSource();
    sources.push(source);
    urls.push(url);
    return source;
  });

  const connection = client.connect({
    cursor: 8,
    dashboardId: "dashboard-live",
    datasetIds: ["dataset-live"],
    onEvent: (event) => events.push(event),
    onResyncRequired: (reason) => resyncReasons.push(reason),
    onStateChange: (state) => states.push(state),
  });
  sources[0].onopen?.({} as Event);
  sources[0].emit(
    "dataset.revision.committed",
    JSON.stringify(realtimeEvent(9, 4)),
  );
  sources[0].emit(
    "system.resync_required",
    JSON.stringify({ reason: "cursor_expired" }),
  );

  assert.deepEqual(events.map((event) => event.eventId), [9]);
  assert.deepEqual(resyncReasons, ["cursor_expired"]);
  assert.equal(sources[0].closed, true);
  assert.deepEqual(states.slice(0, 3), ["connecting", "open", "fallback_polling"]);

  connection.restart(15);
  assert.equal(sources.length, 2);
  assert.match(urls[1], /cursor=15/);
  connection.close();
  assert.equal(sources[1].closed, true);
  assert.equal(states.at(-1), "closed");
});


test("missed heartbeat closes the stale stream and retries from the last cursor", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      clearTimeout: (timerId: number) => timers.delete(timerId),
      removeEventListener: () => undefined,
      setTimeout: (callback: () => void) => {
        const timerId = nextTimerId;
        nextTimerId += 1;
        timers.set(timerId, callback);
        return timerId;
      },
    },
  });

  const sources: FakeEventSource[] = [];
  const states: RealtimeConnectionState[] = [];
  const client = new RealtimeEventClient(() => {
    const source = new FakeEventSource();
    sources.push(source);
    return source;
  });

  try {
    const connection = client.connect({
      cursor: 21,
      dashboardId: "dashboard-live",
      datasetIds: ["dataset-live"],
      heartbeatTimeoutMs: 10_000,
      onEvent: () => undefined,
      onResyncRequired: () => undefined,
      onStateChange: (state) => states.push(state),
      reconnectRetryMs: 1_000,
    });
    sources[0].onopen?.({} as Event);

    const watchdog = timers.get(1);
    assert.ok(watchdog);
    timers.delete(1);
    watchdog();

    assert.equal(sources[0].closed, true);
    assert.equal(states.at(-1), "fallback_polling");
    const reconnect = timers.get(2);
    assert.ok(reconnect);
    timers.delete(2);
    reconnect();
    assert.equal(sources.length, 2);
    connection.close();
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as typeof globalThis & { window?: unknown }).window;
    }
  }
});

test("a dashboard or actor switch closes the previous stream and ignores stale callbacks", () => {
  const sources: FakeEventSource[] = [];
  const firstEvents: number[] = [];
  const firstStates: RealtimeConnectionState[] = [];
  const secondEvents: number[] = [];
  const client = new RealtimeEventClient(() => {
    const source = new FakeEventSource();
    sources.push(source);
    return source;
  });

  client.connect({
    cursor: 4,
    dashboardId: "dashboard-a",
    datasetIds: ["dataset-a"],
    onEvent: (event) => firstEvents.push(event.eventId),
    onResyncRequired: () => undefined,
    onStateChange: (state) => firstStates.push(state),
  });
  client.connect({
    cursor: 8,
    dashboardId: "dashboard-b",
    datasetIds: ["dataset-b"],
    onEvent: (event) => secondEvents.push(event.eventId),
    onResyncRequired: () => undefined,
    onStateChange: () => undefined,
  });

  assert.equal(sources[0].closed, true);
  assert.equal(firstStates.at(-1), "closed");
  sources[0].emit("dataset.revision.committed", JSON.stringify(realtimeEvent(5, 5, "dataset-a")));
  sources[1].emit("dataset.revision.committed", JSON.stringify(realtimeEvent(9, 9, "dataset-b")));
  assert.deepEqual(firstEvents, []);
  assert.deepEqual(secondEvents, [9]);
  client.close();
});

test("invalid event injection is reported without advancing the reconnect cursor", () => {
  const sources: FakeEventSource[] = [];
  const urls: string[] = [];
  const invalidEvents: string[] = [];
  const client = new RealtimeEventClient((url) => {
    urls.push(url);
    const source = new FakeEventSource();
    sources.push(source);
    return source;
  });

  const connection = client.connect({
    cursor: 12,
    dashboardId: "dashboard-live",
    datasetIds: ["dataset-live"],
    onEvent: () => undefined,
    onInvalidEvent: (raw) => invalidEvents.push(raw),
    onResyncRequired: () => undefined,
    onStateChange: () => undefined,
  });
  sources[0].emit("dataset.revision.committed", "{injected");
  connection.restart(0);

  assert.deepEqual(invalidEvents, ["{injected"]);
  assert.match(urls[1], /cursor=12/);
  connection.close();
});
