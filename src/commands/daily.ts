import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { claimDaily } from "../services/users.js";

export const dailyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily bonus points"),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const result = await claimDaily(
      interaction.user.id,
      interaction.guildId!
    );

    if (result.claimed) {
      const embed = new EmbedBuilder()
        .setTitle("Daily Bonus Claimed!")
        .setColor(0x00cc66)
        .setDescription(
          `You received **${result.bonus}** points!\n\nNew balance: **${result.balance.toLocaleString()}** points`
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } else {
      const nextClaimUnix = Math.floor(result.nextClaim.getTime() / 1000);
      const embed = new EmbedBuilder()
        .setTitle("Already Claimed")
        .setColor(0xff6600)
        .setDescription(
          `You already claimed your daily bonus.\n\nNext claim: <t:${nextClaimUnix}:R>\n\nCurrent balance: **${result.balance.toLocaleString()}** points`
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  },
};
