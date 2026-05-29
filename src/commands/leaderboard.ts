import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bets, guildMembers, markets } from "../db/schema.js";
import {
  leaderboardPage,
  leaderboardRefresh,
} from "../interactions/customIds.js";
import { COLORS } from "../ui/colors.js";
import { buildPrevNext, paginate } from "../ui/paginate.js";
import { requireGuildId } from "../utils/guards.js";
import type { Command } from "./types.js";

export const LEADERBOARD_PAGE_SIZE = 10;

export type LeaderboardSort =
  | "net"
  | "portfolio"
  | "points"
  | "skill"
  | "average";

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

    const sort = (interaction.options.getString("sort") ||
      "net") as LeaderboardSort;

    const view = await buildLeaderboardView(guildId, sort, 0);
    await interaction.editReply(view);
  },
};

export async function buildLeaderboardView(
  guildId: string,
  sort: LeaderboardSort,
  page = 0,
): Promise<BaseMessageOptions> {
  const members = await db.query.guildMembers.findMany({
    where: eq(guildMembers.guildId, guildId),
    with: { user: true },
  });

  const refreshButton = (refreshPage: number) =>
    new ButtonBuilder()
      .setCustomId(leaderboardRefresh.encode(sort, refreshPage))
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary);

  const refreshRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    refreshButton(0),
  );

  if (members.length === 0) {
    return {
      content: "No one has placed any bets in this server yet!",
      embeds: [],
      components: [refreshRow],
    };
  }

  type MemberWithUser = (typeof members)[number];

  // Realized Net P&L per user
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

    default:
      sorted = [...members].sort((a, b) => b.pointsBalance - a.pointsBalance);
      title = "Leaderboard — Points";
      formatValue = (m) => `${m.pointsBalance.toLocaleString()} pts`;
      break;
  }

  if (sorted.length === 0) {
    return {
      content: "No qualifying users for this sort mode.",
      embeds: [],
      components: [refreshRow],
    };
  }

  const {
    slice: pageMembers,
    page: safePage,
    totalPages,
  } = paginate(sorted, LEADERBOARD_PAGE_SIZE, page);

  const medals = ["🥇", "🥈", "🥉"];
  const offset = safePage * LEADERBOARD_PAGE_SIZE;
  const lines = pageMembers.map((m, i) => {
    const rank = offset + i;
    const display = rank < 3 ? medals[rank] : `**${rank + 1}.**`;
    return `${display} <@${m.user.discordId}> — ${formatValue(m)}`;
  });

  const footerParts = [
    `${sorted.length} player${sorted.length !== 1 ? "s" : ""} in this server`,
  ];
  if (totalPages > 1) footerParts.push(`Page ${safePage + 1}/${totalPages}`);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setColor(COLORS.GOLD)
    .setFooter({ text: footerParts.join(" • ") })
    .setTimestamp();

  const nav = new ActionRowBuilder<ButtonBuilder>();
  if (totalPages > 1) {
    nav.addComponents(
      ...buildPrevNext(safePage, totalPages, (p) =>
        leaderboardPage.encode(sort, p),
      ),
    );
  }
  nav.addComponents(refreshButton(safePage));

  return { embeds: [embed], components: [nav] };
}
