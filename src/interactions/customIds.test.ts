import { describe, expect, test } from "bun:test";
import {
  backToEvent,
  betButton,
  betModal,
  betsPage,
  betsToggle,
  CHART_INTERVALS,
  categoryPage,
  chart,
  chartBack,
  closeBetButton,
  confirmBet,
  confirmClose,
  eventRefresh,
  eventResolvedToggle,
  eventSelect,
  leaderboardPage,
  leaderboardRefresh,
  marketRefresh,
  newPage,
  portfolioPage,
  portfolioRefresh,
  portfolioToggle,
  searchPage,
  searchResolvedToggle,
  staticIds,
  trendingPage,
} from "./customIds.js";

// Realistic worst-case values: a full Polymarket condition id, a long Gamma
// event id and a 19-digit Discord snowflake.
const COND = `0x${"ab".repeat(32)}`;
const EVT = "1234567";
const USER = "1234567890123456789";

/** Every button customId the bot can render, paired with the prefix that
 * must route it. Mirrors the PREFIX_ROUTES table in buttons.ts. */
const BUTTON_IDS: Array<[prefix: string, id: string]> = [
  [betButton.yesPrefix, betButton.encode("yes", COND)],
  [betButton.noPrefix, betButton.encode("no", COND)],
  [marketRefresh.prefix, marketRefresh.encode(COND, EVT)],
  [eventRefresh.prefix, eventRefresh.encode(EVT)],
  [chart.prefix, chart.encode(COND, EVT, "6h")],
  [chartBack.prefix, chartBack.encode(COND, EVT)],
  [confirmBet.prefix, confirmBet.encode(COND, "yes", 1_000_000_000)],
  [confirmClose.prefix, confirmClose.encode(2_000_000_000, Date.now())],
  [closeBetButton.prefix, closeBetButton.encode(2_000_000_000)],
  [betsPage.prefix, betsPage.encode("settled", 999)],
  [betsToggle.prefix, betsToggle.encode("settled")],
  [portfolioPage.prefix, portfolioPage.encode(USER, "settled", 999)],
  [portfolioRefresh.prefix, portfolioRefresh.encode(USER, "settled", 999)],
  [portfolioToggle.prefix, portfolioToggle.encode(USER, "settled")],
  [leaderboardPage.prefix, leaderboardPage.encode("portfolio", true, 999)],
  [
    leaderboardRefresh.prefix,
    leaderboardRefresh.encode("portfolio", true, 999),
  ],
  [searchPage.prefix, searchPage.encode(999, true, "x".repeat(200))],
  [
    searchResolvedToggle.showPrefix,
    searchResolvedToggle.encode(true, "x".repeat(200)),
  ],
  [
    searchResolvedToggle.hidePrefix,
    searchResolvedToggle.encode(false, "x".repeat(200)),
  ],
  [trendingPage.prefix, trendingPage.encode(999)],
  [newPage.prefix, newPage.encode(999)],
  [categoryPage.prefix, categoryPage.encode(999, "some-long-category-slug")],
  [eventResolvedToggle.showPrefix, eventResolvedToggle.encode(true, EVT)],
  [eventResolvedToggle.hidePrefix, eventResolvedToggle.encode(false, EVT)],
  [backToEvent.prefix, backToEvent.encode(EVT)],
];

describe("routing", () => {
  const prefixes = BUTTON_IDS.map(([prefix]) => prefix);

  test.each(BUTTON_IDS)(
    "%s wins longest-prefix match for its id",
    (prefix, id) => {
      const longest = prefixes
        .filter((p) => id.startsWith(p))
        .sort((a, b) => b.length - a.length)[0];
      expect(longest).toBe(prefix);
    },
  );

  test.each(BUTTON_IDS)("%s ids fit Discord's 100-char limit", (_, id) => {
    expect(id.length).toBeLessThanOrEqual(100);
  });

  test("static ids don't collide with any routed prefix", () => {
    for (const id of Object.values(staticIds)) {
      expect(prefixes.some((p) => id.startsWith(p))).toBe(false);
    }
  });

  test("select-menu ids fit Discord's 100-char limit", () => {
    expect(eventSelect.encode(EVT).length).toBeLessThanOrEqual(100);
  });
});

