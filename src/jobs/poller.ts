import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bets, markets } from "../db/schema.js";
import { getBatchPrices } from "../services/polymarket.js";
import { logger } from "../utils/logger.js";

// Simple intervals based on time-to-close
const INTERVAL_FAR = 4 * 60 * 60 * 1000; // > 7 days: every 4h
const INTERVAL_MEDIUM = 2 * 60 * 60 * 1000; // 1-7 days: every 2h
const INTERVAL_CLOSE = 30 * 60 * 1000; // < 24h: every 30m
const INTERVAL_PAST = 15 * 60 * 1000; // past end date: every 15m

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

  try {
    await runPollCycle();
  } catch (err) {
    logger.error("Poll cycle failed:", err);
  }

  if (stopped) return;

  // Next cycle in 5 minutes — each cycle picks up whatever is due
  pollTimer = setTimeout(() => void schedulePollCycle(), 5 * 60 * 1000);
}

async function runPollCycle() {
  // Find all markets with pending bets
  const marketsWithBets = await db
    .selectDistinct({ marketId: bets.marketId })
    .from(bets)
    .where(eq(bets.status, "pending"));

  if (marketsWithBets.length === 0) {
    logger.debug("No markets with pending bets to poll");
    return;
  }

  const marketIds = marketsWithBets.map((r) => r.marketId);

  // Fetch those markets
  const trackedMarkets = await db.query.markets.findMany({
    where: sql`${markets.id} IN (${sql.join(
      marketIds.map((id) => sql`${id}`),
      sql`, `
    )})`,
  });

  const now = Date.now();
  const due: typeof trackedMarkets = [];

  for (const market of trackedMarkets) {
    const interval = getInterval(market.endDate);
    const lastPolled = market.lastPolledAt?.getTime() ?? 0;

    if (now - lastPolled >= interval) {
      due.push(market);
    }
  }

  if (due.length === 0) {
    logger.debug(
      `Polling: ${trackedMarkets.length} tracked, none due yet`
    );
    return;
  }

  logger.info(`Polling ${due.length} markets (${trackedMarkets.length} tracked total)`);

  // Collect all token IDs for batch fetch
  const tokenIds: string[] = [];
  const tokenToMarket = new Map<string, (typeof due)[number]>();

  for (const market of due) {
    if (market.yesTokenId) {
      tokenIds.push(market.yesTokenId);
      tokenToMarket.set(market.yesTokenId, market);
    }
  }

  if (tokenIds.length === 0) return;

  // Batch fetch prices (up to 20 per call)
  try {
    for (let i = 0; i < tokenIds.length; i += 20) {
      const batch = tokenIds.slice(i, i + 20);
      const prices = await getBatchPrices(batch);

      for (const [tokenId, yesPrice] of prices) {
        const market = tokenToMarket.get(tokenId);
        if (!market) continue;

        const noPrice = 1 - yesPrice;

        await db
          .update(markets)
          .set({
            currentYesPrice: String(yesPrice),
            currentNoPrice: String(noPrice),
            lastPolledAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(markets.id, market.id));
      }
    }

    logger.debug(`Updated prices for ${due.length} markets`);
  } catch (err) {
    logger.error("Batch price fetch failed:", err);
  }
}

function getInterval(endDate: Date | null): number {
  if (!endDate) return INTERVAL_FAR;

  const msUntilClose = endDate.getTime() - Date.now();

  if (msUntilClose < 0) return INTERVAL_PAST; // past end date
  if (msUntilClose < 24 * 60 * 60 * 1000) return INTERVAL_CLOSE; // < 24h
  if (msUntilClose < 7 * 24 * 60 * 60 * 1000) return INTERVAL_MEDIUM; // < 7 days
  return INTERVAL_FAR; // > 7 days
}
