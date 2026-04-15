import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// ─── Normalized types (what our code uses) ────────────────────────────────────

export interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  active: boolean;
  closed: boolean;
  endDate: string | null;
  image: string | null;
  icon: string | null;
  description: string;
  volume: number;
  volume24hr: number;
  oneWeekPriceChange: number | null;
  oneMonthPriceChange: number | null;
  negRisk: boolean;
  negRiskMarketID: string;
  groupItemTitle?: string;
  // Populated when fetched via /markets?id= endpoint
  events?: GammaEvent[];
}

export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  image: string | null;
  icon: string | null;
  active: boolean;
  closed: boolean;
  endDate: string | null;
  negRisk: boolean;
  markets: GammaMarket[];
  commentCount: number;
  volume: number;
  volume24hr: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawApiObject = Record<string, any>;

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: T, ttlMs: number) {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string) {
    this.store.delete(key);
  }
}

const marketCache = new TTLCache<GammaMarket>();
const eventCache = new TTLCache<GammaEvent>();
const priceCache = new TTLCache<number>();

const MARKET_CACHE_TTL = config.ON_DEMAND_CACHE_TTL_MS; // 60s
const PRICE_CACHE_TTL = 10_000; // 10s

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 2
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (response.status === 429 && retries > 0) {
      const retryAfter = parseInt(response.headers.get("retry-after") || "2");
      logger.warn(`Rate limited, retrying in ${retryAfter}s...`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return fetchWithRetry(url, options, retries - 1);
    }

    if (!response.ok) {
      throw new Error(`API error ${response.status}: ${response.statusText}`);
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Parsers ──────────────────────────────────────────────────────────────────
// The Gamma API is consistently camelCase across all endpoints.

function parseMarket(raw: RawApiObject): GammaMarket {
  return {
    id: String(raw.id),
    conditionId: raw.conditionId ?? "",
    question: raw.question ?? "",
    slug: raw.slug ?? "",
    outcomes: safeJsonParse(raw.outcomes, []),
    outcomePrices: safeJsonParse(raw.outcomePrices, []).map(Number),
    clobTokenIds: safeJsonParse(raw.clobTokenIds, []),
    active: raw.active ?? false,
    closed: raw.closed ?? false,
    endDate: raw.endDate ?? null,
    image: raw.image ?? null,
    icon: raw.icon ?? null,
    description: raw.description ?? "",
    volume: parseFloat(raw.volume ?? "0"),
    volume24hr: raw.volume24hr ?? 0,
    oneWeekPriceChange: raw.oneWeekPriceChange ?? null,
    oneMonthPriceChange: raw.oneMonthPriceChange ?? null,
    negRisk: raw.negRisk ?? false,
    negRiskMarketID: raw.negRiskMarketID ?? raw.questionID ?? "",
    groupItemTitle: raw.groupItemTitle ?? undefined,
    events: raw.events?.map(parseEvent),
  };
}

function parseEvent(raw: RawApiObject): GammaEvent {
  return {
    id: String(raw.id),
    slug: raw.slug ?? "",
    title: raw.title ?? "",
    description: raw.description ?? "",
    image: raw.image ?? null,
    icon: raw.icon ?? null,
    active: raw.active ?? false,
    closed: raw.closed ?? false,
    endDate: raw.endDate ?? null,
    negRisk: raw.negRisk ?? false,
    markets: (raw.markets ?? []).map(parseMarket),
    commentCount: raw.commentCount ?? 0,
    volume: typeof raw.volume === "string" ? parseFloat(raw.volume) : (raw.volume ?? 0),
    volume24hr: raw.volume24hr ?? 0,
  };
}

function safeJsonParse<T>(str: string | T | null | undefined, fallback: T): T {
  if (str == null) return fallback;
  if (typeof str !== "string") return str;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// ─── Gamma API ────────────────────────────────────────────────────────────────

export async function searchMarkets(query: string): Promise<GammaEvent[]> {
  const url = `${config.POLYMARKET_GAMMA_URL}/public-search?q=${encodeURIComponent(query)}&limit_per_type=10`;
  const response = await fetchWithRetry(url);
  const data = (await response.json()) as {
    events?: RawApiObject[];
    pagination?: unknown;
  };

  const rawEvents = data.events ?? [];
  const results: GammaEvent[] = [];

  for (const rawEvent of rawEvents) {
    const parsed = parseEvent(rawEvent);
    eventCache.set(`event:${parsed.id}`, parsed, MARKET_CACHE_TTL);
    for (const m of parsed.markets) {
      m.events = [parsed];
      marketCache.set(`market:${m.conditionId}`, m, MARKET_CACHE_TTL);
    }
    results.push(parsed);
  }

  return results;
}

export async function getTrendingMarkets(
  limit: number = 5
): Promise<GammaEvent[]> {
  const url = `${config.POLYMARKET_GAMMA_URL}/events?active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}`;
  const response = await fetchWithRetry(url);
  const raw = (await response.json()) as RawApiObject[];
  const results = raw.map(parseEvent);

  for (const event of results) {
    eventCache.set(`event:${event.id}`, event, MARKET_CACHE_TTL);
    for (const m of event.markets) {
      marketCache.set(`market:${m.conditionId}`, m, MARKET_CACHE_TTL);
    }
  }

  return results;
}

export async function getEventBySlug(
  slug: string
): Promise<GammaEvent | null> {
  const url = `${config.POLYMARKET_GAMMA_URL}/events?slug=${encodeURIComponent(slug)}`;
  const response = await fetchWithRetry(url);
  const raw = (await response.json()) as RawApiObject[];
  if (raw.length === 0) return null;

  const event = parseEvent(raw[0]!);
  eventCache.set(`event:${event.id}`, event, MARKET_CACHE_TTL);
  for (const m of event.markets) {
    marketCache.set(`market:${m.conditionId}`, m, MARKET_CACHE_TTL);
  }
  return event;
}

export async function getMarketById(
  marketId: string
): Promise<GammaMarket | null> {
  const url = `${config.POLYMARKET_GAMMA_URL}/markets?id=${encodeURIComponent(marketId)}`;
  const response = await fetchWithRetry(url);
  const raw = (await response.json()) as RawApiObject[];
  if (!raw || raw.length === 0) return null;

  const market = parseMarket(raw[0]!);
  marketCache.set(`market:${market.conditionId}`, market, MARKET_CACHE_TTL);
  return market;
}

export async function getMarketByConditionId(
  conditionId: string
): Promise<GammaMarket | null> {
  const url = `${config.POLYMARKET_GAMMA_URL}/markets?conditionId=${encodeURIComponent(conditionId)}`;
  const response = await fetchWithRetry(url);
  const raw = (await response.json()) as RawApiObject[];
  if (!raw || raw.length === 0) return null;

  const market = parseMarket(raw[0]!);
  marketCache.set(`market:${market.conditionId}`, market, MARKET_CACHE_TTL);
  return market;
}

// ─── CLOB API ─────────────────────────────────────────────────────────────────

export async function getMidpointPrice(tokenId: string): Promise<number> {
  const cached = priceCache.get(`price:${tokenId}`);
  if (cached !== null) return cached;

  const url = `${config.POLYMARKET_CLOB_URL}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
  const response = await fetchWithRetry(url);
  const data = (await response.json()) as { mid: string };
  const price = parseFloat(data.mid);

  priceCache.set(`price:${tokenId}`, price, PRICE_CACHE_TTL);
  return price;
}

export async function getBatchPrices(
  tokenIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const uncached: string[] = [];

  for (const id of tokenIds) {
    const cached = priceCache.get(`price:${id}`);
    if (cached !== null) {
      result.set(id, cached);
    } else {
      uncached.push(id);
    }
  }

  if (uncached.length > 0) {
    const url = `${config.POLYMARKET_CLOB_URL}/prices`;
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_ids: uncached }),
    });
    const data = (await response.json()) as Record<string, number>;

    for (const [tokenId, price] of Object.entries(data)) {
      const p = typeof price === "string" ? parseFloat(price) : price;
      priceCache.set(`price:${tokenId}`, p, PRICE_CACHE_TTL);
      result.set(tokenId, p);
    }
  }

  return result;
}

export function invalidatePriceCache(tokenId: string) {
  priceCache.delete(`price:${tokenId}`);
}

// ─── Cache lookups ───────────────────────────────────────────────────────────

export function getCachedMarket(conditionId: string): GammaMarket | null {
  return marketCache.get(`market:${conditionId}`);
}

export function getCachedEvent(eventId: string): GammaEvent | null {
  return eventCache.get(`event:${eventId}`);
}
