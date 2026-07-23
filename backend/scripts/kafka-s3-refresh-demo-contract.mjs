export const DEMO_TOPIC = "asklake.revision.events.v1";
export const DEMO_BUCKET = "m3-raw";
export const DEMO_KEY = "asklake-fixtures/kafka-s3-refresh-demo/products.csv";
export const DEFAULT_RATE = 100;
export const DEFAULT_DURATION_SECONDS = 3600;

export const PRODUCTS = [
  { productId: "P-1001", price: 25900 },
  { productId: "P-1002", price: 89000 },
  { productId: "P-1003", price: 49900 },
  { productId: "P-1004", price: 329000 },
  { productId: "P-1005", price: 219000 },
  { productId: "P-1006", price: 149000 },
  { productId: "P-1007", price: 69000 },
  { productId: "P-1008", price: 39000 },
  { productId: "P-1009", price: 29900 },
  { productId: "P-1010", price: 24900 },
];

const EVENT_TYPES = ["product_impression", "product_click", "add_to_cart", "purchase_click"];
const DEVICES = ["mobile", "web", "tablet"];

export function createDemoEvent({ runId, sequence, now = new Date() }) {
  if (!runId) throw new Error("runId is required");
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("sequence must be a positive integer");

  const product = PRODUCTS[(sequence - 1) % PRODUCTS.length];
  const eventType = EVENT_TYPES[(sequence - 1) % EVENT_TYPES.length];
  const quantity = eventType === "purchase_click" ? 1 + (sequence % 3) : 1;

  return {
    schema_version: "1.0",
    event_time: now.toISOString(),
    event_id: `${runId}-${String(sequence).padStart(9, "0")}`,
    user_id: `USR-${String(((sequence - 1) % 5000) + 1).padStart(6, "0")}`,
    session_id: `SES-${String(Math.floor((sequence - 1) / 8) + 1).padStart(8, "0")}`,
    event_type: eventType,
    product_id: product.productId,
    quantity,
    unit_price: product.price,
    amount: eventType === "purchase_click" ? product.price * quantity : 0,
    device_type: DEVICES[(sequence - 1) % DEVICES.length],
    source: "kafka-s3-refresh-demo",
  };
}

export function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
