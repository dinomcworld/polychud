import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import {
  searchMarkets,
  getTrendingMarkets,
  getEventBySlug,
} from "../services/polymarket.js";
import {
  upsertEventWithMarkets,
  getMarketWithPrices,
  getEventWithMarkets,
  getEventByDbSlug,
} from "../services/markets.js";
import {
  buildMarketEmbed,
  buildMarketButtons,
  buildSearchResultsEmbed,
  buildSearchSelectMenu,
  type SearchResultItem,
} from "../ui/marketCard.js";
import {
  buildEventEmbed,
  buildEventSelectMenu,
  buildEventButtons,
  buildBackToEventButton,
  extractOutcomeLabel,
  type EventCardData,
  type EventOutcome,
} from "../ui/eventCard.js";
import { logger } from "../utils/logger.js";
import type { GammaEvent } from "../services/polymarket.js";

export const marketCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("market")
    .setDescription("Browse and search Polymarket prediction markets")
    .addSubcommand((sub) =>
      sub
        .setName("search")
        .setDescription("Search for a market")
        .addStringOption((opt) =>
          opt
            .setName("query")
            .setDescription("Search query")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("trending")
        .setDescription("Show trending markets by volume")
    )
    .addSubcommand((sub) =>
      sub
        .setName("view")
        .setDescription("View a market by Polymarket URL or ID")
        .addStringOption((opt) =>
          opt
            .setName("input")
            .setDescription(
              "Polymarket URL (e.g. polymarket.com/event/...) or market ID"
            )
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === "search") {
      await handleSearch(interaction);
    } else if (sub === "trending") {
      await handleTrending(interaction);
    } else if (sub === "view") {
      await handleView(interaction);
    }
  },
};

async function handleSearch(
  interaction: import("discord.js").ChatInputCommandInteraction
) {
  await interaction.deferReply();
  const query = interaction.options.getString("query", true);

  try {
    const gammaEvents = await searchMarkets(query);

    if (gammaEvents.length === 0) {
      await interaction.editReply({
        content: `No markets found for "${query}".`,
      });
      return;
    }

    // If single result, upsert just that one and show card directly
    if (gammaEvents.length === 1) {
      const event = gammaEvents[0]!;
      const { eventDbId, marketIdMap } = await upsertEventWithMarkets(event);

      if (event.markets.length > 1) {
        const eventData = buildEventCardFromGamma(event, eventDbId, marketIdMap);
        const hasHidden = eventData.outcomes.some(
          (o) => o.status === "resolved" || o.status === "closed"
        );
        const embed = buildEventEmbed(eventData);
        const selectMenu = buildEventSelectMenu(eventData);
        const buttons = buildEventButtons(
          eventDbId,
          event.slug,
          false,
          hasHidden
        );
        await interaction.editReply({
          embeds: [embed],
          components: [selectMenu, buttons],
        });
      } else if (event.markets.length === 1) {
        const m = event.markets[0]!;
        const dbId = marketIdMap.get(m.conditionId);
        if (dbId != null) {
          const market = await getMarketWithPrices(dbId, true);
          if (market) {
            const embed = buildMarketEmbed(marketToCardData(market, event.slug));
            const buttons = buildMarketButtons(
              market.id,
              market.slug,
              market.status === "active",
              event.slug
            );
            await interaction.editReply({
              embeds: [embed],
              components: [buttons],
            });
            return;
          }
        }
        await interaction.editReply({ content: "Market not found." });
      }
      return;
    }

    // Multiple results — build search items without DB upserts (cache only)
    const searchItems: SearchResultItem[] = [];
    for (const event of gammaEvents) {
      const eventStatus = event.closed
        ? "closed"
        : event.active
          ? "active"
          : "inactive";

      if (event.markets.length > 1) {
        const activeMarkets = event.markets.filter(
          (m) => m.active && !m.closed
        );
        const marketsToCheck =
          activeMarkets.length > 0 ? activeMarkets : event.markets;
        const frontrunner = marketsToCheck.reduce((best, m) => {
          const price = m.outcomePrices[0] ?? 0;
          return price > (best.outcomePrices[0] ?? 0) ? m : best;
        }, marketsToCheck[0]!);

        const frontrunnerLabel = extractOutcomeLabel(
          frontrunner.question,
          frontrunner.groupItemTitle
        );
        const pct = ((frontrunner.outcomePrices[0] ?? 0.5) * 100).toFixed(0);
        searchItems.push({
          conditionId: frontrunner.conditionId,
          question: event.title,
          yesPrice: frontrunner.outcomePrices[0] ?? 0.5,
          outcomeLabel: `${frontrunnerLabel} ${pct}% · ${event.markets.length} outcomes`,
          status: eventStatus,
        });
      } else if (event.markets.length === 1) {
        const m = event.markets[0]!;
        searchItems.push({
          conditionId: m.conditionId,
          question: m.question,
          yesPrice: m.outcomePrices[0] ?? 0.5,
          outcomeLabel: m.groupItemTitle || null,
          status: eventStatus,
        });
      }
    }

    const embed = buildSearchResultsEmbed(query, searchItems);
    const selectMenu = buildSearchSelectMenu(searchItems);
    await interaction.editReply({
      embeds: [embed],
      components: [selectMenu],
    });
  } catch (err) {
    logger.error("Market search failed:", err);
    await interaction.editReply({
      content: "Couldn't reach Polymarket right now. Try again in a moment.",
    });
  }
}

