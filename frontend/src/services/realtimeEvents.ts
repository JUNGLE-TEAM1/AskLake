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
  schemaVersion: 1;
  scopeId: "deployment";
};

export type RealtimeEventEnvelope = RealtimeEventBase & (
  | {
    eventType: "dataset.revision.committed";
    resourceType: "dataset";
  }
  | {
    eventType: "dashboard.published";
    resourceType: "dashboard";
  }
);

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
        source?.addEventListener(eventType, (() => {
          if (stopped || this.generation !== generation) return;
          armWatchdog();
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
    const value = JSON.parse(raw) as Partial<RealtimeEventEnvelope>;
    if (
      value.schemaVersion !== 1
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
      || !value.payload
      || typeof value.payload !== "object"
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
    return value as RealtimeEventEnvelope;
  } catch {
    return null;
  }
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


function realtimeApiBaseUrl() {
  const environment = (
    import.meta as ImportMeta & {
      env?: Record<string, boolean | string | undefined>;
    }
  ).env ?? {};
  const defaultBaseUrl = "";
  return String(environment.VITE_API_BASE_URL || defaultBaseUrl).replace(/\/+$/, "");
}


export const dashboardRealtimeEventClient = new RealtimeEventClient();
