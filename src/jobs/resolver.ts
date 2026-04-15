import * as cron from "node-cron";
import { and, eq, or, lte, gte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bets, markets, users } from "../db/schema.js";
import { getMarketById } from "../services/polymarket.js";
import { resolveMarketBets, resolveEventBets } from "../services/betting.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let task: ReturnType<typeof cron.schedule> | null = null;
let running = false;

export function startResolver() {
  logger.info(
    `Starting resolution checker (cron: ${config.RESOLUTION_CHECK_CRON})`
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
          sql`, `
        )})`,
        or(
          // Past end date
          lte(markets.endDate, now),
          // Within 24 hours of end date
          and(lte(markets.endDate, oneDayFromNow), gte(markets.endDate, now)),
          // Status still active but could be resolved
          eq(markets.status, "active")
        )
      ),
    });

    logger.info(
      `Checking ${candidateMarkets.length} markets for resolution...`
    );

    // Track events we've already processed (for multi-outcome)
    const processedEvents = new Set<number>();
    let totalSettled = 0;

    for (const market of candidateMarkets) {
      try {
        // Fetch current state from Gamma API
        const gamma = await getMarketById(market.polymarketConditionId);
        if (!gamma) {
          logger.warn(
            `Could not fetch market ${market.polymarketConditionId} from Gamma`
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

        // Determine winner
        const winningOutcome: "yes" | "no" = prices[0] === 1 ? "yes" : "no";

        logger.info(
          `Market "${market.question}" resolved: ${winningOutcome} wins`
        );

        // Update market status
        await db
          .update(markets)
          .set({
            status: "resolved",
            resolvedOutcome: winningOutcome,
            currentYesPrice: String(prices[0]),
            currentNoPrice: String(prices[1]),
            updatedAt: new Date(),
          })
          .where(eq(markets.id, market.id));

        // Check if multi-outcome event
        if (market.eventId && !processedEvents.has(market.eventId)) {
          processedEvents.add(market.eventId);
          const result = await resolveEventBets(market.eventId);
          totalSettled += result.totalSettled;
          logger.info(
            `Event ${market.eventId}: settled ${result.totalSettled} bets, winner market: ${result.winningMarketId}`
          );
        } else if (!market.eventId) {
          const settled = await resolveMarketBets(market.id, winningOutcome);
          totalSettled += settled;
          logger.info(
            `Market ${market.id}: settled ${settled} bets`
          );
        }
      } catch (err) {
        logger.error(
          `Error checking resolution for market ${market.id}:`,
          err
        );
      }
    }

    if (totalSettled > 0) {
      logger.info(
        `Resolution check complete: settled ${totalSettled} bets across ${processedEvents.size} events`
      );
    }
  } catch (err) {
    logger.error("Resolution check failed:", err);
  } finally {
    running = false;
  }
}

/**
 * Handle a market that was cancelled/archived without resolution.
 * Refunds all pending bets at original stake.
 */
async function handleCancelledMarket(marketId: number) {
  const pendingBets = await db.query.bets.findMany({
    where: and(eq(bets.marketId, marketId), eq(bets.status, "pending")),
  });

  if (pendingBets.length === 0) return;

  logger.info(
    `Market ${marketId} cancelled/archived — refunding ${pendingBets.length} bets`
  );

  const now = new Date();

  for (const bet of pendingBets) {
    await db.transaction(async (tx) => {
      // Refund the bet
      await tx
        .update(bets)
        .set({
          status: "cancelled",
          actualPayout: bet.amount,
          resolvedAt: now,
        })
        .where(eq(bets.id, bet.id));

      // Credit back the original stake
      await tx
        .update(markets)
        .set({ status: "cancelled", updatedAt: now })
        .where(eq(markets.id, marketId));

      // Give points back
      await tx
        .update(users)
        .set({
          pointsBalance: sql`${users.pointsBalance} + ${bet.amount}`,
          updatedAt: now,
        })
        .where(eq(users.id, bet.userId));
    });
  }

  logger.info(`Refunded ${pendingBets.length} bets for cancelled market ${marketId}`);
}
