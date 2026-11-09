import { afterEach, describe, expect, test } from "bun:test";
import {
  fixture,
  mockApi,
  type RecordedCall,
  restoreApi,
} from "../test/mockApi.js";
import {
  checkTradeable,
  fetchPriceHistory,
  getAllTags,
  getBatchPrices,
  getCachedEvent,
  getCachedMarket,
  getEventById,
  getEventBySlug,
  getEventsByTag,
  getMarketByConditionId,
  getMarketById,
  getMidpointPrice,
  getNewEvents,
  getTokenQuote,
  getTrendingMarkets,
  invalidatePriceCache,
  isShortWindow,
  SHORT_WINDOW_REASON,
  searchMarkets,
} from "./polymarket.js";

// biome-ignore lint/suspicious/noExplicitAny: fixtures are raw external payloads
type Raw = Record<string, any>;

afterEach(restoreApi);

/** Index into a fixture array under `noUncheckedIndexedAccess`. */
function at<T>(items: T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`expected index ${index} of ${items.length}`);
  }
  return value;
}

function only(calls: RecordedCall[]): RecordedCall {
  expect(calls).toHaveLength(1);
  return at(calls, 0);
}

// The service's TTL caches are module-level and therefore shared by every test
// in this file. Where a test needs a guaranteed cache miss it rewrites the
// fixture's id to one nothing else touches.
let idCounter = 0;
const uniqueId = () => `test-${++idCounter}`;

const FED_SLUG = "fed-decision-in-september-762";
const FED_EVENT_ID = "481717";
const FED_MARKET_ID = "2252242";
const FED_CONDITION_ID =
  "0x5e464d85eb49f22d876f3ed6168a7db5e2288e9ae1eb91effd2758e994676f86";
const RESOLVED_CONDITION_ID =
  "0x6a368c7b3755a6f5f38f04576cc1ef10c920de3a0171682b7fede7d92d4646d8";
const YES_TOKEN =
  "97186030785608128217926542396950266594898339988989015155120280107165449433603";
const NO_TOKEN =
  "81470465080656150088482886298356783621062802919110096763062861781139262816347";

// ─── Parsing ─────────────────────────────────────────────────────────────────

