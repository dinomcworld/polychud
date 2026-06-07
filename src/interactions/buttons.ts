import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { buildLeaderboardView } from "../commands/leaderboard.js";
import {
  renderCategoryView,
  renderNewView,
  renderTrendingView,
} from "../commands/market.js";
import { config } from "../config.js";
import {
  closeBet,
  closeCooldownMessage,
  closeCooldownRemainingMs,
  getBetById,
  getUserActiveBets,
  getUserSettledBets,
  placeBet,
} from "../services/betting.js";
import { upsertStandaloneMarket } from "../services/markets.js";
import {
  fetchPriceHistory,
  getCachedMarket,
  getEventById,
  getMarketByConditionId,
  getMidpointPrice,
  searchMarkets,
} from "../services/polymarket.js";
import {
  ensureGuildSettings,
  ensureUser,
  getUserStats,
} from "../services/users.js";
import { buildBetListView } from "../ui/betList.js";
import { renderPriceChart } from "../ui/chart.js";
import {
  buildClosePreviewComponents,
  buildClosePreviewEmbed,
} from "../ui/closeCard.js";
import { COLORS } from "../ui/colors.js";
import {
  buildEventButtons,
  buildEventCardFromGamma,
  buildEventEmbed,
  buildEventSelectMenu,
  eventsToSearchItems,
} from "../ui/eventCard.js";
import {
  buildSearchControlsRow,
  buildSearchResultsEmbed,
  buildSearchSelectMenu,
  computeSearchPages,
  escapeMarkdown,
} from "../ui/marketCard.js";
import { renderMarketCardWithSummary } from "../ui/marketCardRender.js";
import { outcomeLabel, resolveOutcomeLabels } from "../ui/outcomeLabels.js";
import { buildPortfolioView } from "../ui/portfolio.js";
import { truncate } from "../ui/text.js";
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
  leaderboardPage,
  leaderboardRefresh,
  portfolioPage,
  portfolioRefresh,
  portfolioToggle,
  searchPage,
  searchResolvedToggle,
} from "./customIds.js";

type ButtonHandler = (interaction: ButtonInteraction) => Promise<void>;

async function handleCancel(interaction: ButtonInteraction) {
  await interaction.update({
    content: "Cancelled.",
    embeds: [],
    components: [],
  });
}

const EXACT_ROUTES: Record<string, ButtonHandler> = {
  cancel_bet: handleCancel,
  cancel_close: handleCancel,
};

/** Prefix → handler. Sorted at module load by descending prefix length so
 * `confirm_close_` wins over `confirm_` and `refresh_event_` wins over
 * `refresh_`, regardless of declaration order here. */
const PREFIX_ROUTES: Array<[string, ButtonHandler]> = [
  ["bet_yes_", handleBetButton],
  ["bet_no_", handleBetButton],
  ["refresh_event_", handleRefreshEvent],
  ["refresh_", handleRefresh],
  ["chart_back_", handleChartBack],
  ["chart_", handleChart],
  [confirmClose.prefix, handleConfirmClose],
  [confirmBet.prefix, handleConfirm],
  ["close_bet_", handleCloseBet],
  [betsPage.prefix, handleBetsPage],
  [betsToggle.prefix, handleBetsToggle],
  [portfolioPage.prefix, handlePortfolioPage],
  [portfolioRefresh.prefix, handlePortfolioRefresh],
  [portfolioToggle.prefix, handlePortfolioToggle],
  [leaderboardPage.prefix, handleLeaderboardPage],
  [leaderboardRefresh.prefix, handleLeaderboardRefresh],
  [searchResolvedToggle.showPrefix, handleToggleSearchResolved],
  [searchResolvedToggle.hidePrefix, handleToggleSearchResolved],
  [searchPage.prefix, handleSearchPage],
  ["trending_page_", handleTrendingPage],
  ["new_page_", handleNewPage],
  ["cat_page_", handleCategoryPage],
  ["show_resolved_", handleToggleResolved],
  ["hide_resolved_", handleToggleResolved],
  ["back_event_", handleBackToEvent],
];

const SORTED_ROUTES: ReadonlyArray<[string, ButtonHandler]> = [
  ...PREFIX_ROUTES,
].sort(([a], [b]) => b.length - a.length);

