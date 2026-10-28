import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { betCommand } from "../src/commands/bet.js";
import { config } from "../src/config.js";
import {
  bets,
  guildMembers,
  guildSettings,
  markets,
} from "../src/db/schema.js";
import { handleButton } from "../src/interactions/buttons.js";
import {
  betButton,
  betModal,
  confirmBet,
  confirmClose,
  staticIds,
} from "../src/interactions/customIds.js";
import { handleModal } from "../src/interactions/modals.js";
import { handleSelectMenu } from "../src/interactions/selects.js";
import type { GammaMarket } from "../src/services/polymarket.js";
import { ensureGuildSettings } from "../src/services/users.js";
import { db, resetDb } from "./db.js";
import {
  customIds,
  embedText,
  FakeButton,
  FakeCommand,
  FakeModalSubmit,
  FakeSelect,
  type FakeUser,
  fakeUser,
  GUILD_ID,
} from "./discord.js";
import { findTradeableMarket } from "./polymarket.js";

// The full bet lifecycle through the real handlers: live Polymarket order
// books for pricing, in-memory Postgres for the ledger.

const STAKE = 100;
const alice = fakeUser("100", "alice");
const bob = fakeUser("200", "bob");

let market: GammaMarket;

beforeAll(async () => {
  market = await findTradeableMarket();
});

beforeEach(resetDb);

async function balanceOf(user: FakeUser): Promise<number> {
  const rows = await db.query.guildMembers.findMany({ with: { user: true } });
  const row = rows.find((r) => r.user.discordId === user.id);
  if (!row) throw new Error(`${user.username} is not registered`);
  return row.pointsBalance;
}

/** Click Bet → submit the stake modal. Returns the modal's reply. */
async function submitStake(
  user: FakeUser,
  outcome: "yes" | "no",
  amount: string,
) {
  const click = new FakeButton(
    user,
    betButton.encode(outcome, market.conditionId),
  );
  await handleButton(click.as());
  const modal = click.last("showModal");
  expect(modal.custom_id).toBe(betModal.encode(market.conditionId, outcome));

  const submit = new FakeModalSubmit(user, modal.custom_id ?? "", {
    [staticIds.betAmountInput]: amount,
  });
  await handleModal(submit.as());
  return submit.last("editReply");
}

/** Bet → stake → Confirm. Returns the new bet's id. */
async function placeBetThroughUi(user: FakeUser, outcome: "yes" | "no") {
  const confirmView = await submitStake(user, outcome, String(STAKE));
  expect(embedText(confirmView)).toContain("Confirm your bet");
  const confirmId = confirmBet.encode(market.conditionId, outcome, STAKE);
  expect(customIds(confirmView)).toContain(confirmId);

  const confirm = new FakeButton(user, confirmId);
  await handleButton(confirm.as());
  expect(confirm.last("editReply").content).toBe("Bet placed!");
  const card = confirm.last("followUp");
  expect(embedText(card)).toContain("Bet Placed!");

  const betId = Number(card.embeds?.[0]?.footer?.text?.replace("Bet #", ""));
  expect(Number.isInteger(betId)).toBe(true);
  return betId;
}

async function disableCloseCooldown() {
  await ensureGuildSettings(GUILD_ID);
  await db
    .update(guildSettings)
    .set({ closeBetCooldownHours: 0 })
    .where(eq(guildSettings.guildId, GUILD_ID));
}

