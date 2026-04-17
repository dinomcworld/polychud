import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { guildMembers } from "../db/schema.js";
import { requireGuildId } from "../utils/guards.js";
import type { Command } from "./types.js";

export const leaderboardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("See the top predictors in this server")
    .addStringOption((opt) =>
      opt
        .setName("sort")
        .setDescription("Sort mode")
        .setRequired(false)
        .addChoices(
          { name: "Points (balance)", value: "points" },
          { name: "Skill (accumulated %)", value: "skill" },
          { name: "Average (per bet)", value: "average" },
        ),
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const guildId = await requireGuildId(interaction);
    if (!guildId) return;

    const sort = interaction.options.getString("sort") || "points";

    // Get all guild members for this guild
    const members = await db.query.guildMembers.findMany({
      where: eq(guildMembers.guildId, guildId),
      with: { user: true },
    });

    if (members.length === 0) {
      await interaction.editReply({
        content: "No one has placed any bets in this server yet!",
      });
      return;
    }

    type MemberWithUser = (typeof members)[number];

    // Sort based on mode
    let sorted: MemberWithUser[];
    let title: string;
    let formatValue: (m: MemberWithUser) => string;

    switch (sort) {
      case "skill":
        sorted = [...members].sort(
          (a, b) => parseFloat(b.accumulatedPct) - parseFloat(a.accumulatedPct),
        );
        title = "Leaderboard — Prediction Skill";
        formatValue = (m) => {
          const pct = parseFloat(m.accumulatedPct);
          const sign = pct >= 0 ? "+" : "";
          return `${sign}${pct.toFixed(2)}%`;
        };
        break;

      case "average":
        sorted = [...members]
          .filter((m) => m.totalBetsSettled > 0)
          .sort((a, b) => {
            const avgA = parseFloat(a.accumulatedPct) / a.totalBetsSettled;
            const avgB = parseFloat(b.accumulatedPct) / b.totalBetsSettled;
            return avgB - avgA;
          });
        title = "Leaderboard — Average Per Bet";
        formatValue = (m) => {
          const avg = parseFloat(m.accumulatedPct) / m.totalBetsSettled;
          const sign = avg >= 0 ? "+" : "";
          return `${sign}${avg.toFixed(2)}% (${m.totalBetsSettled} bets)`;
        };
        break;

      default: // "points"
        sorted = [...members].sort((a, b) => b.pointsBalance - a.pointsBalance);
        title = "Leaderboard — Points";
        formatValue = (m) => `${m.pointsBalance.toLocaleString()} pts`;
        break;
    }

    if (sorted.length === 0) {
      await interaction.editReply({
        content: "No qualifying users for this sort mode.",
      });
      return;
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = sorted.slice(0, 10).map((m, i) => {
      const rank = i < 3 ? medals[i] : `**${i + 1}.**`;
      return `${rank} <@${m.user.discordId}> — ${formatValue(m)}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(lines.join("\n"))
      .setColor(0xffd700)
      .setFooter({
        text: `${sorted.length} player${sorted.length !== 1 ? "s" : ""} in this server`,
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