describe("parsing a Gamma event", () => {
  test("normalizes the captured /events?slug= payload", async () => {
    const raw = fixture<Raw[]>("event-by-slug");
    const calls = mockApi(() => raw);

    const event = await getEventBySlug(FED_SLUG);

    expect(only(calls).url.searchParams.get("slug")).toBe(FED_SLUG);
    if (!event) throw new Error("expected an event");

    expect(event.id).toBe(FED_EVENT_ID);
    expect(event.slug).toBe(FED_SLUG);
    expect(event.negRisk).toBe(true);
    expect(event.closed).toBe(false);
    expect(event.markets).toHaveLength(5);
    expect(event.endDate).toBe(at(raw, 0).endDate);
    expect(event.commentCount).toBe(at(raw, 0).commentCount);
  });

  test("turns Gamma's string-encoded numbers and JSON-in-string arrays into values", async () => {
    // Gamma serializes `outcomes`/`outcomePrices`/`clobTokenIds` as JSON *strings*
    // and `volume` as a decimal string on /markets, but as a number on events.
    const raw = fixture<Raw[]>("market-by-id");
    const rawMarket = at(raw, 0);
    expect(typeof rawMarket.outcomes).toBe("string");
    expect(typeof rawMarket.volume).toBe("string");

    mockApi(() => raw);
    const market = await getMarketById(FED_MARKET_ID);
    if (!market) throw new Error("expected a market");

    expect(market.outcomes).toEqual(["Yes", "No"]);
    expect(market.outcomePrices).toEqual([0.0015, 0.9985]);
    expect(market.clobTokenIds).toEqual([YES_TOKEN, NO_TOKEN]);
    expect(market.volume).toBe(Number.parseFloat(rawMarket.volume));
    expect(typeof rawMarket.liquidity).toBe("string");
    expect(market.liquidity).toBe(Number.parseFloat(rawMarket.liquidity));
    expect(market.spread).toBe(0.001);
    expect(market.bestBid).toBe(0.001);
    expect(market.bestAsk).toBe(0.002);
    expect(market.conditionId).toBe(FED_CONDITION_ID);
  });

  test("parses the parent event nested in a /markets?id= response", async () => {
    mockApi(() => fixture("market-by-id"));

    const market = await getMarketById(FED_MARKET_ID);

    expect(market?.events).toHaveLength(1);
    const parent = at(market?.events ?? [], 0);
    expect(parent.id).toBe(FED_EVENT_ID);
    expect(parent.title).toBe("Fed Decision in September?");
    expect(parent.negRisk).toBe(true);
    // Gamma does not nest sibling markets inside this shape — the caller has to
    // go back to /events for those.
    expect(parent.markets).toEqual([]);
  });

  test("falls back to empty defaults for the fields Gamma omits", async () => {
    // Untraded neg-risk placeholder slots ship without `outcomePrices`, and
    // resolved markets ship without `liquidity`.
    const placeholders = fixture<Raw[]>("event-all-placeholders");
    mockApi(() => placeholders);
    const event = await getEventBySlug(
      "which-party-will-win-the-house-in-2026",
    );
    const partyA = at(event?.markets ?? [], 0);
    expect(at(placeholders, 0).markets[0].outcomePrices).toBeUndefined();
    expect(partyA.outcomePrices).toEqual([]);
    expect(partyA.groupItemTitle).toBe("Party A");

    restoreApi();
    mockApi(() => fixture("market-closed-by-condition-id"));
    const resolved = await getMarketByConditionId(RESOLVED_CONDITION_ID);
    expect(resolved?.closed).toBe(true);
    expect(resolved?.liquidity).toBe(0);
    expect(resolved?.outcomePrices).toEqual([0, 1]);
  });

  test("keeps a zero bestBid rather than nulling it", async () => {
    // `numOrNull(0)` must not collapse to null — a 0¢ bid is real information.
    mockApi(() => fixture("event-all-placeholders"));

    const event = await getEventBySlug(
      "which-party-will-win-the-house-in-2026",
    );

    expect(at(event?.markets ?? [], 0).bestBid).toBe(0);
    expect(at(event?.markets ?? [], 0).bestAsk).toBe(1);
  });

  test("percent-encodes image URLs containing spaces and drops unparseable ones", async () => {
    mockApi(() => fixture("market-unencoded-image"));

    const market = await getMarketById(FED_MARKET_ID);

    expect(market?.image).toBe(
      "https://polymarket-upload.s3.us-east-2.amazonaws.com/Repetitive-markets/soccer%20ball-icon.png",
    );
    expect(market?.icon).toBeNull();
  });

  test("drops untraded placeholder sub-markets from a neg-risk event", async () => {
    const raw = fixture<Raw[]>("event-with-placeholders");
    expect(at(raw, 0).markets).toHaveLength(9);
    mockApi(() => raw);

    const event = await getEventBySlug(
      "which-party-will-win-the-house-in-2026",
    );

    expect(event?.markets.map((m) => m.groupItemTitle)).toEqual([
      "Democratic Party",
      "Republican Party",
    ]);
  });

  test("keeps every sub-market when they are all placeholders", async () => {
    mockApi(() => fixture("event-all-placeholders"));

    const event = await getEventBySlug(
      "which-party-will-win-the-house-in-2026",
    );

    expect(event?.markets).toHaveLength(7);
  });

  test("keeps closed sub-markets so resolved history still renders", async () => {
    // Two of this event's three markets are resolved and carry no liquidity.
    const raw = fixture<Raw[]>("events-trending");
    mockApi(() => [at(raw, 0)]);

    const event = await getEventBySlug("epl-eve-mun-2026-09-06");

    expect(event?.markets).toHaveLength(3);
    expect(event?.markets.filter((m) => m.closed)).toHaveLength(2);
  });
});

