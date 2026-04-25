import {
  ActionRowBuilder,
  type ButtonInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { buildLeaderboardView } from "../commands/leaderboard.js";
import { renderTrendingView } from "../commands/market.js";
import { config } from "../config.js";
import {
  closeBet,
  getBetById,
  getUserActiveBets,
  getUserSettledBets,
  placeBet,
} from "../services/betting.js";
import { upsertStandaloneMarket } from "../services/markets.js";
import {
  getCachedMarket,
  getEventById,
  getMarketByConditionId,
  getMidpointPrice,
  searchMarkets,
} from "../services/polymarket.js";
import { ensureUser, getUserStats } from "../services/users.js";
import { buildBetListView } from "../ui/betList.js";
import {
  buildClosePreviewComponents,
  buildClosePreviewEmbed,
} from "../ui/closeCard.js";
import {
  buildBackToEventButton,
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
  computeSearchPages,
  escapeMarkdown,
  gammaMarketToCardData,
} from "../ui/marketCard.js";
import { buildPortfolioView } from "../ui/portfolio.js";
import {
  rememberMarketMessage,
  takeMarketMessage,
} from "../utils/betContext.js";
import { requireGuildId } from "../utils/guards.js";
import { logger } from "../utils/logger.js";
import {
  betModal,
  betsPage,
  betsToggle,
  confirmBet,
  confirmClose,
  portfolioPage,
  portfolioRefresh,
  portfolioToggle,
  searchPage,
  searchResolvedToggle,
} from "./customIds.js";

export async function handleButton(interaction: ButtonInteraction) {
  const id = interaction.customId;

  logger.debug(
    `button: user=${interaction.user.id} guild=${interaction.guildId ?? "dm"} customId=${id}`,
  );

  // Order matters: longer prefixes (e.g. confirm_close_) must come before
  // their shorter shadows (confirm_) since startsWith is order-dependent.
  if (id.startsWith("bet_yes_") || id.startsWith("bet_no_")) {
    await handleBetButton(interaction);
  } else if (id.startsWith("refresh_event_")) {
    await handleRefreshEvent(interaction);
  } else if (id.startsWith("refresh_")) {
    await handleRefresh(interaction);
  } else if (id.startsWith(confirmClose.prefix)) {
    await handleConfirmClose(interaction);
  } else if (id.startsWith(confirmBet.prefix)) {
    await handleConfirm(interaction);
  } else if (id.startsWith("close_bet_")) {
    await handleCloseBet(interaction);
  } else if (id.startsWith(betsPage.prefix)) {
    await handleBetsPage(interaction);
  } else if (id.startsWith(betsToggle.prefix)) {
    await handleBetsToggle(interaction);
  } else if (id.startsWith(portfolioPage.prefix)) {
    await handlePortfolioPage(interaction);
  } else if (id.startsWith(portfolioRefresh.prefix)) {
    await handlePortfolioRefresh(interaction);
  } else if (id.startsWith(portfolioToggle.prefix)) {
    await handlePortfolioToggle(interaction);
  } else if (id.startsWith("leaderboard_refresh_")) {
    await handleLeaderboardRefresh(interaction);
  } else if (
    id.startsWith(searchResolvedToggle.showPrefix) ||
    id.startsWith(searchResolvedToggle.hidePrefix)
  ) {
    await handleToggleSearchResolved(interaction);
  } else if (id.startsWith(searchPage.prefix)) {
    await handleSearchPage(interaction);
  } else if (id.startsWith("trending_page_")) {
    await handleTrendingPage(interaction);
  } else if (
    id.startsWith("show_resolved_") ||
    id.startsWith("hide_resolved_")
  ) {
    await handleToggleResolved(interaction);
  } else if (id.startsWith("back_event_")) {
    await handleBackToEvent(interaction);
  } else if (id === "cancel_bet" || id === "cancel_close") {
    await interaction.update({
      content: "Cancelled.",
      embeds: [],
      components: [],
    });
  } else {
    await interaction.reply({
      content: "This button isn't implemented yet.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleBetButton(interaction: ButtonInteraction) {
  // bet_yes_{conditionId} or bet_no_{conditionId}
  const [, outcome, conditionId] = interaction.customId.split("_") as [
    string,
    "yes" | "no",
    string,
  ];

  rememberMarketMessage(
    interaction.user.id,
    conditionId,
    outcome,
    interaction.channelId,
    interaction.message.id,
  );

  const modal = new ModalBuilder()
    .setCustomId(betModal.encode(conditionId, outcome))
    .setTitle(`Place a ${outcome.toUpperCase()} bet`);

  const amountInput = new TextInputBuilder()
    .setCustomId("bet_amount")
    .setLabel("Amount (points)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("e.g., 100")
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(10);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput),
  );

  await interaction.showModal(modal);
}

async function handleRefresh(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  // refresh_{conditionId} or refresh_{conditionId}_evt{polyEventId}
  const raw = interaction.customId.slice("refresh_".length);
  const evtIdx = raw.indexOf("_evt");
  const conditionId = evtIdx >= 0 ? raw.slice(0, evtIdx) : raw;
  const polyEventId = evtIdx >= 0 ? raw.slice(evtIdx + 4) : null;

  try {
    // If within an event, fetch the event to get proper market context
    if (polyEventId) {
      const gammaEvent = await getEventById(polyEventId);
      if (gammaEvent) {
        const gamma = gammaEvent.markets.find(
          (m) => m.conditionId === conditionId,
        );
        if (gamma) {
          const cardData = gammaMarketToCardData(gamma, gammaEvent.slug);
          const embed = buildMarketEmbed(cardData);
          const buttons = buildMarketButtons(
            gamma.conditionId,
            gamma.slug,
            gamma.active && !gamma.closed,
            gammaEvent.slug,
            gammaEvent.id,
          );
          buttons.addComponents(buildBackToEventButton(gammaEvent.id));
          await interaction.editReply({
            embeds: [embed],
            components: [buttons],
          });
          return;
        }
      }
    }

    // Standalone market refresh
    const gamma = await getMarketByConditionId(conditionId);
    if (!gamma) {
      await interaction.followUp({
        content: "Market not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const eventSlug = gamma.events?.[0]?.slug ?? null;
    const eventId = gamma.events?.[0]?.id ?? null;
    const cardData = gammaMarketToCardData(gamma, eventSlug);
    const embed = buildMarketEmbed(cardData);
    const buttons = buildMarketButtons(
      gamma.conditionId,
      gamma.slug,
      gamma.active && !gamma.closed,
      eventSlug,
      eventId,
    );
    await interaction.editReply({
      embeds: [embed],
      components: [buttons],
    });
  } catch (err) {
    logger.error("Refresh failed:", err);
    await interaction.followUp({
      content: "Couldn't refresh prices. Try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleRefreshEvent(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  // refresh_event_{polyEventId}
  const polyEventId = interaction.customId.slice("refresh_event_".length);

  try {
    const gammaEvent = await getEventById(polyEventId);
    if (!gammaEvent || gammaEvent.markets.length === 0) {
      await interaction.followUp({
        content: "Event not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

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
  } catch (err) {
    logger.error("Event refresh failed:", err);
    await interaction.followUp({
      content: "Couldn't refresh event. Try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleBackToEvent(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  // back_event_{polyEventId}
  const polyEventId = interaction.customId.slice("back_event_".length);

  try {
    const gammaEvent = await getEventById(polyEventId);
    if (!gammaEvent || gammaEvent.markets.length === 0) {
      await interaction.followUp({
        content: "Event not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

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
  } catch (err) {
    logger.error("Back to event failed:", err);
    await interaction.followUp({
      content: "Couldn't load event. Try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleConfirm(interaction: ButtonInteraction) {
  await interaction.deferUpdate();

  const decoded = confirmBet.decode(interaction.customId);
  if (!decoded) return;
  const { conditionId, outcome, amount } = decoded;

  // Fetch market from Gamma to upsert
  let gamma = getCachedMarket(conditionId);
  if (!gamma) {
    gamma = await getMarketByConditionId(conditionId);
  }

  if (!gamma) {
    await interaction.editReply({
      content: "Market not found. Try searching again.",
      embeds: [],
      components: [],
    });
    return;
  }

  // Upsert only this market to DB (at bet time)
  let marketDbId: number;
  try {
    marketDbId = await upsertStandaloneMarket(gamma);
  } catch (err) {
    logger.error("Market upsert failed:", err);
    await interaction.editReply({
      content: "Failed to save market. Try again.",
      embeds: [],
      components: [],
    });
    return;
  }

  const guildId = await requireGuildId(interaction);
  if (!guildId) return;

  const result = await placeBet(
    interaction.user.id,
    marketDbId,
    guildId,
    outcome,
    amount,
  );

  if (!result.success) {
    await interaction.editReply({
      content: result.error,
      embeds: [],
      components: [],
    });
    return;
  }

  const pct = (result.oddsAtBet * 100).toFixed(1);
  const eventSlug = gamma.events?.[0]?.slug ?? null;
  const linkSlug = eventSlug || gamma.slug;
  const marketUrl = linkSlug
    ? `https://polymarket.com/event/${linkSlug}`
    : "https://polymarket.com";
  const rawMarketTitle = gamma.groupItemTitle
    ? `${gamma.groupItemTitle} — ${gamma.question}`
    : gamma.question;
  const marketTitle = escapeMarkdown(rawMarketTitle);
  const embed = new EmbedBuilder()
    .setTitle("Bet Placed!")
    .setColor(0x00cc66)
    .setAuthor({
      name: interaction.user.displayName,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setDescription(
      [
        `**Market:** [${marketTitle.length > 200 ? `${marketTitle.slice(0, 197)}...` : marketTitle}](${marketUrl})`,
        `**Outcome:** ${outcome.toUpperCase()} at ${pct}%`,
        `**Stake:** ${amount.toLocaleString()} pts`,
        `**Potential payout:** ${result.potentialPayout.toLocaleString()} pts`,
        `**New balance:** ${result.newBalance.toLocaleString()} pts`,
      ].join("\n"),
    )
    .setFooter({ text: `Bet #${result.betId}` })
    .setTimestamp();

  const marketImage = gamma.image || gamma.icon || null;
  if (marketImage) {
    embed.setThumbnail(marketImage);
  }

  await interaction.editReply({
    content: "Bet placed!",
    embeds: [],
    components: [],
  });

  const context = takeMarketMessage(interaction.user.id, conditionId, outcome);
  const channel = interaction.channel;
  if (
    context &&
    channel &&
    "send" in channel &&
    channel.id === context.channelId
  ) {
    try {
      await channel.send({
        embeds: [embed],
        reply: {
          messageReference: context.messageId,
          failIfNotExists: false,
        },
      });
      return;
    } catch (err) {
      logger.warn("Failed to reply to market card, falling back to followUp", {
        err,
      });
    }
  }

  await interaction.followUp({
    embeds: [embed],
  });
}

async function renderBetList(
  interaction: ButtonInteraction,
  mode: "active" | "settled",
  page: number,
) {
  const guildId = await requireGuildId(interaction);
  if (!guildId) return;

  const list =
    mode === "active"
      ? await getUserActiveBets(interaction.user.id, guildId)
      : await getUserSettledBets(interaction.user.id, guildId);

  const view = buildBetListView(list, page, mode);
  await interaction.editReply(view);
}

async function handleBetsPage(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const decoded = betsPage.decode(interaction.customId);
  if (!decoded) return;
  await renderBetList(interaction, decoded.mode, decoded.page);
}

async function handleBetsToggle(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const decoded = betsToggle.decode(interaction.customId);
  if (!decoded) return;
  await renderBetList(interaction, decoded.mode, 0);
}

async function renderPortfolio(
  interaction: ButtonInteraction,
  targetUserId: string,
  mode: "active" | "settled",
  page: number,
) {
  const guildId = await requireGuildId(interaction);
  if (!guildId) return;

  const target = await interaction.client.users.fetch(targetUserId);
  const stats = await getUserStats(targetUserId, guildId);
  const list =
    mode === "active"
      ? await getUserActiveBets(targetUserId, guildId)
      : await getUserSettledBets(targetUserId, guildId);

  const view = buildPortfolioView(target, stats, list, page, mode);
  await interaction.editReply(view);
}

async function handlePortfolioPage(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const decoded = portfolioPage.decode(interaction.customId);
  if (!decoded) return;
  await renderPortfolio(
    interaction,
    decoded.targetUserId,
    decoded.mode,
    decoded.page,
  );
}

async function handlePortfolioRefresh(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const decoded = portfolioRefresh.decode(interaction.customId);
  if (!decoded) return;
  await renderPortfolio(
    interaction,
    decoded.targetUserId,
    decoded.mode,
    decoded.page,
  );
}

async function handleLeaderboardRefresh(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  // leaderboard_refresh_{sort}
  const sort = interaction.customId.slice("leaderboard_refresh_".length);
  const guildId = await requireGuildId(interaction);
  if (!guildId) return;
  const view = await buildLeaderboardView(
    guildId,
    sort as import("../commands/leaderboard.js").LeaderboardSort,
  );
  await interaction.editReply(view);
}

async function handlePortfolioToggle(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const decoded = portfolioToggle.decode(interaction.customId);
  if (!decoded) return;
  await renderPortfolio(interaction, decoded.targetUserId, decoded.mode, 0);
}

async function handleCloseBet(interaction: ButtonInteraction) {
  // close_bet_{betId}
  const betIdStr = interaction.customId.split("_")[2];
  if (!betIdStr) return;
  const betId = parseInt(betIdStr, 10);
  await showCloseBetPreview(interaction, betId);
}

export async function showCloseBetPreview(
  interaction:
    | ButtonInteraction
    | import("discord.js").StringSelectMenuInteraction,
  betId: number,
) {
  // Preview is ephemeral (only the bettor sees the confirm/cancel prompt).
  // The final "Bet Closed" card is posted publicly as a follow-up.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = await requireGuildId(interaction);
  if (!guildId) return;

  try {
    const bet = await getBetById(betId);
    if (!bet) {
      await interaction.editReply({ content: "Bet not found." });
      return;
    }

    // Verify ownership
    const { user } = await ensureUser(interaction.user.id, guildId);
    if (bet.userId !== user.id) {
      await interaction.editReply({ content: "This isn't your bet." });
      return;
    }

    if (bet.status !== "pending") {
      await interaction.editReply({
        content: `This bet is already ${bet.status}. Cannot close.`,
      });
      return;
    }

    if (!bet.market) {
      await interaction.editReply({ content: "Market data unavailable." });
      return;
    }

    // Get fresh price
    const tokenId =
      bet.outcome === "yes" ? bet.market.yesTokenId : bet.market.noTokenId;
    if (!tokenId) {
      await interaction.editReply({ content: "Market pricing unavailable." });
      return;
    }

    const currentPrice = await getMidpointPrice(tokenId);
    const entryPrice = parseFloat(bet.oddsAtBet);
    const timestamp = Date.now();

    const embed = buildClosePreviewEmbed({
      betId,
      question: bet.market.question,
      eventSlug: bet.market.event?.slug ?? null,
      outcome: bet.outcome as "yes" | "no",
      entryPrice,
      currentPrice,
      amount: bet.amount,
      timestamp,
    });
    const row = buildClosePreviewComponents(betId, timestamp);

    await interaction.editReply({
      embeds: [embed],
      components: [row],
    });
  } catch (err) {
    logger.error("Close bet preview failed:", err);
    await interaction.editReply({
      content: "Couldn't load bet details. Try again.",
    });
  }
}

async function handleConfirmClose(interaction: ButtonInteraction) {
  await interaction.deferUpdate();

  const decoded = confirmClose.decode(interaction.customId);
  if (!decoded) return;
  const { betId, timestamp: previewTimestamp } = decoded;

  const guildId = await requireGuildId(interaction);
  if (!guildId) return;

  // Check price staleness
  const age = Date.now() - previewTimestamp;
  if (age > config.CLOSE_BET_PRICE_MAX_AGE_MS) {
    // Re-show confirmation with fresh price instead of executing
    try {
      const bet = await getBetById(betId);
      if (!bet?.market) {
        await interaction.editReply({
          content: "Bet or market not found.",
          embeds: [],
          components: [],
        });
        return;
      }

      const tokenId =
        bet.outcome === "yes" ? bet.market.yesTokenId : bet.market.noTokenId;
      if (!tokenId) {
        await interaction.editReply({
          content: "Market pricing unavailable.",
          embeds: [],
          components: [],
        });
        return;
      }

      const currentPrice = await getMidpointPrice(tokenId);
      const entryPrice = parseFloat(bet.oddsAtBet);
      const newTimestamp = Date.now();

      const embed = buildClosePreviewEmbed({
        betId,
        question: bet.market.question,
        eventSlug: bet.market.event?.slug ?? null,
        outcome: bet.outcome as "yes" | "no",
        entryPrice,
        currentPrice,
        amount: bet.amount,
        stale: true,
        timestamp: newTimestamp,
      });
      const row = buildClosePreviewComponents(betId, newTimestamp);

      await interaction.editReply({ embeds: [embed], components: [row] });
      return;
    } catch (err) {
      logger.error("Close bet re-preview failed:", err);
      await interaction.editReply({
        content: "Couldn't refresh price. Try again.",
        embeds: [],
        components: [],
      });
      return;
    }
  }

  // Execute the close
  const result = await closeBet(betId, interaction.user.id, guildId);

  if (!result.success) {
    await interaction.editReply({
      content: result.error,
      embeds: [],
      components: [],
    });
    return;
  }

  const resultMarketLine = result.eventSlug
    ? `**Market:** [${result.question}](https://polymarket.com/event/${result.eventSlug})`
    : `**Market:** ${result.question}`;

  const embed = new EmbedBuilder()
    .setTitle("Bet Closed")
    .setColor(result.profit >= 0 ? 0x00cc66 : 0xff4444)
    .setAuthor({
      name: interaction.user.displayName,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setDescription(
      [
        resultMarketLine,
        `**Entry:** ${(result.entryPrice * 100).toFixed(1)}% \u2192 **Exit:** ${(result.exitPrice * 100).toFixed(1)}%`,
        `**Staked:** ${result.staked.toLocaleString()} pts`,
        `**Returned:** ${result.cashOut.toLocaleString()} pts (${result.profit >= 0 ? "+" : ""}${result.profit.toLocaleString()})`,
        `**New balance:** ${result.newBalance.toLocaleString()} pts`,
      ].join("\n"),
    )
    .setFooter({ text: `Bet #${betId}` })
    .setTimestamp();

  try {
    const closedBet = await getBetById(betId);
    const conditionId = closedBet?.market?.polymarketConditionId;
    if (conditionId) {
      const gamma =
        getCachedMarket(conditionId) ||
        (await getMarketByConditionId(conditionId));
      const image = gamma?.image || gamma?.icon;
      if (image) embed.setThumbnail(image);
    }
  } catch (err) {
    logger.warn("Failed to attach thumbnail to close card", { err });
  }

  await interaction.editReply({
    content: "Bet closed.",
    embeds: [],
    components: [],
  });

  await interaction.followUp({ embeds: [embed] });
}

async function renderSearchState(
  interaction: ButtonInteraction,
  query: string,
  showResolved: boolean,
  page: number,
) {
  const gammaEvents = await searchMarkets(query);
  const searchItems = eventsToSearchItems(gammaEvents);
  const hasResolved = searchItems.some(
    (r) => r.status === "resolved" || r.status === "closed",
  );
  const totalPages = computeSearchPages(searchItems, showResolved);
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const embed = buildSearchResultsEmbed(
    query,
    searchItems,
    showResolved,
    safePage,
  );
  const selectMenu = buildSearchSelectMenu(searchItems, showResolved, safePage);
  const controls = buildSearchControlsRow(
    query,
    showResolved,
    hasResolved,
    safePage,
    totalPages,
  );
  await interaction.editReply({
    embeds: [embed],
    components: controls ? [selectMenu, controls] : [selectMenu],
  });
}

async function handleToggleSearchResolved(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const decoded = searchResolvedToggle.decode(interaction.customId);
  if (!decoded) return;

  try {
    await renderSearchState(
      interaction,
      decoded.query,
      decoded.showResolved,
      0,
    );
  } catch (err) {
    logger.error("Toggle search resolved failed:", err);
    await interaction.followUp({
      content: "Couldn't update view. Try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleSearchPage(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const decoded = searchPage.decode(interaction.customId);
  if (!decoded) return;

  try {
    await renderSearchState(
      interaction,
      decoded.query,
      decoded.showResolved,
      decoded.page,
    );
  } catch (err) {
    logger.error("Search page change failed:", err);
    await interaction.followUp({
      content: "Couldn't change page. Try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleTrendingPage(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const page = parseInt(
    interaction.customId.slice("trending_page_".length),
    10,
  );
  if (Number.isNaN(page)) return;

  try {
    const view = await renderTrendingView(page);
    if (!view) {
      await interaction.editReply({
        content: "No trending markets found.",
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply(view);
  } catch (err) {
    logger.error("Trending page change failed:", err);
    await interaction.followUp({
      content: "Couldn't change page. Try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleToggleResolved(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const showResolved = interaction.customId.startsWith("show_resolved_");
  // show_resolved_{polyEventId} or hide_resolved_{polyEventId}
  const polyEventId = interaction.customId.split("_")[2];
  if (!polyEventId) return;

  try {
    const gammaEvent = await getEventById(polyEventId);
    if (!gammaEvent || gammaEvent.markets.length === 0) {
      await interaction.followUp({
        content: "Event not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const eventData = buildEventCardFromGamma(gammaEvent);
    const hasHidden = eventData.outcomes.some(
      (o) => o.status === "resolved" || o.status === "closed",
    );
    const embed = buildEventEmbed(eventData, showResolved);
    const selectMenu = buildEventSelectMenu(eventData, showResolved);
    const buttons = buildEventButtons(
      gammaEvent.id,
      gammaEvent.slug,
      showResolved,
      hasHidden,
    );
    await interaction.editReply({
      embeds: [embed],
      components: [selectMenu, buttons],
    });
  } catch (err) {
    logger.error("Toggle resolved failed:", err);
    await interaction.followUp({
      content: "Couldn't update view. Try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}
