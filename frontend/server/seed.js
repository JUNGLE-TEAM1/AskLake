import { databaseUrl, pool, seedDatabase } from "./db.js";

try {
  const summary = await seedDatabase();
  console.log(`Seeded AskLake Postgres at ${databaseUrl}`);
  console.log(`jobs=${summary.jobs}, datasets=${summary.datasets}, dashboards=${summary.dashboards}`);
} finally {
  await pool.end();
}
