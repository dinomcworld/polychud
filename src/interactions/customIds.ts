/**
 * Centralized custom-ID codec. Each route owns its on-the-wire format here so
 * UI builders (encoders) and interaction handlers (decoders) can't drift apart.
 *
 * Wire formats are kept stable for backwards-compat with messages already
 * rendered in user Discord servers — do not change a `prefix` or field order
 * without considering existing buttons in the wild.
 *
 * Discord caps customId at 100 chars. Watch the budget when adding fields.
 */

type Decoded<T> = T | null;

/** Returns the part of `id` after `prefix`, or null if `id` doesn't start
 * with it. */
function stripPrefix(id: string, prefix: string): string | null {
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/** Strict integer parse: rejects "", "1.5", "3abc" (unlike parseInt/Number). */
function parseIntStrict(str: string): number | null {
  return /^-?\d+$/.test(str) ? Number(str) : null;
}

/** Splits `{conditionId}[_evt{polyEventId}]`. */
function decodeMarketRef(
  rest: string,
): Decoded<{ conditionId: string; polyEventId: string | null }> {
  const evtIdx = rest.indexOf("_evt");
  const conditionId = evtIdx >= 0 ? rest.slice(0, evtIdx) : rest;
  const polyEventId = evtIdx >= 0 ? rest.slice(evtIdx + 4) : null;
  if (!conditionId || polyEventId === "") return null;
  return { conditionId, polyEventId };
}

function encodeMarketRef(
  conditionId: string,
  polyEventId: string | null | undefined,
): string {
  return polyEventId ? `${conditionId}_evt${polyEventId}` : conditionId;
}

// ─── Fixed IDs ──────────────────────────────────────────────────────────────

export const staticIds = {
  cancelBet: "cancel_bet",
  cancelClose: "cancel_close",
  marketSelect: "market_select",
  betsCloseSelect: "bets_close_select",
  /** Text input inside the bet modal (not a routed component). */
  betAmountInput: "bet_amount",
} as const;

// ─── Market card ────────────────────────────────────────────────────────────

export type BetOutcome = "yes" | "no";

export const betButton = {
  yesPrefix: "bet_yes_",
  noPrefix: "bet_no_",
  encode: (outcome: BetOutcome, conditionId: string) =>
    `bet_${outcome}_${conditionId}`,
  decode: (
    id: string,
  ): Decoded<{ outcome: BetOutcome; conditionId: string }> => {
    const parts = id.split("_");
    if (parts.length !== 3 || parts[0] !== "bet") return null;
    const [, outcome, conditionId] = parts;
    if ((outcome !== "yes" && outcome !== "no") || !conditionId) return null;
    return { outcome, conditionId };
  },
};

export const marketRefresh = {
  prefix: "refresh_",
  encode: (conditionId: string, polyEventId?: string | null) =>
    `refresh_${encodeMarketRef(conditionId, polyEventId)}`,
  decode: (id: string) => {
    const rest = stripPrefix(id, "refresh_");
    return rest === null ? null : decodeMarketRef(rest);
  },
};

export const CHART_INTERVALS = ["6h", "1d", "1w", "1m", "max"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];
export const DEFAULT_CHART_INTERVAL: ChartInterval = "1w";

function isChartInterval(str: string): str is ChartInterval {
  return (CHART_INTERVALS as readonly string[]).includes(str);
}

export const chart = {
  prefix: "chart_",
  /** The default interval is omitted so the market card's original "Chart"
   * button (`chart_{conditionId}[_evt...]`) keeps working unchanged. */
  encode: (
    conditionId: string,
    polyEventId?: string | null,
    interval: ChartInterval = DEFAULT_CHART_INTERVAL,
  ) => {
    const tf = interval === DEFAULT_CHART_INTERVAL ? "" : `_tf${interval}`;
    return `chart_${encodeMarketRef(conditionId, polyEventId)}${tf}`;
  },
  /** Format: `chart_{conditionId}[_evt{polyEventId}][_tf{interval}]`. An
   * unknown interval suffix is left in place and falls back to the default. */
  decode: (
    id: string,
  ): Decoded<{
    conditionId: string;
    polyEventId: string | null;
    interval: ChartInterval;
  }> => {
    let rest = stripPrefix(id, "chart_");
    if (rest === null) return null;
    let interval: ChartInterval = DEFAULT_CHART_INTERVAL;
    const tfIdx = rest.lastIndexOf("_tf");
    if (tfIdx >= 0) {
      const candidate = rest.slice(tfIdx + 3);
      if (isChartInterval(candidate)) {
        interval = candidate;
        rest = rest.slice(0, tfIdx);
      }
    }
    const ref = decodeMarketRef(rest);
    return ref ? { ...ref, interval } : null;
  },
};

export const chartBack = {
  prefix: "chart_back_",
  encode: (conditionId: string, polyEventId?: string | null) =>
    `chart_back_${encodeMarketRef(conditionId, polyEventId)}`,
  decode: (id: string) => {
    const rest = stripPrefix(id, "chart_back_");
    return rest === null ? null : decodeMarketRef(rest);
  },
};

// ─── Event card ─────────────────────────────────────────────────────────────

function eventIdCodec(prefix: string) {
  return {
    prefix,
    encode: (polyEventId: string) => `${prefix}${polyEventId}`,
    decode: (id: string): Decoded<{ polyEventId: string }> => {
      const polyEventId = stripPrefix(id, prefix);
      return polyEventId ? { polyEventId } : null;
    },
  };
}

export const eventRefresh = eventIdCodec("refresh_event_");
export const backToEvent = eventIdCodec("back_event_");
export const eventSelect = eventIdCodec("event_select_");

export const eventResolvedToggle = {
  showPrefix: "show_resolved_",
  hidePrefix: "hide_resolved_",
  encode: (showResolved: boolean, polyEventId: string) =>
    `${showResolved ? "show_resolved_" : "hide_resolved_"}${polyEventId}`,
  decode: (
    id: string,
  ): Decoded<{ showResolved: boolean; polyEventId: string }> => {
    const shown = stripPrefix(id, "show_resolved_");
    const hidden = stripPrefix(id, "hide_resolved_");
    const polyEventId = shown ?? hidden;
    if (!polyEventId) return null;
    return { showResolved: shown !== null, polyEventId };
  },
};

// ─── Market browse pagination ───────────────────────────────────────────────

function pageCodec(prefix: string) {
  return {
    prefix,
    encode: (page: number) => `${prefix}${page}`,
    decode: (id: string): Decoded<{ page: number }> => {
      const rest = stripPrefix(id, prefix);
      const page = rest === null ? null : parseIntStrict(rest);
      return page === null ? null : { page };
    },
  };
}

export const trendingPage = pageCodec("trending_page_");
export const newPage = pageCodec("new_page_");

export const categoryPage = {
  prefix: "cat_page_",
  encode: (page: number, tagSlug: string) => `cat_page_${page}_${tagSlug}`,
  decode: (id: string): Decoded<{ page: number; tagSlug: string }> => {
    const rest = stripPrefix(id, "cat_page_");
    if (rest === null) return null;
    const sep = rest.indexOf("_");
    if (sep < 0) return null;
    const page = parseIntStrict(rest.slice(0, sep));
    const tagSlug = rest.slice(sep + 1);
    if (page === null || !tagSlug) return null;
    return { page, tagSlug };
  },
};

// ─── Bet placement / confirmation ───────────────────────────────────────────

export const betModal = {
  prefix: "betmodal_",
  encode: (conditionId: string, outcome: "yes" | "no") =>
    `betmodal_${conditionId}_${outcome}`,
  decode: (
    id: string,
  ): Decoded<{ conditionId: string; outcome: "yes" | "no" }> => {
    const parts = id.split("_");
    if (parts.length !== 3 || parts[0] !== "betmodal") return null;
    const outcome = parts[2];
    if (outcome !== "yes" && outcome !== "no") return null;
    return { conditionId: parts[1] as string, outcome };
  },
};

export const confirmBet = {
  prefix: "confirm_",
  encode: (conditionId: string, outcome: "yes" | "no", amount: number) =>
    `confirm_${conditionId}_${outcome}_${amount}`,
  decode: (
    id: string,
  ): Decoded<{
    conditionId: string;
    outcome: "yes" | "no";
    amount: number;
  }> => {
    const parts = id.split("_");
    if (parts.length !== 4 || parts[0] !== "confirm") return null;
    const outcome = parts[2];
    const amount = Number(parts[3]);
    if ((outcome !== "yes" && outcome !== "no") || !Number.isFinite(amount)) {
      return null;
    }
    return { conditionId: parts[1] as string, outcome, amount };
  },
};

// ─── Close-bet flow ─────────────────────────────────────────────────────────

/** Legacy: nothing renders this button any more (the bet list closes via
 * `bets_close_select`), but it stays routable for buttons already in chat. */
export const closeBetButton = {
  prefix: "close_bet_",
  encode: (betId: number) => `close_bet_${betId}`,
  decode: (id: string): Decoded<{ betId: number }> => {
    const rest = stripPrefix(id, "close_bet_");
    const betId = rest === null ? null : parseIntStrict(rest);
    return betId === null ? null : { betId };
  },
};

export const confirmClose = {
  prefix: "confirm_close_",
  encode: (betId: number, timestamp: number) =>
    `confirm_close_${betId}_${timestamp}`,
  decode: (id: string): Decoded<{ betId: number; timestamp: number }> => {
    const parts = id.split("_");
    if (parts.length !== 4) return null;
    const betId = Number(parts[2]);
    const timestamp = Number(parts[3]);
    if (!Number.isFinite(betId) || !Number.isFinite(timestamp)) return null;
    return { betId, timestamp };
  },
};

// ─── /bet list pagination + toggle ──────────────────────────────────────────

export type BetListMode = "active" | "settled";

export const betsPage = {
  prefix: "bets_page_",
  encode: (mode: BetListMode, page: number) => `bets_page_${mode}_${page}`,
  /** Accepts new format `bets_page_{mode}_{page}` and legacy `bets_page_{page}`. */
  decode: (id: string): Decoded<{ mode: BetListMode; page: number }> => {
    const rest = id.slice("bets_page_".length);
    const firstUnderscore = rest.indexOf("_");
    let mode: BetListMode = "active";
    let pageStr = rest;
    if (firstUnderscore >= 0) {
      const prefix = rest.slice(0, firstUnderscore);
      if (prefix === "active" || prefix === "settled") {
        mode = prefix;
        pageStr = rest.slice(firstUnderscore + 1);
      }
    }
    const page = Number(pageStr);
    if (!Number.isFinite(page)) return null;
    return { mode, page };
  },
};

export const betsToggle = {
  prefix: "bets_toggle_",
  encode: (target: BetListMode) => `bets_toggle_${target}`,
  decode: (id: string): Decoded<{ mode: BetListMode }> => {
    const target = id.slice("bets_toggle_".length);
    return {
      mode: target === "settled" ? "settled" : "active",
    };
  },
};

// ─── Portfolio pagination + refresh + toggle ────────────────────────────────

type PortfolioPayload = {
  targetUserId: string;
  mode: BetListMode;
  page: number;
};

/** Splits a `portfolio_<verb>_{userId}_{mode?}_{page}` payload. The legacy
 * format omits {mode}; if absent we default to "active". userId is a Discord
 * snowflake (digits only) — but we tolerate underscores by joining all leading
 * parts before the optional mode/page tail. */
function decodePortfolioTail(rest: string): Decoded<PortfolioPayload> {
  const parts = rest.split("_");
  const last = parts.pop();
  if (!last) return null;
  const page = Number(last);
  if (!Number.isFinite(page)) return null;

  let mode: BetListMode = "active";
  if (parts.length > 0) {
    const maybeMode = parts[parts.length - 1];
    if (maybeMode === "active" || maybeMode === "settled") {
      mode = maybeMode;
      parts.pop();
    }
  }
  const targetUserId = parts.join("_");
  if (!targetUserId) return null;
  return { targetUserId, mode, page };
}

export const portfolioPage = {
  prefix: "portfolio_page_",
  encode: (targetUserId: string, mode: BetListMode, page: number) =>
    `portfolio_page_${targetUserId}_${mode}_${page}`,
  decode: (id: string) =>
    decodePortfolioTail(id.slice("portfolio_page_".length)),
};

export const portfolioRefresh = {
  prefix: "portfolio_refresh_",
  encode: (targetUserId: string, mode: BetListMode, page: number) =>
    `portfolio_refresh_${targetUserId}_${mode}_${page}`,
  decode: (id: string) =>
    decodePortfolioTail(id.slice("portfolio_refresh_".length)),
};

export const portfolioToggle = {
  prefix: "portfolio_toggle_",
  encode: (targetUserId: string, target: BetListMode) =>
    `portfolio_toggle_${targetUserId}_${target}`,
  decode: (
    id: string,
  ): Decoded<{ targetUserId: string; mode: BetListMode }> => {
    const rest = id.slice("portfolio_toggle_".length);
    const lastUnderscore = rest.lastIndexOf("_");
    if (lastUnderscore < 0) return null;
    const targetUserId = rest.slice(0, lastUnderscore);
    const modeStr = rest.slice(lastUnderscore + 1);
    if (!targetUserId) return null;
    return {
      targetUserId,
      mode: modeStr === "settled" ? "settled" : "active",
    };
  },
};

// ─── Leaderboard pagination + refresh ───────────────────────────────────────

/** Splits a `{sort}_{all}_{page}` tail. Sort values are single alphabetic
 * words (net/portfolio/points/skill/average) with no underscores, so the sort
 * is always the first segment. `all` is a "1"/"0" flag for the show-all-players
 * view. Legacy IDs omit `all` (`{sort}_{page}`) or both (`{sort}`); we default
 * `all` to false and `page` to 0 in those cases. */
function decodeLeaderboardTail(
  rest: string,
): Decoded<{ sort: string; all: boolean; page: number }> {
  if (!rest) return null;
  const parts = rest.split("_");
  const sort = parts[0];
  if (!sort) return null;
  const tail = parts.slice(1);
  if (tail.length === 0) return { sort, all: false, page: 0 };
  if (tail.length === 1) {
    const page = Number(tail[0]);
    return { sort, all: false, page: Number.isFinite(page) ? page : 0 };
  }
  // tail.length >= 2: [all, page]
  const page = Number(tail[1]);
  return { sort, all: tail[0] === "1", page: Number.isFinite(page) ? page : 0 };
}

export const leaderboardPage = {
  prefix: "leaderboard_page_",
  encode: (sort: string, all: boolean, page: number) =>
    `leaderboard_page_${sort}_${all ? "1" : "0"}_${page}`,
  decode: (id: string) =>
    decodeLeaderboardTail(id.slice("leaderboard_page_".length)),
};

export const leaderboardRefresh = {
  prefix: "leaderboard_refresh_",
  encode: (sort: string, all: boolean, page: number) =>
    `leaderboard_refresh_${sort}_${all ? "1" : "0"}_${page}`,
  decode: (id: string) =>
    decodeLeaderboardTail(id.slice("leaderboard_refresh_".length)),
};

// ─── Market search pagination + resolved toggle ─────────────────────────────

/** Discord caps customId at 100 chars; encoded query is clipped to 60. */
function encodeQuery(query: string): string {
  return encodeURIComponent(query).slice(0, 60);
}

export const searchPage = {
  prefix: "search_page_",
  encode: (page: number, showResolved: boolean, query: string) =>
    `search_page_${page}_${showResolved ? "1" : "0"}_${encodeQuery(query)}`,
  decode: (
    id: string,
  ): Decoded<{ page: number; showResolved: boolean; query: string }> => {
    const rest = id.slice("search_page_".length);
    const firstUnderscore = rest.indexOf("_");
    const secondUnderscore = rest.indexOf("_", firstUnderscore + 1);
    if (firstUnderscore < 0 || secondUnderscore < 0) return null;
    const page = Number(rest.slice(0, firstUnderscore));
    if (!Number.isFinite(page)) return null;
    const resolvedFlag = rest.slice(firstUnderscore + 1, secondUnderscore);
    const encoded = rest.slice(secondUnderscore + 1);
    return {
      page,
      showResolved: resolvedFlag === "1",
      query: decodeURIComponent(encoded),
    };
  },
};

export const searchResolvedToggle = {
  showPrefix: "show_search_resolved_",
  hidePrefix: "hide_search_resolved_",
  encode: (showResolved: boolean, query: string) =>
    `${showResolved ? "show_search_resolved_" : "hide_search_resolved_"}${encodeQuery(query)}`,
  decode: (id: string): Decoded<{ showResolved: boolean; query: string }> => {
    let prefix: string;
    let showResolved: boolean;
    if (id.startsWith("show_search_resolved_")) {
      prefix = "show_search_resolved_";
      showResolved = true;
    } else if (id.startsWith("hide_search_resolved_")) {
      prefix = "hide_search_resolved_";
      showResolved = false;
    } else {
      return null;
    }
    return {
      showResolved,
      query: decodeURIComponent(id.slice(prefix.length)),
    };
  },
};
