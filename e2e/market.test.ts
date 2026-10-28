import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { marketCommand } from "../src/commands/market.js";
import { handleButton } from "../src/interactions/buttons.js";
import {
  backToEvent,
  betButton,
  chart,
  chartBack,
  eventRefresh,
  eventSelect,
  marketRefresh,
  staticIds,
  trendingPage,
} from "../src/interactions/customIds.js";
import { handleSelectMenu } from "../src/interactions/selects.js";
import {
  type GammaEvent,
  type GammaMarket,
  getTrendingMarkets,
} from "../src/services/polymarket.js";
import { resetDb } from "./db.js";
import {
  customIds,
  embedText,
  FakeButton,
  FakeCommand,
  FakeSelect,
  fakeUser,
  selectValues,
} from "./discord.js";
import { findTradeableMarket } from "./polymarket.js";

// Browsing flows, driven through the real command/button/select handlers
// against live Polymarket data.

const alice = fakeUser("100", "alice");

beforeEach(resetDb);

describe("/market trending", () => {
  test("lists trending markets with a picker and pagination", async () => {
    const cmd = new FakeCommand(alice, "market", { subcommand: "trending" });
    await marketCommand.execute(cmd.as());

    const reply = cmd.last("editReply");
    expect(reply.embeds?.length).toBeGreaterThan(0);
    const ids = customIds(reply);
    expect(ids).toContain(staticIds.marketSelect);
    expect(selectValues(reply).length).toBeGreaterThan(0);

    // 50 trending results never fit on one page.
    const next = ids.find((id) => trendingPage.decode(id)?.page === 1);
    expect(next).toBeDefined();

    const page = new FakeButton(alice, next ?? "");
    await handleButton(page.as());
    expect(page.last("editReply").embeds?.length).toBeGreaterThan(0);
  });

  test("picking a market opens its market or event card", async () => {
    const cmd = new FakeCommand(alice, "market", { subcommand: "trending" });
    await marketCommand.execute(cmd.as());
    const [conditionId] = selectValues(cmd.last("editReply"));
    if (!conditionId) throw new Error("no markets in trending picker");

    const pick = new FakeSelect(alice, staticIds.marketSelect, [conditionId]);
    await handleSelectMenu(pick.as());
    const card = pick.last("editReply");
    expect(card.embeds?.length).toBe(1);
    expect(customIds(card).length).toBeGreaterThan(0);
  });
});

describe("/market search", () => {
  test("finds results for a trending event's title", async () => {
    const [event] = await getTrendingMarkets(1);
    if (!event) throw new Error("no trending event");

    const cmd = new FakeCommand(alice, "market", {
      subcommand: "search",
      strings: { query: event.title },
    });
    await marketCommand.execute(cmd.as());
    const reply = cmd.last("editReply");
    expect(reply.embeds?.length).toBeGreaterThan(0);
    expect(selectValues(reply).length).toBeGreaterThan(0);
  });
});

describe("binary market card", () => {
  let market: GammaMarket;

  beforeAll(async () => {
    market = await findTradeableMarket();
  });

  test("/market view by URL shows the card with bet buttons", async () => {
    const slug = market.events?.[0]?.slug;
    const cmd = new FakeCommand(alice, "market", {
      subcommand: "view",
      strings: { input: `https://polymarket.com/event/${slug}` },
    });
    await marketCommand.execute(cmd.as());

    const reply = cmd.last("editReply");
    expect(reply.embeds?.length).toBe(1);
    const ids = customIds(reply);
    // Multi-market events render an event card instead; only assert on bet
    // buttons when this event is a single market.
    if ((market.events?.[0]?.markets.length ?? 0) === 1) {
      expect(ids).toContain(betButton.encode("yes", market.conditionId));
      expect(ids).toContain(betButton.encode("no", market.conditionId));
    } else {
      expect(ids.some((id) => eventSelect.decode(id))).toBe(true);
    }
  });

  test("the chart renders a PNG with timeframe buttons, and Back restores the card", async () => {
    const open = new FakeButton(alice, chart.encode(market.conditionId));
    await handleButton(open.as());

    const chartView = open.last("editReply", "followUp");
    expect(chartView.content).toBeUndefined();
    expect(chartView.files).toHaveLength(1);
    expect(chartView.embeds?.[0]?.image?.url).toBe("attachment://chart.png");
    const ids = customIds(chartView);
    expect(ids).toContain(chartBack.encode(market.conditionId));
    expect(ids).toContain(chart.encode(market.conditionId, null, "6h"));

    const sixHours = new FakeButton(
      alice,
      chart.encode(market.conditionId, null, "6h"),
    );
    await handleButton(sixHours.as());
    expect(sixHours.last("editReply").embeds?.[0]?.footer?.text).toContain(
      "6-hour",
    );

    const back = new FakeButton(alice, chartBack.encode(market.conditionId));
    await handleButton(back.as());
    const card = back.last("editReply");
    expect(card.files).toEqual([]);
    // The restored card picks its parent event back up from Gamma, so match
    // on the decoded market rather than the exact id.
    const chartButton = customIds(card)
      .map((id) => chart.decode(id))
      .find(Boolean);
    expect(chartButton?.conditionId).toBe(market.conditionId);
  });

  test("Refresh re-renders the card with fresh prices", async () => {
    const refresh = new FakeButton(
      alice,
      marketRefresh.encode(market.conditionId),
    );
    await handleButton(refresh.as());
    expect(embedText(refresh.last("editReply"))).not.toBe("");
  });
});

describe("multi-outcome event card", () => {
  let event: GammaEvent;

  beforeAll(async () => {
    const events = await getTrendingMarkets(30);
    const multi = events.find((e) => e.markets.length > 1);
    if (!multi) throw new Error("no multi-market event among trending");
    event = multi;
  });

  test("view → refresh → pick an outcome → back to event", async () => {
    const view = new FakeCommand(alice, "market", {
      subcommand: "view",
      strings: { input: event.slug },
    });
    await marketCommand.execute(view.as());
    const card = view.last("editReply");
    expect(customIds(card)).toContain(eventSelect.encode(event.id));
    expect(customIds(card)).toContain(eventRefresh.encode(event.id));

    const refresh = new FakeButton(alice, eventRefresh.encode(event.id));
    await handleButton(refresh.as());
    expect(refresh.last("editReply").embeds?.length).toBe(1);

    const [outcome] = selectValues(card);
    if (!outcome) throw new Error("event card has no selectable outcomes");
    const pick = new FakeSelect(alice, eventSelect.encode(event.id), [outcome]);
    await handleSelectMenu(pick.as());
    const marketCard = pick.last("editReply");
    expect(customIds(marketCard)).toContain(backToEvent.encode(event.id));

    const back = new FakeButton(alice, backToEvent.encode(event.id));
    await handleButton(back.as());
    expect(customIds(back.last("editReply"))).toContain(
      eventSelect.encode(event.id),
    );
  });
});
