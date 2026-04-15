import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bets, events, markets, users } from "../db/schema.js";
import { getMidpointPrice } from "./polymarket.js";
import { ensureUser } from "./users.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface PlaceBetResult {
  success: true;
  betId: number;
  oddsAtBet: number;
  potentialPayout: number;
  newBalance: number;
}

export interface PlaceBetError {
  success: false;
  error: string;
}

export async function placeBet(
  discordId: string,
  marketId: number,
  guildId: string,
  outcome: "yes" | "no",
  amount: number
): Promise<PlaceBetResult | PlaceBetError> {
  const user = await ensureUser(discordId, guildId);

  // Check market exists and is active
  const market = await db.query.markets.findFirst({
    where: eq(markets.id, marketId),
  });

  if (!market) return { success: false, error: "Market not found." };
  if (market.status !== "active")
    return { success: false, error: "This market is no longer active." };

  // Check active bet limits
  const userActiveBets = await db.query.bets.findMany({
    where: and(eq(bets.userId, user.id), eq(bets.status, "pending")),
  });

  if (userActiveBets.length >= config.MAX_ACTIVE_BETS_PER_USER) {
    return {
      success: false,
      error: `You already have ${config.MAX_ACTIVE_BETS_PER_USER} active bets. Close some before placing new ones.`,
    };
  }

  const userBetsOnMarket = userActiveBets.filter(
    (b) => b.marketId === marketId
  );
  if (userBetsOnMarket.length >= config.MAX_ACTIVE_BETS_PER_MARKET) {
    return {
      success: false,
      error: `You already have ${config.MAX_ACTIVE_BETS_PER_MARKET} active bet(s) on this market.`,
    };
  }

  // Fetch fresh price
  const tokenId =
    outcome === "yes" ? market.yesTokenId : market.noTokenId;
  if (!tokenId) {
    return { success: false, error: "Market pricing data unavailable." };
  }

  let price: number;
  try {
    price = await getMidpointPrice(tokenId);
  } catch {
    return {
      success: false,
      error: "Couldn't fetch current price. Try again in a moment.",
    };
  }

  if (price <= 0 || price >= 1) {
    return {
      success: false,
      error: "Market price is at an extreme. Cannot place bet.",
    };
  }

  const potentialPayout = Math.floor(amount / price);

  // Atomic transaction: lock user row, check balance, deduct, insert bet
  try {
    const result = await db.transaction(async (tx) => {
      // Lock user row
      const [lockedUser] = await tx
        .select()
        .from(users)
        .where(eq(users.id, user.id))
        .for("update");

      if (!lockedUser || lockedUser.pointsBalance < amount) {
        throw new Error(
          `Insufficient balance. You have ${lockedUser?.pointsBalance ?? 0} points.`
        );
      }

      // Deduct points
      await tx
        .update(users)
        .set({
          pointsBalance: sql`${users.pointsBalance} - ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      // Insert bet
      const [bet] = await tx
        .insert(bets)
        .values({
          userId: user.id,
          marketId,
          eventId: market.eventId,
          guildId,
          outcome,
          amount,
          oddsAtBet: String(price),
          potentialPayout,
          status: "pending",
        })
        .returning();

      return {
        betId: bet!.id,
        newBalance: lockedUser.pointsBalance - amount,
      };
    });

    // Update market prices in DB
    const yesPrice = outcome === "yes" ? price : 1 - price;
    await db
      .update(markets)
      .set({
        currentYesPrice: String(yesPrice),
        currentNoPrice: String(1 - yesPrice),
        lastPolledAt: new Date(),
      })
      .where(eq(markets.id, marketId));

    return {
      success: true,
      betId: result.betId,
      oddsAtBet: price,
      potentialPayout,
      newBalance: result.newBalance,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Transaction failed.";
    return { success: false, error: msg };
  }
}

export async function getUserActiveBets(discordId: string, guildId?: string) {
  const user = await db.query.users.findFirst({
    where: eq(users.discordId, discordId),
  });
  if (!user) return [];

  const conditions = [eq(bets.userId, user.id), eq(bets.status, "pending")];
  if (guildId) {
    conditions.push(eq(bets.guildId, guildId));
  }

  const activeBets = await db.query.bets.findMany({
    where: and(...conditions),
    with: { market: true },
    orderBy: (bets, { desc }) => desc(bets.placedAt),
  });

  return activeBets;
}

export async function getBetById(betId: number) {
  return db.query.bets.findFirst({
    where: eq(bets.id, betId),
    with: { market: true },
  });
}

// ─── Early Close ─────────────────────────────────────────────────────────────

export interface CloseBetSuccess {
  success: true;
  question: string;
  entryPrice: number;
  exitPrice: number;
  staked: number;
  cashOut: number;
  profit: number;
  newBalance: number;
}

export interface CloseBetError {
  success: false;
  error: string;
}

export async function closeBet(
  betId: number,
  discordId: string,
  guildId: string
): Promise<CloseBetSuccess | CloseBetError> {
  const user = await ensureUser(discordId, guildId);

  try {
    const result = await db.transaction(async (tx) => {
      // Lock the bet row
      const [lockedBet] = await tx
        .select()
        .from(bets)
        .where(eq(bets.id, betId))
        .for("update");

      if (!lockedBet) throw new Error("Bet not found.");
      if (lockedBet.userId !== user.id) throw new Error("This isn't your bet.");
      if (lockedBet.status !== "pending")
        throw new Error(`Bet is already ${lockedBet.status}.`);

      // Get market data
      const market = await tx.query.markets.findFirst({
        where: eq(markets.id, lockedBet.marketId),
      });

      if (!market) throw new Error("Market not found.");

      // Get FRESH price from CLOB
      const tokenId =
        lockedBet.outcome === "yes" ? market.yesTokenId : market.noTokenId;
      if (!tokenId) throw new Error("Market pricing unavailable.");

      const currentPrice = await getMidpointPrice(tokenId);
      const entryPrice = parseFloat(lockedBet.oddsAtBet);
      const cashOutAmount = Math.floor(
        lockedBet.amount * (currentPrice / entryPrice)
      );
      const priceDelta = currentPrice - entryPrice;

      const now = new Date();

      // Update bet
      await tx
        .update(bets)
        .set({
          status: "closed_early",
          closedEarly: true,
          closePrice: String(currentPrice),
          actualPayout: cashOutAmount,
          closedAt: now,
          resolvedAt: now,
        })
        .where(eq(bets.id, betId));

      // Update user: credit cash-out, update accumulated_pct and settled count
      await tx
        .update(users)
        .set({
          pointsBalance: sql`${users.pointsBalance} + ${cashOutAmount}`,
          accumulatedPct: sql`${users.accumulatedPct} + ${priceDelta}`,
          totalBetsSettled: sql`${users.totalBetsSettled} + 1`,
          updatedAt: now,
        })
        .where(eq(users.id, user.id));

      // Get updated balance
      const [updatedUser] = await tx
        .select({ pointsBalance: users.pointsBalance })
        .from(users)
        .where(eq(users.id, user.id));

      return {
        question: market.question,
        entryPrice,
        exitPrice: currentPrice,
        staked: lockedBet.amount,
        cashOut: cashOutAmount,
        profit: cashOutAmount - lockedBet.amount,
        newBalance: updatedUser!.pointsBalance,
      };
    });

    return { success: true, ...result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Close failed.";
    return { success: false, error: msg };
  }
}

// ─── Resolution (Phase 4 prep) ───────────────────────────────────────────────

/**
 * Resolve all pending bets on a single market.
 * winningOutcome is "yes" or "no" — determined by the caller.
 */
export async function resolveMarketBets(
  marketId: number,
  winningOutcome: "yes" | "no"
): Promise<number> {
  let settledCount = 0;

  const pendingBets = await db.query.bets.findMany({
    where: and(eq(bets.marketId, marketId), eq(bets.status, "pending")),
  });

  for (const bet of pendingBets) {
    const won = bet.outcome === winningOutcome;
    const entryPrice = parseFloat(bet.oddsAtBet);

    // delta: win = 1.0 - entry, loss = 0.0 - entry
    const exitPrice = won ? 1.0 : 0.0;
    const priceDelta = exitPrice - entryPrice;
    const payout = won ? bet.potentialPayout : 0;

    const now = new Date();

    await db.transaction(async (tx) => {
      // Update bet
      await tx
        .update(bets)
        .set({
          status: won ? "won" : "lost",
          actualPayout: payout,
          resolvedAt: now,
        })
        .where(eq(bets.id, bet.id));

      // Update user
      const userUpdates: Record<string, unknown> = {
        accumulatedPct: sql`${users.accumulatedPct} + ${priceDelta}`,
        totalBetsSettled: sql`${users.totalBetsSettled} + 1`,
        updatedAt: now,
      };

      if (won) {
        userUpdates.pointsBalance = sql`${users.pointsBalance} + ${payout}`;
        userUpdates.totalWon = sql`${users.totalWon} + 1`;
      } else {
        userUpdates.totalLost = sql`${users.totalLost} + 1`;
      }

      await tx
        .update(users)
        .set(userUpdates)
        .where(eq(users.id, bet.userId));
    });

    settledCount++;
  }

  // Mark market as resolved
  await db
    .update(markets)
    .set({
      status: "resolved",
      resolvedOutcome: winningOutcome,
      updatedAt: new Date(),
    })
    .where(eq(markets.id, marketId));

  return settledCount;
}

/**
 * Resolve all sub-markets of a negRisk event.
 * Identifies the winning sub-market (YES price ≈ 1.0) and resolves all others as NO.
 */
export async function resolveEventBets(
  eventDbId: number
): Promise<{ totalSettled: number; winningMarketId: number | null }> {
  const event = await db.query.events.findFirst({
    where: eq(events.id, eventDbId),
    with: { markets: true },
  });

  if (!event) {
    logger.warn(`resolveEventBets: event ${eventDbId} not found`);
    return { totalSettled: 0, winningMarketId: null };
  }

  // Find the winning sub-market: the one with YES price ≈ 1.0
  let winningMarket: (typeof event.markets)[number] | null = null;
  for (const m of event.markets) {
    const yesPrice = parseFloat(m.currentYesPrice || "0");
    if (yesPrice >= 0.95) {
      winningMarket = m;
      break;
    }
  }

  let totalSettled = 0;

  for (const m of event.markets) {
    // If this is the winning sub-market, YES wins
    // Otherwise, NO wins (the other candidates lost)
    const winningOutcome: "yes" | "no" =
      winningMarket && m.id === winningMarket.id ? "yes" : "no";

    const settled = await resolveMarketBets(m.id, winningOutcome);
    totalSettled += settled;
  }

  // Mark event as resolved
  await db
    .update(events)
    .set({ status: "resolved", updatedAt: new Date() })
    .where(eq(events.id, eventDbId));

  return { totalSettled, winningMarketId: winningMarket?.id ?? null };
}