async function handleTrending(
  interaction: import("discord.js").ChatInputCommandInteraction
) {
  await interaction.deferReply();

  try {
    const events = await getTrendingMarkets(5);

    // Build search items without DB upserts (cache only)
    const searchItems: SearchResultItem[] = [];
    for (const event of events) {
      const eventStatus = event.closed
        ? "closed"
        : event.active
          ? "active"
          : "inactive";

      if (event.markets.length > 1) {
        const activeMarkets = event.markets.filter(
          (m) => m.active && !m.closed
        );
        const marketsToCheck =
          activeMarkets.length > 0 ? activeMarkets : event.markets;
        const frontrunner = marketsToCheck.reduce((best, m) => {
          const price = m.outcomePrices[0] ?? 0;
          return price > (best.outcomePrices[0] ?? 0) ? m : best;
        }, marketsToCheck[0]!);

        const frontrunnerLabel = extractOutcomeLabel(
          frontrunner.question,
          frontrunner.groupItemTitle
        );
        const pct = ((frontrunner.outcomePrices[0] ?? 0.5) * 100).toFixed(0);
        searchItems.push({
          conditionId: frontrunner.conditionId,
          question: event.title,
          yesPrice: frontrunner.outcomePrices[0] ?? 0.5,
          outcomeLabel: `${frontrunnerLabel} ${pct}% · ${event.markets.length} outcomes`,
          status: eventStatus,
        });
      } else {
        for (const m of event.markets) {
          searchItems.push({
            conditionId: m.conditionId,
            question: m.question,
            yesPrice: m.outcomePrices[0] ?? 0.5,
            outcomeLabel: m.groupItemTitle || null,
            status: eventStatus,
          });
        }
      }
    }

    if (searchItems.length === 0) {
      await interaction.editReply({ content: "No trending markets found." });
      return;
    }

    const embed = buildSearchResultsEmbed("Trending", searchItems);
    const selectMenu = buildSearchSelectMenu(searchItems);
    await interaction.editReply({
      embeds: [embed],
      components: [selectMenu],
    });
  } catch (err) {
    logger.error("Trending markets fetch failed:", err);
    await interaction.editReply({
      content: "Couldn't reach Polymarket right now. Try again in a moment.",
    });
  }
}

/**
 * Parse input: accepts Polymarket URLs or numeric DB IDs.
 * URLs like: polymarket.com/event/some-slug or https://polymarket.com/event/some-slug
 */
