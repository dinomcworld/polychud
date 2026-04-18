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
import { getUserActiveBets } from "../services/betting.js";
import { ensureUser } from "../services/users.js";
import { requireGuildId } from "../utils/guards.js";
import type { Command } from "./types.js";

type ActiveBet = Awaited<ReturnType<typeof getUserActiveBets>>[number];

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

  const view = buildBetListView(activeBets, 0);
  await interaction.editReply(view);
}

export function buildBetListView(
  bets: ActiveBet[],
  page: number,
): BaseMessageOptions {
  const totalPages = Math.max(1, Math.ceil(bets.length / BETS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * BETS_PAGE_SIZE;
  const pageBets = bets.slice(start, start + BETS_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle("Your Active Bets")
    .setColor(0x5865f2)
    .setTimestamp();

  const fields = pageBets.map((bet) => {
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
    const pnlStr =
      unrealizedPnL >= 0 ? `+${unrealizedPnL}` : `${unrealizedPnL}`;

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
  });

  embed.addFields(fields);

  const footerParts = [
    `${bets.length} active bet${bets.length !== 1 ? "s" : ""}`,
  ];
  if (totalPages > 1) footerParts.push(`Page ${safePage + 1}/${totalPages}`);
  embed.setFooter({ text: footerParts.join(" \u2022 ") });

  const components: ActionRowBuilder<
    ButtonBuilder | StringSelectMenuBuilder
  >[] = [];

  if (pageBets.length > 0) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("bets_close_select")
      .setPlaceholder("Select a bet to close early...")
      .addOptions(
        pageBets.map((bet) => {
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

  if (totalPages > 1) {
    const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`bets_page_${safePage - 1}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0),
      new ButtonBuilder()
        .setCustomId(`bets_page_${safePage + 1}`)
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1),
    );
    components.push(nav);
  }

  return { embeds: [embed], components };
}