// ─── Gamma endpoints ─────────────────────────────────────────────────────────

describe("searchMarkets", () => {
  test("returns the events from /public-search and caches them by id", async () => {
    const calls = mockApi(() => fixture("search-fed-decision"));

    const events = await searchMarkets("fed decision");

    const call = only(calls);
    expect(call.url.pathname).toBe("/public-search");
    expect(call.url.searchParams.get("q")).toBe("fed decision");
    expect(call.url.searchParams.get("limit_per_type")).toBe("50");

    expect(events.map((e) => e.slug)).toEqual([
      FED_SLUG,
      "fed-decision-in-october-20260617190323537",
    ]);
    expect(getCachedEvent(FED_EVENT_ID)?.slug).toBe(FED_SLUG);
  });

  test("caches each sub-market with its parent event attached", async () => {
    mockApi(() => fixture("search-fed-decision"));

    await searchMarkets("fed decision");

    const cached = getCachedMarket(FED_CONDITION_ID);
    expect(cached?.id).toBe(FED_MARKET_ID);
    expect(at(cached?.events ?? [], 0).id).toBe(FED_EVENT_ID);
  });

  test("returns an empty list when /public-search has no events key", async () => {
    mockApi(() => ({ pagination: {} }));

    expect(await searchMarkets("nothing at all")).toEqual([]);
  });
});

describe("getTrendingMarkets", () => {
  test("orders by 24h volume and honours the limit", async () => {
    const calls = mockApi(() => fixture("events-trending"));

    const events = await getTrendingMarkets(3);

    const params = only(calls).url.searchParams;
    expect(params.get("order")).toBe("volume24hr");
    expect(params.get("ascending")).toBe("false");
    expect(params.get("active")).toBe("true");
    expect(params.get("closed")).toBe("false");
    expect(params.get("limit")).toBe("3");
    expect(events).toHaveLength(3);
    expect(at(events, 0).slug).toBe("epl-eve-mun-2026-09-06");
  });
});

describe("getNewEvents", () => {
  test("sorts by start date and floors the end date, excluding sports", async () => {
    const calls = mockApi(() => fixture("events-trending"));

    await getNewEvents(50, 7);

    const params = only(calls).url.searchParams;
    expect(params.get("order")).toBe("startDate");
    expect(params.get("ascending")).toBe("false");
    expect(params.get("liquidity_min")).toBe("1000");
    expect(params.get("exclude_tag_id")).toBe("1"); // the Sports tag
    expect(params.get("limit")).toBe("50");

    const floor = Date.parse(params.get("end_date_min") ?? "");
    const expected = Date.now() + 7 * 86_400_000;
    expect(Math.abs(floor - expected)).toBeLessThan(60_000);
  });
});

describe("getEventsByTag", () => {
  test("filters by tag slug", async () => {
    const calls = mockApi(() => fixture("events-trending"));

    const events = await getEventsByTag("politics", 25);

    const params = only(calls).url.searchParams;
    expect(params.get("tag_slug")).toBe("politics");
    expect(params.get("limit")).toBe("25");
    expect(events).toHaveLength(3);
  });
});

describe("getAllTags", () => {
  test("keeps only tags that appear on a currently-active event", async () => {
    const calls = mockApi(({ url }) =>
      url.pathname === "/tags"
        ? fixture("tags")
        : fixture("events-tag-snapshot"),
    );

    const tags = await getAllTags();

    expect(calls).toHaveLength(2);
    expect(at(calls, 0).url.searchParams.get("order")).toBe("id");
    // The 40 captured tags include long-dead categories; only these two are
    // carried by the captured snapshot of live events.
    expect(tags.map((t) => t.slug)).toEqual(["sports", "politics"]);
    expect(at(tags, 0)).toEqual({ id: "1", slug: "sports", label: "Sports" });
  });

  test("serves the second call from the 1h cache", async () => {
    const calls = mockApi(({ url }) =>
      url.pathname === "/tags"
        ? fixture("tags")
        : fixture("events-tag-snapshot"),
    );

    const first = await getAllTags();
    const second = await getAllTags();

    expect(calls).toHaveLength(0);
    expect(second).toEqual(first);
  });
});

