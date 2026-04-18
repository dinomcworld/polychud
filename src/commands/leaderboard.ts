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
          {
            name: "Portfolio value (balance + open positions)",
            value: "portfolio",
          },
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

    // Realized Net P&L per user, aggregated from settled/closed/cancelled bets
    const netByUserId = new Map<number, number>();
    {
      const rows = await db
        .select({
          userId: bets.userId,
          net: sql<string>`COALESCE(SUM(${bets.actualPayout} - ${bets.amount}), 0)`,
        })
        .from(bets)
        .where(and(eq(bets.guildId, guildId), isNotNull(bets.actualPayout)))
        .groupBy(bets.userId);
      for (const r of rows) netByUserId.set(r.userId, Number(r.net));
    }

    // Open position mark-to-market, unrealized P&L, unrealized pct, active count.
    const openValueByUserId = new Map<number, number>();
    const unrealizedPnLByUserId = new Map<number, number>();
    const unrealizedPctByUserId = new Map<number, number>();
    const activeCountByUserId = new Map<number, number>();
    {
      const currentPriceExpr = sql`CASE WHEN ${bets.outcome} = 'yes' THEN ${markets.currentYesPrice} ELSE ${markets.currentNoPrice} END`;
      const rows = await db
        .select({
          userId: bets.userId,
          openValue: sql<string>`COALESCE(SUM(${bets.potentialPayout} * ${currentPriceExpr}), 0)`,
          unrealizedPnL: sql<string>`COALESCE(SUM(${bets.potentialPayout} * ${currentPriceExpr} - ${bets.amount}), 0)`,
          unrealizedPct: sql<string>`COALESCE(SUM(((${bets.potentialPayout} * ${currentPriceExpr} - ${bets.amount}) / ${bets.amount}) * 100), 0)`,
          activeCount: sql<number>`COUNT(*)`,
        })
        .from(bets)
        .innerJoin(markets, eq(bets.marketId, markets.id))
        .where(and(eq(bets.guildId, guildId), eq(bets.status, "pending")))
        .groupBy(bets.userId);
      for (const r of rows) {
        openValueByUserId.set(r.userId, Number(r.openValue));
        unrealizedPnLByUserId.set(r.userId, Number(r.unrealizedPnL));
        unrealizedPctByUserId.set(r.userId, Number(r.unrealizedPct));
        activeCountByUserId.set(r.userId, Number(r.activeCount));
      }
    }

    const totalNetFor = (m: MemberWithUser) =>
      (netByUserId.get(m.userId) ?? 0) +
      (unrealizedPnLByUserId.get(m.userId) ?? 0);
    const totalPctFor = (m: MemberWithUser) =>
      parseFloat(m.accumulatedPct) + (unrealizedPctByUserId.get(m.userId) ?? 0);
    const totalBetsFor = (m: MemberWithUser) =>
      m.totalBetsSettled + (activeCountByUserId.get(m.userId) ?? 0);

    // Sort based on mode
    let sorted: MemberWithUser[];
    let title: string;
    let formatValue: (m: MemberWithUser) => string;

    switch (sort) {
      case "net": {
        sorted = [...members]
          .filter(
            (m) =>
              netByUserId.has(m.userId) || unrealizedPnLByUserId.has(m.userId),
          )
          .sort((a, b) => totalNetFor(b) - totalNetFor(a));
        title = "Leaderboard — Net P&L";
        formatValue = (m) => {
          const total = Math.round(totalNetFor(m));
          const open = Math.round(unrealizedPnLByUserId.get(m.userId) ?? 0);
          const sign = total >= 0 ? "+" : "";
          const openSign = open >= 0 ? "+" : "";
          return `${sign}${total.toLocaleString()} pts (${openSign}${open.toLocaleString()} open)`;
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
        sorted = [...members].sort((a, b) => totalPctFor(b) - totalPctFor(a));
        title = "Leaderboard — Prediction Skill";
        formatValue = (m) => {
          const total = totalPctFor(m);
          const open = unrealizedPctByUserId.get(m.userId) ?? 0;
          const sign = total >= 0 ? "+" : "";
          const openSign = open >= 0 ? "+" : "";
          return `${sign}${total.toFixed(2)}% (${openSign}${open.toFixed(2)}% open)`;
        };
        break;

      case "average":
        sorted = [...members]
          .filter((m) => totalBetsFor(m) > 0)
          .sort((a, b) => {
            const avgA = totalPctFor(a) / totalBetsFor(a);
            const avgB = totalPctFor(b) / totalBetsFor(b);
            return avgB - avgA;
          });
        title = "Leaderboard — Average Per Bet";
        formatValue = (m) => {
          const bets = totalBetsFor(m);
          const avg = totalPctFor(m) / bets;
          const openBets = activeCountByUserId.get(m.userId) ?? 0;
          const openAvg =
            openBets > 0
              ? (unrealizedPctByUserId.get(m.userId) ?? 0) / openBets
              : 0;
          const sign = avg >= 0 ? "+" : "";
          const openSign = openAvg >= 0 ? "+" : "";
          return `${sign}${avg.toFixed(2)}% (${bets} bets, ${openSign}${openAvg.toFixed(2)}% open)`;
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
