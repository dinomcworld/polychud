import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ModalSubmitInteraction,
} from "discord.js";
import { getMarketWithPrices } from "../services/markets.js";
import { ensureUser, ensureGuildSettings } from "../services/users.js";
import { getUserActiveBets } from "../services/betting.js";
import { config } from "../config.js";

export async function handleModal(interaction: ModalSubmitInteraction) {
  const id = interaction.customId;

  if (id.startsWith("betmodal_")) {
    await handleBetModal(interaction);
  } else {
    await interaction.reply({
      content: "This form isn't implemented yet.",
      ephemeral: true,
    });
  }
}

async function handleBetModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // betmodal_{marketId}_{outcome}
  const parts = interaction.customId.split("_");
  const marketId = parseInt(parts[1]!, 10);
  const outcome = parts[2] as "yes" | "no";

  const amountStr = interaction.fields.getTextInputValue("bet_amount").trim();
  const amount = parseInt(amountStr, 10);

  if (isNaN(amount) || amount <= 0) {
    await interaction.editReply({
      content: "Please enter a valid positive number.",
    });
    return;
  }

  const guild = await ensureGuildSettings(interaction.guildId!);
  const user = await ensureUser(interaction.user.id, interaction.guildId!);

  // Validate amount
  if (amount < guild.minBet) {
    await interaction.editReply({
      content: `Minimum bet is **${guild.minBet}** points.`,
    });
    return;
  }

  if (amount > guild.maxBet) {
    await interaction.editReply({
      content: `Maximum bet is **${guild.maxBet}** points.`,
    });
    return;
  }

  if (amount > user.pointsBalance) {
    await interaction.editReply({
      content: `You only have **${user.pointsBalance.toLocaleString()}** points. Can't bet ${amount.toLocaleString()}.`,
    });
    return;
  }

  // Check active bet limits
  const activeBets = await getUserActiveBets(interaction.user.id);
  if (activeBets.length >= config.MAX_ACTIVE_BETS_PER_USER) {
    await interaction.editReply({
      content: `You already have ${config.MAX_ACTIVE_BETS_PER_USER} active bets. Close some first.`,
    });
    return;
  }

  // Get market
  const market = await getMarketWithPrices(marketId, true);
  if (!market) {
    await interaction.editReply({ content: "Market not found." });
    return;
  }

  if (market.status !== "active") {
    await interaction.editReply({
      content: "This market is no longer active.",
    });
    return;
  }

  const price =
    outcome === "yes"
      ? parseFloat(market.currentYesPrice || "0.5")
      : parseFloat(market.currentNoPrice || "0.5");
  const pct = (price * 100).toFixed(1);
  const potentialPayout = Math.floor(amount / price);

  // Show confirmation
  const embed = new EmbedBuilder()
    .setTitle("Confirm your bet")
    .setColor(0xffaa00)
    .setDescription(
      [
        `**Market:** ${market.question}`,
        `**Outcome:** ${outcome.toUpperCase()} at ${pct}%`,
        `**Stake:** ${amount.toLocaleString()} pts`,
        `**Potential payout:** ${potentialPayout.toLocaleString()} pts (if you win)`,
      ].join("\n")
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_${marketId}_${outcome}_${amount}`)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("cancel_bet")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    embeds: [embed],
    components: [row],
  });
}