// Wire formats are already baked into messages sitting in Discord servers, so
// a change here breaks old buttons. Update these only on purpose.
describe("wire formats", () => {
  test.each([
    [betButton.encode("yes", "0xc"), "bet_yes_0xc"],
    [betButton.encode("no", "0xc"), "bet_no_0xc"],
    [marketRefresh.encode("0xc"), "refresh_0xc"],
    [marketRefresh.encode("0xc", "42"), "refresh_0xc_evt42"],
    [chart.encode("0xc"), "chart_0xc"],
    [chart.encode("0xc", "42"), "chart_0xc_evt42"],
    [chart.encode("0xc", null, "1w"), "chart_0xc"],
    [chart.encode("0xc", "42", "6h"), "chart_0xc_evt42_tf6h"],
    [chartBack.encode("0xc"), "chart_back_0xc"],
    [chartBack.encode("0xc", "42"), "chart_back_0xc_evt42"],
    [closeBetButton.encode(7), "close_bet_7"],
    [eventRefresh.encode("42"), "refresh_event_42"],
    [backToEvent.encode("42"), "back_event_42"],
    [eventSelect.encode("42"), "event_select_42"],
    [eventResolvedToggle.encode(true, "42"), "show_resolved_42"],
    [eventResolvedToggle.encode(false, "42"), "hide_resolved_42"],
    [trendingPage.encode(3), "trending_page_3"],
    [newPage.encode(3), "new_page_3"],
    [categoryPage.encode(3, "us-politics"), "cat_page_3_us-politics"],
    [betModal.encode("0xc", "yes"), "betmodal_0xc_yes"],
    [confirmBet.encode("0xc", "no", 50), "confirm_0xc_no_50"],
    [confirmClose.encode(7, 123), "confirm_close_7_123"],
    [betsPage.encode("active", 2), "bets_page_active_2"],
    [betsToggle.encode("settled"), "bets_toggle_settled"],
    [portfolioPage.encode("99", "active", 2), "portfolio_page_99_active_2"],
    [
      portfolioRefresh.encode("99", "settled", 0),
      "portfolio_refresh_99_settled_0",
    ],
    [portfolioToggle.encode("99", "settled"), "portfolio_toggle_99_settled"],
    [leaderboardPage.encode("net", true, 2), "leaderboard_page_net_1_2"],
    [
      leaderboardRefresh.encode("skill", false, 0),
      "leaderboard_refresh_skill_0_0",
    ],
    [searchPage.encode(1, false, "a b"), "search_page_1_0_a%20b"],
    [searchResolvedToggle.encode(true, "a b"), "show_search_resolved_a%20b"],
  ])("%s", (actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe("market card", () => {
  test("betButton round-trips both outcomes", () => {
    expect(betButton.decode(betButton.encode("yes", COND))).toEqual({
      outcome: "yes",
      conditionId: COND,
    });
    expect(betButton.decode(betButton.encode("no", COND))).toEqual({
      outcome: "no",
      conditionId: COND,
    });
  });

  test.each([
    "bet_maybe_0xc",
    "bet_yes_",
    "bet_yes",
    "bet_yes_0xc_extra",
    "bets_yes_0xc",
  ])("betButton rejects %p", (id) => {
    expect(betButton.decode(id)).toBeNull();
  });

  test("marketRefresh round-trips with and without event", () => {
    expect(marketRefresh.decode(marketRefresh.encode(COND))).toEqual({
      conditionId: COND,
      polyEventId: null,
    });
    expect(marketRefresh.decode(marketRefresh.encode(COND, EVT))).toEqual({
      conditionId: COND,
      polyEventId: EVT,
    });
  });

  test.each(["refresh_", "refresh__evt42", "refresh_0xc_evt", "chart_0xc"])(
    "marketRefresh rejects %p",
    (id) => {
      expect(marketRefresh.decode(id)).toBeNull();
    },
  );

  test.each(CHART_INTERVALS)("chart round-trips interval %s", (interval) => {
    expect(chart.decode(chart.encode(COND, EVT, interval))).toEqual({
      conditionId: COND,
      polyEventId: EVT,
      interval,
    });
    expect(chart.decode(chart.encode(COND, null, interval))).toEqual({
      conditionId: COND,
      polyEventId: null,
      interval,
    });
  });

  test("chart without a timeframe defaults to 1w", () => {
    expect(chart.decode("chart_0xc_evt42")?.interval).toBe("1w");
  });

  test("chart treats an unknown timeframe suffix as part of the event id", () => {
    // Unknown `_tf` tails aren't stripped, so the lookup fails visibly rather
    // than quietly rendering the wrong timeframe.
    expect(chart.decode("chart_0xc_evt42_tf2y")).toEqual({
      conditionId: "0xc",
      polyEventId: "42_tf2y",
      interval: "1w",
    });
  });

  test("chart rejects foreign ids", () => {
    expect(chart.decode("refresh_0xc")).toBeNull();
    expect(chart.decode("chart_")).toBeNull();
  });

  test("chartBack round-trips", () => {
    expect(chartBack.decode(chartBack.encode(COND, EVT))).toEqual({
      conditionId: COND,
      polyEventId: EVT,
    });
    expect(chartBack.decode(chartBack.encode(COND))).toEqual({
      conditionId: COND,
      polyEventId: null,
    });
  });
});

describe("event card", () => {
  test.each([
    ["eventRefresh", eventRefresh],
    ["backToEvent", backToEvent],
    ["eventSelect", eventSelect],
  ] as const)("%s round-trips and rejects empty/foreign ids", (_, codec) => {
    expect(codec.decode(codec.encode(EVT))).toEqual({ polyEventId: EVT });
    expect(codec.decode(codec.prefix)).toBeNull();
    expect(codec.decode(`other_${EVT}`)).toBeNull();
  });

  test("eventResolvedToggle round-trips both states", () => {
    expect(
      eventResolvedToggle.decode(eventResolvedToggle.encode(true, EVT)),
    ).toEqual({ showResolved: true, polyEventId: EVT });
    expect(
      eventResolvedToggle.decode(eventResolvedToggle.encode(false, EVT)),
    ).toEqual({ showResolved: false, polyEventId: EVT });
    expect(eventResolvedToggle.decode("show_resolved_")).toBeNull();
    expect(eventResolvedToggle.decode("show_search_resolved_x")).toBeNull();
  });
});

describe("pagination", () => {
  test.each([
    ["trendingPage", trendingPage],
    ["newPage", newPage],
  ] as const)("%s round-trips and rejects non-integers", (_, codec) => {
    expect(codec.decode(codec.encode(0))).toEqual({ page: 0 });
    expect(codec.decode(codec.encode(12))).toEqual({ page: 12 });
    expect(codec.decode(codec.encode(-1))).toEqual({ page: -1 });
    for (const bad of ["", "abc", "1.5", "3abc", " 3"]) {
      expect(codec.decode(`${codec.prefix}${bad}`)).toBeNull();
    }
  });

  test("categoryPage keeps underscores in the tag slug", () => {
    expect(categoryPage.decode(categoryPage.encode(2, "a_b-c"))).toEqual({
      page: 2,
      tagSlug: "a_b-c",
    });
  });

  test.each(["cat_page_", "cat_page_2", "cat_page_2_", "cat_page_x_slug"])(
    "categoryPage rejects %p",
    (id) => {
      expect(categoryPage.decode(id)).toBeNull();
    },
  );

  test("closeBetButton round-trips and rejects non-integers", () => {
    expect(closeBetButton.decode(closeBetButton.encode(42))).toEqual({
      betId: 42,
    });
    expect(closeBetButton.decode("close_bet_")).toBeNull();
    expect(closeBetButton.decode("close_bet_4x")).toBeNull();
  });
});

describe("bet placement and close flow", () => {
  test("betModal round-trips and validates outcome", () => {
    expect(betModal.decode(betModal.encode(COND, "no"))).toEqual({
      conditionId: COND,
      outcome: "no",
    });
    expect(betModal.decode("betmodal_0xc_maybe")).toBeNull();
  });

  test("confirmBet round-trips and validates amount", () => {
    expect(confirmBet.decode(confirmBet.encode(COND, "yes", 250))).toEqual({
      conditionId: COND,
      outcome: "yes",
      amount: 250,
    });
    expect(confirmBet.decode("confirm_0xc_yes_lots")).toBeNull();
  });

  test("confirmClose round-trips", () => {
    expect(confirmClose.decode(confirmClose.encode(7, 1700000000000))).toEqual({
      betId: 7,
      timestamp: 1700000000000,
    });
  });
});

describe("bet list, portfolio and leaderboard", () => {
  test("betsPage round-trips and accepts the legacy page-only format", () => {
    expect(betsPage.decode(betsPage.encode("settled", 3))).toEqual({
      mode: "settled",
      page: 3,
    });
    expect(betsPage.decode("bets_page_4")).toEqual({ mode: "active", page: 4 });
  });

  test("betsToggle falls back to active", () => {
    expect(betsToggle.decode(betsToggle.encode("settled"))).toEqual({
      mode: "settled",
    });
    expect(betsToggle.decode("bets_toggle_bogus")).toEqual({ mode: "active" });
  });

  test("portfolio codecs round-trip and accept the legacy mode-less format", () => {
    expect(
      portfolioPage.decode(portfolioPage.encode(USER, "settled", 2)),
    ).toEqual({
      targetUserId: USER,
      mode: "settled",
      page: 2,
    });
    expect(
      portfolioRefresh.decode(portfolioRefresh.encode(USER, "active", 0)),
    ).toEqual({ targetUserId: USER, mode: "active", page: 0 });
    expect(portfolioPage.decode(`portfolio_page_${USER}_5`)).toEqual({
      targetUserId: USER,
      mode: "active",
      page: 5,
    });
    expect(
      portfolioToggle.decode(portfolioToggle.encode(USER, "settled")),
    ).toEqual({
      targetUserId: USER,
      mode: "settled",
    });
  });

  test("leaderboard codecs round-trip and accept legacy formats", () => {
    expect(
      leaderboardPage.decode(leaderboardPage.encode("winrate", true, 3)),
    ).toEqual({ sort: "winrate", all: true, page: 3 });
    expect(
      leaderboardRefresh.decode(leaderboardRefresh.encode("net", false, 0)),
    ).toEqual({ sort: "net", all: false, page: 0 });
    expect(leaderboardPage.decode("leaderboard_page_net_2")).toEqual({
      sort: "net",
      all: false,
      page: 2,
    });
    expect(leaderboardRefresh.decode("leaderboard_refresh_skill")).toEqual({
      sort: "skill",
      all: false,
      page: 0,
    });
  });
});

describe("market search", () => {
  test("searchPage round-trips queries containing underscores and unicode", () => {
    const query = "trump_2028 élection";
    expect(searchPage.decode(searchPage.encode(2, true, query))).toEqual({
      page: 2,
      showResolved: true,
      query,
    });
  });

  test("searchResolvedToggle round-trips both states", () => {
    expect(
      searchResolvedToggle.decode(searchResolvedToggle.encode(true, "fed")),
    ).toEqual({ showResolved: true, query: "fed" });
    expect(
      searchResolvedToggle.decode(searchResolvedToggle.encode(false, "fed")),
    ).toEqual({ showResolved: false, query: "fed" });
  });
});
