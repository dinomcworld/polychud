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
import { outcomeLabel, resolveOutcomeLabels } from "./outcomeLabels.js";
import { buildPrevNext } from "./paginate.js";
import { truncate } from "./text.js";

type ActiveBet = Awaited<ReturnType<typeof getUserActiveBets>>[number];
type SettledBet = Awaited<ReturnType<typeof getUserSettledBets>>[number];
type UserStats = Awaited<ReturnType<typeof getUserStats>>;

export type PortfolioBetsMode = "active" | "settled";

export const PORTFOLIO_BETS_PAGE_SIZE = 5;

const EMBED_FIELD_VALUE_MAX_LENGTH = 1024;
const BET_SEPARATOR = "\n\n";

function fitPortfolioBetEntry(
  question: string,
  titleLine: string,
  details: string,
): string {
  const linkedEntry = `**${titleLine}**\n${details}`;
  if (linkedEntry.length <= EMBED_FIELD_VALUE_MAX_LENGTH) return linkedEntry;

  const plainTitle = `**${question}**\n`;
  return `${plainTitle}${truncate(
    details,
    EMBED_FIELD_VALUE_MAX_LENGTH - plainTitle.length,
  )}`;
}

function buildPortfolioBetPages(entries: string[]): string[][] {
  const pages: string[][] = [];
  let currentPage: string[] = [];
  let currentLength = 0;

  for (const entry of entries) {
    const separatorLength = currentPage.length > 0 ? BET_SEPARATOR.length : 0;
    const exceedsPage =
      currentPage.length >= PORTFOLIO_BETS_PAGE_SIZE ||
      (currentPage.length > 0 &&
        currentLength + separatorLength + entry.length >
          EMBED_FIELD_VALUE_MAX_LENGTH);

    if (exceedsPage) {
      pages.push(currentPage);
      currentPage = [];
      currentLength = 0;
    }

    const nextSeparatorLength =
      currentPage.length > 0 ? BET_SEPARATOR.length : 0;
    currentPage.push(entry);
    currentLength += nextSeparatorLength + entry.length;
  }

  if (currentPage.length > 0) pages.push(currentPage);
  return pages;
}

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
    const entryPct = (entryPrice * 100).toFixed(1);
    let pnl: number;
    // Current (active) or close (settled) price as a percentage, when known.
    let currentPct: string | null = null;
    if (mode === "active") {
      const currentPrice = bet.market
        ? parseFloat(
            bet.outcome === "yes"
              ? bet.market.currentYesPrice || "0.5"
              : bet.market.currentNoPrice || "0.5",
          )
        : entryPrice;
      currentPct = (currentPrice * 100).toFixed(1);
      pnl = Math.floor(bet.amount * (currentPrice / entryPrice)) - bet.amount;
    } else {
      const settled = bet as SettledBet;
      const payout = settled.actualPayout ?? 0;
      pnl = payout - bet.amount;
      if (settled.closePrice) {
        currentPct = (parseFloat(settled.closePrice) * 100).toFixed(1);
      }
    }
    return { bet, pnl, entryPct, currentPct };
  });

  betsWithPnL.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

  const betLines = betsWithPnL.map(({ bet, pnl, entryPct, currentPct }) => {
    const question = bet.market
      ? truncate(bet.market.question, 70)
      : `Market #${bet.marketId}`;

    const eventSlug = bet.market?.event?.slug ?? null;
    const titleLine = eventSlug
      ? `[${question}](https://polymarket.com/event/${eventSlug})`
      : question;

    const pnlStr = pnl >= 0 ? `+${pnl}` : `${pnl}`;
    const oddsStr =
      currentPct !== null ? `${entryPct}% → ${currentPct}%` : `${entryPct}%`;
    const labels = resolveOutcomeLabels(
      bet.market?.yesLabel,
      bet.market?.noLabel,
    );
    const sideLabel = outcomeLabel(bet.outcome as "yes" | "no", labels);

    if (mode === "active") {
      const details = `${sideLabel} · **${bet.amount.toLocaleString()}** pts · ${oddsStr} · P&L ${pnlStr} pts`;
      return fitPortfolioBetEntry(question, titleLine, details);
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
    const details = `${sideLabel} · ${statusLabel} · **${settled.amount.toLocaleString()}** pts · ${oddsStr} · P&L ${pnlStr} pts`;
    return fitPortfolioBetEntry(question, titleLine, details);
  });

  const betPages = buildPortfolioBetPages(betLines);
  const totalPages = Math.max(1, betPages.length);
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageBetLines = betPages[safePage] ?? [];

  if (pageBetLines.length > 0) {
    const baseHeader = mode === "active" ? "Active Bets" : "Settled Bets";
    const header =
      totalPages > 1
        ? `${baseHeader} (Page ${safePage + 1}/${totalPages})`
        : baseHeader;

    embed.addFields({
      name: header,
      value: pageBetLines.join(BET_SEPARATOR),
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
