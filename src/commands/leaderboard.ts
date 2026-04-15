import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { eq } from "drizzle-orm";
import type { Command } from "./types.js";
import { db } from "../db/index.js";
import { bets, users } from "../db/schema.js";

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
          { name: "Average (per bet)", value: "average" }
        )
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const sort = interaction.options.getString("sort") || "points";
    const guildId = interaction.guildId!;

    // Get distinct user IDs who have placed bets in this guild
    const guildUserRows = await db
      .selectDistinct({ userId: bets.userId })
      .from(bets)
      .where(eq(bets.guildId, guildId));

    const guildUserIds = guildUserRows.map((r) => r.userId);

    if (guildUserIds.length === 0) {
      await interaction.editReply({
        content: "No one has placed any bets in this server yet!",
      });
      return;
    }

    // Fetch those users
    const allUsers = await db.query.users.findMany();
    const guildUsers = allUsers.filter((u) => guildUserIds.includes(u.id));

    // Sort based on mode
    let sorted: typeof guildUsers;
    let title: string;
    let formatValue: (u: (typeof guildUsers)[number]) => string;

    switch (sort) {
      case "skill":
        sorted = [...guildUsers].sort(
          (a, b) => parseFloat(b.accumulatedPct) - parseFloat(a.accumulatedPct)
        );
        title = "Leaderboard — Prediction Skill";
        formatValue = (u) => {
          const pct = parseFloat(u.accumulatedPct);
          const sign = pct >= 0 ? "+" : "";
          return `${sign}${pct.toFixed(2)}%`;
        };
        break;

      case "average":
        sorted = [...guildUsers]
          .filter((u) => u.totalBetsSettled > 0)
          .sort((a, b) => {
            const avgA =
              parseFloat(a.accumulatedPct) / a.totalBetsSettled;
            const avgB =
              parseFloat(b.accumulatedPct) / b.totalBetsSettled;
            return avgB - avgA;
          });
        title = "Leaderboard — Average Per Bet";
        formatValue = (u) => {
          const avg = parseFloat(u.accumulatedPct) / u.totalBetsSettled;
          const sign = avg >= 0 ? "+" : "";
          return `${sign}${avg.toFixed(2)}% (${u.totalBetsSettled} bets)`;
        };
        break;

      default: // "points"
        sorted = [...guildUsers].sort(
          (a, b) => b.pointsBalance - a.pointsBalance
        );
        title = "Leaderboard — Points";
        formatValue = (u) => `${u.pointsBalance.toLocaleString()} pts`;
        break;
    }

    if (sorted.length === 0) {
      await interaction.editReply({
        content: "No qualifying users for this sort mode.",
      });
      return;
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = sorted.slice(0, 10).map((u, i) => {
      const rank = i < 3 ? medals[i] : `**${i + 1}.**`;
      return `${rank} <@${u.discordId}> — ${formatValue(u)}`;
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
