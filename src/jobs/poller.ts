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
  logger.debug("Starting background poller");
  await schedulePollCycle();
}

export function stopPoller() {
  stopped = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  logger.debug("Background poller stopped");
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

  const pollable = trackedMarkets.filter((m) => m.yesTokenId);
  if (pollable.length === 0) return config.POLL_CYCLE_MS;

  const batchSize = config.POLL_MAX_BATCH_SIZE;
  const batches: (typeof pollable)[] = [];
  for (let i = 0; i < pollable.length; i += batchSize) {
    batches.push(pollable.slice(i, i + batchSize));
  }

  // Spread batches evenly across the cycle
  const interval = Math.floor(config.POLL_CYCLE_MS / batches.length);

  logger.debug(
    `Polling ${pollable.length} markets in ${batches.length} batch(es) of up to ${batchSize}, one every ${Math.round(interval / 1000)}s (${Math.round(config.POLL_CYCLE_MS / 60000)}min cycle)`,
  );

  for (let b = 0; b < batches.length; b++) {
    if (stopped) break;
    const batch = batches[b];
    if (!batch) continue;

    const tokenToMarket = new Map<string, (typeof batch)[number]>();
    for (const m of batch) {
      if (m.yesTokenId) tokenToMarket.set(m.yesTokenId, m);
    }

    try {
      const prices = await getBatchPrices([...tokenToMarket.keys()]);

      for (const [tokenId, market] of tokenToMarket) {
        const yesPrice = prices.get(tokenId);
        if (yesPrice == null) continue;

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
      logger.error(
        `Batch price fetch failed (batch ${b + 1}/${batches.length}):`,
        err,
      );
    }

    if (!stopped && b < batches.length - 1) {
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  return Math.max(interval, 0);
}
