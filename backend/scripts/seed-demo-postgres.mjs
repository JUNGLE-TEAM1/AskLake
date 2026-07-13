import pg from "pg";

const { Client } = pg;

const database = process.env.ASKLAKE_SOURCE_POSTGRES_DATABASE || "asklake_sources";
const client = new Client({
  connectionString: process.env.ASKLAKE_SOURCE_POSTGRES_URL || undefined,
  database,
  host: process.env.ASKLAKE_SOURCE_POSTGRES_HOST || "127.0.0.1",
  password: process.env.ASKLAKE_SOURCE_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || "",
  port: Number(process.env.ASKLAKE_SOURCE_POSTGRES_PORT || 5432),
  user: process.env.ASKLAKE_SOURCE_POSTGRES_USER || process.env.POSTGRES_USER || "asklake",
});

const tableFixtures = [
  {
    columns: ["order_id", "customer_id", "order_date", "total_amount", "status", "region", "channel"],
    conflict: ["order_id"],
    createSql: `
      CREATE TABLE IF NOT EXISTS public.orders_clean (
        order_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        order_date DATE NOT NULL,
        total_amount NUMERIC NOT NULL,
        status TEXT NOT NULL,
        region TEXT NOT NULL,
        channel TEXT NOT NULL
      )
    `,
    rows: [
      ["ORD-1001", "CUS-204", "2026-07-02", 128000, "paid", "KR", "web"],
      ["ORD-1002", "CUS-118", "2026-07-02", 56000, "shipped", "KR", "mobile"],
      ["ORD-1003", "CUS-204", "2026-07-03", 74000, "paid", "KR", "mobile"],
      ["ORD-1004", "CUS-331", "2026-07-03", 219000, "paid", "JP", "web"],
      ["ORD-1005", "CUS-118", "2026-07-04", 33000, "refunded", "KR", "web"],
      ["ORD-1006", "CUS-508", "2026-07-04", 184000, "paid", "SG", "mobile"],
      ["ORD-1007", "CUS-331", "2026-07-05", 91000, "shipped", "JP", "store"],
      ["ORD-1008", "CUS-772", "2026-07-05", 45000, "paid", "AU", "web"],
    ],
    table: "orders_clean",
  },
  {
    columns: ["customer_id", "customer_name", "segment", "region", "signup_date", "is_vip"],
    conflict: ["customer_id"],
    createSql: `
      CREATE TABLE IF NOT EXISTS public.customers_clean (
        customer_id TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        segment TEXT NOT NULL,
        region TEXT NOT NULL,
        signup_date DATE NOT NULL,
        is_vip BOOLEAN NOT NULL
      )
    `,
    rows: [
      ["CUS-204", "김민준", "VIP", "KR", "2024-03-12", true],
      ["CUS-118", "이지아", "Standard", "KR", "2025-01-08", false],
      ["CUS-331", "Haruto Sato", "VIP", "JP", "2023-11-21", true],
      ["CUS-508", "Nur Aisyah", "Growth", "SG", "2025-06-02", false],
      ["CUS-772", "Olivia Brown", "Standard", "AU", "2024-09-17", false],
    ],
    table: "customers_clean",
  },
  {
    columns: ["order_id", "product_id", "quantity", "unit_price", "discount_amount", "item_status"],
    conflict: ["order_id", "product_id"],
    createSql: `
      CREATE TABLE IF NOT EXISTS public.order_items_clean (
        order_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price NUMERIC NOT NULL,
        discount_amount NUMERIC NOT NULL,
        item_status TEXT NOT NULL,
        PRIMARY KEY (order_id, product_id)
      )
    `,
    rows: [
      ["ORD-1001", "SKU-8842", 1, 98000, 0, "fulfilled"],
      ["ORD-1001", "SKU-1120", 2, 15000, 0, "fulfilled"],
      ["ORD-1002", "SKU-200", 1, 56000, 0, "fulfilled"],
      ["ORD-1003", "SKU-1120", 3, 15000, 1000, "fulfilled"],
      ["ORD-1003", "SKU-7741", 1, 30000, 0, "fulfilled"],
      ["ORD-1004", "SKU-8842", 2, 98000, 5000, "fulfilled"],
      ["ORD-1006", "SKU-5501", 1, 184000, 0, "fulfilled"],
    ],
    table: "order_items_clean",
  },
  {
    columns: ["product_id", "product_name", "category", "brand", "list_price"],
    conflict: ["product_id"],
    createSql: `
      CREATE TABLE IF NOT EXISTS public.products_clean (
        product_id TEXT PRIMARY KEY,
        product_name TEXT NOT NULL,
        category TEXT NOT NULL,
        brand TEXT NOT NULL,
        list_price NUMERIC NOT NULL
      )
    `,
    rows: [
      ["SKU-8842", "Smart Air Fryer", "appliance", "NamuHome", 98000],
      ["SKU-1120", "Vitamin Serum", "beauty", "GlowLab", 15000],
      ["SKU-200", "Coffee Capsule Pack", "grocery", "DailyBrew", 56000],
      ["SKU-7741", "Wireless Mouse", "electronics", "WorkMate", 30000],
      ["SKU-5501", "Robot Vacuum", "appliance", "NamuHome", 184000],
    ],
    table: "products_clean",
  },
  {
    columns: ["payment_id", "order_id", "payment_method", "paid_amount", "payment_status", "paid_at"],
    conflict: ["payment_id"],
    createSql: `
      CREATE TABLE IF NOT EXISTS public.payments_clean (
        payment_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        paid_amount NUMERIC NOT NULL,
        payment_status TEXT NOT NULL,
        paid_at TIMESTAMPTZ NOT NULL
      )
    `,
    rows: [
      ["PAY-9001", "ORD-1001", "card", 128000, "captured", "2026-07-02T09:14:22Z"],
      ["PAY-9002", "ORD-1002", "wallet", 56000, "captured", "2026-07-02T10:22:18Z"],
      ["PAY-9003", "ORD-1003", "card", 74000, "captured", "2026-07-03T11:02:45Z"],
      ["PAY-9004", "ORD-1004", "bank_transfer", 219000, "captured", "2026-07-03T15:48:10Z"],
      ["PAY-9005", "ORD-1005", "card", 33000, "refunded", "2026-07-04T08:31:09Z"],
      ["PAY-9006", "ORD-1006", "wallet", 184000, "captured", "2026-07-04T12:10:33Z"],
    ],
    table: "payments_clean",
  },
  {
    columns: ["event_id", "customer_id", "event_time", "page_path", "event_type", "device", "payload"],
    conflict: ["event_id"],
    createSql: `
      CREATE TABLE IF NOT EXISTS public.user_activity (
        event_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        event_time TIMESTAMPTZ NOT NULL,
        page_path TEXT NOT NULL,
        event_type TEXT NOT NULL,
        device TEXT NOT NULL,
        payload JSONB NOT NULL
      )
    `,
    rows: [
      ["ACT-1001", "CUS-204", "2026-07-01T10:12:31Z", "/products/SKU-8842", "product_view", "ios", { experiment: "review_summary", variant: "B" }],
      ["ACT-1002", "CUS-118", "2026-07-02T03:18:44Z", "/cart", "coupon_apply", "web", { couponCode: "SUMMER10", cartValue: 56000 }],
      ["ACT-1003", "CUS-508", "2026-07-04T12:30:03Z", "/returns/ORD-1006", "return_request_failed", "android", { errorCode: "RETURN_POLICY_TIMEOUT", retryCount: 3 }],
    ],
    table: "user_activity",
  },
];

try {
  await client.connect();
  const summaries = [];
  for (const fixture of tableFixtures) {
    await client.query(fixture.createSql);
    for (const row of fixture.rows) {
      await upsertRow(fixture.table, fixture.columns, fixture.conflict, row);
    }
    const countResult = await client.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdent(fixture.table)}`);
    summaries.push({ table: fixture.table, rows: countResult.rows[0].count });
  }
  console.log(JSON.stringify({ database, summaries }, null, 2));
} finally {
  await client.end().catch(() => undefined);
}

async function upsertRow(table, columns, conflictColumns, values) {
  const columnList = columns.map(quoteIdent).join(", ");
  const valueList = values.map((_, index) => `$${index + 1}`).join(", ");
  const conflictList = conflictColumns.map(quoteIdent).join(", ");
  const updateList = columns
    .filter((column) => !conflictColumns.includes(column))
    .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`)
    .join(", ");
  await client.query(
    `
      INSERT INTO ${quoteIdent(table)} (${columnList})
      VALUES (${valueList})
      ON CONFLICT (${conflictList}) DO UPDATE SET ${updateList}
    `,
    values,
  );
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