describe("placing a bet", () => {
  test("Bet → stake → Confirm debits the stake and records the bet at the live ask", async () => {
    const betId = await placeBetThroughUi(alice, "yes");

    expect(await balanceOf(alice)).toBe(config.DEFAULT_STARTING_POINTS - STAKE);

    const bet = await db.query.bets.findFirst({ where: eq(bets.id, betId) });
    expect(bet?.status).toBe("pending");
    expect(bet?.outcome).toBe("yes");
    expect(bet?.amount).toBe(STAKE);
    const entry = Number(bet?.oddsAtBet);
    expect(entry).toBeGreaterThan(0);
    expect(entry).toBeLessThan(1);
    expect(bet?.potentialPayout).toBe(
      Math.floor(Math.min(STAKE / entry, STAKE * config.MAX_PAYOUT_MULTIPLIER)),
    );

    // The market (and its event) were upserted at bet time.
    const stored = await db.query.markets.findFirst({
      where: eq(markets.polymarketConditionId, market.conditionId),
      with: { event: true },
    });
    expect(stored?.status).toBe("active");
    expect(stored?.yesTokenId).toBe(market.clobTokenIds[0] ?? "");
    expect(stored?.event?.polymarketEventId).toBe(market.events?.[0]?.id ?? "");
  });

  test("the bet shows up in /bet list", async () => {
    await placeBetThroughUi(alice, "no");

    const list = new FakeCommand(alice, "bet", { subcommand: "list" });
    await betCommand.execute(list.as());
    const view = list.last("editReply");
    expect(embedText(view)).toContain("Your Active Bets");
    expect(customIds(view)).toContain(staticIds.betsCloseSelect);
  });

  test.each([
    ["a non-number", "lots", "valid positive number"],
    [
      "less than the minimum",
      String(config.DEFAULT_MIN_BET - 1),
      "Minimum bet",
    ],
    [
      "more than the maximum",
      String(config.DEFAULT_MAX_BET + 1),
      "Maximum bet",
    ],
  ])(
    "a stake that is %s is refused before any money moves",
    async (_, amount, message) => {
      const reply = await submitStake(alice, "yes", amount);
      expect(reply.content).toContain(message);
      expect(await db.select().from(bets)).toHaveLength(0);
    },
  );

  test("a stake above the balance is refused", async () => {
    await ensureGuildSettings(GUILD_ID);
    await db
      .update(guildSettings)
      .set({ maxBet: config.DEFAULT_STARTING_POINTS * 2 })
      .where(eq(guildSettings.guildId, GUILD_ID));

    const reply = await submitStake(
      alice,
      "yes",
      String(config.DEFAULT_STARTING_POINTS + 1),
    );
    expect(reply.content).toContain("You only have");
    expect(await db.select().from(bets)).toHaveLength(0);
  });
});

describe("closing a bet early", () => {
  test("is blocked during the default cooldown", async () => {
    const betId = await placeBetThroughUi(alice, "yes");

    const pick = new FakeSelect(alice, staticIds.betsCloseSelect, [
      String(betId),
    ]);
    await handleSelectMenu(pick.as());
    expect(pick.last("editReply").content).toContain(
      `${config.DEFAULT_CLOSE_BET_COOLDOWN_HOURS}h close cooldown`,
    );

    const bet = await db.query.bets.findFirst({ where: eq(bets.id, betId) });
    expect(bet?.status).toBe("pending");
  });

  test("cashes out at the live bid once the cooldown is off", async () => {
    await disableCloseCooldown();
    const betId = await placeBetThroughUi(alice, "yes");

    const pick = new FakeSelect(alice, staticIds.betsCloseSelect, [
      String(betId),
    ]);
    await handleSelectMenu(pick.as());
    const preview = pick.last("editReply");
    const confirmId = customIds(preview).find((id) => confirmClose.decode(id));
    if (!confirmId) throw new Error(`no confirm button: ${embedText(preview)}`);

    const confirm = new FakeButton(alice, confirmId);
    await handleButton(confirm.as());
    expect(confirm.last("editReply").content).toBe("Bet closed.");

    const bet = await db.query.bets.findFirst({ where: eq(bets.id, betId) });
    expect(bet?.status).toBe("closed_early");
    const cashOut = bet?.actualPayout ?? -1;
    expect(cashOut).toBeGreaterThanOrEqual(0);
    expect(Number(bet?.closePrice)).toBeGreaterThan(0);

    expect(await balanceOf(alice)).toBe(
      config.DEFAULT_STARTING_POINTS - STAKE + cashOut,
    );
    const [member] = await db.select().from(guildMembers);
    expect(member?.totalBetsSettled).toBe(1);
  });

  test("someone else can't close your bet", async () => {
    await disableCloseCooldown();
    const betId = await placeBetThroughUi(alice, "yes");

    const pick = new FakeSelect(bob, staticIds.betsCloseSelect, [
      String(betId),
    ]);
    await handleSelectMenu(pick.as());
    expect(pick.last("editReply").content).toBe("This isn't your bet.");

    // Even a hand-crafted confirm button is rejected by closeBet itself.
    const forged = new FakeButton(bob, confirmClose.encode(betId, Date.now()));
    await handleButton(forged.as());
    expect(forged.last("editReply").content).toBe("This isn't your bet.");

    const bet = await db.query.bets.findFirst({ where: eq(bets.id, betId) });
    expect(bet?.status).toBe("pending");
    expect(await balanceOf(alice)).toBe(config.DEFAULT_STARTING_POINTS - STAKE);
  });
});
