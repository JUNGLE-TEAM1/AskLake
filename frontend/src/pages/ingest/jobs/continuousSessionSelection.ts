import type { KafkaContinuousSession } from "../../../types";

export function retainedContinuousSessionId(
  sessions: KafkaContinuousSession[],
  requestedSessionId: string | null,
): string | null {
  return sessions.some((session) => session.sessionId === requestedSessionId)
    ? requestedSessionId
    : sessions[0]?.sessionId ?? null;
}
