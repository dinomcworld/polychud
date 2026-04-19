import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  getUserActiveBets,
  type getUserSettledBets,
} from "../services/betting.js";
import { ensureUser } from "../services/users.js";
import { requireGuildId } from "../utils/guards.js";
import type { Command } from "./types.js";

type ActiveBet = Awaited<ReturnType<typeof getUserActiveBets>>[number];
type SettledBet = Awaited<ReturnType<typeof getUserSettledBets>>[number];

export type BetListMode = "active" | "settled";

export const BETS_PAGE_SIZE = 5;

export const betCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("bet")
    .setDescription("Manage your bets")
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List your active bets"),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      await handleBetList(interaction);
    }
  },
};

async function handleBetList(
  interaction: import("discord.js").ChatInputCommandInteraction,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = await requireGuildId(interaction);
  if (!guildId) return;

  await ensureUser(interaction.user.id, guildId);
  const activeBets = await getUserActiveBets(interaction.user.id, guildId);

  if (activeBets.length === 0) {
    await interaction.editReply({
      content:
        "You have no active bets. Use `/market search` to find markets and place bets!",
    });
    return;
  }

  const view = buildBetListView(activeBets, 0, "active");
  await interaction.editReply(view);
}

export function buildBetListView(
  bets: ActiveBet[] | SettledBet[],
  page: number,
  mode: BetListMode = "active",
): BaseMessageOptions {
  const totalPages = Math.max(1, Math.ceil(bets.length / BETS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * BETS_PAGE_SIZE;
  const pageBets = bets.slice(start, start + BETS_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle(mode === "active" ? "Your Active Bets" : "Your Settled Bets")
    .setColor(0x5865f2)
    .setTimestamp();

  const fields = pageBets.map((bet) =>
    mode === "active"
      ? buildActiveField(bet as ActiveBet)
      : buildSettledField(bet as SettledBet),
  );

  if (fields.length > 0) {
    embed.addFields(fields);
  } else {
    embed.setDescription(
      mode === "active"
        ? "You have no active bets."
        : "You have no settled bets yet.",
    );
  }

  const noun = mode === "active" ? "active" : "settled";
  const footerParts = [
    `${bets.length} ${noun} bet${bets.length !== 1 ? "s" : ""}`,
  ];
  if (totalPages > 1) footerParts.push(`Page ${safePage + 1}/${totalPages}`);
  embed.setFooter({ text: footerParts.join(" \u2022 ") });

  const components: ActionRowBuilder<
    ButtonBuilder | StringSelectMenuBuilder
  >[] = [];

  if (mode === "active" && pageBets.length > 0) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("bets_close_select")
      .setPlaceholder("Select a bet to close early...")
      .addOptions(
        (pageBets as ActiveBet[]).map((bet) => {
          const label = `#${bet.id} — ${bet.outcome.toUpperCase()} · ${bet.amount.toLocaleString()} pts`;
          const desc = bet.market
            ? bet.market.question.length > 100
              ? `${bet.market.question.slice(0, 97)}...`
              : bet.market.question
            : `Market #${bet.marketId}`;
          return {
            label: label.length > 100 ? `${label.slice(0, 97)}...` : label,
            description: desc,
            value: String(bet.id),
          };
        }),
      );
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
    );
  }

  const nav = new ActionRowBuilder<ButtonBuilder>();
  if (totalPages > 1) {
    nav.addComponents(
      new ButtonBuilder()
        .setCustomId(`bets_page_${mode}_${safePage - 1}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0),
      new ButtonBuilder()
        .setCustomId(`bets_page_${mode}_${safePage + 1}`)
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1),
    );
  }
  nav.addComponents(
    new ButtonBuilder()
      .setCustomId(`bets_toggle_${mode === "active" ? "settled" : "active"}`)
      .setLabel(mode === "active" ? "Show Settled" : "Show Active")
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(nav);

  return { embeds: [embed], components };
}

function buildActiveField(bet: ActiveBet) {
  const question = bet.market
    ? bet.market.question.length > 50
      ? `${bet.market.question.slice(0, 47)}...`
      : bet.market.question
    : `Market #${bet.marketId}`;

  const eventSlug = bet.market?.event?.slug ?? null;
  const titleLine = eventSlug
    ? `[${question}](https://polymarket.com/event/${eventSlug})`
    : question;

  const entryPrice = parseFloat(bet.oddsAtBet);
  const entryPct = (entryPrice * 100).toFixed(1);

  const currentPrice = bet.market
    ? parseFloat(
        bet.outcome === "yes"
          ? bet.market.currentYesPrice || "0.5"
          : bet.market.currentNoPrice || "0.5",
      )
    : entryPrice;

  const currentPct = (currentPrice * 100).toFixed(1);
  const unrealizedPnL =
    Math.floor(bet.amount * (currentPrice / entryPrice)) - bet.amount;
  const pnlStr = unrealizedPnL >= 0 ? `+${unrealizedPnL}` : `${unrealizedPnL}`;

  return {
    name: `#${bet.id} — ${bet.outcome.toUpperCase()}`,
    value: [
      titleLine,
      `Stake: **${bet.amount.toLocaleString()}** pts`,
      `Entry: ${entryPct}% \u2192 Now: ${currentPct}%`,
      `Potential payout: **${bet.potentialPayout.toLocaleString()}** pts`,
      `P&L: **${pnlStr}** pts`,
    ].join("\n"),
  };
}

function buildSettledField(bet: SettledBet) {
  const question = bet.market
    ? bet.market.question.length > 50
      ? `${bet.market.question.slice(0, 47)}...`
      : bet.market.question
    : `Market #${bet.marketId}`;

  const eventSlug = bet.market?.event?.slug ?? null;
  const titleLine = eventSlug
    ? `[${question}](https://polymarket.com/event/${eventSlug})`
    : question;

  const entryPrice = parseFloat(bet.oddsAtBet);
  const entryPct = (entryPrice * 100).toFixed(1);
  const payout = bet.actualPayout ?? 0;
  const pnl = payout - bet.amount;
  const pnlStr = pnl >= 0 ? `+${pnl}` : `${pnl}`;

  const statusLabel =
    bet.status === "won"
      ? "WON"
      : bet.status === "lost"
        ? "LOST"
        : bet.status === "closed_early"
          ? "CLOSED EARLY"
          : bet.status.toUpperCase();

  const lines = [
    titleLine,
    `Stake: **${bet.amount.toLocaleString()}** pts`,
    `Entry: ${entryPct}%${
      bet.closePrice
        ? ` \u2192 Close: ${(parseFloat(bet.closePrice) * 100).toFixed(1)}%`
        : ""
    }`,
    `Payout: **${payout.toLocaleString()}** pts`,
    `P&L: **${pnlStr}** pts`,
  ];

  const settledAt = bet.resolvedAt ?? bet.closedAt;
  if (settledAt) {
    const unix = Math.floor(new Date(settledAt).getTime() / 1000);
    lines.push(`Settled <t:${unix}:R>`);
  }

  return {
    name: `#${bet.id} — ${bet.outcome.toUpperCase()} · ${statusLabel}`,
    value: lines.join("\n"),
  };
}
