import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ModalSubmitInteraction,
} from "discord.js";
import { config } from "../config.js";
import { getUserActiveBets } from "../services/betting.js";
import {
  getCachedMarket,
  getMarketByConditionId,
  getMidpointPrice,
} from "../services/polymarket.js";
import { ensureGuildSettings, ensureUser } from "../services/users.js";
import { requireGuildId } from "../utils/guards.js";
import { logger } from "../utils/logger.js";

export async function handleModal(interaction: ModalSubmitInteraction) {
  const id = interaction.customId;

  logger.debug(
    `modal: user=${interaction.user.id} guild=${interaction.guildId ?? "dm"} customId=${id}`,
  );

  if (id.startsWith("betmodal_")) {
    await handleBetModal(interaction);
  } else {
    await interaction.reply({
      content: "This form isn't implemented yet.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleBetModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // betmodal_{conditionId}_{outcome}
  const [, conditionId, outcome] = interaction.customId.split("_") as [
    string,
    string,
    "yes" | "no",
  ];

  const amountStr = interaction.fields.getTextInputValue("bet_amount").trim();
  const amount = parseInt(amountStr, 10);

  if (Number.isNaN(amount) || amount <= 0) {
    await interaction.editReply({
      content: "Please enter a valid positive number.",
    });
    return;
  }

  const guildId = await requireGuildId(interaction);
  if (!guildId) return;

  const guild = await ensureGuildSettings(guildId);
  const { member } = await ensureUser(interaction.user.id, guildId);

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

  if (amount > member.pointsBalance) {
    await interaction.editReply({
      content: `You only have **${member.pointsBalance.toLocaleString()}** points. Can't bet ${amount.toLocaleString()}.`,
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

  // Fetch market from Gamma API
  let gamma = getCachedMarket(conditionId);
  if (!gamma) {
    gamma = await getMarketByConditionId(conditionId);
  }

  if (!gamma) {
    await interaction.editReply({ content: "Market not found." });
    return;
  }

  if (gamma.closed || !gamma.active) {
    await interaction.editReply({
      content: "This market is no longer active.",
    });
    return;
  }

  // Get fresh price from CLOB
  const tokenId =
    outcome === "yes" ? gamma.clobTokenIds[0] : gamma.clobTokenIds[1];
  if (!tokenId) {
    await interaction.editReply({
      content: "Market pricing data unavailable.",
    });
    return;
  }

  let price: number;
  try {
    price = await getMidpointPrice(tokenId);
  } catch {
    await interaction.editReply({
      content: "Couldn't fetch current price. Try again in a moment.",
    });
    return;
  }

  const pct = (price * 100).toFixed(1);
  const potentialPayout = Math.floor(amount / price);

  // Show confirmation — pass conditionId in confirm button
  const embed = new EmbedBuilder()
    .setTitle("Confirm your bet")
    .setColor(0xffaa00)
    .setDescription(
      [
        `**Market:** ${gamma.question}`,
        `**Outcome:** ${outcome.toUpperCase()} at ${pct}%`,
        `**Stake:** ${amount.toLocaleString()} pts`,
        `**Potential payout:** ${potentialPayout.toLocaleString()} pts (if you win)`,
      ].join("\n"),
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_${conditionId}_${outcome}_${amount}`)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("cancel_bet")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    embeds: [embed],
    components: [row],
  });
}
