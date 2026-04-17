import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export async function runMigrations() {
  const migrationClient = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(migrationClient);

  logger.info("Running database migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  logger.info("Migrations complete.");

  await migrationClient.end();
}
