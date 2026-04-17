import { MessageFlags, type StringSelectMenuInteraction } from "discord.js";
import {
  buildEventCardFromGamma,
  gammaMarketToCardData,
} from "../commands/market.js";
import {
  getCachedMarket,
  getMarketByConditionId,
} from "../services/polymarket.js";
import {
  buildBackToEventButton,
  buildEventButtons,
  buildEventEmbed,
  buildEventSelectMenu,
} from "../ui/eventCard.js";
import { buildMarketButtons, buildMarketEmbed } from "../ui/marketCard.js";
import { logger } from "../utils/logger.js";

export async function handleSelectMenu(
  interaction: StringSelectMenuInteraction,
) {
  const id = interaction.customId;

  logger.debug(
    `select: user=${interaction.user.id} guild=${interaction.guildId ?? "dm"} customId=${id} values=${JSON.stringify(interaction.values)}`,
  );

  if (id === "market_select") {
    await handleMarketSelect(interaction);
  } else if (id.startsWith("event_select_")) {
    await handleEventSelect(interaction);
  } else {
    await interaction.reply({
      content: "This menu isn't implemented yet.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleMarketSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();

  const conditionId = interaction.values[0];
  if (!conditionId) return;

  try {
    // Look up from in-memory cache first, then fetch from API
    let gamma = getCachedMarket(conditionId);
    if (!gamma) {
      gamma = await getMarketByConditionId(conditionId);
    }

    if (!gamma) {
      await interaction.followUp({
        content:
          "Market not found. The cache may have expired — try searching again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // If this market belongs to a multi-outcome event, show the event card
    const parentEvent = gamma.events?.[0];
    if (parentEvent && parentEvent.markets.length > 1) {
      const eventData = buildEventCardFromGamma(parentEvent);
      const hasHidden = eventData.outcomes.some(
        (o) => o.status === "resolved" || o.status === "closed",
      );
      const embed = buildEventEmbed(eventData);
      const selectMenu = buildEventSelectMenu(eventData);
      const buttons = buildEventButtons(
        parentEvent.id,
        parentEvent.slug,
        false,
        hasHidden,
      );
      await interaction.editReply({
        embeds: [embed],
        components: [selectMenu, buttons],
      });
      return;
    }

    // Single market — show binary card
    const eventSlug = gamma.events?.[0]?.slug ?? null;
    const cardData = gammaMarketToCardData(gamma, eventSlug);
    const embed = buildMarketEmbed(cardData);
    const buttons = buildMarketButtons(
      gamma.conditionId,
      gamma.slug,
      gamma.active && !gamma.closed,
      eventSlug,
    );

    await interaction.editReply({
      embeds: [embed],
      components: [buttons],
    });
  } catch (err) {
    logger.error("Market select failed:", err);
    await interaction.followUp({
      content: "Couldn't load that market. Try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleEventSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();

  // event_select_{polyEventId}
  const polyEventId = interaction.customId.split("_")[2];
  const conditionId = interaction.values[0];
  if (!polyEventId || !conditionId) return;

  try {
    // Fetch market from cache or API
    let gamma = getCachedMarket(conditionId);
    if (!gamma) {
      gamma = await getMarketByConditionId(conditionId);
    }

    if (!gamma) {
      await interaction.followUp({
        content: "Market not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const eventSlug = gamma.events?.[0]?.slug ?? null;
    const cardData = gammaMarketToCardData(gamma, eventSlug);
    const embed = buildMarketEmbed(cardData);
    const buttons = buildMarketButtons(
      gamma.conditionId,
      gamma.slug,
      gamma.active && !gamma.closed,
      eventSlug,
      polyEventId,
    );
    buttons.addComponents(buildBackToEventButton(polyEventId));

    await interaction.editReply({
      embeds: [embed],
      components: [buttons],
    });
  } catch (err) {
    logger.error("Event select failed:", err);
    await interaction.followUp({
      content: "Couldn't load that market. Try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}
