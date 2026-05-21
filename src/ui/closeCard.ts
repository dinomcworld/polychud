import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { confirmClose } from "../interactions/customIds.js";
import { computeCloseQuote } from "../services/betting.js";
import { COLORS } from "./colors.js";
import { outcomeLabel, resolveOutcomeLabels } from "./outcomeLabels.js";

export interface ClosePreviewInput {
  betId: number;
  question: string;
  eventSlug: string | null;
  outcome: "yes" | "no";
  entryPrice: number;
  currentPrice: number;
  amount: number;
  yesLabel?: string | null;
  noLabel?: string | null;
  /** When true, render the "price refreshed" variant (different title + footer). */
  stale?: boolean;
  /** Confirm-button payload: callers pass the timestamp used in customId. */
  timestamp: number;
}

export function buildClosePreviewEmbed(input: ClosePreviewInput): EmbedBuilder {
  const { question, eventSlug, outcome, entryPrice, currentPrice, amount } =
    input;
  const { cashOut, profit, priceDelta } = computeCloseQuote(
    amount,
    entryPrice,
    currentPrice,
  );

  const marketLine = eventSlug
    ? `**Market:** [${question}](https://polymarket.com/event/${eventSlug})`
    : `**Market:** ${question}`;

  const labels = resolveOutcomeLabels(input.yesLabel, input.noLabel);
  const sideLabel = outcomeLabel(outcome, labels);

  const embed = new EmbedBuilder()
    .setTitle(
      input.stale ? "Price updated — confirm close?" : "Close bet early?",
    )
    .setColor(profit >= 0 ? COLORS.GREEN : COLORS.RED)
    .setDescription(
      [
        marketLine,
        `**Your bet:** ${sideLabel} at ${(entryPrice * 100).toFixed(1)}%`,
        `**Current price:** ${(currentPrice * 100).toFixed(1)}%`,
        "─".repeat(20),
        `**Staked:** ${amount.toLocaleString()} pts`,
        `**Return:** ${cashOut.toLocaleString()} pts (${profit >= 0 ? "+" : ""}${profit.toLocaleString()} profit)`,
        `**Price Δ:** ${priceDelta >= 0 ? "+" : ""}${(priceDelta * 100).toFixed(1)}%`,
      ].join("\n"),
    )
    .setTimestamp();

  if (input.stale) {
    embed.setFooter({ text: "Price was stale — refreshed" });
  }

  return embed;
}

export function buildClosePreviewComponents(
  betId: number,
  timestamp: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmClose.encode(betId, timestamp))
      .setLabel("Confirm Close")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("cancel_close")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}
