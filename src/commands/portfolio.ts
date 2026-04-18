import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  type User,
} from "discord.js";
import { getUserActiveBets } from "../services/betting.js";
import { getUserStats } from "../services/users.js";
import { requireGuildId } from "../utils/guards.js";
import type { Command } from "./types.js";

type ActiveBet = Awaited<ReturnType<typeof getUserActiveBets>>[number];
type UserStats = Awaited<ReturnType<typeof getUserStats>>;

export const PORTFOLIO_BETS_PAGE_SIZE = 5;

export const portfolioCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("portfolio")
    .setDescription("View a betting portfolio and stats")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("User to view (defaults to yourself)")
        .setRequired(false),
    ) as SlashCommandBuilder,

  async execute(interaction) {
    await interaction.deferReply();

    const guildId = await requireGuildId(interaction);
    if (!guildId) return;

    const target = interaction.options.getUser("user") ?? interaction.user;

    const stats = await getUserStats(target.id, guildId);
    const activeBets = await getUserActiveBets(target.id, guildId);

    const view = buildPortfolioView(target, stats, activeBets, 0);
    await interaction.editReply(view);
  },
};

export function buildPortfolioView(
  target: User,
  stats: UserStats,
  activeBets: ActiveBet[],
  page: number,
): BaseMessageOptions {
  const pctSign = stats.accumulatedPct >= 0 ? "+" : "";
  const pctColor =
    stats.accumulatedPct > 0
      ? 0x00cc66
      : stats.accumulatedPct < 0
        ? 0xff4444
        : 0x888888;

  const embed = new EmbedBuilder()
    .setTitle(`${target.displayName}'s Portfolio`)
    .setColor(pctColor)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      {
        name: "Balance",
        value: `**${stats.pointsBalance.toLocaleString()}** points`,
        inline: true,
      },
      {
        name: "Portfolio Value",
        value: `**${Math.round(stats.portfolioValue).toLocaleString()}** pts (+${Math.round(stats.openValue).toLocaleString()} open)`,
        inline: true,
      },
      {
        name: "Net P&L",
        value: `${stats.netPnL >= 0 ? "+" : ""}${stats.netPnL.toLocaleString()} pts`,
        inline: true,
      },
      {
        name: "Accumulated %",
        value: `${pctSign}${stats.accumulatedPct.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Avg Per Bet",
        value:
          stats.totalBetsSettled > 0
            ? `${stats.accumulatedPct / stats.totalBetsSettled >= 0 ? "+" : ""}${(stats.accumulatedPct / stats.totalBetsSettled).toFixed(2)}`
            : "N/A",
        inline: true,
      },
      {
        name: "Active Bets",
        value: `${stats.activeBetsCount}`,
        inline: true,
      },
      {
        name: "Win Rate",
        value: `${stats.winRate}% (${stats.totalWon}/${stats.totalBetsSettled})`,
        inline: true,
      },
    )
    .setTimestamp();

  const totalPages = Math.max(
    1,
    Math.ceil(activeBets.length / PORTFOLIO_BETS_PAGE_SIZE),
  );
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * PORTFOLIO_BETS_PAGE_SIZE;
  const pageBets = activeBets.slice(start, start + PORTFOLIO_BETS_PAGE_SIZE);

  if (pageBets.length > 0) {
    const betLines = pageBets.map((bet) => {
      const question = bet.market
        ? bet.market.question.length > 40
          ? `${bet.market.question.slice(0, 37)}...`
          : bet.market.question
        : `Market #${bet.marketId}`;

      const entryPrice = parseFloat(bet.oddsAtBet);
      const currentPrice = bet.market
        ? parseFloat(
            bet.outcome === "yes"
              ? bet.market.currentYesPrice || "0.5"
              : bet.market.currentNoPrice || "0.5",
          )
        : entryPrice;

      const unrealizedPnL =
        Math.floor(bet.amount * (currentPrice / entryPrice)) - bet.amount;
      const pnlStr =
        unrealizedPnL >= 0 ? `+${unrealizedPnL}` : `${unrealizedPnL}`;

      return `${bet.outcome.toUpperCase()} **${bet.amount}** pts on ${question} (${pnlStr} pts)`;
    });

    const header =
      totalPages > 1
        ? `Active Bets (Page ${safePage + 1}/${totalPages})`
        : "Active Bets";

    embed.addFields({
      name: header,
      value: betLines.join("\n"),
    });
  }

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (totalPages > 1) {
    const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`portfolio_page_${target.id}_${safePage - 1}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0),
      new ButtonBuilder()
        .setCustomId(`portfolio_page_${target.id}_${safePage + 1}`)
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1),
    );
    components.push(nav);
  }

  return { embeds: [embed], components };
}
