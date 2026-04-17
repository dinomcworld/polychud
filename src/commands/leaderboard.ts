import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bets, guildMembers, markets } from "../db/schema.js";
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
          { name: "Net P&L (points gained/lost)", value: "net" },
          { name: "Portfolio value (balance + open positions)", value: "portfolio" },
          { name: "Points (balance)", value: "points" },
          { name: "Skill (accumulated %)", value: "skill" },
          { name: "Average (per bet)", value: "average" },
        ),
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const guildId = await requireGuildId(interaction);
    if (!guildId) return;

    const sort = interaction.options.getString("sort") || "net";

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

    // Net P&L per user, aggregated from settled/closed/cancelled bets
    const netByUserId = new Map<number, number>();
    if (sort === "net") {
      const rows = await db
        .select({
          userId: bets.userId,
          net: sql<string>`COALESCE(SUM(${bets.actualPayout} - ${bets.amount}), 0)`,
        })
        .from(bets)
        .where(
          and(eq(bets.guildId, guildId), isNotNull(bets.actualPayout)),
        )
        .groupBy(bets.userId);
      for (const r of rows) netByUserId.set(r.userId, Number(r.net));
    }

    // Open position mark-to-market value per user
    // shares = potentialPayout; current value = shares * currentPrice(outcome)
    const openValueByUserId = new Map<number, number>();
    if (sort === "portfolio") {
      const rows = await db
        .select({
          userId: bets.userId,
          openValue: sql<string>`COALESCE(SUM(${bets.potentialPayout} * CASE WHEN ${bets.outcome} = 'yes' THEN ${markets.currentYesPrice} ELSE ${markets.currentNoPrice} END), 0)`,
        })
        .from(bets)
        .innerJoin(markets, eq(bets.marketId, markets.id))
        .where(and(eq(bets.guildId, guildId), eq(bets.status, "pending")))
        .groupBy(bets.userId);
      for (const r of rows) openValueByUserId.set(r.userId, Number(r.openValue));
    }

    // Sort based on mode
    let sorted: MemberWithUser[];
    let title: string;
    let formatValue: (m: MemberWithUser) => string;

    switch (sort) {
      case "net": {
        sorted = [...members]
          .filter((m) => netByUserId.has(m.userId))
          .sort(
            (a, b) =>
              (netByUserId.get(b.userId) ?? 0) -
              (netByUserId.get(a.userId) ?? 0),
          );
        title = "Leaderboard — Net P&L";
        formatValue = (m) => {
          const net = netByUserId.get(m.userId) ?? 0;
          const sign = net >= 0 ? "+" : "";
          return `${sign}${net.toLocaleString()} pts`;
        };
        break;
      }

      case "portfolio": {
        const totalFor = (m: MemberWithUser) =>
          m.pointsBalance + (openValueByUserId.get(m.userId) ?? 0);
        sorted = [...members].sort((a, b) => totalFor(b) - totalFor(a));
        title = "Leaderboard — Portfolio Value";
        formatValue = (m) => {
          const open = openValueByUserId.get(m.userId) ?? 0;
          const total = m.pointsBalance + open;
          return `${Math.round(total).toLocaleString()} pts (${m.pointsBalance.toLocaleString()} + ${Math.round(open).toLocaleString()} open)`;
        };
        break;
      }

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
