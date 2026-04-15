import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, guildSettings } from "../db/schema.js";
import { config } from "../config.js";

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
    return (await db.query.guildSettings.findFirst({
      where: eq(guildSettings.guildId, guildId),
    }))!;
  }

  return created;
}

export async function ensureUser(discordId: string, guildId: string) {
  const existing = await db.query.users.findFirst({
    where: eq(users.discordId, discordId),
  });

  if (existing) return existing;

  const guild = await ensureGuildSettings(guildId);

  const [created] = await db
    .insert(users)
    .values({
      discordId,
      pointsBalance: guild.startingPoints,
    })
    .onConflictDoNothing()
    .returning();

  if (!created) {
    return (await db.query.users.findFirst({
      where: eq(users.discordId, discordId),
    }))!;
  }

  return created;
}

export async function claimDaily(discordId: string, guildId: string) {
  const user = await ensureUser(discordId, guildId);
  const guild = await ensureGuildSettings(guildId);
  const now = new Date();

  if (user.lastDailyClaim) {
    const timeSinceClaim = now.getTime() - user.lastDailyClaim.getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (timeSinceClaim < twentyFourHours) {
      const nextClaim = new Date(
        user.lastDailyClaim.getTime() + twentyFourHours
      );
      return { claimed: false as const, nextClaim, balance: user.pointsBalance };
    }
  }

  const newBalance = user.pointsBalance + guild.dailyBonus;

  await db
    .update(users)
    .set({
      pointsBalance: newBalance,
      lastDailyClaim: now,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));

  return {
    claimed: true as const,
    bonus: guild.dailyBonus,
    balance: newBalance,
  };
}

export async function getUserStats(discordId: string, guildId: string) {
  const user = await ensureUser(discordId, guildId);

  // Count active bets
  const activeBets = await db.query.bets.findMany({
    where: (bets, { and, eq: eqOp }) =>
      and(eqOp(bets.userId, user.id), eqOp(bets.status, "pending")),
  });

  const winRate =
    user.totalBetsSettled > 0
      ? ((user.totalWon / user.totalBetsSettled) * 100).toFixed(1)
      : "0.0";

  return {
    pointsBalance: user.pointsBalance,
    accumulatedPct: parseFloat(user.accumulatedPct),
    totalBetsSettled: user.totalBetsSettled,
    totalWon: user.totalWon,
    totalLost: user.totalLost,
    winRate,
    activeBetsCount: activeBets.length,
  };
}
