import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { GammaMarket } from "./polymarket.js";

interface CacheEntry {
  data: string;
  expiresAt: number;
}

const summaryCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string | null>>();

const SYSTEM_PROMPT = `You are a summarizer for Polymarket market descriptions. Your job is to extract only what a trader needs to make a decision, nothing more.

Output format (use this exact structure, no extra commentary):
- YES if: [the core condition that resolves YES, in one sentence]
- NO if: [the core condition that resolves NO, in one sentence]
- Deadline: [date and time, including timezone]
- Key rules: [1-3 bullet points covering edge cases, exclusions, or unusual triggers that could surprise a trader — only include if they materially change the outcome]
- Source: [resolution source in a few words]

Rules:
- Be ruthlessly concise. No filler, no restating the question, no disclaimers.
- Preserve exact dates, times, timezones, thresholds, and numbers.
- Keep edge cases that flip the outcome (e.g. "announcement counts even if effective later", "temporary actions don't count"). Drop boilerplate.
- If the description is ambiguous or missing a field, write "not specified" for that field.
- Never add information not in the description. Never speculate on probability or give trading advice.`;

function isEnabled(): boolean {
  return Boolean(
    config.OPENROUTER_API_KEY && config.OPENROUTER_MODEL.length > 0,
  );
}

export function getCachedMarketSummary(conditionId: string): string | null {
  const entry = summaryCache.get(conditionId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    summaryCache.delete(conditionId);
    return null;
  }
  return entry.data;
}

export async function getMarketSummary(
  market: GammaMarket,
): Promise<string | null> {
  if (!isEnabled()) return null;
  if (!market.description?.trim()) return null;

  const cached = getCachedMarketSummary(market.conditionId);
  if (cached) return cached;

  const existing = inFlight.get(market.conditionId);
  if (existing) return existing;

  const promise = fetchSummaryFromOpenRouter(market).finally(() => {
    inFlight.delete(market.conditionId);
  });
  inFlight.set(market.conditionId, promise);

  const summary = await promise;
  if (summary) {
    summaryCache.set(market.conditionId, {
      data: summary,
      expiresAt: Date.now() + config.AI_SUMMARY_CACHE_TTL_MS,
    });
  }
  return summary;
}

async function fetchSummaryFromOpenRouter(
  market: GammaMarket,
): Promise<string | null> {
  const apiKey = config.OPENROUTER_API_KEY;
  const models = config.OPENROUTER_MODEL;
  if (!apiKey || models.length === 0) return null;

  const userContent = `Question: ${market.question}\n\nDescription:\n${market.description}`;

  for (const model of models) {
    const result = await tryModel(
      apiKey,
      model,
      userContent,
      market.conditionId,
    );
    if (result.kind === "ok") return result.content;
    if (result.kind === "empty") return null;
    if (result.kind === "error") return null;
    // rate_limited | truncated: fall through to the next fallback model.
  }

  logger.warn(
    `OpenRouter all ${models.length} model(s) exhausted (rate-limited or truncated) for ${market.conditionId}`,
  );
  return null;
}

type ModelResult =
  | { kind: "ok"; content: string }
  | { kind: "empty" }
  | { kind: "rate_limited" }
  | { kind: "truncated" }
  | { kind: "error" };

async function tryModel(
  apiKey: string,
  model: string,
  userContent: string,
  conditionId: string,
): Promise<ModelResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const startedAt = Date.now();

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0.2,
          // Generous cap: some free models mandate reasoning and count those
          // tokens toward max_tokens, so we need headroom for thinking +
          // the ~300-token visible answer. Disabling reasoning is not an
          // option — those endpoints 400 on `reasoning.enabled: false`.
          max_tokens: 2500,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }),
      },
    );

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      logger.warn(
        `OpenRouter ${response.status} (${durationMs}ms) model=${model} for ${conditionId}: ${body.slice(0, 200)}`,
      );
      if (response.status === 429) return { kind: "rate_limited" };
      return { kind: "error" };
    }

    const json = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
    };
    const choice = json.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (!content) {
      logger.warn(
        `OpenRouter empty content (${durationMs}ms) model=${model} for ${conditionId}`,
      );
      return { kind: "empty" };
    }

    if (choice?.finish_reason === "length") {
      logger.warn(
        `OpenRouter truncated by max_tokens (${durationMs}ms) model=${model} for ${conditionId} (${content.length}b) — trying next model`,
      );
      return { kind: "truncated" };
    }

    logger.debug(
      `OpenRouter ok (${durationMs}ms) model=${model} for ${conditionId} (${content.length}b finish=${choice?.finish_reason ?? "?"})`,
    );
    return { kind: "ok", content };
  } catch (err) {
    logger.warn(
      `OpenRouter call failed model=${model} for ${conditionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "error" };
  } finally {
    clearTimeout(timeout);
  }
}
