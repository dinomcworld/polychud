import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import * as cron from "node-cron";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { bets, markets } from "../db/schema.js";
import { cancelMarket, resolveMarketBets } from "../services/betting.js";
import { getMarketByConditionId } from "../services/polymarket.js";
import { logger } from "../utils/logger.js";

let task: ReturnType<typeof cron.schedule> | null = null;
let running = false;

export function startResolver() {
  logger.info(
    `Starting resolution checker (cron: ${config.RESOLUTION_CHECK_CRON})`,
  );

  task = cron.schedule(config.RESOLUTION_CHECK_CRON, () => {
    void runResolutionCheck();
  });
}

export function stopResolver() {
  if (task) {
    task.stop();
    task = null;
    logger.info("Resolution checker stopped");
  }
}

async function runResolutionCheck() {
  if (running) {
    logger.debug("Resolution check already running, skipping");
    return;
  }

  running = true;
  logger.info("Running resolution check...");

  try {
    // Find markets that have pending bets AND are near/past end date
    const now = new Date();
    const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Get distinct market IDs that have pending bets
    const marketsWithBets = await db
      .selectDistinct({ marketId: bets.marketId })
      .from(bets)
      .where(eq(bets.status, "pending"));

    if (marketsWithBets.length === 0) {
      logger.debug("No markets with pending bets to check");
      return;
    }

    const marketIds = marketsWithBets.map((r) => r.marketId);

    // Fetch those markets from DB
    const candidateMarkets = await db.query.markets.findMany({
      where: and(
        sql`${markets.id} IN (${sql.join(
          marketIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        or(
          // Past end date
          lte(markets.endDate, now),
          // Within 24 hours of end date
          and(lte(markets.endDate, oneDayFromNow), gte(markets.endDate, now)),
          // Still active, or marked closed by upserts but not yet settled here
          inArray(markets.status, ["active", "closed"]),
        ),
      ),
    });

    logger.info(
      `Checking ${candidateMarkets.length} markets for resolution...`,
    );

    let totalSettled = 0;

    for (const market of candidateMarkets) {
      try {
        // Fetch current state from Gamma API
        const gamma = await getMarketByConditionId(
          market.polymarketConditionId,
        );
        if (!gamma) {
          logger.warn(
            `Could not fetch market ${market.polymarketConditionId} from Gamma`,
          );
          continue;
        }

        // Check if resolved: closed AND outcome prices contain 1 or 0
        if (!gamma.closed) continue;

        const prices = gamma.outcomePrices;
        const hasResolved =
          prices.length >= 2 &&
          (prices[0] === 1 || prices[0] === 0) &&
          (prices[1] === 1 || prices[1] === 0);

        if (!hasResolved) {
          // Market closed but not resolved (e.g., cancelled/archived)
          // Check for cancellation — refund bets
          if (gamma.closed && !gamma.active) {
            await handleCancelledMarket(market.id);
          }
          continue;
        }

        // Each market is resolved independently from its own gamma outcomePrices.
        // Sibling markets in the same event (incl. negRisk) are picked up by the
        // candidates loop on their own and resolved on their own outcomes — we
        // never infer one market's resolution from a sibling's DB price.
        const winningOutcome: "yes" | "no" = prices[0] === 1 ? "yes" : "no";

        const settled = await resolveMarketBets(market.id, winningOutcome);
        totalSettled += settled;
        logger.info(
          `Market ${market.id} "${market.question}" resolved: ${winningOutcome} wins, settled ${settled} bets`,
        );
      } catch (err) {
        logger.error(`Error checking resolution for market ${market.id}:`, err);
      }
    }

    if (totalSettled > 0) {
      logger.info(`Resolution check complete: settled ${totalSettled} bets`);
    }
  } catch (err) {
    logger.error("Resolution check failed:", err);
  } finally {
    running = false;
  }
}

/**
 * Handle a market that was cancelled/archived on Polymarket without resolution.
 * Delegates to `cancelMarket`, which refunds stakes and (for any already-settled
 * bets) reverses the stat counters and claws back payouts.
 */
async function handleCancelledMarket(marketId: number) {
  const result = await cancelMarket(
    marketId,
    "Cancelled or archived on Polymarket",
  );

  if (result.reverted > 0) {
    logger.info(
      `Market ${marketId} cancelled/archived — refunded ${result.reverted} bets (${result.refundedPts} pts) across ${result.users} users`,
    );
  }
}
