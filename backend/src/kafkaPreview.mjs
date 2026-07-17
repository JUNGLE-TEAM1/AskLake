export function recoverKafkaLogLines(messages) {
  const preferredFields = [
    "event_time",
    "event_id",
    "user_id",
    "session_id",
    "event_type",
    "product_id",
    "page_url",
    "device_type",
    "referrer",
    "position",
  ];
  const recovered = messages.map((message) => {
    try {
      const envelope = JSON.parse(message);
      if (!envelope || typeof envelope !== "object" || !/log/i.test(String(envelope.source ?? ""))) return "";
      if (!envelope.raw || typeof envelope.raw !== "object" || Array.isArray(envelope.raw)) return "";
      if (!preferredFields.every((field) => Object.hasOwn(envelope.raw, field))) return "";
      return preferredFields.map((field) => String(envelope.raw[field] ?? "")).join(" ");
    } catch {
      return "";
    }
  });
  return recovered.length > 0 && recovered.every((line) => line.trim()) ? recovered : [];
}
