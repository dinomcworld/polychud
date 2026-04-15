import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { events, markets } from "../db/schema.js";
import {
  getMidpointPrice,
  type GammaEvent,
  type GammaMarket,
} from "./polymarket.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export async function upsertEvent(gamma: GammaEvent) {
  const existing = await db.query.events.findFirst({
    where: eq(events.polymarketEventId, gamma.id),
  });

  const values = {
    polymarketEventId: gamma.id,
    title: gamma.title,
    slug: gamma.slug,
    description: gamma.description || null,
    imageUrl: gamma.image || gamma.icon || null,
    endDate: gamma.endDate ? new Date(gamma.endDate) : null,
    status: gamma.closed ? "closed" : gamma.active ? "active" : "inactive",
    negRisk: gamma.negRisk,
    marketCount: gamma.markets.length,
    lastPolledAt: new Date(),
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(events)
      .set(values)
      .where(eq(events.id, existing.id));
    return existing.id;
  }

  const [created] = await db
    .insert(events)
    .values(values)
    .onConflictDoUpdate({
      target: events.polymarketEventId,
      set: values,
    })
    .returning({ id: events.id });

  return created!.id;
}

export async function upsertMarket(
  gamma: GammaMarket,
  eventDbId?: number | null
) {
  const yesPrice = gamma.outcomePrices[0] ?? 0.5;
  const noPrice = gamma.outcomePrices[1] ?? 1 - yesPrice;
  const yesTokenId = gamma.clobTokenIds[0] ?? null;
  const noTokenId = gamma.clobTokenIds[1] ?? null;

  const values = {
    eventId: eventDbId ?? null,
    polymarketConditionId: gamma.conditionId,
    question: gamma.question,
    outcomeLabel: gamma.groupItemTitle || null,
    slug: gamma.slug,
    yesTokenId,
    noTokenId,
    currentYesPrice: String(yesPrice),
    currentNoPrice: String(noPrice),
    endDate: gamma.endDate ? new Date(gamma.endDate) : null,
    status: gamma.closed ? "closed" : gamma.active ? "active" : "inactive",
    volume24h: gamma.volume24hr != null ? String(gamma.volume24hr) : null,
    oneHourPriceChange:
      gamma.oneWeekPriceChange != null
        ? String(gamma.oneWeekPriceChange)
        : null,
    oneDayPriceChange:
      gamma.oneMonthPriceChange != null
        ? String(gamma.oneMonthPriceChange)
        : null,
    lastPolledAt: new Date(),
    updatedAt: new Date(),
  };

  const existing = await db.query.markets.findFirst({
    where: eq(markets.polymarketConditionId, gamma.conditionId),
  });

  if (existing) {
    await db
      .update(markets)
      .set(values)
      .where(eq(markets.id, existing.id));
    return existing.id;
  }

  const [created] = await db
    .insert(markets)
    .values(values)
    .onConflictDoUpdate({
      target: markets.polymarketConditionId,
      set: values,
    })
    .returning({ id: markets.id });

  return created!.id;
}

/** Upsert a full event with all its markets. Returns map of conditionId -> dbId. */
export async function upsertEventWithMarkets(gamma: GammaEvent) {
  const eventDbId = await upsertEvent(gamma);
  const marketIdMap = new Map<string, number>();

  for (const m of gamma.markets) {
    const dbId = await upsertMarket(m, eventDbId);
    marketIdMap.set(m.conditionId, dbId);
  }

  return { eventDbId, marketIdMap };
}

/** Upsert a standalone market (no event or extract event from gamma). */
export async function upsertStandaloneMarket(gamma: GammaMarket) {
  let eventDbId: number | null = null;

  if (gamma.events && gamma.events.length > 0) {
    eventDbId = await upsertEvent(gamma.events[0]!);
  }

  const dbId = await upsertMarket(gamma, eventDbId);
  return dbId;
}

/** Get a market from DB by its internal ID, optionally refresh price from CLOB. */
export async function getMarketWithPrices(
  marketId: number,
  refreshPrice = false
) {
  const market = await db.query.markets.findFirst({
    where: eq(markets.id, marketId),
  });

  if (!market) return null;

  if (refreshPrice && market.yesTokenId) {
    try {
      const yesPrice = await getMidpointPrice(market.yesTokenId);
      const noPrice = 1 - yesPrice;

      await db
        .update(markets)
        .set({
          currentYesPrice: String(yesPrice),
          currentNoPrice: String(noPrice),
          lastPolledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(markets.id, marketId));

      return {
        ...market,
        currentYesPrice: String(yesPrice),
        currentNoPrice: String(noPrice),
      };
    } catch (err) {
      logger.warn(`Failed to refresh price for market ${marketId}:`, err);
    }
  }

  return market;
}

/** Get an event from DB by its internal ID, with all its markets. */
export async function getEventWithMarkets(eventDbId: number) {
  return db.query.events.findFirst({
    where: eq(events.id, eventDbId),
    with: { markets: true },
  });
}

/** Get an event from DB by its slug, with all its markets. */
export async function getEventByDbSlug(slug: string) {
  return db.query.events.findFirst({
    where: eq(events.slug, slug),
    with: { markets: true },
  });
}

/** Check if price data is stale (older than cache TTL). */
export function isPriceStale(market: { lastPolledAt: Date | null }): boolean {
  if (!market.lastPolledAt) return true;
  return Date.now() - market.lastPolledAt.getTime() > config.ON_DEMAND_CACHE_TTL_MS;
}
