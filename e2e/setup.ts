/**
 * Preloaded before every e2e test file (see the `test:e2e` script).
 *
 * Polymarket is called for real. Postgres is swapped for PGlite — real
 * Postgres compiled to WASM, running in memory — so transactions, row locks
 * and the drizzle migrations all behave as in production without a server.
 */
import { mock, setDefaultTimeout } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

// config.ts validates the environment on import; Discord itself is faked.
process.env.DISCORD_TOKEN = "e2e-token";
process.env.DISCORD_CLIENT_ID = "e2e-client";
process.env.DATABASE_URL = "postgres://pglite/in-memory";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL ??= "warn";
// Keep the AI summary off: it would need a paid key and isn't under test.
delete process.env.AI_API_KEY;
delete process.env.AI_MODEL;

const schema = await import("../src/db/schema.js");

export const pg = new PGlite();
export const db = drizzle(pg, { schema });
await migrate(db, { migrationsFolder: "./drizzle" });

mock.module("../src/db/index.ts", () => ({ db }));

// Live HTTP round-trips to Polymarket are far slower than bun's 5s default.
setDefaultTimeout(60_000);