describe("getEventById", () => {
  test("fetches and caches an event that is not in the cache", async () => {
    const raw = fixture<Raw[]>("event-by-id");
    const id = uniqueId();
    at(raw, 0).id = id;
    const calls = mockApi(() => raw);

    const event = await getEventById(id);

    expect(only(calls).url.searchParams.get("id")).toBe(id);
    expect(event?.slug).toBe(FED_SLUG);
    expect(getCachedEvent(id)?.id).toBe(id);
  });

  test("serves a cached event without hitting the API", async () => {
    const raw = fixture<Raw[]>("event-by-id");
    const id = uniqueId();
    at(raw, 0).id = id;
    mockApi(() => raw);
    await getEventById(id);
    restoreApi();

    const calls = mockApi(() => undefined);
    const event = await getEventById(id);

    expect(calls).toHaveLength(0);
    expect(event?.id).toBe(id);
  });

  test("returns null when Gamma has no such event", async () => {
    mockApi(() => []);

    expect(await getEventById(uniqueId())).toBeNull();
  });
});

describe("getMarketByConditionId", () => {
  test("returns the open market from the first query", async () => {
    const calls = mockApi(() => fixture("market-by-condition-id"));

    const market = await getMarketByConditionId(FED_CONDITION_ID);

    const call = only(calls);
    expect(call.url.searchParams.get("condition_ids")).toBe(FED_CONDITION_ID);
    expect(call.url.searchParams.has("closed")).toBe(false);
    expect(market?.id).toBe(FED_MARKET_ID);
  });

  test("retries with closed=true for a resolved market", async () => {
    // Verbatim behaviour of the live API: the default query filters resolved
    // markets out and returns [], so the resolver needs the second query.
    const calls = mockApi(({ url }) =>
      url.searchParams.get("closed") === "true"
        ? fixture("market-closed-by-condition-id")
        : [],
    );

    const market = await getMarketByConditionId(RESOLVED_CONDITION_ID);

    expect(calls).toHaveLength(2);
    expect(market?.closed).toBe(true);
    expect(market?.conditionId).toBe(RESOLVED_CONDITION_ID);
    expect(market?.outcomePrices).toEqual([0, 1]);
  });

  test("rejects a response for a different market", async () => {
    // Gamma has been seen ignoring condition_ids and returning something else;
    // handing that back would settle a bet against the wrong market.
    mockApi(() => fixture("market-by-condition-id"));

    expect(await getMarketByConditionId(RESOLVED_CONDITION_ID)).toBeNull();
  });

  test("short-circuits on an empty condition id", async () => {
    const calls = mockApi(() => undefined);

    expect(await getMarketByConditionId("")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("returns null when both queries come back empty", async () => {
    const calls = mockApi(() => []);

    expect(await getMarketByConditionId(FED_CONDITION_ID)).toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe("getMarketById", () => {
  test("returns null when Gamma has no such market", async () => {
    mockApi(() => []);

    expect(await getMarketById("0")).toBeNull();
  });
});

// ─── CLOB endpoints ──────────────────────────────────────────────────────────

/** Re-key the captured /prices payload onto ids nothing else has cached. */
function pricesFor(yes: string, no: string): Record<string, unknown> {
  const raw = fixture<Record<string, unknown>>("clob-prices");
  return { [yes]: raw[YES_TOKEN], [no]: raw[NO_TOKEN] };
}

describe("getTokenQuote", () => {
  test("derives mid and spread from the book's two sides", async () => {
    const yes = uniqueId();
    const no = uniqueId();
    const calls = mockApi(() => pricesFor(yes, no));

    const quote = await getTokenQuote(yes);

    const call = only(calls);
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/prices");
    // `side` names the resting order: BUY is the best bid, SELL the best ask.
    expect(call.body).toEqual([
      { token_id: yes, side: "BUY" },
      { token_id: yes, side: "SELL" },
    ]);

    expect(quote.bid).toBe(0.001);
    expect(quote.ask).toBe(0.002);
    expect(quote.mid).toBeCloseTo(0.0015, 10);
    expect(quote.spread).toBeCloseTo(0.001, 10);
  });

  test("falls back to the single available side", async () => {
    const yes = uniqueId();
    const calls = mockApi(() => ({ [yes]: { BUY: "0.998" } }));

    const quote = await getTokenQuote(yes);

    expect(calls).toHaveLength(1);
    expect(quote).toEqual({ bid: 0.998, ask: null, mid: 0.998, spread: null });
  });

  test("returns all-null for a token the CLOB does not know", async () => {
    mockApi(() => ({}));

    expect(await getTokenQuote(uniqueId())).toEqual({
      bid: null,
      ask: null,
      mid: null,
      spread: null,
    });
  });

  test("caches the quote until invalidated", async () => {
    const yes = uniqueId();
    const no = uniqueId();
    const calls = mockApi(() => pricesFor(yes, no));

    await getTokenQuote(yes);
    await getTokenQuote(yes);
    expect(calls).toHaveLength(1);

    invalidatePriceCache(yes);
    await getTokenQuote(yes);
    expect(calls).toHaveLength(2);
  });

  test("seeds the price cache so getMidpointPrice needs no request", async () => {
    const yes = uniqueId();
    const no = uniqueId();
    const calls = mockApi(() => pricesFor(yes, no));

    await getTokenQuote(yes);
    const mid = await getMidpointPrice(yes);

    expect(calls).toHaveLength(1);
    expect(mid).toBeCloseTo(0.0015, 10);
  });
});

describe("getMidpointPrice", () => {
  test("parses the CLOB's string midpoint", async () => {
    const token = uniqueId();
    const calls = mockApi(() => fixture("clob-midpoint"));

    const price = await getMidpointPrice(token);

    expect(only(calls).url.searchParams.get("token_id")).toBe(token);
    expect(price).toBe(0.0015);
  });
});

describe("getBatchPrices", () => {
  test("averages both sides for every requested token", async () => {
    const yes = uniqueId();
    const no = uniqueId();
    const calls = mockApi(() => pricesFor(yes, no));

    const prices = await getBatchPrices([yes, no]);

    expect(only(calls).body).toEqual([
      { token_id: yes, side: "BUY" },
      { token_id: yes, side: "SELL" },
      { token_id: no, side: "BUY" },
      { token_id: no, side: "SELL" },
    ]);
    expect(prices.get(yes)).toBeCloseTo(0.0015, 10);
    expect(prices.get(no)).toBeCloseTo(0.9985, 10);
  });

  test("only requests the tokens that are not already cached", async () => {
    const yes = uniqueId();
    const no = uniqueId();
    mockApi(() => pricesFor(yes, no));
    await getBatchPrices([yes, no]);
    restoreApi();

    const other = uniqueId();
    const calls = mockApi(() => ({ [other]: { BUY: "0.4", SELL: "0.5" } }));
    const prices = await getBatchPrices([yes, no, other]);

    expect(only(calls).body).toEqual([
      { token_id: other, side: "BUY" },
      { token_id: other, side: "SELL" },
    ]);
    expect(prices.size).toBe(3);
    expect(prices.get(other)).toBeCloseTo(0.45, 10);
  });

  test("skips tokens the CLOB returns with no priced side", async () => {
    const token = uniqueId();
    const calls = mockApi(() => ({ [token]: {} }));

    const prices = await getBatchPrices([token]);

    expect(calls).toHaveLength(1);
    expect(prices.size).toBe(0);
  });

  test("makes no request when every token is cached", async () => {
    const yes = uniqueId();
    const no = uniqueId();
    mockApi(() => pricesFor(yes, no));
    await getBatchPrices([yes, no]);
    restoreApi();

    const calls = mockApi(() => undefined);
    const prices = await getBatchPrices([yes, no]);

    expect(calls).toHaveLength(0);
    expect(prices.size).toBe(2);
  });
});

describe("fetchPriceHistory", () => {
  test("requests the given interval and unwraps the history array", async () => {
    const token = uniqueId();
    const calls = mockApi(() => fixture("clob-prices-history"));

    const points = await fetchPriceHistory(token, "1w", 60);

    const params = only(calls).url.searchParams;
    expect(params.get("market")).toBe(token);
    expect(params.get("interval")).toBe("1w");
    expect(params.get("fidelity")).toBe("60");
    expect(points).toHaveLength(50);
    expect(at(points, 0)).toEqual({ t: 1788112820, p: 0.0025 });
  });

  test("returns an empty series when the CLOB has no history", async () => {
    mockApi(() => ({}));

    expect(await fetchPriceHistory(uniqueId())).toEqual([]);
  });

  test("caches per token, interval and fidelity", async () => {
    const token = uniqueId();
    const calls = mockApi(() => fixture("clob-prices-history"));

    await fetchPriceHistory(token, "1w", 60);
    await fetchPriceHistory(token, "1w", 60);
    expect(calls).toHaveLength(1);

    await fetchPriceHistory(token, "1d", 60);
    expect(calls).toHaveLength(2);
  });
});

// ─── Transport ───────────────────────────────────────────────────────────────

describe("fetchWithRetry", () => {
  test("honours retry-after on a 429 and retries", async () => {
    let attempt = 0;
    const calls = mockApi(() => {
      attempt += 1;
      return attempt === 1
        ? new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0" },
          })
        : fixture("clob-midpoint");
    });

    const price = await getMidpointPrice(uniqueId());

    expect(calls).toHaveLength(2);
    expect(price).toBe(0.0015);
  });

  test("gives up after the retry budget is spent", async () => {
    const calls = mockApi(
      () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
    );

    await expect(getMidpointPrice(uniqueId())).rejects.toThrow("API error 429");
    expect(calls).toHaveLength(3); // initial attempt plus two retries
  });

  test("throws with the status on a non-429 error", async () => {
    mockApi(() => new Response("boom", { status: 500 }));

    await expect(searchMarkets("anything")).rejects.toThrow("API error 500");
  });
});

// ─── Short-window markets ────────────────────────────────────────────────────

const UPDOWN_5M_SLUG = "btc-updown-5m-1794237900";
const UPDOWN_5M_CONDITION_ID =
  "0x91567b4824cd394897e6b03c445223adce607113d69b8dfe2d28cba73dc36c80";
const UPDOWN_DAILY_SLUG = "bitcoin-up-or-down-on-november-9-2026";

describe("short-window markets", () => {
  test("reads the series cadence off the event", async () => {
    mockApi(() => fixture("event-updown-5m"));
    expect((await getEventBySlug(UPDOWN_5M_SLUG))?.recurrence).toBe("5m");

    mockApi(() => fixture("event-by-slug"));
    expect((await getEventBySlug(FED_SLUG))?.recurrence).toBe("monthly");
  });

  test.each([
    ["5m", true],
    ["15m", true],
    ["hourly", true],
    ["4h", true],
    ["daily", false],
    ["weekly", false],
    ["monthly", false],
    [null, false],
  ])("classifies a %p series as short-window: %p", (recurrence, expected) => {
    expect(isShortWindow({ recurrence })).toBe(expected);
  });

  test("are dropped from search, trending and category listings", async () => {
    const raw = [
      ...fixture<Raw[]>("event-updown-5m"),
      ...fixture<Raw[]>("event-updown-daily"),
    ];
    const slugs = (events: { slug: string }[]) => events.map((e) => e.slug);

    mockApi(() => ({ events: raw }));
    expect(slugs(await searchMarkets("bitcoin up or down"))).toEqual([
      UPDOWN_DAILY_SLUG,
    ]);

    mockApi(() => raw);
    expect(slugs(await getTrendingMarkets(2))).toEqual([UPDOWN_DAILY_SLUG]);

    mockApi(() => raw);
    expect(slugs(await getEventsByTag("crypto", 2))).toEqual([
      UPDOWN_DAILY_SLUG,
    ]);
  });

  test("cannot be bet on, however deep and tight the book", async () => {
    mockApi(() => fixture("event-updown-5m"));
    const market = at((await getEventBySlug(UPDOWN_5M_SLUG))?.markets ?? [], 0);
    expect(market.liquidity).toBeGreaterThan(10_000);
    expect(market.spread).toBe(0.01);

    expect(checkTradeable(market)).toEqual({
      tradeable: false,
      reason: SHORT_WINDOW_REASON,
    });
  });

  test("are recognised from the parent event nested in /markets", async () => {
    mockApi(() => fixture("market-updown-5m-by-condition-id"));
    const market = await getMarketByConditionId(UPDOWN_5M_CONDITION_ID);
    if (!market) throw new Error("expected a market");

    expect(checkTradeable(market).reason).toBe(SHORT_WINDOW_REASON);
  });

  test("leave daily up/down markets tradeable", async () => {
    mockApi(() => fixture("event-updown-daily"));
    const event = await getEventBySlug(UPDOWN_DAILY_SLUG);
    expect(event?.recurrence).toBe("daily");

    expect(checkTradeable(at(event?.markets ?? [], 0)).tradeable).toBe(true);
  });
});

// ─── Tradeability gate ───────────────────────────────────────────────────────

describe("checkTradeable", () => {
  async function fedMarket(index: number) {
    mockApi(() => fixture("event-by-slug"));
    const event = await getEventBySlug(FED_SLUG);
    restoreApi();
    return at(event?.markets ?? [], index);
  }

  test("accepts a deep, tight market", async () => {
    const market = await fedMarket(2); // "No change": ~$879k book, 1c spread

    expect(checkTradeable(market)).toEqual({ tradeable: true, reason: null });
  });

  test("rejects a resolved market", async () => {
    mockApi(() => fixture("market-closed-by-condition-id"));
    const market = await getMarketByConditionId(RESOLVED_CONDITION_ID);
    if (!market) throw new Error("expected a market");

    const result = checkTradeable(market);

    expect(result.tradeable).toBe(false);
    expect(result.reason).toBe("This market is no longer active.");
  });

  test("rejects an untraded placeholder as inactive", async () => {
    mockApi(() => fixture("event-all-placeholders"));
    const event = await getEventBySlug(
      "which-party-will-win-the-house-in-2026",
    );
    const partyA = at(event?.markets ?? [], 0);
    expect(partyA.active).toBe(false);

    expect(checkTradeable(partyA).tradeable).toBe(false);
  });

  test("rejects a market with too little in the book", async () => {
    const market = await fedMarket(2);

    const result = checkTradeable({ ...market, liquidity: 100 });

    expect(result.tradeable).toBe(false);
    expect(result.reason).toBe(
      "Too illiquid to bet on ($100 in the book, minimum $500).",
    );
  });

  test("rejects a market whose book is too wide to price", async () => {
    // The placeholder slots really do quote 0/1 — a 100c spread that midpoints
    // to a meaningless "50%".
    const market = await fedMarket(2);

    const result = checkTradeable({ ...market, spread: 1 });

    expect(result.tradeable).toBe(false);
    expect(result.reason).toBe(
      "The order book is too wide to price a bet (100¢ spread, maximum 8¢).",
    );
  });

  test("accepts a market whose spread Gamma did not report", async () => {
    const market = await fedMarket(2);

    expect(checkTradeable({ ...market, spread: null }).tradeable).toBe(true);
  });
});
