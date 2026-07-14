export function decorateReplayRecord(record, cycle, streamOffset, { loop }) {
  if (!loop) return record;

  const replayEventId = `${record.event_id}--cycle-${String(cycle).padStart(6, "0")}--offset-${streamOffset}`;
  const raw = record.raw && typeof record.raw === "object" && !Array.isArray(record.raw)
    ? { ...record.raw }
    : record.raw;

  // Continuous pipelines may use the nested source event id as their merge key.
  // Keep it unique together with the replay envelope id so a replay appends rows
  // instead of repeatedly upserting the same source records.
  if (raw && Object.hasOwn(raw, "event_id")) raw.event_id = replayEventId;
  if (raw && Object.hasOwn(raw, "eventId")) raw.eventId = replayEventId;

  return {
    ...record,
    event_id: replayEventId,
    offset: streamOffset,
    raw,
  };
}
