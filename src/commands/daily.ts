import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import { claimDaily } from "../services/users.js";
import { COLORS } from "../ui/colors.js";
import { requireGuildId } from "../utils/guards.js";
import type { Command } from "./types.js";

export const dailyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily bonus points"),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = await requireGuildId(interaction);
    if (!guildId) return;

    const result = await claimDaily(interaction.user.id, guildId);

    if (result.claimed) {
      const embed = new EmbedBuilder()
        .setTitle("Daily Bonus Claimed!")
        .setColor(COLORS.GREEN)
        .setDescription(
          `You received **${result.bonus}** points!\n\nNew balance: **${result.balance.toLocaleString()}** points`,
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } else {
      const nextClaimUnix = Math.floor(result.nextClaim.getTime() / 1000);
      const embed = new EmbedBuilder()
        .setTitle("Already Claimed")
        .setColor(COLORS.ORANGE_DEEP)
        .setDescription(
          `You already claimed your daily bonus.\n\nNext claim: <t:${nextClaimUnix}:R>\n\nCurrent balance: **${result.balance.toLocaleString()}** points`,
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  },
};
