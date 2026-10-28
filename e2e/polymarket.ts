/** Helpers for picking live Polymarket markets that suit a given test. */
import { config } from "../src/config.js";
import { quoteEntryPrice, quoteExitPrice } from "../src/services/betting.js";
import {
  checkTradeable,
  type GammaMarket,
  getMarketByConditionId,
  getTrendingMarkets,
} from "../src/services/polymarket.js";

/**
 * A liquid, open binary market whose live book quotes both an entry and an
 * exit price on each side — i.e. one the bot will actually let you bet on and
 * close. Returned with its parent event attached, as the bet flow expects.
 * Trending events are by far the most liquid, so the first page suffices.
 */
export async function findTradeableMarket(): Promise<GammaMarket> {
  const events = await getTrendingMarkets(30);
  for (const event of events) {
    for (const market of event.markets) {
      const [yesToken, noToken] = market.clobTokenIds;
      if (!market.conditionId || !yesToken || !noToken) continue;
      if (!checkTradeable(market).tradeable) continue;
      const [yesEntry, noEntry, yesExit] = await Promise.all([
        quoteEntryPrice(yesToken),
        quoteEntryPrice(noToken),
        quoteExitPrice(yesToken),
      ]);
      // Stay away from the extremes so a stake of a few hundred points can't
      // hit the payout cap and the price can't drift out of range mid-test.
      if (!yesEntry.ok || !noEntry.ok || !yesExit.ok) continue;
      if (yesEntry.price < 0.1 || yesEntry.price > 0.9) continue;
      return { ...market, events: [event] };
    }
  }
  throw new Error(
    "No tradeable market found among Polymarket's trending events",
  );
}

/**
 * A closed market that has resolved to a definite YES or NO, fetched through
 * the same lookup the resolver uses.
 */
export async function findResolvedMarket(): Promise<
  GammaMarket & { winner: "yes" | "no" }
> {
  const params = new URLSearchParams({
    closed: "true",
    order: "endDate",
    ascending: "false",
    end_date_max: new Date().toISOString(),
    volume_num_min: "10000",
    limit: "100",
  });
  const response = await fetch(
    `${config.POLYMARKET_GAMMA_URL}/markets?${params}`,
  );
  if (!response.ok) {
    throw new Error(`Gamma /markets responded ${response.status}`);
  }
  const raw = (await response.json()) as Array<{
    conditionId?: string;
    outcomePrices?: string;
  }>;

  for (const candidate of raw) {
    if (!candidate.conditionId) continue;
    const prices = JSON.parse(candidate.outcomePrices ?? "[]").map(Number);
    const resolved =
      (prices[0] === 1 && prices[1] === 0) ||
      (prices[0] === 0 && prices[1] === 1);
    if (!resolved) continue;

    const market = await getMarketByConditionId(candidate.conditionId);
    if (!market?.closed || !market.events?.[0]) continue;
    return { ...market, winner: market.outcomePrices[0] === 1 ? "yes" : "no" };
  }
  throw new Error("No resolved market found among recently closed ones");
}
