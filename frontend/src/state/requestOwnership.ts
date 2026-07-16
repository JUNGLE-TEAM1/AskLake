export type ResourceQueryKeyInput = {
  resource: string;
  sessionId?: string | null;
  version?: number | string | null;
  params?: Record<string, unknown>;
};

export type RequestLease = {
  key: string;
  revision: number;
  signal: AbortSignal;
};

export type MutationPhase = "idle" | "pending" | "accepted" | "reconciled" | "failed";

export type MutationLifecycle = {
  error: string | null;
  phase: MutationPhase;
  revision: number;
};

export type MutationLease = {
  key: string;
  revision: number;
};

export function createResourceQueryKey({ resource, sessionId, version, params = {} }: ResourceQueryKeyInput) {
  const normalizedParams = Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({
    params: normalizedParams,
    resource,
    sessionId: sessionId ?? null,
    version: version ?? null,
  });
}

export class LatestRequestGate {
  private controller: AbortController | null = null;
  private key = "";
  private revision = 0;

  begin(key: string): RequestLease {
    this.controller?.abort();
    this.controller = new AbortController();
    this.key = key;
    this.revision += 1;
    return {
      key,
      revision: this.revision,
      signal: this.controller.signal,
    };
  }

  complete(lease: RequestLease) {
    if (!this.isCurrent(lease)) return false;
    this.controller = null;
    return true;
  }

  invalidate() {
    this.controller?.abort();
    this.controller = null;
    this.key = "";
    this.revision += 1;
  }

  isCurrent(lease: RequestLease) {
    return lease.revision === this.revision && lease.key === this.key && !lease.signal.aborted;
  }
}

export class MutationRevisionGate {
  private revisions = new Map<string, number>();

  begin(key: string): MutationLease {
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    return { key, revision };
  }

  invalidate(key: string) {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
  }

  isCurrent(lease: MutationLease) {
    return this.revisions.get(lease.key) === lease.revision;
  }
}

export function createMutationLifecycle(): MutationLifecycle {
  return { error: null, phase: "idle", revision: 0 };
}

export function transitionMutation(
  current: MutationLifecycle,
  phase: Exclude<MutationPhase, "idle">,
  error: string | null = null,
): MutationLifecycle {
  if (phase === "pending") {
    return { error: null, phase, revision: current.revision + 1 };
  }
  return { error, phase, revision: current.revision };
}
