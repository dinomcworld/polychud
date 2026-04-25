import { and, eq, gt, ne, or, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { bets, events, guildMembers, markets, users } from "../db/schema.js";
import { logger } from "../utils/logger.js";
import { getMidpointPrice } from "./polymarket.js";
import { ensureUser } from "./users.js";

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
  amount: number,
): Promise<PlaceBetResult | PlaceBetError> {
  const { user, member } = await ensureUser(discordId, guildId);

  // Check market exists and is active
  const market = await db.query.markets.findFirst({
    where: eq(markets.id, marketId),
  });

  if (!market) return { success: false, error: "Market not found." };
  if (market.status !== "active")
    return { success: false, error: "This market is no longer active." };

  // Fetch fresh price
  const tokenId = outcome === "yes" ? market.yesTokenId : market.noTokenId;
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

  const rawPayout = amount / price;
  const cap = amount * config.MAX_PAYOUT_MULTIPLIER;
  const potentialPayout = Math.floor(Math.min(rawPayout, cap));

  // Atomic transaction: lock guild_members row, check limits + balance, deduct,
  // insert bet. The lock on guildMembers serializes concurrent bets from the
  // same user+guild so the active-bet counts below are accurate under bursts.
  try {
    const result = await db.transaction(async (tx) => {
      // Lock guild member row
      const [lockedMember] = await tx
        .select()
        .from(guildMembers)
        .where(eq(guildMembers.id, member.id))
        .for("update");

      if (!lockedMember) throw new Error("Member not found.");

      // Under the lock, count active bets (safe from TOCTOU bursts)
      const userActiveBets = await tx.query.bets.findMany({
        where: and(
          eq(bets.userId, user.id),
          eq(bets.guildId, guildId),
          eq(bets.status, "pending"),
        ),
      });

      if (userActiveBets.length >= config.MAX_ACTIVE_BETS_PER_USER) {
        throw new Error(
          `You already have ${config.MAX_ACTIVE_BETS_PER_USER} active bets. Close some before placing new ones.`,
        );
      }

      const betsOnMarket = userActiveBets.filter(
        (b) => b.marketId === marketId,
      ).length;
      if (betsOnMarket >= config.MAX_ACTIVE_BETS_PER_MARKET) {
        throw new Error(
          `You already have ${config.MAX_ACTIVE_BETS_PER_MARKET} active bet(s) on this market.`,
        );
      }

      if (lockedMember.pointsBalance < amount) {
        throw new Error(
          `Insufficient balance. You have ${lockedMember.pointsBalance} points.`,
        );
      }

      // Deduct points from guild member
      await tx
        .update(guildMembers)
        .set({
          pointsBalance: sql`${guildMembers.pointsBalance} - ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(guildMembers.id, member.id));

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

      if (!bet) throw new Error("Failed to insert bet.");
      return {
        betId: bet.id,
        newBalance: lockedMember.pointsBalance - amount,
      };
    });

    logger.info(
      `bet placed: betId=${result.betId} user=${discordId} guild=${guildId} marketId=${marketId} outcome=${outcome} stake=${amount} entry=${price.toFixed(4)} payout=${potentialPayout} balance=${result.newBalance}`,
    );

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
    with: { market: { with: { event: true } } },
    orderBy: (bets, { desc }) => desc(bets.placedAt),
  });

  return activeBets;
}

export async function getUserSettledBets(discordId: string, guildId?: string) {
  const user = await db.query.users.findFirst({
    where: eq(users.discordId, discordId),
  });
  if (!user) return [];

  const conditions = [eq(bets.userId, user.id), ne(bets.status, "pending")];
  if (guildId) {
    conditions.push(eq(bets.guildId, guildId));
  }

  const settled = await db.query.bets.findMany({
    where: and(...conditions),
    with: { market: { with: { event: true } } },
    orderBy: (bets, { desc }) => [
      desc(bets.resolvedAt),
      desc(bets.closedAt),
      desc(bets.placedAt),
    ],
  });

  return settled;
}

export interface NewSettlement {
  betId: number;
  outcome: "yes" | "no";
  status: string;
  amount: number;
  actualPayout: number;
  oddsAtBet: string;
  closePrice: string | null;
  marketQuestion: string;
  marketConditionId: string;
  eventSlug: string | null;
}

/**
 * Fetch bets auto-settled since the user's last-seen marker and advance the
 * marker. Returns the settled bets + net pts change so callers can surface a
 * passive "while you were away" notice without sending any push notification.
 *
 * Excludes `closed_early` bets since those are user-initiated and the user
 * already saw the close card.
 *
 * First-time callers (marker is null) get no results — we initialize the marker
 * to now so future settlements are reported from this point forward.
 */
export async function consumeNewSettlements(
  discordId: string,
  guildId: string,
): Promise<{ count: number; netPts: number; settlements: NewSettlement[] }> {
  const { user, member } = await ensureUser(discordId, guildId);
  const now = new Date();

  if (!member.lastSettlementsSeenAt) {
    await db
      .update(guildMembers)
      .set({ lastSettlementsSeenAt: now })
      .where(eq(guildMembers.id, member.id));
    return { count: 0, netPts: 0, settlements: [] };
  }

  const since = member.lastSettlementsSeenAt;

  const newlySettled = await db.query.bets.findMany({
    where: and(
      eq(bets.userId, user.id),
      eq(bets.guildId, guildId),
      ne(bets.status, "pending"),
      ne(bets.status, "closed_early"),
      or(gt(bets.resolvedAt, since), gt(bets.closedAt, since)),
    ),
    with: { market: { with: { event: true } } },
    orderBy: (bets, { desc }) => [
      desc(bets.resolvedAt),
      desc(bets.closedAt),
      desc(bets.placedAt),
    ],
  });

  if (newlySettled.length === 0) {
    // Bump the marker anyway so we don't repeat this query work next time.
    await db
      .update(guildMembers)
      .set({ lastSettlementsSeenAt: now })
      .where(eq(guildMembers.id, member.id));
    return { count: 0, netPts: 0, settlements: [] };
  }

  const netPts = newlySettled.reduce(
    (sum, b) => sum + ((b.actualPayout ?? 0) - b.amount),
    0,
  );

  const settlements: NewSettlement[] = newlySettled.map((b) => ({
    betId: b.id,
    outcome: b.outcome as "yes" | "no",
    status: b.status,
    amount: b.amount,
    actualPayout: b.actualPayout ?? 0,
    oddsAtBet: b.oddsAtBet,
    closePrice: b.closePrice,
    marketQuestion: b.market?.question ?? "(unknown market)",
    marketConditionId: b.market?.polymarketConditionId ?? "",
    eventSlug: b.market?.event?.slug ?? null,
  }));

  await db
    .update(guildMembers)
    .set({ lastSettlementsSeenAt: now })
    .where(eq(guildMembers.id, member.id));

  return { count: newlySettled.length, netPts, settlements };
}

export async function getBetById(betId: number) {
  return db.query.bets.findFirst({
    where: eq(bets.id, betId),
    with: { market: { with: { event: true } } },
  });
}

// ─── Early Close ─────────────────────────────────────────────────────────────

export interface CloseQuote {
  cashOut: number;
  profit: number;
  priceDelta: number;
}

/** Pure cash-out math, capped by MAX_PAYOUT_MULTIPLIER. Used by the close
 * preview UI and the actual closeBet execution so they can't drift apart. */
export function computeCloseQuote(
  amount: number,
  entryPrice: number,
  currentPrice: number,
): CloseQuote {
  const rawCashOut = amount * (currentPrice / entryPrice);
  const cap = amount * config.MAX_PAYOUT_MULTIPLIER;
  const cashOut = Math.floor(Math.min(rawCashOut, cap));
  return {
    cashOut,
    profit: cashOut - amount,
    priceDelta: currentPrice - entryPrice,
  };
}

export interface CloseBetSuccess {
  success: true;
  question: string;
  eventSlug: string | null;
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
  guildId: string,
): Promise<CloseBetSuccess | CloseBetError> {
  const { member } = await ensureUser(discordId, guildId);

  try {
    const result = await db.transaction(async (tx) => {
      // Lock the bet row
      const [lockedBet] = await tx
        .select()
        .from(bets)
        .where(eq(bets.id, betId))
        .for("update");

      if (!lockedBet) throw new Error("Bet not found.");
      if (lockedBet.guildId !== guildId)
        throw new Error("This bet belongs to a different server.");
      if (lockedBet.status !== "pending")
        throw new Error(`Bet is already ${lockedBet.status}.`);

      // Verify ownership via guild member
      const [lockedMember] = await tx
        .select()
        .from(guildMembers)
        .where(eq(guildMembers.id, member.id))
        .for("update");

      if (!lockedMember) throw new Error("Member not found.");

      // Check that this bet belongs to the user behind this guild member
      if (lockedBet.userId !== lockedMember.userId)
        throw new Error("This isn't your bet.");

      // Get market data (with parent event for slug)
      const market = await tx.query.markets.findFirst({
        where: eq(markets.id, lockedBet.marketId),
        with: { event: true },
      });

      if (!market) throw new Error("Market not found.");

      // Get FRESH price from CLOB
      const tokenId =
        lockedBet.outcome === "yes" ? market.yesTokenId : market.noTokenId;
      if (!tokenId) throw new Error("Market pricing unavailable.");

      const currentPrice = await getMidpointPrice(tokenId);
      const entryPrice = parseFloat(lockedBet.oddsAtBet);
      const { cashOut: cashOutAmount, priceDelta } = computeCloseQuote(
        lockedBet.amount,
        entryPrice,
        currentPrice,
      );

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

      // Credit guild member
      await tx
        .update(guildMembers)
        .set({
          pointsBalance: sql`${guildMembers.pointsBalance} + ${cashOutAmount}`,
          accumulatedPct: sql`${guildMembers.accumulatedPct} + ${priceDelta}`,
          totalBetsSettled: sql`${guildMembers.totalBetsSettled} + 1`,
          updatedAt: now,
        })
        .where(eq(guildMembers.id, member.id));

      // Get updated balance
      const [updatedMember] = await tx
        .select({ pointsBalance: guildMembers.pointsBalance })
        .from(guildMembers)
        .where(eq(guildMembers.id, member.id));

      return {
        question: market.question,
        eventSlug: market.event?.slug ?? null,
        entryPrice,
        exitPrice: currentPrice,
        staked: lockedBet.amount,
        cashOut: cashOutAmount,
        profit: cashOutAmount - lockedBet.amount,
        newBalance: updatedMember?.pointsBalance ?? 0,
      };
    });

    return { success: true, ...result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Close failed.";
    return { success: false, error: msg };
  }
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve all pending bets on a single market.
 * winningOutcome is "yes" or "no" — determined by the caller.
 */
export async function resolveMarketBets(
  marketId: number,
  winningOutcome: "yes" | "no",
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

      // Find guild member for this user+guild
      const [member] = await tx
        .select()
        .from(guildMembers)
        .where(
          and(
            eq(guildMembers.userId, bet.userId),
            eq(guildMembers.guildId, bet.guildId),
          ),
        );

      if (!member) {
        logger.warn(
          `No guild member found for user ${bet.userId} in guild ${bet.guildId}`,
        );
        return;
      }

      // Update guild member stats
      const memberUpdates: Record<string, unknown> = {
        accumulatedPct: sql`${guildMembers.accumulatedPct} + ${priceDelta}`,
        totalBetsSettled: sql`${guildMembers.totalBetsSettled} + 1`,
        updatedAt: now,
      };

      if (won) {
        memberUpdates.pointsBalance = sql`${guildMembers.pointsBalance} + ${payout}`;
        memberUpdates.totalWon = sql`${guildMembers.totalWon} + 1`;
      } else {
        memberUpdates.totalLost = sql`${guildMembers.totalLost} + 1`;
      }

      await tx
        .update(guildMembers)
        .set(memberUpdates)
        .where(eq(guildMembers.id, member.id));
    });

    settledCount++;
  }

  // Mark market as resolved AFTER all bets settle. If we crash mid-loop the
  // market keeps its prior status so the resolver re-picks it up next cycle.
  await db
    .update(markets)
    .set({
      status: "resolved",
      currentYesPrice: winningOutcome === "yes" ? "1" : "0",
      currentNoPrice: winningOutcome === "yes" ? "0" : "1",
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
  eventDbId: number,
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
