import "dotenv/config";
import { z } from "zod/v4";

const envSchema = z.object({
  // Core
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Polymarket
  POLYMARKET_GAMMA_URL: z.url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_CLOB_URL: z.url().default("https://clob.polymarket.com"),

  // Polling
  POLL_BASE_INTERVAL_MS: z.coerce.number().int().positive().default(21_600_000),
  POLL_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  POLL_MAX_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),
  RESOLUTION_CHECK_CRON: z.string().default("*/30 * * * *"),
  METADATA_REFRESH_CRON: z.string().default("0 */6 * * *"),
  MOMENTUM_THRESHOLD_LOW: z.coerce.number().default(0.02),
  MOMENTUM_THRESHOLD_HIGH: z.coerce.number().default(0.10),
  ON_DEMAND_CACHE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  CLOSE_BET_PRICE_MAX_AGE_MS: z.coerce.number().int().positive().default(30_000),

  // Points economy
  DEFAULT_STARTING_POINTS: z.coerce.number().int().positive().default(1000),
  DEFAULT_MAX_BET: z.coerce.number().int().positive().default(500),
  DEFAULT_MIN_BET: z.coerce.number().int().positive().default(10),
  DEFAULT_DAILY_BONUS: z.coerce.number().int().positive().default(100),
  MAX_ACTIVE_BETS_PER_USER: z.coerce.number().int().positive().default(10),
  MAX_ACTIVE_BETS_PER_MARKET: z.coerce.number().int().positive().default(3),

  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(result.error));
  process.exit(1);
}

export const config = result.data;
export type Config = typeof config;