function parseViewInput(input: string): { type: "slug"; slug: string } | { type: "id"; id: number } | null {
  // Try to extract slug from URL
  const urlMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?polymarket\.com\/event\/([a-z0-9-]+)/i
  );
  if (urlMatch) {
    return { type: "slug", slug: urlMatch[1]! };
  }

  // Try as numeric ID
  const id = parseInt(input, 10);
  if (!isNaN(id) && id > 0) {
    return { type: "id", id };
  }

  // Try as bare slug (no URL prefix)
  if (/^[a-z0-9-]+$/i.test(input)) {
    return { type: "slug", slug: input };
  }

  return null;
}

async function handleView(
  interaction: import("discord.js").ChatInputCommandInteraction
) {
  await interaction.deferReply();
  const input = interaction.options.getString("input", true).trim();

  const parsed = parseViewInput(input);
  if (!parsed) {
    await interaction.editReply({
      content:
        "Invalid input. Use a Polymarket URL (e.g. `polymarket.com/event/some-slug`) or a market ID.",
    });
    return;
  }

  try {
    if (parsed.type === "slug") {
      await handleViewBySlug(interaction, parsed.slug);
    } else {
      await handleViewById(interaction, parsed.id);
    }
  } catch (err) {
    logger.error("Market view failed:", err);
    await interaction.editReply({
      content: "Couldn't load that market. Try again in a moment.",
    });
  }
}

async function handleViewBySlug(
  interaction: import("discord.js").ChatInputCommandInteraction,
  slug: string
) {
  // Try Gamma API first
  const gammaEvent = await getEventBySlug(slug);

  if (gammaEvent) {
    const { eventDbId, marketIdMap } = await upsertEventWithMarkets(gammaEvent);

    if (gammaEvent.markets.length > 1) {
      // Multi-outcome — show event card
      const eventData = buildEventCardFromGamma(
        gammaEvent,
        eventDbId,
        marketIdMap
      );
      const hasHidden = eventData.outcomes.some(
        (o) => o.status === "resolved" || o.status === "closed"
      );
      const embed = buildEventEmbed(eventData);
      const selectMenu = buildEventSelectMenu(eventData);
      const buttons = buildEventButtons(
        eventDbId,
        gammaEvent.slug,
        false,
        hasHidden
      );
      await interaction.editReply({
        embeds: [embed],
        components: [selectMenu, buttons],
      });
      return;
    }

    // Single market — show binary card
    const m = gammaEvent.markets[0];
    if (m) {
      const dbId = marketIdMap.get(m.conditionId);
      if (dbId != null) {
        const market = await getMarketWithPrices(dbId, true);
        if (market) {
          const embed = buildMarketEmbed(
            marketToCardData(market, gammaEvent.slug)
          );
          const buttons = buildMarketButtons(
            market.id,
            market.slug,
            market.status === "active",
            gammaEvent.slug
          );
          await interaction.editReply({
            embeds: [embed],
            components: [buttons],
          });
          return;
        }
      }
    }
  }

  // Fallback: check DB
  const dbEvent = await getEventByDbSlug(slug);
  if (!dbEvent || dbEvent.markets.length === 0) {
    await interaction.editReply({
      content: `Event "${slug}" not found. Check the URL and try again.`,
    });
    return;
  }

  const eventData = buildEventCardFromDb(dbEvent);
  const hasHidden = eventData.outcomes.some(
    (o) => o.status === "resolved" || o.status === "closed"
  );

  if (dbEvent.markets.length > 1) {
    const embed = buildEventEmbed(eventData);
    const selectMenu = buildEventSelectMenu(eventData);
    const buttons = buildEventButtons(
      dbEvent.id,
      dbEvent.slug,
      false,
      hasHidden
    );
    await interaction.editReply({
      embeds: [embed],
      components: [selectMenu, buttons],
    });
  } else {
    const market = await getMarketWithPrices(dbEvent.markets[0]!.id, true);
    if (!market) {
      await interaction.editReply({ content: "Market not found." });
      return;
    }
    const embed = buildMarketEmbed(marketToCardData(market, dbEvent.slug));
    const buttons = buildMarketButtons(
      market.id,
      market.slug,
      market.status === "active",
      dbEvent.slug
    );
    await interaction.editReply({
      embeds: [embed],
      components: [buttons],
    });
  }
}

