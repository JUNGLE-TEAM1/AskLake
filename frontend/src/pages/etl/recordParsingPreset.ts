import type { RecordParsingDraft } from "../../types";

export const CLICK_EVENT_RECORD_SCHEMA_PRESET: RecordParsingDraft["columns"] = [
  { position: 0, name: "event_time", inferredType: "Timestamp" },
  { position: 1, name: "event_id", inferredType: "String" },
  { position: 2, name: "user_id", inferredType: "String" },
  { position: 3, name: "session_id", inferredType: "String" },
  { position: 4, name: "event_type", inferredType: "String" },
  { position: 5, name: "product_id", inferredType: "String" },
  { position: 6, name: "page_url", inferredType: "String" },
  { position: 7, name: "device_type", inferredType: "String" },
  { position: 8, name: "referrer", inferredType: "String" },
  { position: 9, name: "position", inferredType: "Integer" },
];

const CLICK_EVENT_LOG_PATTERN = /(?:^|[/\\])click[-_]?events?\.log(?:$|[?#])/i;

export function isClickEventLogSource(sourceLabel: string, sourceConfig: Array<[string, string]>): boolean {
  return [sourceLabel, ...sourceConfig.map(([, value]) => value)]
    .some((value) => CLICK_EVENT_LOG_PATTERN.test(value.trim()));
}

export function applyClickEventRecordSchemaPreset(recordParsing: RecordParsingDraft): RecordParsingDraft | null {
  if (
    recordParsing.expectedFieldCount !== CLICK_EVENT_RECORD_SCHEMA_PRESET.length
    || recordParsing.columns.length !== CLICK_EVENT_RECORD_SCHEMA_PRESET.length
  ) return null;

  return {
    ...recordParsing,
    columns: recordParsing.columns.map((column, index) => ({
      ...column,
      name: CLICK_EVENT_RECORD_SCHEMA_PRESET[index].name,
      inferredType: CLICK_EVENT_RECORD_SCHEMA_PRESET[index].inferredType,
    })),
  };
}
