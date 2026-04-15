import type { StringSelectMenuInteraction } from "discord.js";
import { logger } from "../utils/logger.js";
import {
  getMarketWithPrices,
  getEventWithMarkets,
  upsertEventWithMarkets,
  upsertStandaloneMarket,
} from "../services/markets.js";
import {
  getCachedMarket,
  getMarketByConditionId,
} from "../services/polymarket.js";
import { buildMarketEmbed, buildMarketButtons } from "../ui/marketCard.js";
import {
  marketToCardData,
  buildEventCardFromGamma,
} from "../commands/market.js";
import {
  buildEventEmbed,
  buildEventSelectMenu,
  buildEventButtons,
  buildBackToEventButton,
} from "../ui/eventCard.js";

export async function handleSelectMenu(
  interaction: StringSelectMenuInteraction
) {
  const id = interaction.customId;

  if (id === "market_select") {
    await handleMarketSelect(interaction);
  } else if (id.startsWith("event_select_")) {
    await handleEventSelect(interaction);
  } else {
    await interaction.reply({
      content: "This menu isn't implemented yet.",
      ephemeral: true,
    });
  }
}

async function handleMarketSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();

  const conditionId = interaction.values[0]!;

  try {
    // Look up from in-memory cache first, then fetch from API
    let gamma = getCachedMarket(conditionId);
    if (!gamma) {
      gamma = await getMarketByConditionId(conditionId);
    }

    if (!gamma) {
      await interaction.followUp({
        content: "Market not found. The cache may have expired — try searching again.",
        ephemeral: true,
      });
      return;
    }

    // If this market belongs to a multi-outcome event, show the event card
    const parentEvent = gamma.events?.[0];
    if (parentEvent && parentEvent.markets.length > 1) {
      // Upsert only this event to DB (needed for bet/refresh buttons)
      const { eventDbId, marketIdMap } = await upsertEventWithMarkets(parentEvent);
      const eventData = buildEventCardFromGamma(parentEvent, eventDbId, marketIdMap);
      const hasHidden = eventData.outcomes.some(
        (o) => o.status === "resolved" || o.status === "closed"
      );
      const embed = buildEventEmbed(eventData);
      const selectMenu = buildEventSelectMenu(eventData);
      const buttons = buildEventButtons(
        eventDbId,
        parentEvent.slug,
        false,
        hasHidden
      );
      await interaction.editReply({
        embeds: [embed],
        components: [selectMenu, buttons],
      });
      return;
    }

    // Single market — upsert just this one, then show binary card
    const dbId = await upsertStandaloneMarket(gamma);
    const market = await getMarketWithPrices(dbId, true);
    if (!market) {
      await interaction.followUp({
        content: "Market not found.",
        ephemeral: true,
      });
      return;
    }

    let eventSlug: string | null = null;
    if (market.eventId) {
      const event = await getEventWithMarkets(market.eventId);
      if (event) eventSlug = event.slug;
    }

    const embed = buildMarketEmbed(marketToCardData(market, eventSlug));
    const buttons = buildMarketButtons(
      market.id,
      market.slug,
      market.status === "active",
      eventSlug
    );

    await interaction.editReply({
      embeds: [embed],
      components: [buttons],
    });
  } catch (err) {
    logger.error("Market select failed:", err);
    await interaction.followUp({
      content: "Couldn't load that market. Try again.",
      ephemeral: true,
    });
  }
}

async function handleEventSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();

  const eventDbId = parseInt(interaction.customId.split("_")[2]!, 10);
  const marketId = parseInt(interaction.values[0]!, 10);

  try {
    const market = await getMarketWithPrices(marketId, true);
    if (!market) {
      await interaction.followUp({
        content: "Market not found.",
        ephemeral: true,
      });
      return;
    }

    let eventSlug: string | null = null;
    const event = await getEventWithMarkets(eventDbId);
    if (event) eventSlug = event.slug;

    const embed = buildMarketEmbed(marketToCardData(market, eventSlug));
    const buttons = buildMarketButtons(
      market.id,
      market.slug,
      market.status === "active",
      eventSlug
    );
    buttons.addComponents(buildBackToEventButton(eventDbId));

    await interaction.editReply({
      embeds: [embed],
      components: [buttons],
    });
  } catch (err) {
    logger.error("Event select failed:", err);
    await interaction.followUp({
      content: "Couldn't load that market. Try again.",
      ephemeral: true,
    });
  }
}