async function handleViewById(
  interaction: import("discord.js").ChatInputCommandInteraction,
  marketId: number
) {
  const market = await getMarketWithPrices(marketId, true);
  if (!market) {
    await interaction.editReply({
      content: `Market #${marketId} not found. Use \`/market search\` first.`,
    });
    return;
  }

  let eventSlug: string | null = null;
  if (market.eventId) {
    const event = await getEventWithMarkets(market.eventId);
    if (event) {
      eventSlug = event.slug;
      if (event.markets.length > 1) {
        const embed = buildMarketEmbed(marketToCardData(market, eventSlug));
        const buttons = buildMarketButtons(
          market.id,
          market.slug,
          market.status === "active",
          eventSlug
        );
        buttons.addComponents(buildBackToEventButton(event.id));
        await interaction.editReply({
          embeds: [embed],
          components: [buttons],
        });
        return;
      }
    }
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function marketToCardData(
  market: {
    id: number;
    question: string;
    slug: string | null;
    currentYesPrice: string | null;
    currentNoPrice: string | null;
    volume24h: string | null;
    endDate: Date | null;
    status: string;
    outcomeLabel: string | null;
    eventId: number | null;
  },
  eventSlug?: string | null
) {
  return {
    dbId: market.id,
    question: market.question,
    slug: market.slug,
    eventSlug: eventSlug ?? null,
    yesPrice: parseFloat(market.currentYesPrice || "0.5"),
    noPrice: parseFloat(market.currentNoPrice || "0.5"),
    volume24h: market.volume24h,
    endDate: market.endDate,
    imageUrl: null as string | null,
    status: market.status,
    outcomeLabel: market.outcomeLabel,
  };
}

function buildEventCardFromGamma(
  gamma: GammaEvent,
  eventDbId: number,
  marketIdMap: Map<string, number>
): EventCardData {
  const outcomes: EventOutcome[] = [];
  for (const m of gamma.markets) {
    const dbId = marketIdMap.get(m.conditionId);
    if (dbId != null) {
      const mStatus = m.closed ? "closed" : m.active ? "active" : "inactive";
      outcomes.push({
        marketDbId: dbId,
        label: extractOutcomeLabel(m.question, m.groupItemTitle),
        yesPrice: m.outcomePrices[0] ?? 0.5,
        status: mStatus,
        endDate: m.endDate ? new Date(m.endDate) : null,
      });
    }
  }

  return {
    eventDbId,
    title: gamma.title,
    slug: gamma.slug,
    imageUrl: gamma.image || gamma.icon || null,
    endDate: gamma.endDate ? new Date(gamma.endDate) : null,
    status: gamma.closed ? "closed" : gamma.active ? "active" : "inactive",
    volume24h: gamma.volume24hr ?? null,
    outcomes,
  };
}

function buildEventCardFromDb(event: {
  id: number;
  title: string;
  slug: string | null;
  imageUrl: string | null;
  endDate: Date | null;
  status: string;
  markets: Array<{
    id: number;
    question: string;
    outcomeLabel: string | null;
    currentYesPrice: string | null;
    volume24h: string | null;
    status: string;
    endDate: Date | null;
  }>;
}): EventCardData {
  const outcomes: EventOutcome[] = event.markets.map((m) => ({
    marketDbId: m.id,
    label: extractOutcomeLabel(m.question, m.outcomeLabel),
    yesPrice: parseFloat(m.currentYesPrice || "0.5"),
    status: m.status,
    endDate: m.endDate,
  }));

  const totalVolume = event.markets.reduce((sum, m) => {
    return sum + (m.volume24h ? parseFloat(m.volume24h) : 0);
  }, 0);

  return {
    eventDbId: event.id,
    title: event.title,
    slug: event.slug,
    imageUrl: event.imageUrl,
    endDate: event.endDate,
    status: event.status,
    volume24h: totalVolume > 0 ? totalVolume : null,
    outcomes,
  };
}

export { marketToCardData, buildEventCardFromDb, buildEventCardFromGamma };
