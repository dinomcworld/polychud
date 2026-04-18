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
  const totalPct = stats.accumulatedPct + stats.unrealizedPct;
  const totalPnL = stats.netPnL + stats.unrealizedPnL;
  const totalBets = stats.totalBetsSettled + stats.activeBetsCount;
  const totalAvg = totalBets > 0 ? totalPct / totalBets : 0;

  const pctColor = totalPct > 0 ? 0x00cc66 : totalPct < 0 ? 0xff4444 : 0x888888;

  const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toLocaleString()}`;
  const signedFixed = (n: number, d = 2) =>
    `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;

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
        value: `${signed(Math.round(totalPnL))} pts (${signed(Math.round(stats.unrealizedPnL))} open)`,
        inline: true,
      },
      {
        name: "Accumulated %",
        value: `${signedFixed(totalPct)} (${signedFixed(stats.unrealizedPct)} open)`,
        inline: true,
      },
      {
        name: "Avg Per Bet",
        value:
          totalBets > 0
            ? `${signedFixed(totalAvg)} (${totalBets} bets)`
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
        ? bet.market.question.length > 70
          ? `${bet.market.question.slice(0, 67)}...`
          : bet.market.question
        : `Market #${bet.marketId}`;

      const eventSlug = bet.market?.event?.slug ?? null;
      const titleLine = eventSlug
        ? `[${question}](https://polymarket.com/event/${eventSlug})`
        : question;

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

      return [
        `**${titleLine}**`,
        `${bet.outcome.toUpperCase()} · **${bet.amount.toLocaleString()}** pts · P&L ${pnlStr} pts`,
      ].join("\n");
    });

    const header =
      totalPages > 1
        ? `Active Bets (Page ${safePage + 1}/${totalPages})`
        : "Active Bets";

    embed.addFields({
      name: header,
      value: betLines.join("\n\n"),
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
