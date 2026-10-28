import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../src/config.js";
import { bets, guildMembers, markets } from "../src/db/schema.js";
import { runResolutionCheck } from "../src/jobs/resolver.js";
import { upsertStandaloneMarket } from "../src/services/markets.js";
import type { GammaMarket } from "../src/services/polymarket.js";
import { ensureUser, getUserStats } from "../src/services/users.js";
import { db, resetDb } from "./db.js";
import { GUILD_ID } from "./discord.js";
import { findResolvedMarket } from "./polymarket.js";

// The resolver job against a market Polymarket has actually resolved.

const STAKE = 100;
const ENTRY = 0.5;
const PAYOUT = STAKE / ENTRY;

let market: GammaMarket & { winner: "yes" | "no" };

beforeAll(async () => {
  market = await findResolvedMarket();
});

beforeEach(resetDb);

/** Seed a pending bet as placeBet would have left it while the market was
 * still open (placeBet itself refuses closed markets). */
async function seedPendingBet(
  discordId: string,
  marketId: number,
  outcome: "yes" | "no",
) {
  const { user, member } = await ensureUser(discordId, GUILD_ID);
  const stored = await db.query.markets.findFirst({
    where: eq(markets.id, marketId),
  });
  if (!stored) throw new Error(`market ${marketId} not stored`);
  await db
    .update(guildMembers)
    .set({ pointsBalance: member.pointsBalance - STAKE })
    .where(eq(guildMembers.id, member.id));
  const [bet] = await db
    .insert(bets)
    .values({
      userId: user.id,
      marketId,
      eventId: stored.eventId,
      guildId: GUILD_ID,
      outcome,
      amount: STAKE,
      oddsAtBet: String(ENTRY),
      potentialPayout: PAYOUT,
      status: "pending",
    })
    .returning();
  if (!bet) throw new Error("failed to seed bet");
  return bet.id;
}

describe("resolver", () => {
  test("settles pending bets on a resolved market by its real outcome", async () => {
    const marketId = await upsertStandaloneMarket(market);
    const loser = market.winner === "yes" ? "no" : "yes";
    const winnerBet = await seedPendingBet("100", marketId, market.winner);
    const loserBet = await seedPendingBet("200", marketId, loser);

    await runResolutionCheck();

    const won = await db.query.bets.findFirst({
      where: eq(bets.id, winnerBet),
    });
    expect(won?.status).toBe("won");
    expect(won?.actualPayout).toBe(PAYOUT);

    const lost = await db.query.bets.findFirst({
      where: eq(bets.id, loserBet),
    });
    expect(lost?.status).toBe("lost");
    expect(lost?.actualPayout).toBe(0);

    const members = await db.query.guildMembers.findMany({
      with: { user: true },
    });
    const winner = members.find((m) => m.user.discordId === "100");
    const other = members.find((m) => m.user.discordId === "200");
    expect(winner?.pointsBalance).toBe(
      config.DEFAULT_STARTING_POINTS - STAKE + PAYOUT,
    );
    expect(winner?.totalWon).toBe(1);
    expect(other?.pointsBalance).toBe(config.DEFAULT_STARTING_POINTS - STAKE);
    expect(other?.totalLost).toBe(1);

    const stored = await db.query.markets.findFirst({
      where: eq(markets.id, marketId),
    });
    expect(stored?.status).toBe("resolved");
  });

  test("running it again doesn't pay out twice", async () => {
    const marketId = await upsertStandaloneMarket(market);
    await seedPendingBet("100", marketId, market.winner);

    await runResolutionCheck();
    await runResolutionCheck();

    const [member] = await db.select().from(guildMembers);
    expect(member?.pointsBalance).toBe(
      config.DEFAULT_STARTING_POINTS - STAKE + PAYOUT,
    );
  });

  test("win rate counts repeat bets on the same market once", async () => {
    const marketId = await upsertStandaloneMarket(market);
    const loser = market.winner === "yes" ? "no" : "yes";
    await seedPendingBet("100", marketId, market.winner);
    await seedPendingBet("100", marketId, market.winner);
    await seedPendingBet("200", marketId, loser);
    await seedPendingBet("200", marketId, loser);

    await runResolutionCheck();

    const winner = await getUserStats("100", GUILD_ID);
    expect(winner.winRate).toBe("100.0");
    expect(winner.winRatePositionsWon).toBe(1);
    expect(winner.winRatePositionsSettled).toBe(1);
    expect(winner.totalWon).toBe(2);

    const other = await getUserStats("200", GUILD_ID);
    expect(other.winRate).toBe("0.0");
    expect(other.winRatePositionsWon).toBe(0);
    expect(other.winRatePositionsSettled).toBe(1);
  });
});