export async function handleButton(interaction: ButtonInteraction) {
  const id = interaction.customId;

  logger.debug(
    `button: user=${interaction.user.id} guild=${interaction.guildId ?? "dm"} customId=${id}`,
  );

  const exact = EXACT_ROUTES[id];
  if (exact) {
    await exact(interaction);
    return;
  }

  for (const [prefix, handler] of SORTED_ROUTES) {
    if (id.startsWith(prefix)) {
      await handler(interaction);
      return;
    }
  }

  await interaction.reply({
    content: "This button isn't implemented yet.",
    flags: MessageFlags.Ephemeral,
  });
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

  const cached = getCachedMarket(conditionId);
  const labels = resolveOutcomeLabels(cached?.outcomes[0], cached?.outcomes[1]);
  const label = truncate(outcomeLabel(outcome, labels), 30);

  // Surface the user's current balance in the modal so they know how much
  // they have before deciding a stake. Best-effort: a lookup failure (or DM,
  // where there's no guild balance) just omits the line — never blocks the bet.
  let balanceNote: string | null = null;
  if (interaction.guildId) {
    try {
      const { member } = await ensureUser(
        interaction.user.id,
        interaction.guildId,
      );
      balanceNote = `Your balance: **${member.pointsBalance.toLocaleString()}** pts`;
    } catch (err) {
      logger.error("Failed to load balance for bet modal:", err);
    }
  }

  const modal = new ModalBuilder()
    .setCustomId(betModal.encode(conditionId, outcome))
    .setTitle(`Place a ${label} bet`);

  const amountInput = new TextInputBuilder()
    .setCustomId("bet_amount")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("e.g., 100")
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(10);

  if (balanceNote) {
    modal.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(balanceNote),
    );
  }

  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel("Amount (points)")
      .setTextInputComponent(amountInput),
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
          await renderMarketCardWithSummary(interaction, gamma, {
            eventSlug: gammaEvent.slug,
            polyEventId: gammaEvent.id,
            includeBackToEvent: true,
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
    await renderMarketCardWithSummary(interaction, gamma, {
      eventSlug,
      polyEventId: eventId,
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

type ChartInterval = "6h" | "1d" | "1w" | "1m" | "max";

const CHART_TIMEFRAMES: Array<{
  interval: ChartInterval;
  label: string;
  pillLabel: string;
  fidelity: number;
  footer: string;
}> = [
  {
    interval: "6h",
    label: "6H",
    pillLabel: "6H",
    fidelity: 5,
    footer: "6-hour price history",
  },
  {
    interval: "1d",
    label: "1D",
    pillLabel: "1D",
    fidelity: 30,
    footer: "24-hour price history",
  },
  {
    interval: "1w",
    label: "1W",
    pillLabel: "1W",
    fidelity: 60,
    footer: "1-week price history",
  },
  {
    interval: "1m",
    label: "1M",
    pillLabel: "1M",
    fidelity: 240,
    footer: "1-month price history",
  },
  {
    interval: "max",
    label: "ALL",
    pillLabel: "ALL",
    fidelity: 1440,
    footer: "Full price history",
  },
];

const DEFAULT_CHART_INTERVAL: ChartInterval = "1w";

function parseChartCustomId(raw: string): {
  conditionId: string;
  polyEventId: string | null;
  interval: ChartInterval;
} {
  // Format: {conditionId}[_evt{polyEventId}][_tf{interval}]
  let rest = raw;
  let interval: ChartInterval = DEFAULT_CHART_INTERVAL;
  const tfIdx = rest.lastIndexOf("_tf");
  if (tfIdx >= 0) {
    const candidate = rest.slice(tfIdx + 3) as ChartInterval;
    if (CHART_TIMEFRAMES.some((t) => t.interval === candidate)) {
      interval = candidate;
      rest = rest.slice(0, tfIdx);
    }
  }
  const evtIdx = rest.indexOf("_evt");
  const conditionId = evtIdx >= 0 ? rest.slice(0, evtIdx) : rest;
  const polyEventId = evtIdx >= 0 ? rest.slice(evtIdx + 4) : null;
  return { conditionId, polyEventId, interval };
}

function chartCustomId(
  conditionId: string,
  polyEventId: string | null,
  interval: ChartInterval,
): string {
  const evt = polyEventId ? `_evt${polyEventId}` : "";
  // Default interval is omitted so the existing "Chart" button on the market
  // card (`chart_{conditionId}[_evt...]`) keeps working unchanged.
  const tf = interval === DEFAULT_CHART_INTERVAL ? "" : `_tf${interval}`;
  return `chart_${conditionId}${evt}${tf}`;
}

async function handleChart(interaction: ButtonInteraction) {
  // Edit the market card in place — Back to Market reverses it. Cleaner than
  // an ephemeral follow-up, which leaves duplicate chat behind on Back.
  await interaction.deferUpdate();
  const { conditionId, polyEventId, interval } = parseChartCustomId(
    interaction.customId.slice("chart_".length),
  );
  const tf =
    CHART_TIMEFRAMES.find((t) => t.interval === interval) ??
    CHART_TIMEFRAMES[2]; // 1w fallback
  if (!tf) return;

  // We deferred via deferUpdate, so the original market card is untouched
  // until we editReply. Errors should leave the card intact and surface as
  // an ephemeral follow-up.
  const ephemeralError = (content: string) =>
    interaction.followUp({ content, flags: MessageFlags.Ephemeral });

  try {
    const gamma =
      getCachedMarket(conditionId) ??
      (await getMarketByConditionId(conditionId));
    if (!gamma) {
      await ephemeralError("Market not found.");
      return;
    }

    const yesTokenId = gamma.clobTokenIds[0];
    if (!yesTokenId) {
      await ephemeralError("Price history unavailable for this market.");
      return;
    }

    const points = await fetchPriceHistory(
      yesTokenId,
      tf.interval,
      tf.fidelity,
    );
    if (points.length < 2) {
      await ephemeralError(
        `Not enough ${tf.label} price history yet for this market.`,
      );
      return;
    }

    const first = points[0]?.p ?? 0;
    const last = points[points.length - 1]?.p ?? 0;
    const direction = last > first ? "up" : last < first ? "down" : "flat";

    const rawTitle = gamma.groupItemTitle
      ? `${gamma.groupItemTitle} — ${gamma.question}`
      : gamma.question;
    const png = await renderPriceChart(points, {
      title: rawTitle,
      direction,
      timeframe: tf.pillLabel,
      iconUrl: gamma.image || gamma.icon || null,
    });
    if (!png) {
      await ephemeralError("Couldn't render chart.");
      return;
    }

    const file = new AttachmentBuilder(png, { name: "chart.png" });
    const eventSlug = gamma.events?.[0]?.slug ?? gamma.slug;
    const marketUrl = eventSlug
      ? `https://polymarket.com/event/${eventSlug}`
      : "https://polymarket.com";
    const embed = new EmbedBuilder()
      .setTitle(truncate(escapeMarkdown(rawTitle), 256))
      .setURL(marketUrl)
      .setColor(
        direction === "up"
          ? COLORS.GREEN
          : direction === "down"
            ? COLORS.RED
            : COLORS.GRAY,
      )
      .setImage("attachment://chart.png")
      .setFooter({ text: `${tf.footer} • Polymarket` });

    const evtSuffix = polyEventId ? `_evt${polyEventId}` : "";
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`chart_back_${conditionId}${evtSuffix}`)
        .setLabel("◀ Back to Market")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setLabel("Polymarket")
        .setStyle(ButtonStyle.Link)
        .setURL(marketUrl),
    );
    const tfRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...CHART_TIMEFRAMES.map((t) =>
        new ButtonBuilder()
          .setCustomId(chartCustomId(conditionId, polyEventId, t.interval))
          .setLabel(t.label)
          .setStyle(
            t.interval === interval
              ? ButtonStyle.Primary
              : ButtonStyle.Secondary,
          )
          // Disable the active timeframe — clicking it would be a no-op edit
          // and the disabled state doubles as a visual selection indicator.
          .setDisabled(t.interval === interval),
      ),
    );

    await interaction.editReply({
      embeds: [embed],
      files: [file],
      components: [tfRow, navRow],
    });
  } catch (err) {
    logger.error("Chart render failed:", err);
    await ephemeralError("Couldn't load chart. Try again.");
  }
}

async function handleChartBack(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  // chart_back_{conditionId} or chart_back_{conditionId}_evt{polyEventId}
  const raw = interaction.customId.slice("chart_back_".length);
  const evtIdx = raw.indexOf("_evt");
  const conditionId = evtIdx >= 0 ? raw.slice(0, evtIdx) : raw;
  const polyEventId = evtIdx >= 0 ? raw.slice(evtIdx + 4) : null;

  try {
    if (polyEventId) {
      const gammaEvent = await getEventById(polyEventId);
      const gamma = gammaEvent?.markets.find(
        (m) => m.conditionId === conditionId,
      );
      if (gammaEvent && gamma) {
        // Restore Back to Event so the user keeps the same affordances they
        // had before clicking Chart.
        await renderMarketCardWithSummary(interaction, gamma, {
          eventSlug: gammaEvent.slug,
          polyEventId: gammaEvent.id,
          includeBackToEvent: true,
          clearFiles: true,
        });
        return;
      }
    }

    const gamma =
      getCachedMarket(conditionId) ??
      (await getMarketByConditionId(conditionId));
    if (!gamma) {
      await interaction.followUp({
        content: "Market not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const eventSlug = gamma.events?.[0]?.slug ?? null;
    const eventId = gamma.events?.[0]?.id ?? null;
    await renderMarketCardWithSummary(interaction, gamma, {
      eventSlug,
      polyEventId: eventId,
      clearFiles: true,
    });
  } catch (err) {
    logger.error("Chart back failed:", err);
    await interaction.followUp({
      content: "Couldn't load market. Try again.",
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
  const labels = resolveOutcomeLabels(gamma.outcomes[0], gamma.outcomes[1]);
  const sideLabel = outcomeLabel(outcome, labels);
  const embed = new EmbedBuilder()
    .setTitle("Bet Placed!")
    .setColor(COLORS.GREEN)
    .setAuthor({
      name: interaction.user.displayName,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setDescription(
      [
        `**Market:** [${truncate(marketTitle, 200)}](${marketUrl})`,
        `**Outcome:** ${sideLabel} at ${pct}%`,
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
  const decoded = leaderboardRefresh.decode(interaction.customId);
  if (!decoded) return;
  const guildId = await requireGuildId(interaction);
  if (!guildId) return;
  const view = await buildLeaderboardView(
    guildId,
    decoded.sort as import("../commands/leaderboard.js").LeaderboardSort,
    decoded.all,
    decoded.page,
  );
  await interaction.editReply(view);
}

async function handleLeaderboardPage(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const decoded = leaderboardPage.decode(interaction.customId);
  if (!decoded) return;
  const guildId = await requireGuildId(interaction);
  if (!guildId) return;
  const view = await buildLeaderboardView(
    guildId,
    decoded.sort as import("../commands/leaderboard.js").LeaderboardSort,
    decoded.all,
    decoded.page,
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

    // Block manual early close while on cooldown, before showing a confirm
    // button. closeBet re-checks this authoritatively.
    const settings = await ensureGuildSettings(guildId);
    const cooldownRemaining = closeCooldownRemainingMs(
      bet.placedAt,
      settings.closeBetCooldownHours,
    );
    if (cooldownRemaining > 0) {
      await interaction.editReply({
        content: closeCooldownMessage(
          cooldownRemaining,
          settings.closeBetCooldownHours,
        ),
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
      yesLabel: bet.market.yesLabel,
      noLabel: bet.market.noLabel,
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
        yesLabel: bet.market.yesLabel,
        noLabel: bet.market.noLabel,
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
    .setColor(result.profit >= 0 ? COLORS.GREEN : COLORS.RED)
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

async function handleNewPage(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const page = parseInt(interaction.customId.slice("new_page_".length), 10);
  if (Number.isNaN(page)) return;

  try {
    const view = await renderNewView(page);
    if (!view) {
      await interaction.editReply({
        content: "No new markets found.",
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply(view);
  } catch (err) {
    logger.error("New page change failed:", err);
    await interaction.followUp({
      content: "Couldn't change page. Try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleCategoryPage(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  // cat_page_{page}_{tagSlug}
  const rest = interaction.customId.slice("cat_page_".length);
  const sep = rest.indexOf("_");
  if (sep < 0) return;
  const page = parseInt(rest.slice(0, sep), 10);
  const tagSlug = rest.slice(sep + 1);
  if (Number.isNaN(page) || !tagSlug) return;

  try {
    const view = await renderCategoryView(tagSlug, page);
    if (!view) {
      await interaction.editReply({
        content: `No markets found in category "${tagSlug}".`,
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply(view);
  } catch (err) {
    logger.error("Category page change failed:", err);
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
