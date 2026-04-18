import { and, eq, isNotNull, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  bets,
  guildMembers,
  guildSettings,
  markets,
  users,
} from "../db/schema.js";

export async function ensureGuildSettings(guildId: string) {
  const existing = await db.query.guildSettings.findFirst({
    where: eq(guildSettings.guildId, guildId),
  });

  if (existing) return existing;

  const [created] = await db
    .insert(guildSettings)
    .values({
      guildId,
      startingPoints: config.DEFAULT_STARTING_POINTS,
      maxBet: config.DEFAULT_MAX_BET,
      minBet: config.DEFAULT_MIN_BET,
      dailyBonus: config.DEFAULT_DAILY_BONUS,
    })
    .onConflictDoNothing()
    .returning();

  // Race condition: another request may have inserted first
  if (!created) {
    const found = await db.query.guildSettings.findFirst({
      where: eq(guildSettings.guildId, guildId),
    });
    if (!found)
      throw new Error(`Failed to create guild settings for ${guildId}`);
    return found;
  }

  return created;
}

/** Ensure a user row exists (identity only). */
async function ensureUserRow(discordId: string) {
  const existing = await db.query.users.findFirst({
    where: eq(users.discordId, discordId),
  });

  if (existing) return existing;

  const [created] = await db
    .insert(users)
    .values({ discordId })
    .onConflictDoNothing()
    .returning();

  if (!created) {
    const found = await db.query.users.findFirst({
      where: eq(users.discordId, discordId),
    });
    if (!found) throw new Error(`Failed to create user ${discordId}`);
    return found;
  }

  return created;
}

/** Ensure a guild_members row exists for this user+guild combo. */
async function ensureMemberRow(userId: number, guildId: string) {
  const existing = await db.query.guildMembers.findFirst({
    where: and(
      eq(guildMembers.userId, userId),
      eq(guildMembers.guildId, guildId),
    ),
  });

  if (existing) return existing;

  const guild = await ensureGuildSettings(guildId);

  const [created] = await db
    .insert(guildMembers)
    .values({
      userId,
      guildId,
      pointsBalance: guild.startingPoints,
    })
    .onConflictDoNothing()
    .returning();

  if (!created) {
    const found = await db.query.guildMembers.findFirst({
      where: and(
        eq(guildMembers.userId, userId),
        eq(guildMembers.guildId, guildId),
      ),
    });
    if (!found) throw new Error(`Failed to create guild member for ${guildId}`);
    return found;
  }

  return created;
}

/**
 * Ensure user + guild membership exist.
 * Returns { user, member } where member holds the per-guild balance/stats.
 */
export async function ensureUser(discordId: string, guildId: string) {
  const user = await ensureUserRow(discordId);
  const member = await ensureMemberRow(user.id, guildId);
  return { user, member };
}

export async function claimDaily(discordId: string, guildId: string) {
  const { member } = await ensureUser(discordId, guildId);
  const guild = await ensureGuildSettings(guildId);
  const now = new Date();

  // Daily resets at UTC midnight: eligible if last claim was before today (UTC).
  const startOfTodayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const startOfTomorrowUtc = startOfTodayUtc + 24 * 60 * 60 * 1000;

  if (
    member.lastDailyClaim &&
    member.lastDailyClaim.getTime() >= startOfTodayUtc
  ) {
    return {
      claimed: false as const,
      nextClaim: new Date(startOfTomorrowUtc),
      balance: member.pointsBalance,
    };
  }

  const newBalance = member.pointsBalance + guild.dailyBonus;

  await db
    .update(guildMembers)
    .set({
      pointsBalance: newBalance,
      lastDailyClaim: now,
      updatedAt: now,
    })
    .where(eq(guildMembers.id, member.id));

  return {
    claimed: true as const,
    bonus: guild.dailyBonus,
    balance: newBalance,
  };
}

export async function getUserStats(discordId: string, guildId: string) {
  const { user, member } = await ensureUser(discordId, guildId);

  // Count active bets in this guild
  const activeBets = await db.query.bets.findMany({
    where: (bets, { and: andOp, eq: eqOp }) =>
      andOp(
        eqOp(bets.userId, user.id),
        eqOp(bets.guildId, guildId),
        eqOp(bets.status, "pending"),
      ),
  });

  const winRate =
    member.totalBetsSettled > 0
      ? ((member.totalWon / member.totalBetsSettled) * 100).toFixed(1)
      : "0.0";

  // Realized net P&L from settled/closed/cancelled bets
  const [netRow] = await db
    .select({
      net: sql<string>`COALESCE(SUM(${bets.actualPayout} - ${bets.amount}), 0)`,
    })
    .from(bets)
    .where(
      and(
        eq(bets.userId, user.id),
        eq(bets.guildId, guildId),
        isNotNull(bets.actualPayout),
      ),
    );
  const netPnL = Number(netRow?.net ?? 0);

  // Mark-to-market value of open positions
  const [openRow] = await db
    .select({
      openValue: sql<string>`COALESCE(SUM(${bets.potentialPayout} * CASE WHEN ${bets.outcome} = 'yes' THEN ${markets.currentYesPrice} ELSE ${markets.currentNoPrice} END), 0)`,
    })
    .from(bets)
    .innerJoin(markets, eq(bets.marketId, markets.id))
    .where(
      and(
        eq(bets.userId, user.id),
        eq(bets.guildId, guildId),
        eq(bets.status, "pending"),
      ),
    );
  const openValue = Number(openRow?.openValue ?? 0);

  return {
    pointsBalance: member.pointsBalance,
    accumulatedPct: parseFloat(member.accumulatedPct),
    totalBetsSettled: member.totalBetsSettled,
    totalWon: member.totalWon,
    totalLost: member.totalLost,
    winRate,
    activeBetsCount: activeBets.length,
    netPnL,
    openValue,
    portfolioValue: member.pointsBalance + openValue,
  };
}
