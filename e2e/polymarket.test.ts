import { beforeAll, describe, expect, test } from "bun:test";
import {
  fetchPriceHistory,
  type GammaEvent,
  getAllTags,
  getEventById,
  getEventBySlug,
  getMarketByConditionId,
  getNewEvents,
  getTokenQuote,
  getTrendingMarkets,
  searchMarkets,
} from "../src/services/polymarket.js";
import { findTradeableMarket } from "./polymarket.js";

// Contract tests: the bot's Polymarket client against the live API. These
// catch Gamma/CLOB shape changes the parsers would otherwise swallow.

const CONDITION_ID = /^0x[0-9a-f]{64}$/i;

describe("Gamma API", () => {
  let trending: GammaEvent[];

  beforeAll(async () => {
    trending = await getTrendingMarkets(10);
  });

  test("trending events parse into well-formed markets", () => {
    expect(trending.length).toBeGreaterThan(0);
    for (const event of trending) {
      expect(event.id).toMatch(/^\d+$/);
      expect(event.slug).not.toBe("");
      expect(event.active).toBe(true);
      expect(event.markets.length).toBeGreaterThan(0);
      for (const m of event.markets) {
        expect(m.conditionId).toMatch(CONDITION_ID);
        // Unpriced placeholder markets carry no tokens; the bot shows those
        // as untradeable, so only the binary shape is a hard contract.
        if (m.clobTokenIds.length > 0) expect(m.clobTokenIds).toHaveLength(2);
        expect(m.outcomes).toHaveLength(2);
        for (const p of m.outcomePrices) {
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("an event round-trips by slug and by id", async () => {
    const event = trending[0];
    if (!event) throw new Error("no trending event");
    expect((await getEventBySlug(event.slug))?.id).toBe(event.id);
    expect((await getEventById(event.id))?.slug).toBe(event.slug);
  });

  test("a market round-trips by condition id, with its parent event", async () => {
    const market = trending[0]?.markets[0];
    if (!market) throw new Error("no trending market");
    const fetched = await getMarketByConditionId(market.conditionId);
    expect(fetched?.conditionId).toBe(market.conditionId);
    expect(fetched?.question).toBe(market.question);
    expect(fetched?.events?.[0]?.id).toBe(trending[0]?.id);
  });

  test("an unknown condition id resolves to null", async () => {
    expect(await getMarketByConditionId(`0x${"0".repeat(64)}`)).toBeNull();
  });

  test("search finds a trending event by its title", async () => {
    const event = trending[0];
    if (!event) throw new Error("no trending event");
    const results = await searchMarkets(event.title);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((e) => typeof e.id === "string")).toBe(true);
  });

  test("new events all end at least a week out", async () => {
    const events = await getNewEvents(20, 7);
    expect(events.length).toBeGreaterThan(0);
    const cutoff = Date.now() + 6 * 86_400_000; // a day of slack for clocks
    for (const e of events) {
      if (e.endDate) expect(Date.parse(e.endDate)).toBeGreaterThan(cutoff);
    }
  });

  test("tags are live categories with slugs and labels", async () => {
    const tags = await getAllTags();
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) {
      expect(t.slug).not.toBe("");
      expect(t.label).not.toBe("");
    }
  });
});

describe("CLOB API", () => {
  test("a liquid market quotes a sane top of book on both tokens", async () => {
    const market = await findTradeableMarket();
    for (const token of market.clobTokenIds) {
      const quote = await getTokenQuote(token);
      expect(quote.bid).not.toBeNull();
      expect(quote.ask).not.toBeNull();
      expect(quote.bid ?? 1).toBeLessThanOrEqual(quote.ask ?? 0);
      expect(quote.bid ?? 0).toBeGreaterThan(0);
      expect(quote.ask ?? 1).toBeLessThan(1);
    }
  });

  test("price history is a chronological series of probabilities", async () => {
    const market = await findTradeableMarket();
    const [yesToken] = market.clobTokenIds;
    if (!yesToken) throw new Error("no yes token");
    const points = await fetchPriceHistory(yesToken, "1w", 60);
    expect(points.length).toBeGreaterThan(1);
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (!point) continue;
      expect(point.p).toBeGreaterThanOrEqual(0);
      expect(point.p).toBeLessThanOrEqual(1);
      const prev = points[i - 1];
      if (prev) expect(point.t).toBeGreaterThan(prev.t);
    }
  });
});
