import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { betCommand } from "../src/commands/bet.js";
import { dailyCommand } from "../src/commands/daily.js";
import { portfolioCommand } from "../src/commands/portfolio.js";
import { config } from "../src/config.js";
import { guildMembers } from "../src/db/schema.js";
import { db, resetDb } from "./db.js";
import { embedText, FakeCommand, fakeUser } from "./discord.js";

// Database-only flows: no Polymarket calls, so these also validate the harness.
describe("account commands", () => {
  beforeEach(resetDb);

  const alice = fakeUser("100", "alice");

  test("/daily registers the user and pays the bonus once per day", async () => {
    const first = new FakeCommand(alice, "daily");
    await dailyCommand.execute(first.as());
    expect(embedText(first.last())).toContain("Daily Bonus Claimed!");

    const [member] = await db.select().from(guildMembers);
    expect(member?.pointsBalance).toBe(
      config.DEFAULT_STARTING_POINTS + config.DEFAULT_DAILY_BONUS,
    );

    const second = new FakeCommand(alice, "daily");
    await dailyCommand.execute(second.as());
    expect(embedText(second.last())).toContain("Already Claimed");

    const [after] = await db
      .select()
      .from(guildMembers)
      .where(eq(guildMembers.id, member?.id ?? -1));
    expect(after?.pointsBalance).toBe(member?.pointsBalance);
  });

  test("/portfolio shows a fresh user's starting balance", async () => {
    const cmd = new FakeCommand(alice, "portfolio");
    await portfolioCommand.execute(cmd.as());
    expect(embedText(cmd.last())).toContain(
      config.DEFAULT_STARTING_POINTS.toLocaleString(),
    );
  });

  test("/bet list with no bets points the user at /market search", async () => {
    const cmd = new FakeCommand(alice, "bet", { subcommand: "list" });
    await betCommand.execute(cmd.as());
    expect(cmd.last().content).toContain("You have no active bets");
  });

  test("commands outside a server are refused", async () => {
    const cmd = new FakeCommand(alice, "daily", {}, null);
    await dailyCommand.execute(cmd.as());
    expect(cmd.last().content).toContain("can only be used in a server");
  });
});
