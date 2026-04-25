import { SlashCommandBuilder } from "discord.js";
import {
  getEventById,
  getEventBySlug,
  getTrendingMarkets,
  searchMarkets,
} from "../services/polymarket.js";
import {
  buildEventButtons,
  buildEventCardFromGamma,
  buildEventEmbed,
  buildEventSelectMenu,
  eventsToSearchItems,
} from "../ui/eventCard.js";
import {
  buildMarketButtons,
  buildMarketEmbed,
  buildSearchControlsRow,
  buildSearchResultsEmbed,
  buildSearchSelectMenu,
  buildTrendingControlsRow,
  computeSearchPages,
  gammaMarketToCardData,
} from "../ui/marketCard.js";
import { logger } from "../utils/logger.js";
import type { Command } from "./types.js";

export const marketCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("market")
    .setDescription("Browse and search Polymarket prediction markets")
    .addSubcommand((sub) =>
      sub
        .setName("search")
        .setDescription("Search for a market")
        .addStringOption((opt) =>
          opt.setName("query").setDescription("Search query").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("trending").setDescription("Show trending markets by volume"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("view")
        .setDescription("View a market by Polymarket URL or ID")
        .addStringOption((opt) =>
          opt
            .setName("input")
            .setDescription(
              "Polymarket URL (e.g. polymarket.com/event/...) or market ID",
            )
            .setRequired(true),
        ),
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
  interaction: import("discord.js").ChatInputCommandInteraction,
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

    // If single result, show card directly (no DB write)
    if (gammaEvents.length === 1) {
      const [event] = gammaEvents;
      if (!event) return;

      if (event.markets.length > 1) {
        const eventData = buildEventCardFromGamma(event);
        const hasHidden = eventData.outcomes.some(
          (o) => o.status === "resolved" || o.status === "closed",
        );
        const embed = buildEventEmbed(eventData);
        const selectMenu = buildEventSelectMenu(eventData);
        const buttons = buildEventButtons(
          event.id,
          event.slug,
          false,
          hasHidden,
        );
        await interaction.editReply({
          embeds: [embed],
          components: [selectMenu, buttons],
        });
      } else if (event.markets.length === 1) {
        const [m] = event.markets;
        if (!m) return;
        const cardData = gammaMarketToCardData(m, event.slug);
        const embed = buildMarketEmbed(cardData);
        const buttons = buildMarketButtons(
          m.conditionId,
          m.slug,
          m.active && !m.closed,
          event.slug,
        );
        await interaction.editReply({
          embeds: [embed],
          components: [buttons],
        });
      }
      return;
    }

    const searchItems = eventsToSearchItems(gammaEvents);
    const hasResolved = searchItems.some(
      (r) => r.status === "resolved" || r.status === "closed",
    );
    const totalPages = computeSearchPages(searchItems, false);
    const embed = buildSearchResultsEmbed(query, searchItems, false, 0);
    const selectMenu = buildSearchSelectMenu(searchItems, false, 0);
    const controls = buildSearchControlsRow(
      query,
      false,
      hasResolved,
      0,
      totalPages,
    );
    await interaction.editReply({
      embeds: [embed],
      components: controls ? [selectMenu, controls] : [selectMenu],
    });
  } catch (err) {
    logger.error("Market search failed:", err);
    await interaction.editReply({
      content: "Couldn't reach Polymarket right now. Try again in a moment.",
    });
  }
}

export const TRENDING_LIMIT = 50;

export async function renderTrendingView(page = 0) {
  const events = await getTrendingMarkets(TRENDING_LIMIT);
  const searchItems = eventsToSearchItems(events);

  if (searchItems.length === 0) {
    return null;
  }

  const totalPages = computeSearchPages(searchItems, false);
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const embed = buildSearchResultsEmbed(
    "Trending",
    searchItems,
    false,
    safePage,
  );
  const selectMenu = buildSearchSelectMenu(searchItems, false, safePage);
  const controls = buildTrendingControlsRow(safePage, totalPages);
  return {
    embeds: [embed],
    components: controls ? [selectMenu, controls] : [selectMenu],
  };
}

async function handleTrending(
  interaction: import("discord.js").ChatInputCommandInteraction,
) {
  await interaction.deferReply();

  try {
    const view = await renderTrendingView(0);
    if (!view) {
      await interaction.editReply({ content: "No trending markets found." });
      return;
    }
    await interaction.editReply(view);
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
function parseViewInput(
  input: string,
): { type: "slug"; slug: string } | { type: "id"; id: number } | null {
  // Try to extract slug from URL
  const urlMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?polymarket\.com\/event\/([a-z0-9-]+)/i,
  );
  if (urlMatch?.[1]) {
    return { type: "slug", slug: urlMatch[1] };
  }

  // Try as numeric ID
  const id = parseInt(input, 10);
  if (!Number.isNaN(id) && id > 0) {
    return { type: "id", id };
  }

  // Try as bare slug (no URL prefix)
  if (/^[a-z0-9-]+$/i.test(input)) {
    return { type: "slug", slug: input };
  }

  return null;
}

async function handleView(
  interaction: import("discord.js").ChatInputCommandInteraction,
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
  slug: string,
) {
  // Fetch from Gamma API (no DB write)
  const gammaEvent = await getEventBySlug(slug);

  if (!gammaEvent) {
    await interaction.editReply({
      content: `Event "${slug}" not found. Check the URL and try again.`,
    });
    return;
  }

  if (gammaEvent.markets.length > 1) {
    const eventData = buildEventCardFromGamma(gammaEvent);
    const hasHidden = eventData.outcomes.some(
      (o) => o.status === "resolved" || o.status === "closed",
    );
    const embed = buildEventEmbed(eventData);
    const selectMenu = buildEventSelectMenu(eventData);
    const buttons = buildEventButtons(
      gammaEvent.id,
      gammaEvent.slug,
      false,
      hasHidden,
    );
    await interaction.editReply({
      embeds: [embed],
      components: [selectMenu, buttons],
    });
  } else if (gammaEvent.markets.length === 1) {
    const [m] = gammaEvent.markets;
    if (!m) return;
    const cardData = gammaMarketToCardData(m, gammaEvent.slug);
    const embed = buildMarketEmbed(cardData);
    const buttons = buildMarketButtons(
      m.conditionId,
      m.slug,
      m.active && !m.closed,
      gammaEvent.slug,
    );
    await interaction.editReply({
      embeds: [embed],
      components: [buttons],
    });
  } else {
    await interaction.editReply({
      content: `Event "${slug}" has no markets.`,
    });
  }
}

async function handleViewById(
  interaction: import("discord.js").ChatInputCommandInteraction,
  polyEventId: number,
) {
  const gammaEvent = await getEventById(String(polyEventId));
  if (!gammaEvent) {
    await interaction.editReply({
      content: `Event #${polyEventId} not found on Polymarket.`,
    });
    return;
  }

  if (gammaEvent.markets.length > 1) {
    const eventData = buildEventCardFromGamma(gammaEvent);
    const hasHidden = eventData.outcomes.some(
      (o) => o.status === "resolved" || o.status === "closed",
    );
    const embed = buildEventEmbed(eventData);
    const selectMenu = buildEventSelectMenu(eventData);
    const buttons = buildEventButtons(
      gammaEvent.id,
      gammaEvent.slug,
      false,
      hasHidden,
    );
    await interaction.editReply({
      embeds: [embed],
      components: [selectMenu, buttons],
    });
  } else if (gammaEvent.markets.length === 1) {
    const [m] = gammaEvent.markets;
    if (!m) return;
    const cardData = gammaMarketToCardData(m, gammaEvent.slug);
    const embed = buildMarketEmbed(cardData);
    const buttons = buildMarketButtons(
      m.conditionId,
      m.slug,
      m.active && !m.closed,
      gammaEvent.slug,
    );
    await interaction.editReply({
      embeds: [embed],
      components: [buttons],
    });
  } else {
    await interaction.editReply({
      content: `Event #${polyEventId} has no markets.`,
    });
  }
}
