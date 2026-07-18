export type RealtimeConnectionState =
  | "connecting"
  | "open"
  | "degraded"
  | "fallback_polling"
  | "closed";

type RealtimeEventBase = {
  aggregateRevision: number;
  correlationId: string;
  eventId: number;
  invalidate: string[];
  occurredAt: string;
  payload: Record<string, unknown>;
  resourceId: string;
  scopeId: "deployment";
};

export type RealtimeMutationType = "append" | "upsert" | "replace" | "retract";

export type RealtimeEventV1 = RealtimeEventBase & { schemaVersion: 1 } & (
  | {
    eventType: "dataset.revision.committed";
    resourceType: "dataset";
  }
  | {
    eventType: "dashboard.published";
    resourceType: "dashboard";
  }
);

export type RealtimeDatasetEventV2 = RealtimeEventBase & {
  eventType: "dataset.revision.committed";
  payload: {
    bindingEpoch: number;
    materializationId: string;
    mutationType: RealtimeMutationType;
    pipelineVersionId: string;
    servingVersionId: string;
    sourceBoundary: Record<string, unknown>;
  };
  resourceType: "dataset";
  schemaVersion: 2;
};

export type RealtimeEventEnvelope = RealtimeEventV1 | RealtimeDatasetEventV2;

export type RealtimeEventConnection = {
  close: () => void;
  restart: (cursor: number) => void;
};

export type RealtimeEventClientOptions = {
  cursor: number;
  dashboardId: string;
  datasetIds: string[];
  heartbeatTimeoutMs?: number;
  onEvent: (event: RealtimeEventEnvelope) => void;
  onInvalidEvent?: (raw: string) => void;
  onReady?: (currentCursor: number | null) => void;
  onResyncRequired: (reason: string) => void;
  onStateChange: (state: RealtimeConnectionState) => void;
  reconnectRetryMs?: number;
};

type EventSourceLike = {
  addEventListener: (type: string, listener: EventListener) => void;
  close: () => void;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
};

import { apiBaseUrl } from "./apiOrigin.ts";

type EventSourceFactory = (
  url: string,
  eventSourceInitDict?: EventSourceInit,
) => EventSourceLike;

const REALTIME_DOMAIN_EVENT_TYPES = [
  "dataset.revision.committed",
  "dashboard.published",
] as const;
const REALTIME_RESYNC_EVENT_TYPES = [
  "system.resync_required",
  "system.authorization_changed",
] as const;


export class RealtimeEventClient {
  private activeClose: (() => void) | null = null;
  private readonly eventSourceFactory: EventSourceFactory;
  private generation = 0;

  constructor(
    eventSourceFactory: EventSourceFactory = (
      url,
      options,
    ) => new EventSource(url, options),
  ) {
    this.eventSourceFactory = eventSourceFactory;
  }

  connect(options: RealtimeEventClientOptions): RealtimeEventConnection {
    this.close();
    const generation = ++this.generation;
    let source: EventSourceLike | null = null;
    let lastCursor = Math.max(0, Math.floor(options.cursor));
    let stopped = false;
    let reconnectTimer: number | undefined;
    let watchdogTimer: number | undefined;
    const heartbeatTimeoutMs = Math.max(10_000, options.heartbeatTimeoutMs ?? 45_000);
    const reconnectRetryMs = Math.max(1_000, options.reconnectRetryMs ?? 3_000);

    const updateState = (state: RealtimeConnectionState) => {
      if (this.generation === generation && !stopped) options.onStateChange(state);
    };

    const clearReconnectTimer = () => {
      if (reconnectTimer === undefined || typeof window === "undefined") return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };

    const clearWatchdog = () => {
      if (watchdogTimer === undefined || typeof window === "undefined") return;
      window.clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    };

    const closeSource = () => {
      clearWatchdog();
      source?.close();
      source = null;
    };

    const armWatchdog = () => {
      if (typeof window === "undefined") return;
      clearWatchdog();
      watchdogTimer = window.setTimeout(() => {
        watchdogTimer = undefined;
        if (stopped || this.generation !== generation) return;
        closeSource();
        updateState("fallback_polling");
        clearReconnectTimer();
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = undefined;
          open(lastCursor);
        }, reconnectRetryMs);
      }, heartbeatTimeoutMs);
    };

    const open = (cursor: number) => {
      if (stopped || this.generation !== generation) return;
      clearReconnectTimer();
      closeSource();
      lastCursor = Math.max(lastCursor, Math.max(0, Math.floor(cursor)));
      updateState(typeof navigator !== "undefined" && navigator.onLine === false
        ? "fallback_polling"
        : "connecting");
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;

      source = this.eventSourceFactory(
        realtimeEventsUrl(options.dashboardId, options.datasetIds, lastCursor),
        { withCredentials: true },
      );
      source.onopen = () => {
        updateState("open");
        armWatchdog();
      };
      source.onerror = () => updateState(
        typeof navigator !== "undefined" && navigator.onLine === false
          ? "fallback_polling"
          : "degraded",
      );

      REALTIME_DOMAIN_EVENT_TYPES.forEach((eventType) => {
        source?.addEventListener(eventType, ((message: MessageEvent<string>) => {
          if (stopped || this.generation !== generation) return;
          armWatchdog();
          const event = parseRealtimeEvent(message.data);
          if (!event) {
            options.onInvalidEvent?.(message.data);
            return;
          }
          lastCursor = Math.max(lastCursor, event.eventId);
          options.onEvent(event);
        }) as EventListener);
      });

      ["stream.ready", "system.heartbeat"].forEach((eventType) => {
        source?.addEventListener(eventType, ((message: MessageEvent<string>) => {
          if (stopped || this.generation !== generation) return;
          armWatchdog();
          if (eventType === "stream.ready") options.onReady?.(systemEventCursor(message.data));
        }) as EventListener);
      });

      REALTIME_RESYNC_EVENT_TYPES.forEach((eventType) => {
        source?.addEventListener(eventType, ((message: MessageEvent<string>) => {
          if (stopped || this.generation !== generation) return;
          armWatchdog();
          closeSource();
          updateState("fallback_polling");
          options.onResyncRequired(systemEventReason(message.data, eventType));
        }) as EventListener);
      });
    };

    const handleOffline = () => {
      clearReconnectTimer();
      closeSource();
      updateState("fallback_polling");
    };
    const handleOnline = () => open(lastCursor);
    if (typeof window !== "undefined") {
      window.addEventListener("offline", handleOffline);
      window.addEventListener("online", handleOnline);
    }

    const close = () => {
      if (stopped) return;
      stopped = true;
      clearReconnectTimer();
      closeSource();
      if (typeof window !== "undefined") {
        window.removeEventListener("offline", handleOffline);
        window.removeEventListener("online", handleOnline);
      }
      if (this.generation === generation) {
        options.onStateChange("closed");
        this.activeClose = null;
      }
    };

    this.activeClose = close;
    open(lastCursor);
    return {
      close,
      restart: (cursor) => {
        if (stopped || this.generation !== generation) return;
        open(cursor);
      },
    };
  }

  close() {
    this.activeClose?.();
    this.activeClose = null;
  }
}


