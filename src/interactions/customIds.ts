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
