import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { bets, markets } from "../db/schema.js";
import { getBatchPrices } from "../services/polymarket.js";
import { logger } from "../utils/logger.js";

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export async function startPoller() {
  stopped = false;
  logger.info("Starting background poller");
  await schedulePollCycle();
}

export function stopPoller() {
  stopped = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  logger.info("Background poller stopped");
}

async function schedulePollCycle() {
  if (stopped) return;

  let nextDelay = config.POLL_CYCLE_MS;

  try {
    nextDelay = await runPollCycle();
  } catch (err) {
    logger.error("Poll cycle failed:", err);
  }

  if (stopped) return;

  pollTimer = setTimeout(() => void schedulePollCycle(), nextDelay);
}

async function runPollCycle(): Promise<number> {
  // Find all markets with pending bets
  const marketsWithBets = await db
    .selectDistinct({ marketId: bets.marketId })
    .from(bets)
    .where(eq(bets.status, "pending"));

  if (marketsWithBets.length === 0) {
    logger.debug("No markets with pending bets to poll");
    return config.POLL_CYCLE_MS;
  }

  const marketIds = marketsWithBets.map((r) => r.marketId);

  const trackedMarkets = await db.query.markets.findMany({
    where: sql`${markets.id} IN (${sql.join(
      marketIds.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  });

  if (trackedMarkets.length === 0) return config.POLL_CYCLE_MS;

  // Spread polls evenly: cycle_time / market_count
  const interval = Math.floor(config.POLL_CYCLE_MS / trackedMarkets.length);

  logger.info(
    `Polling ${trackedMarkets.length} markets, one every ${Math.round(interval / 1000)}s (${Math.round(config.POLL_CYCLE_MS / 60000)}min cycle)`,
  );

  for (const market of trackedMarkets) {
    if (stopped) break;

    if (!market.yesTokenId) continue;

    try {
      const prices = await getBatchPrices([market.yesTokenId]);
      const yesPrice = prices.get(market.yesTokenId);

      if (yesPrice != null) {
        await db
          .update(markets)
          .set({
            currentYesPrice: String(yesPrice),
            currentNoPrice: String(1 - yesPrice),
            updatedAt: new Date(),
          })
          .where(eq(markets.id, market.id));

        logger.debug(`Updated market ${market.id}: yes=${yesPrice.toFixed(4)}`);
      }
    } catch (err) {
      logger.error(`Price fetch failed for market ${market.id}:`, err);
    }

    // Wait before polling next market (skip delay after last one)
    if (!stopped && market !== trackedMarkets[trackedMarkets.length - 1]) {
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // Return remaining time in cycle (or 0 if we took longer than the cycle)
  return Math.max(interval, 0);
}