export function realtimeEventsUrl(
  dashboardId: string,
  datasetIds: string[],
  cursor: number,
) {
  const normalizedDatasetIds = Array.from(new Set(datasetIds.map((id) => id.trim()).filter(Boolean))).sort();
  const query = new URLSearchParams({
    cursor: String(Math.max(0, Math.floor(cursor))),
    dashboardId: dashboardId.trim(),
    datasetIds: normalizedDatasetIds.join(","),
  });
  return `${realtimeApiBaseUrl()}/api/realtime/events?${query.toString()}`;
}


export function parseRealtimeEvent(raw: string): RealtimeEventEnvelope | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      (value.schemaVersion !== 1 && value.schemaVersion !== 2)
      || value.scopeId !== "deployment"
      || typeof value.resourceId !== "string"
      || !value.resourceId
      || typeof value.eventId !== "number"
      || !Number.isSafeInteger(value.eventId)
      || value.eventId < 1
      || typeof value.aggregateRevision !== "number"
      || !Number.isSafeInteger(value.aggregateRevision)
      || value.aggregateRevision < 0
      || typeof value.correlationId !== "string"
      || typeof value.occurredAt !== "string"
      || !Array.isArray(value.invalidate)
      || !value.invalidate.every((item) => typeof item === "string")
      || !value.payload
      || typeof value.payload !== "object"
      || Array.isArray(value.payload)
    ) {
      return null;
    }
    const eventMatchesResource = (
      value.eventType === "dataset.revision.committed"
      && value.resourceType === "dataset"
    ) || (
      value.eventType === "dashboard.published"
      && value.resourceType === "dashboard"
    );
    if (!eventMatchesResource) return null;
    if (value.schemaVersion === 2) {
      if (value.eventType !== "dataset.revision.committed" || value.resourceType !== "dataset") {
        return null;
      }
      const payload = value.payload as Record<string, unknown>;
      if (
        !Number.isSafeInteger(payload.bindingEpoch)
        || (payload.bindingEpoch as number) < 0
        || !nonEmptyString(payload.materializationId)
        || !isRealtimeMutationType(payload.mutationType)
        || !nonEmptyString(payload.pipelineVersionId)
        || !nonEmptyString(payload.servingVersionId)
        || !payload.sourceBoundary
        || typeof payload.sourceBoundary !== "object"
        || Array.isArray(payload.sourceBoundary)
      ) {
        return null;
      }
    }
    return value as RealtimeEventEnvelope;
  } catch {
    return null;
  }
}


function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}


function isRealtimeMutationType(value: unknown): value is RealtimeMutationType {
  return value === "append" || value === "upsert" || value === "replace" || value === "retract";
}


export function coalesceDatasetRevisions(events: RealtimeEventEnvelope[]) {
  const latestRevisionByDatasetId = new Map<string, {
    eventCursor: number;
    revision: number;
  }>();
  events.forEach((event) => {
    if (event.eventType !== "dataset.revision.committed") return;
    const current = latestRevisionByDatasetId.get(event.resourceId);
    if (
      !current
      || event.aggregateRevision > current.revision
      || (
        event.aggregateRevision === current.revision
        && event.eventId > current.eventCursor
      )
    ) {
      latestRevisionByDatasetId.set(event.resourceId, {
        eventCursor: event.eventId,
        revision: event.aggregateRevision,
      });
    }
  });
  return latestRevisionByDatasetId;
}


function systemEventReason(raw: string, fallback: string) {
  try {
    const value = JSON.parse(raw) as { reason?: unknown };
    return typeof value.reason === "string" && value.reason ? value.reason : fallback;
  } catch {
    return fallback;
  }
}


function systemEventCursor(raw: string) {
  try {
    const value = JSON.parse(raw) as { currentCursor?: unknown };
    return Number.isSafeInteger(value.currentCursor) && (value.currentCursor as number) >= 0
      ? value.currentCursor as number
      : null;
  } catch {
    return null;
  }
}


function realtimeApiBaseUrl() {
  return apiBaseUrl;
}


export const dashboardRealtimeEventClient = new RealtimeEventClient();
