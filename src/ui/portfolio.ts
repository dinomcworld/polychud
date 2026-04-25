import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type User,
} from "discord.js";
import {
  portfolioPage,
  portfolioRefresh,
  portfolioToggle,
} from "../interactions/customIds.js";
import type {
  getUserActiveBets,
  getUserSettledBets,
} from "../services/betting.js";
import type { getUserStats } from "../services/users.js";
import { signedColor } from "./colors.js";
import { buildPrevNext, paginate } from "./paginate.js";
import { truncate } from "./text.js";

type ActiveBet = Awaited<ReturnType<typeof getUserActiveBets>>[number];
type SettledBet = Awaited<ReturnType<typeof getUserSettledBets>>[number];
type UserStats = Awaited<ReturnType<typeof getUserStats>>;

export type PortfolioBetsMode = "active" | "settled";

export const PORTFOLIO_BETS_PAGE_SIZE = 5;

export function buildPortfolioView(
  target: User,
  stats: UserStats,
  bets: ActiveBet[] | SettledBet[],
  page: number,
  mode: PortfolioBetsMode = "active",
): BaseMessageOptions {
  const totalPct = stats.accumulatedPct + stats.unrealizedPct;
  const totalPnL = stats.netPnL + stats.unrealizedPnL;
  const totalBets = stats.totalBetsSettled + stats.activeBetsCount;
  const totalAvg = totalBets > 0 ? totalPct / totalBets : 0;

  const pctColor = signedColor(totalPct);

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

  const betsWithPnL = bets.map((bet) => {
    const entryPrice = parseFloat(bet.oddsAtBet);
    let pnl: number;
    if (mode === "active") {
      const currentPrice = bet.market
        ? parseFloat(
            bet.outcome === "yes"
              ? bet.market.currentYesPrice || "0.5"
              : bet.market.currentNoPrice || "0.5",
          )
        : entryPrice;
      pnl = Math.floor(bet.amount * (currentPrice / entryPrice)) - bet.amount;
    } else {
      const payout = (bet as SettledBet).actualPayout ?? 0;
      pnl = payout - bet.amount;
    }
    return { bet, pnl };
  });

  betsWithPnL.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

  const {
    slice: pageBets,
    page: safePage,
    totalPages,
  } = paginate(betsWithPnL, PORTFOLIO_BETS_PAGE_SIZE, page);

  if (pageBets.length > 0) {
    const betLines = pageBets.map(({ bet, pnl }) => {
      const question = bet.market
        ? truncate(bet.market.question, 70)
        : `Market #${bet.marketId}`;

      const eventSlug = bet.market?.event?.slug ?? null;
      const titleLine = eventSlug
        ? `[${question}](https://polymarket.com/event/${eventSlug})`
        : question;

      const pnlStr = pnl >= 0 ? `+${pnl}` : `${pnl}`;

      if (mode === "active") {
        return [
          `**${titleLine}**`,
          `${bet.outcome.toUpperCase()} · **${bet.amount.toLocaleString()}** pts · P&L ${pnlStr} pts`,
        ].join("\n");
      }

      const settled = bet as SettledBet;
      const statusLabel =
        settled.status === "won"
          ? "WON"
          : settled.status === "lost"
            ? "LOST"
            : settled.status === "closed_early"
              ? "CLOSED"
              : settled.status.toUpperCase();
      return [
        `**${titleLine}**`,
        `${settled.outcome.toUpperCase()} · ${statusLabel} · **${settled.amount.toLocaleString()}** pts · P&L ${pnlStr} pts`,
      ].join("\n");
    });

    const baseHeader = mode === "active" ? "Active Bets" : "Settled Bets";
    const header =
      totalPages > 1
        ? `${baseHeader} (Page ${safePage + 1}/${totalPages})`
        : baseHeader;

    embed.addFields({
      name: header,
      value: betLines.join("\n\n"),
    });
  } else {
    embed.addFields({
      name: mode === "active" ? "Active Bets" : "Settled Bets",
      value: mode === "active" ? "_No active bets._" : "_No settled bets yet._",
    });
  }

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const nav = new ActionRowBuilder<ButtonBuilder>();
  if (totalPages > 1) {
    nav.addComponents(
      ...buildPrevNext(safePage, totalPages, (p) =>
        portfolioPage.encode(target.id, mode, p),
      ),
    );
  }
  nav.addComponents(
    new ButtonBuilder()
      .setCustomId(
        portfolioToggle.encode(
          target.id,
          mode === "active" ? "settled" : "active",
        ),
      )
      .setLabel(mode === "active" ? "Show Settled" : "Show Active")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(portfolioRefresh.encode(target.id, mode, safePage))
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(nav);

  return { embeds: [embed], components };
}
