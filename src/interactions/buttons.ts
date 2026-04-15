import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
} from "discord.js";
import { logger } from "../utils/logger.js";
import { getMarketWithPrices, getEventWithMarkets } from "../services/markets.js";
import { placeBet, getBetById } from "../services/betting.js";
import { closeBet } from "../services/betting.js";
import { ensureUser } from "../services/users.js";
import { getMidpointPrice } from "../services/polymarket.js";
import {
  buildMarketEmbed,
  buildMarketButtons,
} from "../ui/marketCard.js";
import {
  buildEventEmbed,
  buildEventSelectMenu,
  buildEventButtons,
} from "../ui/eventCard.js";
import { marketToCardData, buildEventCardFromDb } from "../commands/market.js";
import { config } from "../config.js";

export async function handleButton(interaction: ButtonInteraction) {
  const id = interaction.customId;

  if (id.startsWith("bet_yes_") || id.startsWith("bet_no_")) {
    await handleBetButton(interaction);
  } else if (id.startsWith("refresh_event_")) {
    await handleRefreshEvent(interaction);
  } else if (id.startsWith("refresh_")) {
    await handleRefresh(interaction);
  } else if (id.startsWith("confirm_close_")) {
    await handleConfirmClose(interaction);
  } else if (id.startsWith("confirm_")) {
    await handleConfirm(interaction);
  } else if (id.startsWith("close_bet_")) {
    await handleCloseBet(interaction);
  } else if (id.startsWith("show_resolved_") || id.startsWith("hide_resolved_")) {
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
      ephemeral: true,
    });
  }
}

async function handleBetButton(interaction: ButtonInteraction) {
  const parts = interaction.customId.split("_");
  // bet_yes_42 or bet_no_42
  const outcome = parts[1] as "yes" | "no";
  const marketId = parseInt(parts[2]!, 10);

  const modal = new ModalBuilder()
    .setCustomId(`betmodal_${marketId}_${outcome}`)
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
    new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput)
  );

  await interaction.showModal(modal);
}

async function handleRefresh(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const marketId = parseInt(interaction.customId.split("_")[1]!, 10);

  try {
    const market = await getMarketWithPrices(marketId, true);
    if (!market) {
      await interaction.followUp({
        content: "Market not found.",
        ephemeral: true,
      });
      return;
    }

    // Look up event slug for correct Polymarket link
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
    logger.error("Refresh failed:", err);
    await interaction.followUp({
      content: "Couldn't refresh prices. Try again.",
      ephemeral: true,
    });
  }
}

async function handleRefreshEvent(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const eventDbId = parseInt(interaction.customId.split("_")[2]!, 10);

  try {
    const event = await getEventWithMarkets(eventDbId);
    if (!event || event.markets.length === 0) {
      await interaction.followUp({
        content: "Event not found.",
        ephemeral: true,
      });
      return;
    }

    const eventData = buildEventCardFromDb(event);
    const hasHidden = eventData.outcomes.some(
      (o) => o.status === "resolved" || o.status === "closed"
    );
    const embed = buildEventEmbed(eventData);
    const selectMenu = buildEventSelectMenu(eventData);
    const buttons = buildEventButtons(event.id, event.slug, false, hasHidden);
    await interaction.editReply({
      embeds: [embed],
      components: [selectMenu, buttons],
    });
  } catch (err) {
    logger.error("Event refresh failed:", err);
    await interaction.followUp({
      content: "Couldn't refresh event. Try again.",
      ephemeral: true,
    });
  }
}

async function handleBackToEvent(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const eventDbId = parseInt(interaction.customId.split("_")[2]!, 10);

  try {
    const event = await getEventWithMarkets(eventDbId);
    if (!event || event.markets.length === 0) {
      await interaction.followUp({
        content: "Event not found.",
        ephemeral: true,
      });
      return;
    }

    const eventData = buildEventCardFromDb(event);
    const hasHidden = eventData.outcomes.some(
      (o) => o.status === "resolved" || o.status === "closed"
    );
    const embed = buildEventEmbed(eventData);
    const selectMenu = buildEventSelectMenu(eventData);
    const buttons = buildEventButtons(event.id, event.slug, false, hasHidden);
    await interaction.editReply({
      embeds: [embed],
      components: [selectMenu, buttons],
    });
  } catch (err) {
    logger.error("Back to event failed:", err);
    await interaction.followUp({
      content: "Couldn't load event. Try again.",
      ephemeral: true,
    });
  }
}

