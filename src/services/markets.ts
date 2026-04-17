import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { events, markets } from "../db/schema.js";
import type { GammaEvent, GammaMarket } from "./polymarket.js";

export async function upsertEvent(gamma: GammaEvent) {
  const values = {
    polymarketEventId: gamma.id,
    slug: gamma.slug || null,
    status: gamma.closed ? "closed" : gamma.active ? "active" : "inactive",
    updatedAt: new Date(),
  };

  const existing = await db.query.events.findFirst({
    where: eq(events.polymarketEventId, gamma.id),
  });

  if (existing) {
    await db.update(events).set(values).where(eq(events.id, existing.id));
    return existing.id;
  }

  const [created] = await db
    .insert(events)
    .values(values)
    .onConflictDoUpdate({ target: events.polymarketEventId, set: values })
    .returning({ id: events.id });

  if (!created) throw new Error(`Failed to upsert event ${gamma.id}`);
  return created.id;
}

export async function upsertMarket(gamma: GammaMarket, eventDbId: number) {
  const yesPrice = gamma.outcomePrices[0] ?? 0.5;
  const noPrice = gamma.outcomePrices[1] ?? 1 - yesPrice;
  const yesTokenId = gamma.clobTokenIds[0] ?? null;
  const noTokenId = gamma.clobTokenIds[1] ?? null;

  const values = {
    eventId: eventDbId,
    polymarketConditionId: gamma.conditionId,
    question: gamma.question,
    yesTokenId,
    noTokenId,
    currentYesPrice: String(yesPrice),
    currentNoPrice: String(noPrice),
    endDate: gamma.endDate ? new Date(gamma.endDate) : null,
    status: gamma.closed ? "closed" : gamma.active ? "active" : "inactive",
    updatedAt: new Date(),
  };

  const existing = await db.query.markets.findFirst({
    where: eq(markets.polymarketConditionId, gamma.conditionId),
  });

  if (existing) {
    await db.update(markets).set(values).where(eq(markets.id, existing.id));
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

  if (!created) throw new Error(`Failed to upsert market ${gamma.conditionId}`);
  return created.id;
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

/** Upsert a standalone market together with its parent event. */
export async function upsertStandaloneMarket(gamma: GammaMarket) {
  const parentEvent = gamma.events?.[0];
  if (!parentEvent) {
    throw new Error(
      `Market ${gamma.conditionId} is missing a parent event; refusing to upsert.`,
    );
  }

  const eventDbId = await upsertEvent(parentEvent);
  return upsertMarket(gamma, eventDbId);
}
