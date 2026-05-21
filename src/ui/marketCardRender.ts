import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import {
  getCachedMarketSummary,
  getMarketSummary,
} from "../services/aiSummary.js";
import type { GammaMarket } from "../services/polymarket.js";
import { logger } from "../utils/logger.js";
import { buildBackToEventButton } from "./eventCard.js";
import {
  buildMarketButtons,
  buildMarketEmbed,
  gammaMarketToCardData,
} from "./marketCard.js";

type RenderableInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction;

export interface RenderMarketCardOptions {
  eventSlug?: string | null;
  polyEventId?: string | null;
  /** Append "Back to Event" button (and use polyEventId on refresh/chart buttons). */
  includeBackToEvent?: boolean;
  /** Pass `files: []` on editReply — needed when editing away from a chart. */
  clearFiles?: boolean;
}

/**
 * Render a market card with a two-phase update for AI summary:
 *   1. Synchronously include the cached summary if any, and editReply.
 *   2. If no cache hit, fire-and-forget an async fetch and editReply again
 *      when the summary lands. Failures are silent — the card without summary
 *      remains as the user's final view.
 */
export async function renderMarketCardWithSummary(
  interaction: RenderableInteraction,
  gamma: GammaMarket,
  options: RenderMarketCardOptions = {},
): Promise<void> {
  const eventSlug = options.eventSlug ?? null;
  const polyEventId = options.polyEventId ?? null;
  const cardData = gammaMarketToCardData(gamma, eventSlug);

  const buttons = buildMarketButtons(
    gamma.conditionId,
    gamma.slug,
    gamma.active && !gamma.closed,
    eventSlug,
    polyEventId,
    cardData.yesLabel,
    cardData.noLabel,
  );
  if (options.includeBackToEvent && polyEventId) {
    buttons.addComponents(buildBackToEventButton(polyEventId));
  }

  const cached = getCachedMarketSummary(gamma.conditionId);
  const initialEmbed = buildMarketEmbed({ ...cardData, summary: cached });

  const basePayload = {
    embeds: [initialEmbed],
    components: [buttons],
    ...(options.clearFiles ? { files: [] } : {}),
  };
  await interaction.editReply(basePayload);

  if (cached) return;

  void (async () => {
    const summary = await getMarketSummary(gamma);
    if (!summary) return;
    const updated = buildMarketEmbed({ ...cardData, summary });
    try {
      await interaction.editReply({
        embeds: [updated],
        components: [buttons],
        ...(options.clearFiles ? { files: [] } : {}),
      });
    } catch (err) {
      logger.warn(
        `AI summary editReply failed for ${gamma.conditionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}