async function handleConfirm(interaction: ButtonInteraction) {
  await interaction.deferUpdate();

  // confirm_{marketId}_{outcome}_{amount}
  const parts = interaction.customId.split("_");
  const marketId = parseInt(parts[1]!, 10);
  const outcome = parts[2] as "yes" | "no";
  const amount = parseInt(parts[3]!, 10);

  const result = await placeBet(
    interaction.user.id,
    marketId,
    interaction.guildId!,
    outcome,
    amount
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
  const embed = new EmbedBuilder()
    .setTitle("Bet Placed!")
    .setColor(0x00cc66)
    .setDescription(
      [
        `**Outcome:** ${outcome.toUpperCase()} at ${pct}%`,
        `**Stake:** ${amount.toLocaleString()} pts`,
        `**Potential payout:** ${result.potentialPayout.toLocaleString()} pts`,
        `**New balance:** ${result.newBalance.toLocaleString()} pts`,
      ].join("\n")
    )
    .setFooter({ text: `Bet #${result.betId}` })
    .setTimestamp();

  await interaction.editReply({
    embeds: [embed],
    components: [],
  });
}

async function handleCloseBet(interaction: ButtonInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // close_bet_{betId}
  const betId = parseInt(interaction.customId.split("_")[2]!, 10);

  try {
    const bet = await getBetById(betId);
    if (!bet) {
      await interaction.editReply({ content: "Bet not found." });
      return;
    }

    // Verify ownership
    const user = await ensureUser(interaction.user.id, interaction.guildId!);
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
    const cashOutAmount = Math.floor(bet.amount * (currentPrice / entryPrice));
    const profit = cashOutAmount - bet.amount;
    const priceDelta = currentPrice - entryPrice;

    const timestamp = Date.now();

    const embed = new EmbedBuilder()
      .setTitle("Close bet early?")
      .setColor(profit >= 0 ? 0x00cc66 : 0xff4444)
      .setDescription(
        [
          `**Market:** ${bet.market.question}`,
          `**Your bet:** ${bet.outcome.toUpperCase()} at ${(entryPrice * 100).toFixed(1)}%`,
          `**Current price:** ${(currentPrice * 100).toFixed(1)}%`,
          "\u2500".repeat(20),
          `**Staked:** ${bet.amount.toLocaleString()} pts`,
          `**Return:** ${cashOutAmount.toLocaleString()} pts (${profit >= 0 ? "+" : ""}${profit.toLocaleString()} profit)`,
          `**Price \u0394:** ${priceDelta >= 0 ? "+" : ""}${(priceDelta * 100).toFixed(1)}%`,
        ].join("\n")
      )
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_close_${betId}_${timestamp}`)
        .setLabel("Confirm Close")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("cancel_close")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
    );

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

  // confirm_close_{betId}_{timestamp}
  const parts = interaction.customId.split("_");
  const betId = parseInt(parts[2]!, 10);
  const previewTimestamp = parseInt(parts[3]!, 10);

  // Check price staleness
  const age = Date.now() - previewTimestamp;
  if (age > config.CLOSE_BET_PRICE_MAX_AGE_MS) {
    // Re-show confirmation with fresh price instead of executing
    try {
      const bet = await getBetById(betId);
      if (!bet || !bet.market) {
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
      const cashOutAmount = Math.floor(
        bet.amount * (currentPrice / entryPrice)
      );
      const profit = cashOutAmount - bet.amount;
      const priceDelta = currentPrice - entryPrice;
      const newTimestamp = Date.now();

      const embed = new EmbedBuilder()
        .setTitle("Price updated — confirm close?")
        .setColor(profit >= 0 ? 0x00cc66 : 0xff4444)
        .setDescription(
          [
            `**Market:** ${bet.market.question}`,
            `**Your bet:** ${bet.outcome.toUpperCase()} at ${(entryPrice * 100).toFixed(1)}%`,
            `**Current price:** ${(currentPrice * 100).toFixed(1)}%`,
            "\u2500".repeat(20),
            `**Staked:** ${bet.amount.toLocaleString()} pts`,
            `**Return:** ${cashOutAmount.toLocaleString()} pts (${profit >= 0 ? "+" : ""}${profit.toLocaleString()} profit)`,
            `**Price \u0394:** ${priceDelta >= 0 ? "+" : ""}${(priceDelta * 100).toFixed(1)}%`,
          ].join("\n")
        )
        .setFooter({ text: "Price was stale — refreshed" })
        .setTimestamp();

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_close_${betId}_${newTimestamp}`)
          .setLabel("Confirm Close")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("cancel_close")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
      );

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
  const result = await closeBet(betId, interaction.user.id, interaction.guildId!);

  if (!result.success) {
    await interaction.editReply({
      content: result.error,
      embeds: [],
      components: [],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Bet Closed")
    .setColor(result.profit >= 0 ? 0x00cc66 : 0xff4444)
    .setDescription(
      [
        `**Market:** ${result.question}`,
        `**Entry:** ${(result.entryPrice * 100).toFixed(1)}% \u2192 **Exit:** ${(result.exitPrice * 100).toFixed(1)}%`,
        `**Staked:** ${result.staked.toLocaleString()} pts`,
        `**Returned:** ${result.cashOut.toLocaleString()} pts (${result.profit >= 0 ? "+" : ""}${result.profit.toLocaleString()})`,
        `**New balance:** ${result.newBalance.toLocaleString()} pts`,
      ].join("\n")
    )
    .setFooter({ text: `Bet #${betId}` })
    .setTimestamp();

  await interaction.editReply({
    embeds: [embed],
    components: [],
  });
}

async function handleToggleResolved(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const showResolved = interaction.customId.startsWith("show_resolved_");
  const eventDbId = parseInt(interaction.customId.split("_")[2]!, 10);

  try {
    const event = await getEventWithMarkets(eventDbId);
    if (!event || event.markets.length === 0) {
      await interaction.followUp({
        content: "Event not found.",
        ephemeral: true,
      });
      return;
    }

    const eventData = buildEventCardFromDb(event);
    const hasHidden = eventData.outcomes.some(
      (o) => o.status === "resolved" || o.status === "closed"
    );
    const embed = buildEventEmbed(eventData, showResolved);
    const selectMenu = buildEventSelectMenu(eventData, showResolved);
    const buttons = buildEventButtons(
      event.id,
      event.slug,
      showResolved,
      hasHidden
    );
    await interaction.editReply({
      embeds: [embed],
      components: [selectMenu, buttons],
    });
  } catch (err) {
    logger.error("Toggle resolved failed:", err);
    await interaction.followUp({
      content: "Couldn't update view. Try again.",
      ephemeral: true,
    });
  }
}
